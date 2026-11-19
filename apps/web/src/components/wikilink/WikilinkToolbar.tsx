import { useMemo, useState, type FocusEventHandler, type PointerEventHandler, type ReactElement, type RefObject } from "react";
import { Popover } from "radix-ui";
import { useTranslation } from "react-i18next";
import type { BlockNoteEditor } from "@blocknote/core";
import type { NoteDto } from "@knotebook/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generics; repo convention is any (avoids circular imports, same as spec.tsx)
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Node type isn't available at value level in apps/web
type AnyPmNode = any;

export interface WikilinkToolbarProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactElement;
  /** Checked for focus before a hover close. */
  contentRef?: RefObject<HTMLDivElement | null>;
  /** For a hover-opened toolbar: entering cancels the close, leaving schedules it. */
  contentHandlers?: {
    onPointerEnter?: PointerEventHandler<HTMLDivElement>;
    onPointerLeave?: PointerEventHandler<HTMLDivElement>;
    onPointerDownCapture?: PointerEventHandler<HTMLDivElement>;
    onFocusCapture?: FocusEventHandler<HTMLDivElement>;
  };
  label: string;
  displayText: string;
  notes: readonly NoteDto[] | undefined;
  onSaveLabel(label: string): void;
  onChangeTarget(note: NoteDto): void;
  onRemove(): void;
  onRestoreFocus(): void;
}

/** Max change-target candidates; filtered by the same rule as the `[[` menu (lowercased title contains the query). */
const TARGET_LIMIT = 20;

/**
 * Three buttons and no "open": clicking the link itself navigates. Opens on hover or long-press (`useToolbarTriggers`),
 * anchored on the link; Esc or outside click closes. No autofocus on open (as BlockNote's link toolbar).
 * `onCloseAutoFocus` (all close paths go through it) pulls focus back to the editor only when it has nowhere to go
 * (`activeElement` is body/null): an outside click on a focusable element (the title field, another wikilink's toolbar)
 * has already moved it. `preventDefault()` there stops Radix, which runs after this handler, calling
 * `triggerRef.current?.focus()`, a no-op today (Anchor, no Trigger) that would steal focus if this ever switches to
 * `Popover.Trigger`.
 */
export function WikilinkToolbar(p: WikilinkToolbarProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<"menu" | "text" | "target">("menu");
  const [text, setText] = useState(p.label);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.toLowerCase();
    return (p.notes ?? []).filter((n) => n.title.toLowerCase().includes(q)).slice(0, TARGET_LIMIT);
  }, [p.notes, query]);
  // Controlled close (`close()`) skips Root's onOpenChange, so both paths reset to the menu state; otherwise the next open resumes the old sub-view.
  const reset = () => {
    setView("menu");
    setQuery("");
  };
  const close = () => {
    reset();
    p.onOpenChange(false);
  };
  return (
    <Popover.Root
      open={p.open}
      onOpenChange={(open) => {
        if (!open) reset();
        p.onOpenChange(open);
      }}
    >
      <Popover.Anchor asChild>{p.children}</Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          ref={p.contentRef}
          role="dialog"
          aria-label={t("note.wikilink.toolbar.label")}
          sideOffset={4}
          className="z-50 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md outline-none"
          {...p.contentHandlers}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const active = document.activeElement;
            if (active === null || active === document.body) p.onRestoreFocus();
          }}
        >
          {view === "menu" && (
            <div className="flex gap-1">
              <Button type="button" size="sm" variant="outline" onClick={() => { setText(p.label); setView("text"); }}>
                {t("note.wikilink.toolbar.editText")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setView("target")}>
                {t("note.wikilink.toolbar.changeTarget")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { close(); p.onRemove(); }}>
                {t("note.wikilink.toolbar.remove")}
              </Button>
            </div>
          )}
          {view === "text" && (
            <form
              className="flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                close();
                p.onSaveLabel(text.trim() === "" ? "" : text);
              }}
            >
              <Input aria-label={t("note.wikilink.toolbar.textLabel")} value={text} placeholder={p.displayText} onChange={(e) => setText(e.target.value)} autoFocus />
              <Button type="submit" size="sm" variant="outline">
                {t("note.wikilink.toolbar.save")}
              </Button>
            </form>
          )}
          {view === "target" && (
            <div className="flex w-64 flex-col gap-1">
              <Input aria-label={t("note.wikilink.toolbar.search")} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
              <div className="flex max-h-60 flex-col overflow-y-auto">
                {matches.map((n) => (
                  <Button key={n.id} type="button" size="sm" variant="ghost" className="justify-start" onClick={() => { close(); p.onChangeTarget(n); }}>
                    {n.title}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Matched via `view.nodeDOM(pos)`, not props: one paragraph can hold two wikilinks with identical props. Null if the document changed underneath. */
export function findWikilinkPos(editor: AnyEditor, el: HTMLElement): { pos: number; node: AnyPmNode } | null {
  const view = editor._tiptapEditor.view;
  let found: { pos: number; node: AnyPmNode } | null = null;
  view.state.doc.descendants((node: AnyPmNode, pos: number) => {
    if (found) return false;
    if (node.type.name === "wikilink") {
      const dom = view.nodeDOM(pos) as Node | null;
      if (dom && (dom === el || dom.contains(el))) found = { pos, node };
    }
    return true;
  });
  return found;
}

/**
 * Replaces the node with plain text in one transaction; false if not found. Other marks on the node (bold, color…:
 * PM nodes carry them though BlockNote's JSON doesn't list them) carry over to the text; only `link` is dropped so the
 * site-link converter won't re-convert. `placeCaret`: the same transaction puts the caret after the new text, because
 * the editor is unfocused while the toolbar is open and the focus restore on close must land at the link, not the old selection.
 */
export function removeWikilinkNode(editor: AnyEditor, el: HTMLElement, text: string, placeCaret = false): boolean {
  const hit = findWikilinkPos(editor, el);
  if (!hit) return false;
  const { pos, node } = hit;
  const marks = (node.marks as AnyPmNode[]).filter((mark) => mark.type.name !== "link");
  let chain = editor._tiptapEditor.chain().command(({ tr }) => {
    tr.replaceWith(pos, pos + node.nodeSize, tr.doc.type.schema.text(text, marks));
    return true;
  });
  if (placeCaret) chain = chain.setTextSelection(pos + text.length);
  chain.run();
  return true;
}
