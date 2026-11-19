// No syntax regex or scheme allowlist: the whole text goes to the parser and only "the last inline content is a link whose reconstruction equals the tail" is accepted, so `![a](url)` and `\[a](url)` are excluded by the parser itself. Rationale and known exceptions: #99.
import { Extension, InputRule } from "@tiptap/core";
import { SuggestionMenu } from "@blocknote/core";
import { parseSiteNoteHref, wikilinkPropsFromLink } from "@knotebook/shared";
import type { EditorRef } from "@/components/wikilink/menu";
import { resolveFromCache } from "@/lib/site-link-resolve";
import type { SiteLinkEnvRef } from "./site-link-convert";
import { blockIdAt } from "./site-link-pm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters, repo convention (as in components/NoteEditor.tsx, components/wikilink/menu.ts)
type AnyEditor = any;

export interface TrailingLink {
  text: string;
  href: string;
  /** Includes the `)` that is not yet in the document. */
  matchedLength: number;
}

export function resolveTrailingMarkdownLink(editor: AnyEditor, textBefore: string): TrailingLink | null {
  if (!textBefore.endsWith(")")) return null;

  const blocks = editor.tryParseMarkdownToBlocks(textBefore);
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  // Positive condition: `content` is absent for an image, an empty array for empty display text, and an object for a table; excluding shapes one by one missed the table and threw a TypeError that dropped the keystroke.
  const content = blocks[blocks.length - 1]?.content;
  if (!Array.isArray(content) || content.length === 0) return null;

  const last = content[content.length - 1];
  if (!last || last.type !== "link") return null;

  const inner = last.content;
  if (!Array.isArray(inner) || inner.length !== 1) return null;
  const only = inner[0];
  if (!only || only.type !== "text" || typeof only.text !== "string") return null;
  // Styled display text isn't accepted: replacing with a plain string would drop the styling.
  if (only.styles && Object.keys(only.styles).length > 0) return null;

  const href = last.href;
  if (typeof href !== "string" || href === "") return null;

  // Must mirror how the parser splits: asymmetric cases (title, angle-bracket URL, whitespace around the URL) deliberately don't trigger; the list is in `markdown-link.oracle.test.ts`.
  const recon = `[${only.text}](${href})`;
  if (!textBefore.endsWith(recon)) return null;

  return { text: only.text, href, matchedLength: recon.length };
}

// `getTextContentFromNodes($from, 500)` upstream doesn't bound the output length (a single-text-node paragraph comes out whole), so we truncate ourselves to keep the parse cost flat.
export const MAX_LINK_SCAN = 500;

export function createMarkdownLinkExtension({ editorRef, siteLinks }: { editorRef: EditorRef; siteLinks?: SiteLinkEnvRef }): Extension {
  return Extension.create({
    name: "knotebookMarkdownLink",
    addInputRules() {
      return [
        new InputRule({
          find: (text: string) => {
            if (!text.endsWith(")")) return null; // cheapest early exit; must stay first
            const editor = editorRef.current;
            if (!editor) return null;
            // Doesn't fire while any suggestion menu is open (`shown()` is shared across triggers, also true for the `/` menu), matching the existing precedence of the `[[` detection.
            // Known limitation: a link can't be typed while a menu is open; Esc closes it.
            // To block only `[[`, compare `menu.store.state?.triggerCharacter === "[["` (not on the extension itself) and update this limitation and its test names.
            if (editor.getExtension(SuggestionMenu)?.shown?.()) return null;

            const scanned = text.length > MAX_LINK_SCAN ? text.slice(-MAX_LINK_SCAN) : text;
            const hit = resolveTrailingMarkdownLink(editor, scanned);
            if (!hit) return null;
            // Truncation reintroduces a left-boundary blind spot: the parser is immune to `\[` and `![` only because it sees the character left of `[`; a match reaching the truncated left edge hides it, so it is rejected.
            if (scanned.length < text.length && hit.matchedLength === scanned.length) return null;

            const index = scanned.length - hit.matchedLength;
            // `run()` computes the document range as `match[0].length - text.length`, so `text` must be the reconstructed string including the trailing `)`.
            // `index` is relative to the truncated `scanned` while tiptap sets `result.input` to the untruncated `text`; `run()` reads neither. The two disagree after truncation, so don't compute positions from `match.index`/`match.input`.
            return { text: scanned.slice(index), index, data: { href: hit.href, label: hit.text } };
          },
          handler: ({ state, range, match, chain }) => {
            const href = (match as { data?: { href?: string } }).data?.href;
            const label = (match as { data?: { label?: string } }).data?.label;
            if (typeof href !== "string" || typeof label !== "string") return null;

            // Use the `range` from `run()`, don't derive it from matchedLength: on the `handleTextInput` path the `)` isn't in the document yet, on the IME `compositionend` path `text` is "" and the `)` is already there.
            // The range must carry no mark: `find` and `run()`'s validation both see flattened text, so "`[` + bold `a` + `](url)`" passes, and a plain-string replacement would drop the bold.
            // "No mark in the range", not "a single text node": y-prosemirror sync splits adjacent same-mark nodes.
            let hasMark = false;
            state.doc.nodesBetween(range.from, range.to, (node) => {
              if (node.isText && node.marks.length > 0) hasMark = true;
            });
            if (hasMark) return null;

            // #269: a site URL with a cache hit becomes a wikilink directly; otherwise an ordinary link, plus a queued fallback if it is a site URL.
            const env = siteLinks?.current ?? null;
            const parsed = env ? parseSiteNoteHref(href, env.origin) : null;
            if (env && parsed) {
              const hit = resolveFromCache(env.notes(), parsed);
              if (hit.kind === "hit") {
                chain()
                  .deleteRange(range)
                  .insertContent({ type: "wikilink", attrs: wikilinkPropsFromLink({ text: label, href, target: hit.target, anchorBlockId: parsed.anchorBlockId }) })
                  .run();
                return undefined;
              }
            }
            chain().deleteRange(range).insertContent({ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] }).run();
            if (env && parsed) {
              const blockId = blockIdAt(state.doc, range.from);
              const request = { blockIds: blockId ? [blockId] : [], href, text: label, parsed };
              queueMicrotask(() => env.schedule([request]));
            }
            return undefined;
          },
        }),
      ];
    },
  });
}
