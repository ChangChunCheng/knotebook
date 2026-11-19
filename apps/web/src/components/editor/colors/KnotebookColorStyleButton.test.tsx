import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { REWRITE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SelectionAiController } from "@/components/ai/SelectionAiController";
import { installCustomColors, resetCustomColorsForTest } from "@/lib/custom-colors";
import { resetRecentColorsForTest } from "@/lib/recent-colors";
import { contentStart, createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { IMG, P } from "@/test/columns-fixtures";
import { layoutHostTrigger, waitForMenuShown } from "@/test/color-menu-host";

// The formatting toolbar's color button: besides the 10 built-in colors each section has one more "Custom...", which opens the custom color panel inside the same dropdown.
// Mounted like `AiToolbar.test.tsx`: the toolbar is mounted by `SelectionAiController` via `FormattingToolbarController`; select a run of text to make it appear.

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"];

beforeEach(async () => {
  localStorage.clear();
  resetRecentColorsForTest();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  resetCustomColorsForTest();
  vi.unstubAllGlobals();
});

function renderHost(editor: AnyEditor) {
  stubAiFetch({ actions: [REWRITE] });
  // The icon and preview use the block-kind selector, which production registers through a global observer; same order as `main.tsx`: install it first, then mount.
  installCustomColors(document.body);
  renderAiHost({ editor, children: <SelectionAiController /> });
}

/** Two blocks: `top` (p0) and `target text` (p1); p1's text can carry styles. After mounting, selects `target` in p1 and waits for the toolbar and the AI button to appear. */
async function mount(styles: Record<string, string> = {}): Promise<AnyEditor> {
  const editor = createTestEditor([
    { id: "p0", type: "paragraph", content: "top" },
    { id: "p1", type: "paragraph", content: [{ type: "text", text: "target text", styles }] },
  ]);
  renderHost(editor);
  selectInBlock(editor, "p1", 0, 6);
  // The AI button only appears after the action list loads; waiting for it keeps later steps from being interrupted by this toolbar re-render.
  await screen.findByRole("button", { name: "AI" });
  await waitFor(() => expect(colorsButton()).not.toBeNull());
  return editor;
}

const colorsButton = () => document.querySelector<HTMLElement>('.bn-formatting-toolbar [data-test="colors"]');
const dropdown = () => document.querySelector<HTMLElement>(".bn-formatting-toolbar .bn-color-picker-dropdown");
const panel = () => document.querySelector<HTMLElement>(".bn-formatting-toolbar .kb-color-panel");
const item = (test: string) => document.querySelector<HTMLElement>(`[data-test="${test}"]`)!;
const hexInput = () => screen.getByRole("textbox", { name: "Hex color", hidden: true }) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name, hidden: true }) as HTMLButtonElement;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/**
 * `.bn-toolbar` is `overflow-x: auto`, which floating-ui treats as the color button's clipping ancestor; in jsdom its box is 0x0, so the hide
 * middleware decides the color button is clipped and marks the dropdown display:none. Gives the toolbar a box that encloses the color button (call before opening the menu).
 */
function layoutToolbar(): () => void {
  const toolbar = document.querySelector<HTMLElement>(".bn-formatting-toolbar")!;
  toolbar.getBoundingClientRect = () => new DOMRect(90, 90, 400, 40);
  Object.defineProperty(toolbar, "clientWidth", { value: 400, configurable: true });
  Object.defineProperty(toolbar, "clientHeight", { value: 40, configurable: true });
  return () => {
    delete (toolbar as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    delete (toolbar as { clientWidth?: number }).clientWidth;
    delete (toolbar as { clientHeight?: number }).clientHeight;
  };
}

/** A Menu.Item with checked true has a tick svg on the right; false has a `.bn-tick-space` placeholder. */
const isChecked = (el: Element) => el.querySelector(".bn-tick-space") === null && el.querySelector("svg") !== null;

/** Current style of the `target` run at the start of p1. */
function targetStyles(editor: AnyEditor): Record<string, string> {
  const content = editor.getBlock("p1")!.content as Array<{ text: string; styles: Record<string, string> }>;
  return content.find((c) => c.text.startsWith("target"))!.styles;
}

/** Opens the color menu, waits for the dropdown to mount, and lets Mantine's initial focus timer run out (including the one after the toolbar trap activates). */
async function openColors() {
  fireEvent.click(colorsButton()!);
  await waitFor(() => expect(dropdown()).not.toBeNull());
  await wait(50);
}

/** Opens the menu and clicks "Custom..." (`detail` 0 = keyboard activation, the hex field gets focus); waits for the panel to mount. */
async function openPanel(section: "text" | "background" = "text") {
  await openColors();
  fireEvent.click(item(`${section}-color-custom`), { detail: 0 });
  await waitFor(() => expect(panel()).not.toBeNull());
}

describe("KnotebookColorStyleButton", () => {
  it("color menu: each of the two sections has 10 built-in color items (data-test unchanged) plus one \"Custom...\"", async () => {
    await mount();
    await openColors();
    const ids = (prefix: string) =>
      Array.from(dropdown()!.querySelectorAll(`[data-test^="${prefix}-color-"]`)).map((el) => el.getAttribute("data-test"));
    expect(ids("text")).toEqual([...COLORS.map((c) => `text-color-${c}`), "text-color-custom"]);
    expect(ids("background")).toEqual([...COLORS.map((c) => `background-color-${c}`), "background-color-custom"]);
    expect(item("text-color-custom")).toHaveTextContent("Custom…");
  });

  it("selected text with a canonical hex color: \"Custom...\" is checked and default is not", async () => {
    await mount({ textColor: "#ff6600" });
    await openColors();
    expect(isChecked(item("text-color-custom"))).toBe(true);
    expect(isChecked(item("text-color-default"))).toBe(false);
    expect(isChecked(item("background-color-custom"))).toBe(false);
    expect(isChecked(item("background-color-default"))).toBe(true);
  });

  it("selected text with a non-canonical rgb(1, 2, 3): no item in the text section is checked and neither \"Custom...\" is checked", async () => {
    await mount({ textColor: "rgb(1, 2, 3)" });
    await openColors();
    for (const c of [...COLORS, "custom"]) expect(isChecked(item(`text-color-${c}`)), `text-color-${c}`).toBe(false);
    expect(isChecked(item("background-color-custom"))).toBe(false);
    expect(isChecked(item("background-color-default"))).toBe(true);
  });

  it("\"Custom...\" opens the panel and the menu stays open; entering #ff6600 and pressing Apply applies it to the selected text, closes the menu and the toolbar icon changes to that color", async () => {
    const editor = await mount();
    await openPanel();
    expect(colorsButton()).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(hexInput(), { target: { value: "#ff6600" } });
    fireEvent.click(button("Apply"));
    expect(targetStyles(editor).textColor).toBe("#ff6600");
    expect(colorsButton()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => {
      const icon = document.querySelector<HTMLElement>('[data-test="colors"] .bn-color-icon')!;
      expect(icon.getAttribute("data-text-color")).toBe("#ff6600");
      expect(getComputedStyle(icon).color).toBe("rgb(255, 102, 0)");
    });
  });

  it("built-in color background-color-red: applies and the menu closes (same as native)", async () => {
    const editor = await mount();
    await openColors();
    fireEvent.click(item("background-color-red"));
    expect(targetStyles(editor).backgroundColor).toBe("red");
    expect(colorsButton()).toHaveAttribute("aria-expanded", "false");
  });

  it("with no recent colors, Tab on the panel's last Apply wraps to Back and the color dropdown stays in the toolbar", async () => {
    // jsdom's fireEvent.click does not focus, and the dropdown's trap registers before the toolbar's; a real browser has the opposite order, covered by e2e.
    await mount();
    const restore = layoutHostTrigger(colorsButton()!);
    const restoreToolbar = layoutToolbar();
    try {
      await openPanel();
      await waitForMenuShown(() => dropdown()!);
      fireEvent.change(hexInput(), { target: { value: "#ff6600" } });
      const apply = button("Apply");
      expect(apply).toBeEnabled();
      expect(screen.queryAllByRole("button", { name: /^#/, hidden: true })).toHaveLength(0);
      apply.focus();
      expect(fireEvent.keyDown(apply, { key: "Tab" })).toBe(false);
      expect(document.activeElement).toBe(button("Back"));
      expect(dropdown()).not.toBeNull();
      expect(colorsButton()).toHaveAttribute("aria-expanded", "true");
    } finally {
      restoreToolbar();
      restore();
    }
  });

  it("Back returns to the item list with focus on the text section's \"Custom...\"", async () => {
    await mount();
    await openPanel();
    fireEvent.click(button("Back"));
    await waitFor(() => expect(document.activeElement).toBe(item("text-color-custom")));
    expect(panel()).toBeNull();
  });

  it("a paragraph is added before the selection while the panel is open (toolbar re-render): focus stays in the hex field, the panel stays open and the typed text remains", async () => {
    const editor = await mount();
    await openPanel();
    const hex = hexInput();
    hex.focus();
    fireEvent.change(hex, { target: { value: "#ff6" } });
    await wait(20);
    // Baseline: focus was in the hex field before the insert. A failure here means focus was grabbed when focus first entered the toolbar, not by the re-render.
    expect(document.activeElement).toBe(hex);
    // Selection remapped -> toolbar position changes -> toolbar re-renders; Mantine's focus trap receives the ref again and schedules a focusNode.
    act(() => {
      editor.insertBlocks([{ type: "paragraph", content: "x" }], "p0", "before");
    });
    await wait(20);
    expect(document.activeElement).toBe(hex);
    expect(panel()).not.toBeNull();
    expect(hex.value).toBe("#ff6");
  });

  it("after Back from the panel, a toolbar re-render: the dropdown's initial-focus placeholder is restored and focus stays inside the dropdown", async () => {
    const editor = await mount();
    await openPanel();
    fireEvent.click(button("Back"));
    await waitFor(() => expect(document.activeElement).toBe(item("text-color-custom")));
    const dd = dropdown()!;
    act(() => {
      editor.insertBlocks([{ type: "paragraph", content: "x" }], "p0", "before");
    });
    await wait(30);
    // The data-autofocus the panel borrowed must be returned: only the placeholder element has it, so when the toolbar refocuses focus lands on it and does not jump out of the dropdown.
    expect(dd.querySelectorAll("[data-autofocus]")).toHaveLength(1);
    expect(dd.contains(document.activeElement)).toBe(true);
  });

  it("selected blocks have no inline content (an image selected): the toolbar is present but has no color button", async () => {
    const editor = createTestEditor([P("x", "x"), IMG("img"), P("z", "z")]);
    renderHost(editor);
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    // Wait for our own file-delete button so this selection's toolbar has rendered; otherwise "no color button" could pass before the toolbar exists.
    await waitFor(() => expect(document.querySelector(".bn-formatting-toolbar [data-kb-file-delete]")).not.toBeNull());
    expect(colorsButton()).toBeNull();
  });
});
