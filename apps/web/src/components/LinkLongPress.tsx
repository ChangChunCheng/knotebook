import { useEffect } from "react";
import { useBlockNoteEditor, useEditorDOMElement } from "@blocknote/react";
import { createLongPress } from "@/lib/long-press";

const LINK_SELECTOR = 'a[data-inline-content-type="link"]';

/** Long-press places an empty selection inside the link so `LinkToolbarController` opens its toolbar; the synthesized mousedown/mouseup/click are stopped in capture because ProseMirror `handleClick` (on mouseup) would still open a new tab. Must be mounted inside `<BlockNoteView>` (uses its context). */
export function LinkLongPress() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor has three generic parameters; repo convention is any (as in wikilink/menu.ts)
  const editor = useBlockNoteEditor<any, any, any>();
  const dom = useEditorDOMElement();

  useEffect(() => {
    if (!dom) return;
    let link: HTMLAnchorElement | null = null;
    const press = createLongPress(() => {
      if (!link?.isConnected || !editor.isEditable) return;
      const view = editor._tiptapEditor.view;
      // Styling can split a link into several `<a>`: probe inside and both ends; the cursor goes one past the start because the link mark is not inclusive. One-character links are not found (docs/known-limitations.md).
      const start = view.posAtDOM(link, 0);
      const end = view.posAtDOM(link, link.childNodes.length);
      const range = [start + 1, end, start].map((p) => editor.getLinkMarkAtPos(p)).find((r) => r !== undefined);
      if (!range) return;
      editor._tiptapEditor.commands.setTextSelection(range.from + 1);
    });
    const linkOf = (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest<HTMLAnchorElement>(LINK_SELECTOR) : null;
      return el && dom.contains(el) ? el : null;
    };
    const onDown = (e: PointerEvent) => {
      // `editable` is set in an effect that runs after child effects, so check at event time.
      link = editor.isEditable ? linkOf(e.target) : null;
      if (link) press.down(e);
      else press.reset();
    };
    const onMove = (e: PointerEvent) => press.move(e);
    const onEnd = () => press.end();
    const onContextMenu = (e: MouseEvent) => {
      if (press.contextMenu()) e.preventDefault();
    };
    const swallow = (e: MouseEvent) => {
      if (!press.suppressing()) return;
      if (e.type === "click") press.consumeClick();
      e.preventDefault();
      e.stopPropagation();
    };
    const listeners: Array<[string, (e: never) => void]> = [
      ["pointerdown", onDown],
      ["pointermove", onMove],
      ["pointerup", onEnd],
      ["pointercancel", onEnd],
      ["contextmenu", onContextMenu],
      ["mousedown", swallow],
      ["mouseup", swallow],
      ["click", swallow],
    ];
    for (const [type, fn] of listeners) dom.addEventListener(type, fn as EventListener, true);
    return () => {
      press.dispose();
      for (const [type, fn] of listeners) dom.removeEventListener(type, fn as EventListener, true);
    };
  }, [dom, editor]);

  return null;
}
