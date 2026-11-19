import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { YDOC_FRAGMENT, canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager } from "@/collab/undo";
import { Toaster } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";

// The toolbar row. A real editor (collab setup, built like collab/undo.test.tsx) plus BlockNoteView.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

const note = (id: string, title: string, slug: string): NoteDto => ({
  id, title, slug, ownerId: "u1", role: "owner", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  slugIsCustom: false, prevSlug: null, ownerHandle: "tester", lastEdited: null, group: null, groupId: null, folderId: null, permissions: OWNER_PERMS,
});
const TARGET = note("22222222-2222-4222-8222-222222222222", "Target", "target");
const OTHER = note("33333333-3333-4333-8333-333333333333", "Other Note", "other-note");

function LocationProbe() {
  const l = useLocation();
  return <p data-testid="loc">{`${l.pathname}${l.hash}`}</p>;
}

/** `second`: puts a second wikilink pointing at OTHER in the same paragraph (for the "click B while A is open" case). There is also an input outside the editor (for the "click outside lands on a focusable element" case). */
async function mount(props: Record<string, string>, notes: NoteDto[] = [TARGET, OTHER], second = false) {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: { provider: { awareness: undefined }, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { id: "u1", name: "U", color: "#123456" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's options type requires the full schema triple
    } as any),
  ) as AnyEditor;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["notes"], notes);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/start"]}>
        <input aria-label="Outside" />
        <BlockNoteView editor={editor} editable />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const wikilinkB = { type: "wikilink", props: { targetNoteId: OTHER.id, snapshotTitle: "Other Note", label: "", anchorBlockId: "" } };
  await act(async () => {
    editor.replaceBlocks(editor.document, [
      {
        type: "paragraph",
        content: [
          "see ",
          { type: "wikilink", props: { targetNoteId: TARGET.id, snapshotTitle: "Target", label: "", anchorBlockId: "", ...props } },
          ...(second ? [" and ", wikilinkB] : []),
          " end",
        ],
      },
    ]);
  });
  return { doc, editor };
}

function wikilinkProps(editor: AnyEditor): Record<string, string> | undefined {
  const node = (editor.document[0]!.content as Array<{ type: string; props?: Record<string, string> }>).find((n) => n.type === "wikilink");
  return node?.props;
}
const editorHasFocus = (editor: AnyEditor) => editor._tiptapEditor.view.dom.contains(document.activeElement);
const MOUSE = { pointerType: "mouse" } as const;
const TOUCH = { pointerType: "touch", clientX: 10, clientY: 10 } as const;
const queryToolbar = () => screen.queryByRole("dialog", { name: "Note link" });
/** Mouse hover: the open delay is 250 ms, which `findByRole`'s wait covers. */
async function openToolbar(name: string) {
  fireEvent.pointerEnter(screen.getByRole("link", { name }), MOUSE);
  return screen.findByRole("dialog", { name: "Note link" });
}
/** Yields real timers for a while (Radix's pointerdown listener and FocusScope's unmount focus handling both run in setTimeout(0)). */
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
/** Must unmount even when an assertion fails: first RTL `cleanup()` unmounts the React root, then leftover portals in body are cleared. */
function teardown() {
  cleanup();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
}

describe("#269 wikilink mini toolbar (opens on hover / touch long-press; a click navigates directly)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });
  afterEach(teardown);

  it("a plain click in edit mode: navigates straight to canonical and opens no toolbar", async () => {
    await mount({});
    expect(fireEvent.click(screen.getByRole("link", { name: "Target" }))).toBe(false);
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(canonicalNotePath(TARGET)));
    await settle(300);
    expect(queryToolbar()).not.toBeInTheDocument();
  });

  it("mouse hover: the toolbar appears only after a delay and does not take focus; it has only the edit text / change target / remove link buttons (no Open)", async () => {
    await mount({});
    fireEvent.pointerEnter(screen.getByRole("link", { name: "Target" }), MOUSE);
    await settle(100);
    expect(queryToolbar()).not.toBeInTheDocument();
    const dialog = await screen.findByRole("dialog", { name: "Note link" });
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Edit text", "Change target", "Remove link"]);
    expect(dialog.contains(document.activeElement)).toBe(false);
    expect(screen.getByTestId("loc").textContent).toBe("/start");
  });

  it("a touch pointerenter does not count as hover (no toolbar)", async () => {
    await mount({});
    fireEvent.pointerEnter(screen.getByRole("link", { name: "Target" }), TOUCH);
    await settle(400);
    expect(queryToolbar()).not.toBeInTheDocument();
  });

  it("leaving the link: closes after a delay without pulling focus into the editor; moving into the toolbar does not close it, and leaving the toolbar does", async () => {
    const { editor } = await mount({});
    const link = screen.getByRole("link", { name: "Target" });
    let dialog = await openToolbar("Target");
    fireEvent.pointerLeave(link, MOUSE);
    fireEvent.pointerEnter(dialog, MOUSE);
    await settle(400);
    expect(queryToolbar()).toBeInTheDocument();
    fireEvent.pointerLeave(dialog, MOUSE);
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    await settle(20);
    expect(editorHasFocus(editor)).toBe(false);

    dialog = await openToolbar("Target");
    fireEvent.pointerLeave(link, MOUSE);
    await settle(100);
    expect(queryToolbar()).toBeInTheDocument(); // closing also has a delay (time for the mouse to reach the toolbar)
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
  });

  it("moving the mouse out does not close the toolbar while it holds focus (text is being edited)", async () => {
    await mount({});
    const dialog = await openToolbar("Target");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
    expect(within(dialog).getByRole("textbox", { name: "Link text" })).toHaveFocus();
    fireEvent.pointerLeave(dialog, MOUSE);
    await settle(500);
    expect(queryToolbar()).toBeInTheDocument();
  });

  it("edit text: the current label is prefilled and submitting writes it back; an all-blank submit clears the label; focus returns to the editor after closing", async () => {
    const { editor } = await mount({ label: "Old label" });
    let dialog = await openToolbar("Old label");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
    const input = within(dialog).getByRole("textbox", { name: "Link text" });
    expect(input).toHaveValue("Old label");
    fireEvent.change(input, { target: { value: " New label " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(wikilinkProps(editor)?.label).toBe(" New label "));
    await waitFor(() => expect(editorHasFocus(editor)).toBe(true));

    dialog = await openToolbar("New label"); // the accessible name trims leading and trailing whitespace
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Link text" }), { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(wikilinkProps(editor)?.label).toBe(""));
  });

  it("change target: filter by title, and choosing one replaces targetNoteId / snapshotTitle, clears anchorBlockId and keeps the label", async () => {
    const { editor } = await mount({ label: "Keep", anchorBlockId: "b1" });
    const dialog = await openToolbar("Keep");
    fireEvent.click(within(dialog).getByRole("button", { name: "Change target" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Find a note" }), { target: { value: "other" } });
    expect(within(dialog).queryByRole("button", { name: "Target" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Other Note" }));
    await waitFor(() =>
      expect(wikilinkProps(editor)).toEqual({ targetNoteId: OTHER.id, snapshotTitle: "Other Note", label: "Keep", anchorBlockId: "" }),
    );
  });

  it("remove link: the node becomes plain text (the text is the current title, not snapshotTitle) with no link mark; focus returns to the editor", async () => {
    const { editor } = await mount({ snapshotTitle: "Old" });
    const dialog = await openToolbar("Target");
    const remove = within(dialog).getByRole("button", { name: "Remove link" });
    fireEvent.pointerDown(remove, MOUSE); // a real click has a pointerdown first: it counts as having interacted inside the toolbar, so focus returns to the editor after closing
    fireEvent.click(remove);
    await waitFor(() => expect(editor.document[0]!.content).toEqual([{ type: "text", text: "see Target end", styles: {} }]));
    await waitFor(() => expect(editorHasFocus(editor)).toBe(true));
  });

  it("editor not focused when opened: after removing the link or saving text focus returns to the editor and the cursor lands where the link was (not at the editor's old selection)", async () => {
    const { editor } = await mount({});
    const tt = editor._tiptapEditor;
    const wikilinkPos = () => {
      let at = -1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the ProseMirror Node type is not available at value level in apps/web
      tt.state.doc.descendants((n: any, pos: number) => {
        if (n.type.name === "wikilink") at = pos;
        return true;
      });
      return at;
    };
    act(() => {
      tt.commands.setTextSelection(1); // the editor's old selection is near the start of the document
    });
    const pos = wikilinkPos();
    let dialog = await openToolbar("Target");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Link text" }), { target: { value: "L" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(editorHasFocus(editor)).toBe(true));
    expect(tt.state.selection.from).toBe(pos + 1);

    act(() => {
      tt.commands.setTextSelection(1);
      (document.activeElement as HTMLElement).blur();
    });
    dialog = await openToolbar("L");
    const remove = within(dialog).getByRole("button", { name: "Remove link" });
    fireEvent.pointerDown(remove, MOUSE);
    fireEvent.click(remove);
    await waitFor(() => expect(editor.document[0]!.content).toEqual([{ type: "text", text: "see L end", styles: {} }]));
    await waitFor(() => expect(editorHasFocus(editor)).toBe(true));
    expect(tt.state.selection.from).toBe(pos + "L".length);
  });

  it("editor focused when opened: after saving text or removing the link the cursor stays where the user had it (not moved)", async () => {
    const { editor } = await mount({});
    const tt = editor._tiptapEditor;
    act(() => {
      tt.commands.setTextSelection(2);
      editor.focus();
    });
    const before = tt.state.selection.from;
    const dialog = await openToolbar("Target");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Link text" }), { target: { value: "L" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(editorHasFocus(editor)).toBe(true));
    expect(tt.state.selection.from).toBe(before);

    act(() => editor.focus());
    const dialog2 = await openToolbar("L");
    const remove = within(dialog2).getByRole("button", { name: "Remove link" });
    fireEvent.pointerDown(remove, MOUSE);
    fireEvent.click(remove);
    await waitFor(() => expect(editor.document[0]!.content).toEqual([{ type: "text", text: "see L end", styles: {} }]));
    expect(tt.state.selection.from).toBe(before); // the cursor is before the link, so the replacement does not affect its position
  });

  it("remove link: other styles on the wikilink (bold) stay on the text and only the link is dropped", async () => {
    const { editor } = await mount({});
    const tt = editor._tiptapEditor;
    let from = -1;
    let to = -1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the ProseMirror Node type is not available at value level in apps/web
    tt.state.doc.descendants((n: any, pos: number) => {
      if (n.type.name === "paragraph") {
        from = pos + 1;
        to = pos + 1 + n.content.size;
      }
      return true;
    });
    act(() => {
      tt.commands.setTextSelection({ from, to });
      editor.addStyles({ bold: true });
    });
    await screen.findByRole("link", { name: "Target" }); // after the mark is added the node view is rebuilt and the React content is filled in asynchronously
    const dialog = await openToolbar("Target");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(editor.document[0]!.content).toEqual([{ type: "text", text: "see Target end", styles: { bold: true } }]));
  });

  it("broken link: hover also shows the toolbar (to make changing or removing easy); a click only toasts and does not navigate", async () => {
    await mount({ snapshotTitle: "Gone" }, [OTHER]);
    const span = screen.getByText("Gone");
    fireEvent.pointerEnter(span, MOUSE);
    const dialog = await screen.findByRole("dialog", { name: "Note link" });
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Edit text", "Change target", "Remove link"]);
    fireEvent.click(span);
    expect(await screen.findByText("This linked note no longer exists.")).toBeInTheDocument();
    expect(screen.getByTestId("loc").textContent).toBe("/start");
  });

  it("editor focused when opened: Esc closes -> focus returns to the editor; clicking outside (pointerdown on body) closes -> focus returns to the editor", async () => {
    const { editor } = await mount({});
    act(() => editor.focus());
    let dialog = await openToolbar("Target");
    act(() => (document.activeElement as HTMLElement).blur()); // focus is pulled back only when it landed on body (nowhere to go)
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    expect(editorHasFocus(editor)).toBe(true);
    dialog = await openToolbar("Target");
    act(() => (document.activeElement as HTMLElement).blur());
    // Plays the real click event sequence (@radix-ui/react-dismissable-layer dist/index.mjs): after opening, the document pointerdown listener is attached inside setTimeout(0)
    // (a real click outside is always later than that tick); Popover carries `deferPointerDownOutside`, so a left-button click outside closes only on the click of the same press.
    await settle();
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
    fireEvent.click(document.body);
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    expect(editorHasFocus(editor)).toBe(true);
  });

  it("editor not focused when opened and no interaction inside the toolbar: closing with Esc or a click outside does not pull focus into the editor (so a phone does not raise the virtual keyboard)", async () => {
    const { editor } = await mount({});
    let dialog = await openToolbar("Target");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    await settle(20);
    expect(editorHasFocus(editor)).toBe(false);

    const link = screen.getByRole("link", { name: "Target" });
    fireEvent.pointerDown(link, TOUCH);
    await settle(600);
    fireEvent.pointerUp(link, TOUCH);
    dialog = await screen.findByRole("dialog", { name: "Note link" });
    await settle();
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "touch" });
    fireEvent.click(document.body);
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    await settle(20);
    expect(editorHasFocus(editor)).toBe(false);
  });

  it("a click outside that lands on a focusable element (an input outside the editor): after closing focus stays there and is not pulled back to the editor", async () => {
    await mount({});
    await openToolbar("Target");
    await settle();
    const outside = screen.getByRole("textbox", { name: "Outside" });
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    act(() => outside.focus()); // the default behavior of a real mousedown: focus moves to the clicked input
    fireEvent.click(outside);
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    await settle(20); // FocusScope's focus handling on unmount runs in setTimeout(0)
    expect(document.activeElement).toBe(outside);
  });

  it("mouse moves to B while A's toolbar is open: A closes and only B's toolbar remains", async () => {
    await mount({}, [TARGET, OTHER], true);
    await openToolbar("Target");
    fireEvent.pointerLeave(screen.getByRole("link", { name: "Target" }), MOUSE);
    fireEvent.pointerEnter(screen.getByRole("link", { name: "Other Note" }), MOUSE);
    await settle(500);
    const dialogs = screen.getAllByRole("dialog", { name: "Note link" });
    expect(dialogs).toHaveLength(1);
    fireEvent.click(within(dialogs[0]!).getByRole("button", { name: "Edit text" }));
    expect(within(dialogs[0]!).getByRole("textbox", { name: "Link text" })).toHaveAttribute("placeholder", "Other Note");
  });

  it("touch long-press of about 500 ms: the toolbar appears; the click re-dispatched after the long-press is blocked (no navigation); the next short press navigates as usual", async () => {
    await mount({});
    const link = screen.getByRole("link", { name: "Target" });
    fireEvent.pointerDown(link, TOUCH);
    await settle(300);
    expect(queryToolbar()).not.toBeInTheDocument();
    await settle(300);
    expect(queryToolbar()).toBeInTheDocument();
    fireEvent.pointerUp(link, TOUCH);
    expect(fireEvent.mouseDown(link)).toBe(false); // the re-dispatched mousedown is also blocked (so ProseMirror does not move the cursor or steal focus and close the toolbar)
    expect(fireEvent.click(link)).toBe(false);
    await settle(50);
    expect(screen.getByTestId("loc").textContent).toBe("/start");
    expect(queryToolbar()).toBeInTheDocument();

    fireEvent.pointerDown(link, TOUCH);
    fireEvent.pointerUp(link, TOUCH);
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(canonicalNotePath(TARGET)));
  });

  it("touch short press: navigates and opens no toolbar", async () => {
    await mount({});
    const link = screen.getByRole("link", { name: "Target" });
    fireEvent.pointerDown(link, TOUCH);
    await settle(100);
    fireEvent.pointerUp(link, TOUCH);
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(canonicalNotePath(TARGET)));
    await settle(600);
    expect(queryToolbar()).not.toBeInTheDocument();
  });

  it("finger moves past the threshold during a long-press: cancelled (no toolbar); a small jitter does not cancel", async () => {
    await mount({});
    const link = screen.getByRole("link", { name: "Target" });
    fireEvent.pointerDown(link, TOUCH);
    fireEvent.pointerMove(link, { ...TOUCH, clientX: 30 });
    await settle(600);
    expect(queryToolbar()).not.toBeInTheDocument();
    fireEvent.pointerUp(link, TOUCH);

    fireEvent.pointerDown(link, TOUCH);
    fireEvent.pointerMove(link, { ...TOUCH, clientX: 13, clientY: 12 });
    await settle(600);
    expect(queryToolbar()).toBeInTheDocument();
  });

  it("editable: a contextmenu during a touch press (Android long-press) is preventDefault-ed and shows the toolbar at once; a mouse right-click contextmenu is not intercepted", async () => {
    await mount({});
    const link = screen.getByRole("link", { name: "Target" });
    fireEvent.pointerDown(link, { pointerType: "mouse", button: 2 });
    expect(fireEvent.contextMenu(link)).toBe(true);
    fireEvent.pointerUp(link, { pointerType: "mouse", button: 2 });
    expect(queryToolbar()).not.toBeInTheDocument();

    fireEvent.pointerDown(link, TOUCH);
    expect(fireEvent.contextMenu(link)).toBe(false);
    await settle(50); // takes effect at once without waiting for the 500 ms timer
    expect(queryToolbar()).toBeInTheDocument();
    fireEvent.pointerUp(link, TOUCH);
    expect(fireEvent.click(link)).toBe(false);
    expect(screen.getByTestId("loc").textContent).toBe("/start");
  });
});

/**
 * One Ctrl+Z (UndoManager.undo) reverts each toolbar action. `stopCapturing()` runs before each action (= the user pausing for more than 500 ms)
 * so the rule's own semantics are exercised; no fake timers.
 */
const MEASURED = { editText: true, changeTarget: true, remove: true } as const;

describe("#269 undo of toolbar actions", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });
  afterEach(teardown);

  for (const action of ["editText", "changeTarget", "remove"] as const) {
    it(`${action}: one undo reverts it: ${String(MEASURED[action])}`, async () => {
      const { editor } = await mount({ label: "L" });
      const before = JSON.stringify(editor.document[0]!.content);
      collabUndoManager(editor)!.stopCapturing();
      const dialog = await openToolbar("L");
      if (action === "editText") {
        fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
        fireEvent.change(within(dialog).getByRole("textbox", { name: "Link text" }), { target: { value: "M" } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      } else if (action === "changeTarget") {
        fireEvent.click(within(dialog).getByRole("button", { name: "Change target" }));
        fireEvent.click(within(dialog).getByRole("button", { name: "Other Note" }));
      } else {
        fireEvent.click(within(dialog).getByRole("button", { name: "Remove link" }));
      }
      await waitFor(() => expect(JSON.stringify(editor.document[0]!.content)).not.toBe(before));
      act(() => {
        collabUndoManager(editor)!.undo();
      });
      expect(JSON.stringify(editor.document[0]!.content) === before).toBe(MEASURED[action]);
    });
  }
});
