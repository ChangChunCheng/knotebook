import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { TableHandlesExtension } from "@blocknote/core/extensions";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { buildCollabEditorBase, NOTE_TABLE_SETTINGS } from "@/collab/editor-options";
import { resetCustomColorsForTest } from "@/lib/custom-colors";
import { resetRecentColorsForTest } from "@/lib/recent-colors";
import { renderAiHost, type AnyEditor } from "@/test/ai-host";

// Table cell handle and row/column handles: the "Colors" submenu in the menu gains "Custom...", which swaps the root menu's dropdown for the custom color panel.
// Always mounts the real `NoteEditorView` (`renderAiHost`); the handles are drawn by the `TableHandlesController` wired up in `NoteEditor.tsx`, and building a
// BlockNoteView by hand would not test that wiring. The table handle state comes from a real mousemove so TableHandlesExtension computes it itself: it looks upward
// from the event target for a cell, which jsdom's lack of layout does not affect. The SideMenu and column-resize plugin use elementsFromPoint/elementFromPoint
// (missing in jsdom) on the same mousemove, so each gets a stub returning that cell's text, removed after every case.

type CellLike = { type: "tableCell"; props: Record<string, string>; content: { type: "text"; text: string; styles: Record<string, never> }[] };

const cell = (text: string, props: Record<string, string> = {}): CellLike => ({
  type: "tableCell",
  props,
  content: [{ type: "text", text, styles: {} }],
});

/** 2x2 table `t1`: (0,0)=a1, (0,1)=b1, (1,0)=a2, (1,1)=b2; the first row's two cells can carry extra props. */
function table(row0Props: [Record<string, string>, Record<string, string>] = [{}, {}]) {
  return {
    id: "t1",
    type: "table",
    content: {
      type: "tableContent",
      rows: [{ cells: [cell("a1", row0Props[0]), cell("b1", row0Props[1])] }, { cells: [cell("a2"), cell("b2")] }],
    },
  };
}

function mount(row0Props?: [Record<string, string>, Record<string, string>]): AnyEditor {
  const editor = BlockNoteEditor.create({
    schema: noteSchema,
    tables: NOTE_TABLE_SETTINGS,
    initialContent: [{ id: "p0", type: "paragraph", content: "top" }, table(row0Props)] as never,
  }) as AnyEditor;
  renderAiHost({ editor });
  return editor;
}

type Cell = { props: Record<string, string>; content: { text: string }[] };
function cellAt(editor: AnyEditor, r: number, c: number): Cell {
  const t = editor.getBlock("t1")!.content as unknown as { rows: { cells: Cell[] }[] };
  return t.rows[r]!.cells[c]!;
}
const cellText = (editor: AnyEditor, r: number, c: number) => cellAt(editor, r, c).content.map((x) => x.text).join("");

const cellHandles = () => Array.from(document.querySelectorAll<HTMLElement>("button.bn-table-cell-handle"));
// The row handle and the column handle are the same component; the column handle is rotated 90 degrees with a transform
const rowHandle = () => Array.from(document.querySelectorAll<HTMLElement>(".bn-table-handle")).find((el) => !el.style.transform) ?? null;
const tableMenu = () => document.querySelector<HTMLElement>(".bn-table-handle-menu");
/**
 * The root menu dropdown of a given handle (Mantine's trigger points to it via aria-controls). After a cell menu has been opened, during the row handle overlay's
 * fade-out BlockNote shows an HTML copy of what it last showed open (possibly including the just-closed row menu); querying by class would find that copy first.
 */
const menuOf = (trigger: HTMLElement) => document.getElementById(trigger.getAttribute("aria-controls") ?? "");
const colorsItem = () => document.querySelector<HTMLElement>('[data-kb-color-return="tbl-colors"]');
const item = (test: string) => document.querySelector<HTMLElement>(`[data-test="${test}"]`);
const panel = () => document.querySelector<HTMLElement>(".bn-table-handle-menu .kb-color-panel");
const hexInput = () => screen.getByRole("textbox", { name: "Hex color", hidden: true }) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name, hidden: true }) as HTMLButtonElement;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
/** A Menu.Item that is checked has a tick svg on the right; unchecked has a `.bn-tick-space` placeholder. */
const isChecked = (el: Element) => el.querySelector(".bn-tick-space") === null && el.querySelector("svg") !== null;

/** Moves the mouse over the cell whose text is `text` and waits for the handle to appear. */
async function hoverCell(editor: AnyEditor, text: string): Promise<void> {
  const el = screen.getByText(text);
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [el] });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => el });
  act(() => {
    fireEvent.mouseMove(el, { clientX: 0, clientY: 0 });
  });
  expect(editor.getExtension(TableHandlesExtension)!.store.state?.block?.id).toBe("t1");
  await waitFor(() => expect(rowHandle()).not.toBeNull());
}

/**
 * Clicks the handle to open the root menu, waits for this handle's own dropdown to mount, and lets the initial focus timer Mantine schedules run out.
 * Wait on `menuOf(trigger)`, not on any `.bn-table-handle-menu`: the HTML copy a fading-out handle leaves also has that class and would satisfy the wait
 * before the handle's own dropdown mounts.
 */
async function openMenu(trigger: HTMLElement): Promise<void> {
  fireEvent.click(trigger);
  await waitFor(() => expect(menuOf(trigger)).not.toBeNull());
  await wait(0);
}

/** Opens the submenu from "Colors" with the keyboard (right arrow) and waits for "Custom..." to appear. */
async function openColorsSub(): Promise<void> {
  const colors = colorsItem()!;
  colors.focus();
  fireEvent.keyDown(colors, { key: "ArrowRight" });
  await waitFor(() => expect(item("text-color-custom") ?? item("background-color-custom")).not.toBeNull());
}

/** The section's "Custom..." in the submenu (`detail` 0 = keyboard activation, the hex field gets focus); waits for the panel to mount. */
async function clickCustom(section: "text" | "background"): Promise<void> {
  fireEvent.click(item(`${section}-color-custom`)!, { detail: 0 });
  await waitFor(() => expect(panel()).not.toBeNull());
}

/** Root menu is closed: dropdown absent; if the handle is still there, aria-expanded is false (applying a color may collapse the handle entirely). */
async function expectMenuClosed(trigger: () => HTMLElement | null | undefined): Promise<void> {
  await waitFor(() => {
    expect(tableMenu()).toBeNull();
    expect(trigger()?.getAttribute("aria-expanded") ?? "false").toBe("false");
  });
}

/**
 * Someone else changes the text at (r,c) to `text`: rebuilds rows from the current table, replaces only that cell's content, then `updateBlock` on the whole table.
 * In a single editor this does not replace the table's block element, so the handle's state and the open panel stay.
 */
function remoteSetCellText(editor: AnyEditor, r: number, c: number, text: string): void {
  const block = editor.getBlock("t1")!;
  const t = block.content as unknown as { rows: { cells: object[] }[] };
  const rows = t.rows.map((row, ri) => ({
    ...row,
    cells: row.cells.map((x, ci) => (ri === r && ci === c ? { ...x, content: [{ type: "text", text, styles: {} }] } : x)),
  }));
  act(() => {
    editor.updateBlock(block, { type: "table", content: { ...t, rows } } as never);
  });
}

beforeEach(async () => {
  localStorage.clear();
  resetRecentColorsForTest();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  resetCustomColorsForTest();
  Reflect.deleteProperty(document, "elementsFromPoint");
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("table handle color menu", () => {
  it("the editor wires up our own table handles: moving over a cell shows a single cell handle whose menu is ours (only Colors)", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await waitFor(() => expect(cellHandles().length).toBeGreaterThan(0));
    await wait(50);
    expect(cellHandles()).toHaveLength(1);
    const cellTrigger = cellHandles()[0]!;
    await openMenu(cellTrigger);
    const menu = menuOf(cellTrigger)!;
    expect(within(menu).getAllByRole("menuitem", { hidden: true }).map((el) => el.textContent)).toEqual(["Colors"]);
    expect(within(menu).queryByText("Split cell")).toBeNull();
    expect(colorsItem()).not.toBeNull();
  });

  it("row handle menu: Delete row, Add row above, Add row below, Colors, no header row/column toggle", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    const rowTrigger = rowHandle()!;
    await openMenu(rowTrigger);
    const texts = within(menuOf(rowTrigger)!)
      .getAllByRole("menuitem", { hidden: true })
      .map((el) => el.textContent);
    expect(texts).toEqual(["Delete row", "Add row above", "Add row below", "Colors"]);
    expect(screen.queryByText("Header row")).toBeNull();
    expect(screen.queryByText("Header column")).toBeNull();
  });

  it("the row handle's dropdown has bn-table-handle-menu and not bn-menu-dropdown; the cell menu has both", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    const rowTrigger = rowHandle()!;
    await openMenu(rowTrigger);
    const rowMenu = menuOf(rowTrigger)!;
    expect(rowMenu.classList.contains("bn-table-handle-menu")).toBe(true);
    expect(rowMenu.classList.contains("bn-menu-dropdown")).toBe(false);
    fireEvent.keyDown(rowMenu, { key: "Escape" });
    await expectMenuClosed(rowHandle);
    await wait(400);
    await hoverCell(editor, "a1");
    const trigger = cellHandles()[0]!;
    await openMenu(trigger);
    const cellMenu = menuOf(trigger)!;
    expect(cellMenu).toHaveTextContent(/^Colors$/);
    expect(cellMenu.classList.contains("bn-table-handle-menu")).toBe(true);
    expect(cellMenu.classList.contains("bn-menu-dropdown")).toBe(true);
  });

  it("cell menu Colors -> Background red: that cell's background is red, other cells unchanged", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    const trigger = cellHandles()[0]!;
    await openMenu(trigger);
    await openColorsSub();
    fireEvent.click(item("background-color-red")!);
    expect(cellAt(editor, 0, 0).props.backgroundColor).toBe("red");
    expect(cellAt(editor, 0, 1).props.backgroundColor).toBe("default");
    await expectMenuClosed(() => cellHandles()[0]);
  });

  it("row whose two cells have different text colors: the row's Colors submenu has \"Auto\" checked and \"Custom...\" unchecked", async () => {
    const editor = mount([{ textColor: "#ff6600" }, { textColor: "red" }]);
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    await openColorsSub();
    expect(isChecked(item("text-color-default")!)).toBe(true);
    expect(isChecked(item("text-color-custom")!)).toBe(false);
    expect(isChecked(item("text-color-red")!)).toBe(false);
    expect(isChecked(item("background-color-default")!)).toBe(true);
  });

  it("row whose two cells both have #ff6600 text: the row's Colors submenu has \"Custom...\" checked and \"Auto\" unchecked", async () => {
    const editor = mount([{ textColor: "#ff6600" }, { textColor: "#ff6600" }]);
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    await openColorsSub();
    expect(isChecked(item("text-color-custom")!)).toBe(true);
    expect(isChecked(item("text-color-default")!)).toBe(false);
  });

  it("cell background is #ff6600: the cell's Colors submenu background section has \"Custom...\" checked and \"Auto\" unchecked", async () => {
    const editor = mount([{ backgroundColor: "#ff6600" }, {}]);
    await hoverCell(editor, "a1");
    await openMenu(cellHandles()[0]!);
    await openColorsSub();
    expect(isChecked(item("background-color-custom")!)).toBe(true);
    expect(isChecked(item("background-color-default")!)).toBe(false);
  });

  it("cell Custom...: the root menu stays open and focus is in the panel; Back returns to the item list with focus on Colors; Custom... again and applying #ff6600 colors the cell and closes the menu", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    const trigger = cellHandles()[0]!;
    await openMenu(trigger);
    await openColorsSub();
    await clickCustom("background");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel()!.contains(document.activeElement)).toBe(true);
    fireEvent.click(button("Back"));
    await waitFor(() => expect(document.activeElement).toBe(colorsItem()));
    expect(panel()).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await openColorsSub();
    await clickCustom("background");
    fireEvent.change(hexInput(), { target: { value: "#ff6600" } });
    fireEvent.click(button("Apply"));
    expect(cellAt(editor, 0, 0).props.backgroundColor).toBe("#ff6600");
    expect(cellAt(editor, 1, 1).props.backgroundColor).toBe("default");
    await expectMenuClosed(() => cellHandles()[0]);
  });

  it("the editor option `tables` is NOTE_TABLE_SETTINGS: cell text color and background enabled, no splitCells or headers", () => {
    const base = buildCollabEditorBase({ doc: new Y.Doc(), awareness: undefined, language: "en", user: { name: "alice", color: "#888888" } });
    expect(base.tables).toBe(NOTE_TABLE_SETTINGS);
    expect(base.tables).toEqual({ cellTextColor: true, cellBackgroundColor: true });
    expect(Object.keys(base.tables).sort()).toEqual(["cellBackgroundColor", "cellTextColor"]);
  });

  it("someone else edits the text of (0,0) while the cell panel is open, then Apply #ff6600: (0,0) has the new text and the cell is colored", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    const trigger = cellHandles()[0]!;
    await openMenu(trigger);
    await openColorsSub();
    await clickCustom("background");
    remoteSetCellText(editor, 0, 0, "remote");
    expect(cellText(editor, 0, 0)).toBe("remote");
    await wait(50);
    expect(panel()).not.toBeNull();
    fireEvent.change(hexInput(), { target: { value: "#ff6600" } });
    fireEvent.click(button("Apply"));
    expect(cellText(editor, 0, 0)).toBe("remote");
    expect(cellAt(editor, 0, 0).props.backgroundColor).toBe("#ff6600");
    await expectMenuClosed(() => cellHandles()[0]);
  });

  it("someone else edits the text of (0,0) while the row handle panel is open, then Apply #ff6600: (0,0) has the new text and the whole row's text color is #ff6600", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    await openColorsSub();
    await clickCustom("text");
    remoteSetCellText(editor, 0, 0, "remote");
    expect(cellText(editor, 0, 0)).toBe("remote");
    await wait(50);
    expect(panel()).not.toBeNull();
    fireEvent.change(hexInput(), { target: { value: "#ff6600" } });
    fireEvent.click(button("Apply"));
    expect(cellText(editor, 0, 0)).toBe("remote");
    expect(cellAt(editor, 0, 0).props.textColor).toBe("#ff6600");
    expect(cellAt(editor, 0, 1).props.textColor).toBe("#ff6600");
    expect(cellAt(editor, 1, 0).props.textColor).toBe("default");
    await expectMenuClosed(rowHandle);
  });

  it("row handle Custom...: the root menu stays open and focus is in the panel; Back focuses Colors; closing and reopening shows the item list; Custom... applying #0000ff sets the row's text color and closes the menu", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    await openColorsSub();
    await clickCustom("text");
    expect(rowHandle()).toHaveAttribute("aria-expanded", "true");
    expect(panel()!.contains(document.activeElement)).toBe(true);
    fireEvent.click(button("Back"));
    await waitFor(() => expect(document.activeElement).toBe(colorsItem()));
    expect(panel()).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await expectMenuClosed(rowHandle);
    await wait(400);
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    expect(panel()).toBeNull();
    expect(colorsItem()).not.toBeNull();
    expect(screen.getByText("Delete row")).toBeInTheDocument();
    await openColorsSub();
    await clickCustom("text");
    fireEvent.change(hexInput(), { target: { value: "#0000ff" } });
    fireEvent.click(button("Apply"));
    expect(cellAt(editor, 0, 0).props.textColor).toBe("#0000ff");
    expect(cellAt(editor, 0, 1).props.textColor).toBe("#0000ff");
    expect(cellAt(editor, 1, 1).props.textColor).toBe("default");
    await expectMenuClosed(rowHandle);
  });

  // The table handle's menu sits inside Mantine Menu's own focus trap, but that trap's ref is remembered through useMergedRef and does not change on re-render, so it does not refocus.
  // The formatting toolbar differs: it rebuilds the merged ref on every render, so the trap remounts and steals focus. These two cases pin that a document change
  // while the panel is open (the handle re-renders with it) does not steal focus from the hex field.
  it("while the cell panel is open a paragraph is added before the table: focus stays in the hex field, the panel stays open and the typed text remains", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await openMenu(cellHandles()[0]!);
    await openColorsSub();
    await clickCustom("background");
    const hex = hexInput();
    hex.focus();
    fireEvent.change(hex, { target: { value: "#ff6" } });
    await wait(20);
    expect(document.activeElement).toBe(hex);
    act(() => {
      editor.insertBlocks([{ type: "paragraph", content: "x" }], "p0", "before");
    });
    await wait(50);
    expect(document.activeElement).toBe(hex);
    expect(panel()).not.toBeNull();
    expect(hex.value).toBe("#ff6");
  });

  it("while the row handle panel is open another cell's text changes: focus stays in the hex field, the panel stays open and the typed text remains", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    await openColorsSub();
    await clickCustom("text");
    const hex = hexInput();
    hex.focus();
    fireEvent.change(hex, { target: { value: "#ff6" } });
    await wait(20);
    expect(document.activeElement).toBe(hex);
    remoteSetCellText(editor, 1, 1, "changed");
    await wait(50);
    expect(document.activeElement).toBe(hex);
    expect(panel()).not.toBeNull();
    expect(hex.value).toBe("#ff6");
  });
});
