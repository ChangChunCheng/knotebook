import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { noteSchema } from "@/collab/schema";
import { LinkLongPress } from "./LinkLongPress";

// Touch long-press on an external link (a normal link mark) => BlockNote's native link toolbar.
// Real editor + BlockNoteView (comes with LinkToolbarController); a long press puts the cursor in the link, so BlockNote's existing "cursor inside a link" path opens the toolbar.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; any by repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

const TOUCH = { pointerType: "touch", clientX: 10, clientY: 10 } as const;
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const linkToolbar = () => document.querySelector(".bn-link-toolbar");

type LinkContent = string | Array<{ type: "text"; text: string; styles: Record<string, boolean> }>;

async function mount(editable = true, linkContent: LinkContent = "Example") {
  const editor = BlockNoteEditor.create({ schema: noteSchema }) as AnyEditor;
  render(
    <BlockNoteView editor={editor} editable={editable}>
      <LinkLongPress />
    </BlockNoteView>,
  );
  await act(async () => {
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: ["see ", { type: "link", href: "https://example.com/", content: linkContent }, " end"] },
    ]);
  });
  // `useEditorDOMElement` (also used by BlockNote's LinkToolbarController) only gets the editor root one tick after mount, so the listener is attached then.
  await settle(10);
  const link = document.querySelector<HTMLAnchorElement>('a[data-inline-content-type="link"]')!;
  expect(link).not.toBeNull();
  return { editor, link };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("touch long press on an external link", () => {
  it("long press of about 500 ms: cursor goes into the link and BlockNote's native link toolbar appears; not before", async () => {
    const { editor, link } = await mount();
    fireEvent.pointerDown(link, TOUCH);
    await settle(300);
    expect(linkToolbar()).toBeNull();
    await settle(300);
    fireEvent.pointerUp(link, TOUCH);
    const sel = editor._tiptapEditor.state.selection;
    expect(sel.empty).toBe(true);
    expect(editor.getSelectedLinkUrl()).toBe("https://example.com/");
    await screen.findByRole("button", { name: "Open in new tab" });
    expect(linkToolbar()).not.toBeNull();
  });

  it("styles split a link into several <a>: long-pressing a one-character segment still finds the whole link; a whole link of one character doesn't open (known limitation)", async () => {
    const { editor } = await mount(true, [
      { type: "text", text: "Exampl", styles: {} },
      { type: "text", text: "e", styles: { bold: true } },
    ]);
    const segments = [...document.querySelectorAll<HTMLAnchorElement>('a[data-inline-content-type="link"]')];
    expect(segments.map((a) => a.textContent)).toEqual(["Exampl", "e"]);
    // Tail segment has one character: the position after the start is exactly the link's end (not inclusive, so no link is found).
    fireEvent.pointerDown(segments[1]!, TOUCH);
    await settle(600);
    fireEvent.pointerUp(segments[1]!, TOUCH);
    expect(editor.getSelectedLinkUrl()).toBe("https://example.com/");
    await screen.findByRole("button", { name: "Open in new tab" });

    cleanup();
    const one = await mount(true, "X");
    const before = one.editor._tiptapEditor.state.selection.toJSON();
    fireEvent.pointerDown(one.link, TOUCH);
    await settle(600);
    expect(one.editor._tiptapEditor.state.selection.toJSON()).toEqual(before);
    expect(linkToolbar()).toBeNull();
  });

  it("editor becomes read-only during the long-press timer (downgrade, expired tab): the selection isn't touched when it fires", async () => {
    const { editor, link } = await mount();
    const before = editor._tiptapEditor.state.selection.toJSON();
    fireEvent.pointerDown(link, TOUCH);
    await settle(200);
    editor.isEditable = false;
    await settle(400);
    expect(editor._tiptapEditor.state.selection.toJSON()).toEqual(before);
  });

  it("the mousedown/mouseup/click replayed after a long press are swallowed (don't reach the editor's handlers, preventDefault); the next short press passes as usual", async () => {
    const { editor, link } = await mount();
    const seen: string[] = [];
    const root = editor._tiptapEditor.view.dom;
    for (const type of ["mousedown", "mouseup", "click"]) root.addEventListener(type, () => seen.push(type));
    fireEvent.pointerDown(link, TOUCH);
    await settle(600);
    fireEvent.pointerUp(link, TOUCH);
    expect(fireEvent.mouseDown(link)).toBe(false);
    expect(fireEvent.mouseUp(link)).toBe(false);
    expect(fireEvent.click(link)).toBe(false);
    expect(seen).toEqual([]);

    fireEvent.pointerDown(link, TOUCH);
    fireEvent.pointerUp(link, TOUCH);
    fireEvent.mouseUp(link);
    fireEvent.click(link);
    expect(seen).toEqual(["mouseup", "click"]);
  });

  it("long press fires but no click is replayed (common on iOS/Android): the next tap outside the link passes as usual", async () => {
    const { editor, link } = await mount();
    const seen: string[] = [];
    const root = editor._tiptapEditor.view.dom;
    for (const type of ["mouseup", "click"]) root.addEventListener(type, () => seen.push(type));
    fireEvent.pointerDown(link, TOUCH);
    await settle(600);
    fireEvent.pointerUp(link, TOUCH);
    const plain = link.previousSibling?.parentElement ?? root;
    fireEvent.pointerDown(plain, { pointerType: "mouse" });
    fireEvent.mouseUp(plain);
    fireEvent.click(plain);
    expect(seen).toEqual(["mouseup", "click"]);
  });

  it("short press: no toolbar, selection untouched", async () => {
    const { editor, link } = await mount();
    const before = editor._tiptapEditor.state.selection.toJSON();
    fireEvent.pointerDown(link, TOUCH);
    await settle(100);
    fireEvent.pointerUp(link, TOUCH);
    await settle(600);
    expect(editor._tiptapEditor.state.selection.toJSON()).toEqual(before);
    expect(linkToolbar()).toBeNull();
  });

  it("finger moves beyond the threshold during the long press: cancelled", async () => {
    const { link } = await mount();
    fireEvent.pointerDown(link, TOUCH);
    fireEvent.pointerMove(link, { ...TOUCH, clientY: 40 });
    await settle(600);
    expect(linkToolbar()).toBeNull();
  });

  it("editable: contextmenu during a touch press is preventDefault-ed (and opens the toolbar at once); a mouse right-click contextmenu isn't intercepted", async () => {
    const rendered = await mount();
    const { link } = rendered;
    fireEvent.pointerDown(link, { pointerType: "mouse", button: 2 });
    expect(fireEvent.contextMenu(link)).toBe(true);
    fireEvent.pointerUp(link, { pointerType: "mouse", button: 2 });

    const { editor } = rendered;
    fireEvent.pointerDown(link, TOUCH);
    expect(fireEvent.contextMenu(link)).toBe(false);
    expect(editor.getSelectedLinkUrl()).toBe("https://example.com/"); // holds immediately, without waiting for the 500 ms timer
    await screen.findByRole("button", { name: "Open in new tab" });
  });

  it("read-only: touch long press doesn't intercept contextmenu or the following click (keeps system behaviour)", async () => {
    const { link } = await mount(false);
    fireEvent.pointerDown(link, TOUCH);
    expect(fireEvent.contextMenu(link)).toBe(true);
    await settle(600);
    fireEvent.pointerUp(link, TOUCH);
    expect(fireEvent.click(link)).toBe(true);
  });

  it("index.css: the iOS long-press link menu (-webkit-touch-callout) is disabled only inside an editable editor, not a read-only one", () => {
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]*)\{([^}]*-webkit-touch-callout[^}]*)\}/g)];
    expect(rules).toHaveLength(1);
    const selectors = rules[0]![1]!.split(",").map((s) => s.trim());
    expect(selectors).toEqual(['.bn-editor[contenteditable="true"] a']);
    expect(rules[0]![2]).toMatch(/-webkit-touch-callout:\s*none/);
  });

  it("precondition of the previous selector: when editable the editor root is `.bn-editor[contenteditable=true]`, when read-only it isn't", async () => {
    const { editor } = await mount();
    expect(editor._tiptapEditor.view.dom.matches('.bn-editor[contenteditable="true"]')).toBe(true);
    cleanup();
    const ro = await mount(false);
    expect(ro.editor._tiptapEditor.view.dom.matches('.bn-editor[contenteditable="true"]')).toBe(false);
  });
});
