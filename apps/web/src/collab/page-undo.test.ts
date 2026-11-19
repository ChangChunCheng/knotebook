/* eslint-disable @typescript-eslint/no-explicit-any -- tests reach into PM's view/selection directly (types unavailable in apps/web) */
import { afterEach, describe, expect, it } from "vitest";
import { P, blockPos, mountEditor, shape } from "@/test/columns-fixtures";
import { collabUndoManager, keepCollabUndoAlive } from "./undo";
import { attachPageUndoShortcut, pageUndoYields, undoActionOf, undoKeyOf } from "./page-undo";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const key = (k: string, mods: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });

describe("undoActionOf", () => {
  // Keys and modifiers live in the table and the event is built inside the case: vitest serializes it.each parameters and jsdom event objects can't be serialized.
  it.each([
    ["Ctrl+Z", "z", {}, { ctrlKey: true }, "undo"],
    ["Ctrl+Shift+Z", "Z", {}, { ctrlKey: true, shiftKey: true }, "redo"],
    ["Ctrl+Y", "y", {}, { ctrlKey: true }, "redo"],
    ["Cmd+Z (not Mac)", "z", {}, { metaKey: true }, null],
    ["Z (no modifier)", "z", {}, {}, null],
    ["Ctrl+Alt+Z", "z", {}, { ctrlKey: true, altKey: true }, null],
    ["Ctrl+Shift+Y", "Y", {}, { ctrlKey: true, shiftKey: true }, null],
    ["Ctrl+S", "s", {}, { ctrlKey: true }, null],
    ["Ctrl+Z on a Russian layout (key is Cyrillic)", "я", { code: "KeyZ" }, { ctrlKey: true }, "undo"],
    ["Ctrl+Y on a Russian layout (key is Cyrillic)", "н", { code: "KeyY" }, { ctrlKey: true }, "redo"],
    ["Ctrl+Z on a Greek layout (key is Greek)", "ζ", { code: "KeyZ" }, { ctrlKey: true }, "undo"],
    ["Ctrl at the Z position on Dvorak (key is ;)", ";", { code: "KeyZ" }, { ctrlKey: true }, null],
    ["Ctrl at the Z position on BEPO (key is a-grave)", "à", { code: "KeyZ" }, { ctrlKey: true }, null],
    ["Ctrl at the Z position on AZERTY (key is w)", "w", { code: "KeyZ" }, { ctrlKey: true }, null],
    ["Ctrl at the Z position on QWERTZ (key is y)", "y", { code: "KeyZ" }, { ctrlKey: true }, "redo"],
    ["Ctrl+Z on Dvorak (key is z, at the / position)", "z", { code: "Slash" }, { ctrlKey: true }, "undo"],
  ] as const)("other platforms: %s -> %s", (_label, k, code, mods, expected) => {
    expect(undoActionOf(key(k, { ...code, ...mods }), false)).toBe(expected);
  });

  it.each([
    ["Cmd+Z", "z", { metaKey: true }, "undo"],
    ["Cmd+Shift+Z", "Z", { metaKey: true, shiftKey: true }, "redo"],
    ["Cmd+Y (browser history)", "y", { metaKey: true }, null],
    ["Ctrl+Z", "z", { ctrlKey: true }, null],
  ] as const)("Mac: %s -> %s", (_label, k, mods, expected) => {
    expect(undoActionOf(key(k, mods), true)).toBe(expected);
  });

  it.each([
    ["Ctrl+Z", "z", { ctrlKey: true }, "undo"],
    ["Cmd+Z", "z", { metaKey: true }, "undo"],
    ["Cmd+Y", "y", { metaKey: true }, "redo"],
    ["Ctrl+S", "s", { ctrlKey: true }, null],
  ] as const)("undoKeyOf is platform-independent: %s -> %s", (_label, k, mods, expected) => {
    expect(undoKeyOf(key(k, mods))).toBe(expected);
  });
});

/** Collab editor: content is written to the Y.Doc first (not in the undo stack), then one typed character becomes one undo step; focus moves to `<body>`. */
function setup(opts: { enabled?: boolean } = {}) {
  const mounted = mountEditor([P("x", "x1"), P("y", "y1")], { collab: true });
  cleanups.push(mounted.destroy);
  const editor = mounted.editor;
  // Same as NoteEditor's `useCollabUndoLifeline`: attach the undo lifeline after mount.
  cleanups.push(keepCollabUndoAlive(editor));
  let enabled = opts.enabled ?? true;
  cleanups.push(attachPageUndoShortcut(editor, () => enabled));
  const manager = collabUndoManager(editor)!;
  editor.setTextCursorPosition("y1", "end");
  const view = editor.prosemirrorView as any;
  view.dispatch(view.state.tr.insertText("Q"));
  manager.stopCapturing();
  (document.activeElement as HTMLElement | null)?.blur();
  return { editor, view, manager, setEnabled: (v: boolean) => (enabled = v) };
}

function press(target: EventTarget, event: KeyboardEvent): KeyboardEvent {
  target.dispatchEvent(event);
  return event;
}

function addElement(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  cleanups.push(() => host.remove());
  return host.firstElementChild as HTMLElement;
}

describe("undo shortcuts on the note page", () => {
  it("focus on <body>: Ctrl+Z undoes one step, preventDefault, focus moves back to the editor; Ctrl+Shift+Z and Ctrl+Y each redo one step", () => {
    const { editor, view, manager } = setup();
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
    expect(document.activeElement).toBe(document.body);
    const stack = manager.undoStack.length;
    const e = press(document.body, key("z", { ctrlKey: true }));
    expect(e.defaultPrevented).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:y");
    expect(manager.undoStack.length).toBe(stack - 1);
    expect(document.activeElement).toBe(view.dom);

    view.dom.blur();
    expect(press(document.body, key("Z", { ctrlKey: true, shiftKey: true })).defaultPrevented).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
    press(document.body, key("z", { ctrlKey: true }));
    view.dom.blur();
    expect(press(document.body, key("y", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("focus on a button with nothing to undo or redo: focus stays on the button, document unchanged", () => {
    const { editor, view, manager } = setup();
    press(document.body, key("z", { ctrlKey: true }));
    expect(manager.undoStack.length, "前提：撤銷堆疊空了").toBe(0);
    view.dom.blur();
    const el = addElement("<button>share</button>");
    el.focus();
    press(el, key("z", { ctrlKey: true }));
    expect(document.activeElement, "撤銷：焦點不動").toBe(el);
    expect(shape(editor)).toBe("paragraph:x  paragraph:y");
    press(el, key("y", { ctrlKey: true }));
    expect(shape(editor), "前提：重做一步").toBe("paragraph:x  paragraph:yQ");
    expect(document.activeElement, "有東西可重做：焦點移回編輯器").toBe(view.dom);
    el.focus();
    expect(manager.redoStack.length, "前提：重做堆疊空了").toBe(0);
    press(el, key("y", { ctrlKey: true }));
    expect(document.activeElement, "重做：焦點不動").toBe(el);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it.each([
    ["a button", "<button>share</button>"],
    ["a checkbox (outside the editor, e.g. the settings page)", '<input type="checkbox" />'],
    ["a radio button", '<input type="radio" />'],
    ["an input button", '<input type="button" value="b" />'],
    ["a slider", '<input type="range" />'],
    ["a color input", '<input type="color" />'],
    ["a column divider (role=separator)", '<div role="separator" tabindex="0" aria-orientation="vertical"></div>'],
  ])("focus on %s (no text undo of its own): undo still works", (_label, html) => {
    const { editor } = setup();
    const el = addElement(html);
    el.focus();
    expect(document.activeElement).toBe(el); // precondition
    expect(press(el, key("z", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:y");
  });

  it.each([
    ["an input (e.g. the title box)", '<input value="title" />'],
    ["textarea", "<textarea>t</textarea>"],
    ["select", "<select><option>a</option></select>"],
    ["a contenteditable outside the editor", '<div contenteditable="true">t</div>'],
  ])("focus on %s: no undo, no preventDefault", (_label, html) => {
    const { editor } = setup();
    const el = addElement(html);
    el.focus();
    expect(document.activeElement).toBe(el); // precondition
    const e = press(el, key("z", { ctrlKey: true }));
    expect(e.defaultPrevented).toBe(false);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("key inside the editor: the editor's own keymap undoes one step and the bubbled event doesn't undo again", () => {
    const { editor, view, manager } = setup();
    view.dispatch(view.state.tr.insertText("R"));
    manager.stopCapturing();
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQR"); // precondition: two steps
    view.focus();
    press(view.dom.querySelector(".bn-inline-content")!, key("z", { ctrlKey: true }));
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("key target inside the editor with nothing for the editor's keymap to undo (no preventDefault): not intercepted, no undo", () => {
    const { editor, view } = setup();
    press(document.body, key("z", { ctrlKey: true }));
    expect(shape(editor)).toBe("paragraph:x  paragraph:y"); // precondition: the undo stack is empty
    const e = press(view.dom.querySelector(".bn-inline-content")!, key("z", { ctrlKey: true }));
    expect(e.defaultPrevented).toBe(false);
  });

  it.each([
    ["a dialog", '<div role="dialog"></div>'],
    ["an alert dialog", '<div role="alertdialog"></div>'],
    ["a menu", '<div role="menu"></div>'],
    ["a listbox", '<div role="listbox"></div>'],
    ["the AI box", '<div role="region" data-kb-ai-box=""></div>'],
    ["the custom color panel", '<div class="kb-color-panel"></div>'],
  ])("%s is open: no undo, no preventDefault", (_label, html) => {
    const { editor } = setup();
    addElement(html);
    const e = press(document.body, key("z", { ctrlKey: true }));
    expect(e.defaultPrevented).toBe(false);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("during IME composition: no undo, no preventDefault", () => {
    const { editor } = setup();
    const e = press(document.body, key("z", { ctrlKey: true, isComposing: true }));
    expect(e.defaultPrevented).toBe(false);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("event already handled (defaultPrevented): no undo", () => {
    const { editor } = setup();
    const e = key("z", { ctrlKey: true });
    e.preventDefault();
    expect(pageUndoYields(e)).toBe(true);
    press(document.body, e);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("read-only: no undo, no preventDefault", () => {
    const { editor } = setup();
    editor.isEditable = false;
    const e = press(document.body, key("z", { ctrlKey: true }));
    expect(e.defaultPrevented).toBe(false);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("disabled by the caller (presentation mode, version preview): no undo; undoes again once re-enabled", () => {
    const { editor, setEnabled } = setup({ enabled: false });
    expect(press(document.body, key("z", { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
    setEnabled(true);
    expect(press(document.body, key("z", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:y");
  });

  it("selection is a NodeSelection of the block the undo will move away: undo throws nothing and the document is restored (same failure as #428)", () => {
    const { editor, view, manager } = setup();
    editor.insertBlocks([P("n", "n1")], "y1", "after");
    manager.stopCapturing();
    const Sel = (() => {
      let base = view.state.selection.constructor;
      for (let p = Object.getPrototypeOf(base); p && p !== Function.prototype; p = Object.getPrototypeOf(base)) base = p;
      return base;
    })();
    view.dispatch(view.state.tr.setSelection(Sel.fromJSON(view.state.doc, { type: "node", anchor: blockPos(editor, "n1") })));
    expect(view.state.selection.toJSON().type).toBe("node"); // precondition
    view.dom.blur();
    expect(() => press(document.body, key("z", { ctrlKey: true }))).not.toThrow();
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });
});
