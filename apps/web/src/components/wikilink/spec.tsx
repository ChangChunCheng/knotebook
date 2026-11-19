import { useContext, useRef, type MouseEvent } from "react";
import type { BlockNoteEditor, DefaultStyleSchema } from "@blocknote/core";
import { createReactInlineContentSpec, type ReactCustomInlineContentRenderProps } from "@blocknote/react";
import { canonicalNotePath, normalizeAnchor, wikilinkConfig, wikilinkHref, wikilinkVisibleText, type PublicLinkDto } from "@knotebook/shared";
import { useNotes } from "@/api/notes";
import { tourTarget } from "@/lib/tour-targets";
import { sameNoteId } from "@/lib/note-id";
import { WikilinkContext } from "./context";
import { useToolbarTriggers } from "./useToolbarTriggers";
import { useWikilinkClick } from "./useWikilinkClick";
import { findWikilinkPos, removeWikilinkNode, WikilinkToolbar } from "./WikilinkToolbar";

// Must not import `@/collab/schema` (it imports this file to build `inlineContentSpecs`): type editors as `BlockNoteEditor<any,any,any>`.
// propSchema (`targetNoteId`, `snapshotTitle`, `label`, `anchorBlockId`) lives in `@knotebook/shared`'s `note-schema-config.ts`.
// The editor's renderHTML (in-app `blocknote/html` copy, drag) also uses the `toExternalHTML` component, so that component must not take
// `contentRef` (see `WikilinkExternalHTML`); the `render` component is exempt.

type WikilinkRenderProps = ReactCustomInlineContentRenderProps<typeof wikilinkConfig, DefaultStyleSchema>;

/**
 * Live link = brand color + solid underline (same as external links), deliberately without the external-link icon (same-tab navigation);
 * broken = muted + dashed underline, no brand color (#153, #269). Colors use `text-(--color-brand)`, not `text-brand`: `.bn-root.dark`
 * resets the nested `--brand` to indigo; `--color-brand` is declared only in `@theme inline` (guarded by `theme.link-guard.test.ts`).
 */
const LIVE_LINK_CLASS = "cursor-pointer text-(--color-brand) underline";
const BROKEN_CLASS = "cursor-pointer border-b border-dashed border-muted-foreground text-muted-foreground";

/**
 * Headless export (`blocksToHTMLLossy`/markdown, `toClipboard`): must be a side-effect-free component reading only props, since there is no
 * React context there (any hook throws). Renders `<a href="/notes/<id>[#b-...]">label || snapshotTitle || href</a>` inside a `<span>`,
 * matching the shared headless spec (parity test in `collab/schema.test.ts`). The caller swaps in current titles on the export copy
 * (`wikilinksToLinks`).
 */
function WikilinkExternalHTML({ inlineContent }: WikilinkRenderProps) {
  // No contentRef: wikilink is an atom (content: "none"), so renderHTML would return a contentDOM, and in-app copy (serializeForClipboard) throws "Content hole not allowed in a leaf node spec"
  // and empties the clipboard (#269).
  // Keep the outer <span>: attributes go on the root element, and a root `<a href>` would match the link mark's `a[href]` rule before the wikilink rule on in-app paste
  // (PM raw parse) and paste a plain link (guarded by the in-app copy/paste case in `collab/wikilink-props.facts.test.tsx`).
  const { targetNoteId, anchorBlockId } = inlineContent.props;
  return (
    <span>
      <a href={wikilinkHref(targetNoteId, normalizeAnchor(anchorBlockId))}>
        {wikilinkVisibleText(inlineContent.props)}
      </a>
    </span>
  );
}

/** Two components because hooks can't be conditional; public never calls `useNotes()`. */
export function WikilinkInline(props: WikilinkRenderProps) {
  const mode = useContext(WikilinkContext);
  return mode.mode === "public" ? <PublicWikilink {...props} links={mode.links} /> : <MemberWikilink {...props} />;
}

/**
 * Editor, viewer and version preview. A failed list query counts as "pending": not enough information to call the target missing, so
 * navigation is allowed and the note page handles the 404. A loaded list without this id (deleted or no access) renders the broken style.
 * Clicks always navigate, even when editable; when editable the toolbar opens on hover or touch long-press (`useToolbarTriggers`), and the
 * keyboard can't open it (known limitation).
 */
function MemberWikilink({ inlineContent, contentRef, editor, updateInlineContent }: WikilinkRenderProps) {
  const notesQuery = useNotes();
  const click = useWikilinkClick();
  const elRef = useRef<HTMLElement | null>(null);
  const toolbar = useToolbarTriggers(editor, editor.isEditable);
  const { targetNoteId } = inlineContent.props;
  const label = inlineContent.props.label ?? "";
  const anchor = normalizeAnchor(inlineContent.props.anchorBlockId);
  const list = notesQuery.isPending || !notesQuery.data ? undefined : notesQuery.data;
  const note = list?.find((candidate) => sameNoteId(candidate.id, targetNoteId));
  const broken = list !== undefined && note === undefined;
  const href = note ? `${canonicalNotePath(note)}${anchor ? `#b-${anchor}` : ""}` : wikilinkHref(targetNoteId, anchor);
  const text = broken ? wikilinkVisibleText(inlineContent.props) : wikilinkVisibleText(inlineContent.props, note?.title);
  const target = { href: broken ? "" : href, targetNoteId, anchorBlockId: anchor, broken };
  const setRefs = (el: HTMLElement | null) => {
    elRef.current = el;
    contentRef(el);
  };
  const onClick = (e: MouseEvent<HTMLElement>) => {
    if (!toolbar.consumeClick(e)) click(e, target);
  };
  // `draggable={false}` when editable: tiptap's NodeView.stopEvent leaves dragstart of non-selectable nodes to the browser, so a native <a> would be dragged as a text/html
  // link and dropping it back into the editor would add a copy (`view.dragging` is null, so since #352 it is treated as an external drop and
  // turned into a wikilink copy). Read-only leaves it draggable so readers can still drag links to the tab bar or bookmarks.
  const anchorEl = broken ? (
    <span ref={setRefs} className={BROKEN_CLASS} onClick={onClick} {...tourTarget("wikilink")} {...toolbar.anchorHandlers}>
      {text}
    </span>
  ) : (
    <a ref={setRefs} href={href} className={LIVE_LINK_CLASS} draggable={editor.isEditable ? false : undefined} onClick={onClick} {...tourTarget("wikilink")} {...toolbar.anchorHandlers}>
      {text}
    </a>
  );
  if (!editor.isEditable) return anchorEl;
  // The editor lacks focus while the toolbar is open: put the caret after the link when refocusing. updateInlineContent replaces the atom in place (size stays 1), so a selection-only transaction follows at pos + 1.
  const updateKeepingCaret = (props: typeof inlineContent.props) => {
    const hit = !toolbar.editorHadFocus() && elRef.current ? findWikilinkPos(editor, elRef.current) : null;
    updateInlineContent({ type: "wikilink", props });
    if (hit) editor._tiptapEditor.commands.setTextSelection(hit.pos + 1);
  };
  return (
    <WikilinkToolbar
      open={toolbar.open}
      onOpenChange={toolbar.onOpenChange}
      contentRef={toolbar.contentRef}
      contentHandlers={toolbar.contentHandlers}
      label={label}
      displayText={text}
      notes={list}
      onSaveLabel={(next) => updateKeepingCaret({ ...inlineContent.props, label: next })}
      onChangeTarget={(picked) => updateKeepingCaret({ ...inlineContent.props, targetNoteId: picked.id, snapshotTitle: picked.title, anchorBlockId: "" })}
      onRemove={() => {
        if (elRef.current) removeWikilinkNode(editor, elRef.current, text, !toolbar.editorHadFocus());
      }}
      onRestoreFocus={() => {
        if (toolbar.shouldRestoreFocus()) editor.focus();
      }}
    >
      {anchorEl}
    </WikilinkToolbar>
  );
}

/**
 * `links` (public payload) contains only targets with a custom public URL: a hit links to `/p/...[#b-...]` with `label || public title`;
 * otherwise an anchor whose block exists on this page links to `#b-...` (whether this page is the token form or a custom URL); anything else
 * is plain text.
 */
function PublicWikilink({ inlineContent, contentRef, editor, links }: WikilinkRenderProps & { links: ReadonlyMap<string, PublicLinkDto> }) {
  const click = useWikilinkClick();
  const { targetNoteId } = inlineContent.props;
  const anchor = normalizeAnchor(inlineContent.props.anchorBlockId);
  const target = links.get(targetNoteId.toLowerCase());
  if (target) {
    const href = `${target.path}${anchor ? `#b-${anchor}` : ""}`;
    return (
      <a ref={contentRef} href={href} className={LIVE_LINK_CLASS} onClick={(e) => click(e, { href, targetNoteId, anchorBlockId: anchor, broken: false })}>
        {wikilinkVisibleText(inlineContent.props, target.title)}
      </a>
    );
  }
  if (anchor !== "" && editor.getBlock(anchor) !== undefined) {
    const href = `#b-${anchor}`;
    return (
      <a ref={contentRef} href={href} className={LIVE_LINK_CLASS} onClick={(e) => click(e, { href, targetNoteId: null, anchorBlockId: anchor, broken: false })}>
        {wikilinkVisibleText(inlineContent.props)}
      </a>
    );
  }
  return <span ref={contentRef}>{wikilinkVisibleText(inlineContent.props)}</span>;
}

/** Registered in `collab/schema.ts`'s `inlineContentSpecs`, which replaces the whole set: spread the default text/link specs there. */
export const wikilinkSpec = createReactInlineContentSpec(wikilinkConfig, {
  render: WikilinkInline,
  toExternalHTML: WikilinkExternalHTML,
});

/** Adds a trailing space so typed text doesn't stick to the atom node. `label`/`anchorBlockId` are optional, defaulting to empty strings. */
export function insertWikilink(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's editor generics can't be named here (circular import); any per repo convention
  editor: BlockNoteEditor<any, any, any>,
  wikilink: { targetNoteId: string; snapshotTitle: string; label?: string; anchorBlockId?: string },
): void {
  editor.insertInlineContent([{ type: "wikilink", props: { label: "", anchorBlockId: "", ...wikilink } }, " "]);
}
