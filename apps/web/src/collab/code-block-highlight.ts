/**
 * Case-insensitive shiki highlighting plugin for `codeBlock` nodes (#590).
 *
 * Replaces BlockNote's built-in `code-block-highlighter` extension, which matches
 * `node.attrs.language` case-sensitively and forwards the raw attribute value to shiki.
 * Resolving via `resolveCodeBlockLanguage` ensures pre-existing notes with mixed-case or alias
 * `language` props (e.g. `"Python"`, `"LaTeX"`, `"TS"`) are still highlighted in both editable and
 * read-only views without mutating the Y.Doc, while unknown languages and `"text"` never load shiki.
 */
import { createExtension } from "@blocknote/core";
import { resolveCodeBlockLanguage } from "@knotebook/shared";
// Must be the same prosemirror-view copy BlockNote uses (see `code-block-caret`).
import { Decoration, DecorationSet } from "prosemirror-view";
import { createHighlighter } from "@/lib/code-highlight";
import { createPmPlugin } from "./pm-plugin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Node/Transaction/EditorState types can't be imported: prosemirror-state isn't an apps/web dependency
type Any = any;

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;
type BundledLang = Parameters<Highlighter["loadLanguage"]>[0];
type CodeLang = NonNullable<Parameters<Highlighter["codeToTokens"]>[1]>["lang"];

// TextMate FontStyle bitmask (`@shikijs/vscode-textmate`); `NotSet` is -1 so callers guard `> 0`.
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

const REFRESH_META = "knotebook-code-highlight-refresh";

let loadedHighlighter: Highlighter | null = null;
let highlighterPromise: Promise<void> | null = null;
const loadingLanguages = new Map<string, Promise<void>>();

function ensureHighlighter(): Promise<void> {
  if (highlighterPromise === null) {
    highlighterPromise = createHighlighter()
      .then((hl) => {
        loadedHighlighter = hl;
      })
      .catch((err: unknown) => {
        // Drop a rejected promise so a transient chunk-load failure can recover on the next attempt.
        highlighterPromise = null;
        throw err;
      });
  }
  return highlighterPromise;
}

function ensureLanguage(hl: Highlighter, lang: string): Promise<void> {
  let pending = loadingLanguages.get(lang);
  if (!pending) {
    pending = hl.loadLanguage(lang as BundledLang).finally(() => {
      loadingLanguages.delete(lang);
    });
    loadingLanguages.set(lang, pending);
  }
  return pending;
}

function tokenStyle(color: string | undefined, fontStyle: number | undefined): string {
  const parts: string[] = [];
  if (color) parts.push(`color: ${color}`);
  if (fontStyle && fontStyle > 0) {
    if (fontStyle & FONT_STYLE_ITALIC) parts.push("font-style: italic");
    if (fontStyle & FONT_STYLE_BOLD) parts.push("font-weight: bold");
    const decorations: string[] = [];
    if (fontStyle & FONT_STYLE_UNDERLINE) decorations.push("underline");
    if (fontStyle & FONT_STYLE_STRIKETHROUGH) decorations.push("line-through");
    if (decorations.length > 0) parts.push(`text-decoration: ${decorations.join(" ")}`);
  }
  return parts.join("; ");
}

function tokenizeNode(node: Any, pos: number, lang: string): Decoration[] | Promise<void> {
  if (!loadedHighlighter) return ensureHighlighter();
  if (!loadedHighlighter.getLoadedLanguages().includes(lang)) return ensureLanguage(loadedHighlighter, lang);
  const theme = loadedHighlighter.getLoadedThemes()[0];
  if (!theme) return [];

  const { tokens, fg, bg } = loadedHighlighter.codeToTokens(node.textContent as string, {
    lang: lang as CodeLang,
    theme,
  });
  const decorations: Decoration[] = [];
  if (fg && bg) {
    decorations.push(
      Decoration.node(pos, pos + (node.nodeSize as number), {
        style: `--prosemirror-highlight:${fg};--prosemirror-highlight-bg:${bg}`,
      }),
    );
  }
  let from = pos + 1;
  for (const line of tokens) {
    for (const token of line) {
      const to = from + token.content.length;
      if (to > from) {
        const style = tokenStyle(token.color, token.fontStyle);
        decorations.push(Decoration.inline(from, to, { style, class: "shiki" }));
      }
      from = to;
    }
    from += 1;
  }
  return decorations;
}

type CacheMap = Map<number, readonly [node: Any, decorations: Decoration[]]>;

interface HighlightState {
  cache: CacheMap;
  decorations: DecorationSet;
  promises: Promise<void>[];
}

function invalidateCache(prev: CacheMap, tr: Any): CacheMap {
  const next: CacheMap = new Map();
  const mapping = tr.mapping;
  prev.forEach(([node, decorations], pos) => {
    const mapped = mapping.mapResult(pos);
    const mappedNode = tr.doc.nodeAt(mapped.pos);
    if (mapped.deleted || !mappedNode?.eq(node)) return;
    if (pos === mapped.pos) {
      next.set(pos, [node, decorations]);
    } else {
      const moved = decorations
        .map((d) => (d as Any).map(mapping, 0, 0) as Decoration | null)
        .filter((d): d is Decoration => d !== null);
      next.set(mapped.pos, [mappedNode, moved]);
    }
  });
  return next;
}

function calculate(doc: Any, cache: CacheMap): HighlightState {
  const allDecorations: Decoration[] = [];
  const promises: Promise<void>[] = [];
  const nodes: Array<[Any, number]> = [];
  doc.descendants((node: Any, pos: number) => {
    if (node.type.inlineContent && node.type.name === "codeBlock") {
      nodes.push([node, pos]);
      return false;
    }
    return undefined;
  });

  for (const [node, pos] of nodes) {
    const canonical = resolveCodeBlockLanguage(node.attrs?.language as string | undefined);
    if (!canonical || canonical === "text") {
      cache.delete(pos);
      continue;
    }
    const cached = cache.get(pos);
    if (cached) {
      if (cached[1].length > 0) allDecorations.push(...cached[1]);
      continue;
    }
    const result = tokenizeNode(node, pos, canonical);
    if (Array.isArray(result)) {
      cache.set(pos, [node, result]);
      if (result.length > 0) allDecorations.push(...result);
    } else {
      cache.delete(pos);
      promises.push(result);
    }
  }

  return {
    cache,
    decorations: allDecorations.length > 0 ? DecorationSet.create(doc, allDecorations) : DecorationSet.empty,
    promises,
  };
}

function createCodeHighlightPlugin(): unknown {
  const plugin: Any = createPmPlugin({
    state: {
      init: (_config: Any, state: Any) => calculate(state.doc, new Map()),
      apply: (tr: Any, prev: HighlightState) => {
        const cache = invalidateCache(prev.cache, tr);
        const refresh = Boolean(tr.getMeta(REFRESH_META));
        if (!tr.docChanged && !refresh) {
          return {
            cache,
            decorations: prev.decorations.map(tr.mapping, tr.doc),
            promises: prev.promises,
          };
        }
        return calculate(tr.doc, cache);
      },
    },
    props: {
      decorations(state: Any) {
        return (plugin.getState(state) as HighlightState | undefined)?.decorations;
      },
    },
    view(editorView: Any) {
      let destroyed = false;
      const pending = new Set<Promise<void>>();
      const refresh = () => {
        if (pending.size > 0 || destroyed || editorView.isDestroyed) return;
        editorView.dispatch(editorView.state.tr.setMeta(REFRESH_META, true).setMeta("addToHistory", false));
      };
      const check = () => {
        const state = plugin.getState(editorView.state) as HighlightState | undefined;
        for (const promise of state?.promises ?? []) {
          if (pending.has(promise)) continue;
          pending.add(promise);
          promise.then(
            () => {
              pending.delete(promise);
              refresh();
            },
            () => {
              pending.delete(promise);
            },
          );
        }
      };
      check();
      return {
        update: () => {
          check();
        },
        destroy: () => {
          destroyed = true;
        },
      };
    },
  });
  return plugin;
}

const codeHighlightExtension = createExtension(() => ({
  key: "code-block-highlighter",
  prosemirrorPlugins: [createCodeHighlightPlugin() as never],
}))();

interface SpecWithExtensions {
  extensions?: readonly unknown[];
}

export function withCaseInsensitiveCodeHighlight<S extends SpecWithExtensions>(spec: S): S {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote extension factory union isn't narrowed by key
  const extensions = (spec.extensions ?? []).map((ext: any) => {
    const resolved = typeof ext === "function" ? ext({ editor: undefined }) : ext;
    return resolved?.key === "code-block-highlighter" ? codeHighlightExtension : ext;
  });
  return { ...spec, extensions };
}
