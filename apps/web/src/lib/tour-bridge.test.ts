import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTourNoteEditor,
  getShellControls,
  notifyEditorEditable,
  onEditorEditable,
  registerEditor,
  registerShellControls,
  setTourTransactionFilter,
  type ShellControls,
  type TourEditor,
} from "./tour-bridge";
import { isTourTransactionFilterOn } from "@/collab/tour-filter-flag";

// The registry is module-level state: each case removes what it registered, so a failure does not affect the next case.
const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});
function keep(dispose: () => void): () => void {
  disposers.push(dispose);
  return dispose;
}

function shell(): ShellControls {
  return { showTab: vi.fn(), endSelectionIfActive: vi.fn(() => false), closeDrawer: vi.fn(), getTab: vi.fn(() => "myNotes" as const) };
}

/** The registry only hands the editor back without calling its methods, so distinct empty objects suffice as stand-ins. */
function fakeEditor(): TourEditor {
  return {} as TourEditor;
}

describe("tour-bridge: shell control", () => {
  it("register -> get -> unregister", () => {
    const a = shell();
    const unregister = registerShellControls(a);
    expect(getShellControls()).toBe(a);
    unregister();
    expect(getShellControls()).toBeNull();
  });

  it("A registers, B registers, A unregisters -> still get B; only after B unregisters is it empty", () => {
    const a = shell();
    const b = shell();
    const unregisterA = keep(registerShellControls(a));
    const unregisterB = keep(registerShellControls(b));
    expect(getShellControls()).toBe(b);
    unregisterA();
    expect(getShellControls()).toBe(b);
    unregisterB();
    expect(getShellControls()).toBeNull();
  });
});

describe("tour-bridge: editor", () => {
  it("register -> get -> unregister", () => {
    const editor = fakeEditor();
    const unregister = registerEditor("note-1", editor);
    expect(getTourNoteEditor("note-1")).toBe(editor);
    unregister();
    expect(getTourNoteEditor("note-1")).toBeNull();
  });

  it("A registers, B registers, A unregisters -> still get B; only after B unregisters is it empty", () => {
    const a = fakeEditor();
    const b = fakeEditor();
    const unregisterA = keep(registerEditor("note-1", a));
    const unregisterB = keep(registerEditor("note-1", b));
    expect(getTourNoteEditor("note-1")).toBe(b);
    unregisterA();
    expect(getTourNoteEditor("note-1")).toBe(b);
    unregisterB();
    expect(getTourNoteEditor("note-1")).toBeNull();
  });

  it("a passed id different from the registered one -> null (the registered one is still returned)", () => {
    const editor = fakeEditor();
    keep(registerEditor("note-1", editor));
    expect(getTourNoteEditor("other")).toBeNull();
    expect(getTourNoteEditor("note-1")).toBe(editor);
  });

  it("nothing registered -> null", () => {
    expect(getTourNoteEditor("note-1")).toBeNull();
  });

  it("notifies once per editor instance; notifies again for a different instance", () => {
    const fn = vi.fn();
    keep(onEditorEditable(fn));
    const a = fakeEditor();
    notifyEditorEditable("note-1", a);
    notifyEditorEditable("note-1", a);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("note-1", a);
    const b = fakeEditor();
    notifyEditorEditable("note-1", b);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("note-1", b);
  });

  it("a subscriber throwing -> not rethrown, logged to console, the next one still runs", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    keep(
      onEditorEditable(() => {
        throw boom;
      }),
    );
    const next = vi.fn();
    keep(onEditorEditable(next));
    const editor = fakeEditor();
    expect(() => notifyEditorEditable("note-1", editor)).not.toThrow();
    expect(next).toHaveBeenCalledWith("note-1", editor);
    expect(consoleError).toHaveBeenCalledWith(boom);
    consoleError.mockRestore();
  });

  it("not called after unsubscribing", () => {
    const fn = vi.fn();
    const off = onEditorEditable(fn);
    off();
    notifyEditorEditable("note-1", fakeEditor());
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("tour-bridge: transaction-filter switch for the feature tour", () => {
  /** The switch is stored on the tiptap editor instance, so a stand-in only needs a `_tiptapEditor` object. */
  function filterableEditor(): TourEditor {
    return { _tiptapEditor: {} } as unknown as TourEditor;
  }
  const isOn = (editor: TourEditor) => isTourTransactionFilterOn(editor._tiptapEditor);

  it("an id different from the registered one -> false, switch untouched; the same id -> true and the switch follows", () => {
    const editor = filterableEditor();
    keep(registerEditor("note-1", editor));
    expect(setTourTransactionFilter("other", true)).toBe(false);
    expect(isOn(editor)).toBe(false);
    expect(setTourTransactionFilter("note-1", true)).toBe(true);
    expect(isOn(editor)).toBe(true);
    expect(setTourTransactionFilter("note-1", false)).toBe(true);
    expect(isOn(editor)).toBe(false);
  });

  it("nothing registered -> false", () => {
    expect(setTourTransactionFilter("note-1", true)).toBe(false);
  });

  it("unregistering turns off its own switch", () => {
    const editor = filterableEditor();
    const unregister = registerEditor("note-1", editor);
    setTourTransactionFilter("note-1", true);
    unregister();
    expect(isOn(editor)).toBe(false);
  });

  it("A registers and turns on, B registers and turns on, A unregisters -> A's switch is off, B's stays on", () => {
    const a = filterableEditor();
    const b = filterableEditor();
    const unregisterA = keep(registerEditor("note-1", a));
    setTourTransactionFilter("note-1", true);
    keep(registerEditor("note-1", b));
    setTourTransactionFilter("note-1", true);
    unregisterA();
    expect(isOn(a)).toBe(false);
    expect(isOn(b)).toBe(true);
  });
});
