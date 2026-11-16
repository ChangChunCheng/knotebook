import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { LinkDialog } from "@/components/LinkDialog";
import { useLinkMenuState } from "@/components/NoteEditor";
import { editorHasBlockWithType } from "@blocknote/core";
import { blockTypeSelectItems } from "@blocknote/react";
import i18n from "@/i18n";
import { resetCustomColorsForTest } from "@/lib/custom-colors";
import { resetRecentColorsForTest } from "@/lib/recent-colors";
import { createTestEditor, placeCursor, renderAiHost, selectInBlock, selectWholeBlocks, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { CB, P, textPos } from "@/test/columns-fixtures";
import { ShowSelectionExtension } from "@blocknote/core/extensions";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { AiSessionProvider, SELECTION_AI_HIGHLIGHT_KEY } from "@/components/ai/AiSession";
import { NoteEditorView } from "@/components/NoteEditor";
import { ThemeProvider } from "@/theme";
import { MobileEditToolbar, MOBILE_COLOR_PANEL_HIGHLIGHT_KEY, MOBILE_COLOR_PANEL_OPEN_ATTR } from "./MobileEditToolbar";
import { MobileToolbarSpacer } from "./MobileToolbarSpacer";
import { resetRememberedKeyboardInsetForTest } from "./toolbar-footprint";

let editor: AnyEditor;
let onCreateLink: ReturnType<typeof vi.fn>;

async function mount(doc: unknown[] = [P("hello world", "a"), P("second", "b")], extra?: React.ReactNode) {
  editor = createTestEditor(doc);
  onCreateLink = vi.fn();
  stubAiFetch({ actions: [] });
  renderAiHost({
    editor,
    children: (
      <>
        <MobileEditToolbar editor={editor} onCreateLink={onCreateLink} />
        {extra}
      </>
    ),
  });
}

const root = () => document.querySelector<HTMLElement>("[data-mobile-edit-toolbar]")!;
const button = (name: string) => within(root()).getByRole("button", { name });
const labels = () => within(root()).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
const dict = () => editor.dictionary;
const formatMode = () => fireEvent.click(button("Text formatting"));
const inEditor = () => editor.domElement!.contains(document.activeElement);

beforeEach(async () => {
  localStorage.clear();
  resetRecentColorsForTest();
  resetRememberedKeyboardInsetForTest();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  resetCustomColorsForTest();
  vi.unstubAllGlobals();
});

describe("格式列", () => {
  it("依序：返回、粗體、斜體、底線、刪除線、程式碼、連結、靠左、置中、靠右、縮排、取消縮排、顏色", async () => {
    await mount();
    formatMode();
    const f = dict().formatting_toolbar;
    expect(labels()).toEqual([
      "Back",
      f.bold.tooltip,
      f.italic.tooltip,
      f.underline.tooltip,
      f.strike.tooltip,
      f.code.tooltip,
      f.link.tooltip,
      f.align_left.tooltip,
      f.align_center.tooltip,
      f.align_right.tooltip,
      f.nest.tooltip,
      f.unnest.tooltip,
      f.colors.tooltip,
    ]);
  });

  it.each([
    ["bold", "Bold"],
    ["italic", "Italic"],
    ["underline", "Underline"],
    ["strike", "Strike"],
    ["code", "Code"],
  ] as const)("%s 鈕套用到選取、按下狀態跟著實際樣式，再按取消", async (style, label) => {
    await mount();
    selectInBlock(editor, "a", 0, 5);
    formatMode();
    expect(button(label)).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button(label));
    expect(editor.getActiveStyles()[style]).toBe(true);
    expect(button(label)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button(label));
    expect(editor.getActiveStyles()[style]).toBeUndefined();
    expect(button(label)).toHaveAttribute("aria-pressed", "false");
  });

  it("游標移到已有樣式的字，按下狀態跟著變", async () => {
    await mount([{ id: "a", type: "paragraph", content: [{ type: "text", text: "bold", styles: { bold: true } }, { type: "text", text: " plain", styles: {} }] } as never]);
    formatMode();
    placeCursor(editor, "a", 2);
    expect(button("Bold")).toHaveAttribute("aria-pressed", "true");
    placeCursor(editor, "a", 7);
    expect(button("Bold")).toHaveAttribute("aria-pressed", "false");
  });

  it("連結鈕呼叫 onCreateLink；游標在連結裡時是按下狀態", async () => {
    await mount([{ id: "a", type: "paragraph", content: [{ type: "link", href: "https://example.com", content: [{ type: "text", text: "site", styles: {} }] }, { type: "text", text: " tail", styles: {} }] } as never]);
    formatMode();
    expect(button("Create link")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button("Create link"));
    expect(onCreateLink).toHaveBeenCalledTimes(1);
    placeCursor(editor, "a", 2);
    expect(button("Create link")).toHaveAttribute("aria-pressed", "true");
  });

  describe("對齊", () => {
    it("三顆分開的鈕：作用在游標所在的區塊，別的區塊不動", async () => {
      await mount();
      placeCursor(editor, "b", 2);
      formatMode();
      fireEvent.click(button("Align text center"));
      expect(editor.getBlock("b")!.props.textAlignment).toBe("center");
      expect(editor.getBlock("a")!.props.textAlignment).toBe("left");
      fireEvent.click(button("Align text right"));
      expect(editor.getBlock("b")!.props.textAlignment).toBe("right");
      fireEvent.click(button("Align text left"));
      expect(editor.getBlock("b")!.props.textAlignment).toBe("left");
    });

    it("選取跨兩個區塊：兩個都套用", async () => {
      await mount();
      selectWholeBlocks(editor, "a", "b");
      formatMode();
      fireEvent.click(button("Align text right"));
      expect(editor.getBlock("a")!.props.textAlignment).toBe("right");
      expect(editor.getBlock("b")!.props.textAlignment).toBe("right");
    });

    it("按下狀態跟著區塊的對齊", async () => {
      await mount();
      placeCursor(editor, "a", 1);
      formatMode();
      expect(button("Align text left")).toHaveAttribute("aria-pressed", "true");
      expect(button("Align text center")).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(button("Align text center"));
      expect(button("Align text center")).toHaveAttribute("aria-pressed", "true");
      expect(button("Align text left")).toHaveAttribute("aria-pressed", "false");
      placeCursor(editor, "b", 1);
      expect(button("Align text left")).toHaveAttribute("aria-pressed", "true");
    });
  });

  describe("縮排", () => {
    it("第二個區塊可縮排、不可取消縮排；縮排後換過來；第一個區塊兩顆都停用", async () => {
      await mount();
      placeCursor(editor, "b", 1);
      formatMode();
      expect(button("Nest block")).not.toHaveAttribute("aria-disabled");
      expect(button("Unnest block")).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button("Nest block"));
      expect(editor.document).toHaveLength(1);
      expect(editor.document[0]!.children.map((child) => child.id)).toEqual(["b"]);
      expect(button("Nest block")).toHaveAttribute("aria-disabled", "true");
      expect(button("Unnest block")).not.toHaveAttribute("aria-disabled");
      fireEvent.click(button("Unnest block"));
      expect(editor.document.map((block) => block.id)).toEqual(["a", "b"]);
      placeCursor(editor, "a", 1);
      expect(button("Nest block")).toHaveAttribute("aria-disabled", "true");
      expect(button("Unnest block")).toHaveAttribute("aria-disabled", "true");
    });
  });

  it("顏色鈕：長得像桌機那顆「A」，字色是目前文字色、小方塊是目前背景色", async () => {
    await mount([{ id: "a", type: "paragraph", content: [{ type: "text", text: "tint", styles: { textColor: "red", backgroundColor: "yellow" } }] } as never]);
    placeCursor(editor, "a", 2);
    formatMode();
    const icon = button("Colors").querySelector(".bn-color-icon")!;
    expect(icon).toHaveTextContent("A");
    expect(icon).toHaveAttribute("data-text-color", "red");
    expect(icon).toHaveAttribute("data-background-color", "yellow");
    expect(icon.closest(".bn-root")).not.toBeNull();
  });

  it("連結以外所有鈕都不搶焦點（mousedown 被擋）", async () => {
    await mount();
    formatMode();
    for (const b of within(root()).getAllByRole("button")) expect(fireEvent.mouseDown(b)).toBe(false);
  });
});

describe("區塊類型列", () => {
  const blockTypeMode = () => fireEvent.click(button("Change block type"));
  const expectedNames = () =>
    blockTypeSelectItems(editor.dictionary)
      .filter((item) =>
        editorHasBlockWithType(editor, item.type, Object.fromEntries(Object.entries(item.props ?? {}).map(([name, value]) => [name, typeof value])) as never),
      )
      .map((item) => item.name);

  it("項目與桌機區塊類型選單同一份（同順序、同集合），前面是返回", async () => {
    await mount();
    blockTypeMode();
    const names = expectedNames();
    expect(names.length).toBeGreaterThan(8);
    expect(labels()).toEqual(["Back", ...names]);
  });

  it("按項目：游標所在區塊換類型，別的區塊不動；目前的類型是按下狀態", async () => {
    await mount();
    placeCursor(editor, "b", 2);
    blockTypeMode();
    expect(button(dict().slash_menu.paragraph.title)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button(dict().slash_menu.heading_2.title));
    expect(editor.getBlock("b")!.type).toBe("heading");
    expect(editor.getBlock("b")!.props.level).toBe(2);
    expect(editor.getBlock("a")!.type).toBe("paragraph");
    expect(button(dict().slash_menu.heading_2.title)).toHaveAttribute("aria-pressed", "true");
    expect(button(dict().slash_menu.heading.title)).toHaveAttribute("aria-pressed", "false");
    expect(button(dict().slash_menu.toggle_heading_2.title)).toHaveAttribute("aria-pressed", "false");
    expect(button(dict().slash_menu.paragraph.title)).toHaveAttribute("aria-pressed", "false");
  });

  it("可收合標題與一般標題是兩個不同的項目", async () => {
    await mount();
    placeCursor(editor, "a", 1);
    blockTypeMode();
    fireEvent.click(button(dict().slash_menu.toggle_heading.title));
    expect(editor.getBlock("a")!.props).toMatchObject({ level: 1, isToggleable: true });
    expect(button(dict().slash_menu.toggle_heading.title)).toHaveAttribute("aria-pressed", "true");
    expect(button(dict().slash_menu.heading.title)).toHaveAttribute("aria-pressed", "false");
  });

  it("選取跨兩個區塊：兩個都換", async () => {
    await mount();
    selectWholeBlocks(editor, "a", "b");
    blockTypeMode();
    fireEvent.click(button(dict().slash_menu.bullet_list.title));
    expect(editor.getBlock("a")!.type).toBe("bulletListItem");
    expect(editor.getBlock("b")!.type).toBe("bulletListItem");
  });

  const TABLE = { id: "t", type: "table", content: { type: "tableContent", rows: [{ cells: ["x", "y"] }, { cells: ["z", "w"] }] } } as never;

  describe("目前區塊不能換類型（表格、程式碼區塊）", () => {
    it("游標在表格儲存格：主列 ¶ 鈕停用、點了不進模式；段落裡可按", async () => {
      await mount([P("hello", "a"), TABLE]);
      placeCursor(editor, "a", 1);
      expect(button("Change block type")).not.toHaveAttribute("aria-disabled");
      act(() => editor._tiptapEditor.commands.setTextSelection(textPos(editor, "x", 0)));
      expect(button("Change block type")).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button("Change block type"));
      expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "main");
    });

    it("游標在程式碼區塊：¶ 鈕停用", async () => {
      await mount([{ id: "c", type: "codeBlock", content: "line1\nline2" } as never, P("z", "z")]);
      placeCursor(editor, "c", 2);
      expect(button("Change block type")).toHaveAttribute("aria-disabled", "true");
    });

    it("模式開著時游標移進表格：所有項目停用，點了不動內容", async () => {
      await mount([P("hello", "a"), TABLE]);
      placeCursor(editor, "a", 1);
      blockTypeMode();
      expect(button(dict().slash_menu.heading.title)).not.toHaveAttribute("aria-disabled");
      act(() => editor._tiptapEditor.commands.setTextSelection(textPos(editor, "x", 0)));
      for (const b of within(root()).getAllByRole("button").slice(1)) expect(b).toHaveAttribute("aria-disabled", "true");
      const before = JSON.stringify(editor.document);
      fireEvent.click(button(dict().slash_menu.heading.title));
      expect(JSON.stringify(editor.document)).toBe(before);
    });

    it("段落＋表格一起選：只換段落，表格內容不動", async () => {
      await mount([P("hello", "a"), TABLE]);
      act(() => editor._tiptapEditor.commands.setTextSelection({ from: textPos(editor, "hello", 0), to: textPos(editor, "w", 1) }));
      expect(editor.getSelection()!.blocks.map((block) => block.type)).toEqual(["paragraph", "table"]);
      const tableBefore = JSON.stringify(editor.getBlock("t")!.content);
      blockTypeMode();
      fireEvent.click(button(dict().slash_menu.heading_2.title));
      expect(editor.getBlock("a")!.type).toBe("heading");
      expect(editor.getBlock("t")!.type).toBe("table");
      expect(JSON.stringify(editor.getBlock("t")!.content)).toBe(tableBefore);
    });

    it("段落＋程式碼區塊一起選：程式碼區塊的內容不被清掉", async () => {
      await mount([P("hello", "a"), CB("c", "keep me")]);
      act(() => editor._tiptapEditor.commands.setTextSelection({ from: textPos(editor, "hello", 0), to: textPos(editor, "keep me", 3) }));
      blockTypeMode();
      fireEvent.click(button(dict().slash_menu.heading.title));
      expect(editor.getBlock("a")!.type).toBe("heading");
      expect(editor.getBlock("c")!.type).toBe("codeBlock");
      expect(JSON.stringify(editor.getBlock("c")!.content)).toContain("keep me");
    });
  });

  it("每顆鈕不搶焦點", async () => {
    await mount();
    blockTypeMode();
    for (const b of within(root()).getAllByRole("button")) expect(fireEvent.mouseDown(b)).toBe(false);
  });
});

describe("色盤", () => {
  const colorsButton = () => button("Colors");
  const panel = () => document.querySelector<HTMLElement>("[data-mobile-color-panel]");
  const row = (section: "Text" | "Background") => within(panel()!).getByRole("group", { name: section });
  const swatch = (section: "Text" | "Background", name: string) => within(row(section)).getByRole("button", { name });
  const openColors = () => fireEvent.click(colorsButton());

  async function mountSelected() {
    await mount();
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 5);
    formatMode();
  }

  it("開色盤：模式是 color、色盤在膠囊下方的獨立區塊、顏色鈕是按下狀態", async () => {
    await mountSelected();
    expect(panel()).toBeNull();
    openColors();
    expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "color");
    expect(panel()).not.toBeNull();
    expect(panel()!.closest("[data-mobile-edit-toolbar]")).toBe(root());
    expect(panel()!.closest(".bn-root")).not.toBeNull();
    expect(colorsButton()).toHaveAttribute("aria-pressed", "true");
    expect(within(root()).getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("開色盤：焦點從編輯器移進工具列、工具列不卸載", async () => {
    await mountSelected();
    expect(inEditor()).toBe(true);
    openColors();
    expect(inEditor()).toBe(false);
    expect(root().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    // NotePage 靠焦點是否仍在工具列內判斷「還在編輯中」：再等一輪確認焦點沒掉到 body
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    expect(root().contains(document.activeElement)).toBe(true);
    expect(root().isConnected).toBe(true);
  });

  it("兩列：文字色一列、背景色一列，第一格是預設、其後是九種內建色、最後是「自訂…」", async () => {
    await mountSelected();
    openColors();
    const names = dict().color_picker.colors;
    for (const section of ["Text", "Background"] as const) {
      const cells = within(row(section)).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
      expect(cells).toEqual([names.default, names.gray, names.brown, names.red, names.orange, names.yellow, names.green, names.blue, names.purple, names.pink, "Custom…"]);
    }
    const groups = within(panel()!).getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Text", "Background"]);
  });

  it("色票視覺 32、點擊區 44", async () => {
    await mountSelected();
    openColors();
    const cell = swatch("Text", "Red");
    expect(cell).toHaveClass("size-11");
    expect(cell.querySelector(".bn-color-icon")).toHaveClass("size-8");
  });

  it("選文字色：套到原本的選取（編輯器已失焦），目前那格有外圈（aria-pressed）", async () => {
    await mountSelected();
    openColors();
    fireEvent.click(swatch("Text", "Red"));
    const content = editor.getBlock("a")!.content as { text: string; styles: Record<string, string> }[];
    expect(content.find((c) => c.styles.textColor === "red")!.text).toBe("hello");
    expect(content.filter((c) => c.styles.textColor === "red")).toHaveLength(1);
    expect(swatch("Text", "Red")).toHaveAttribute("aria-pressed", "true");
    expect(swatch("Text", "Auto")).toHaveAttribute("aria-pressed", "false");
    expect(colorsButton().querySelector(".bn-color-icon")).toHaveAttribute("data-text-color", "red");
    expect(inEditor()).toBe(false);
  });

  it("選背景色套到選取；預設（Auto）清除", async () => {
    await mountSelected();
    openColors();
    fireEvent.click(swatch("Background", "Yellow"));
    expect(editor.getActiveStyles().backgroundColor).toBe("yellow");
    expect(swatch("Background", "Yellow")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(swatch("Background", "Auto"));
    expect(editor.getActiveStyles().backgroundColor).toBeUndefined();
    expect(swatch("Background", "Auto")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(swatch("Text", "Blue"));
    fireEvent.click(swatch("Text", "Auto"));
    expect(editor.getActiveStyles().textColor).toBeUndefined();
  });

  it("「自訂…」在色盤裡換頁，輸入色碼套用後回到色票頁；顏色寫進選取", async () => {
    await mountSelected();
    openColors();
    fireEvent.click(within(row("Background")).getByRole("button", { name: "Custom…" }));
    const input = await waitFor(() => within(panel()!).getByLabelText("Hex color"));
    expect(root().contains(document.activeElement)).toBe(true);
    expect(root().isConnected).toBe(true);
    fireEvent.change(input, { target: { value: "#123456" } });
    fireEvent.click(within(panel()!).getByRole("button", { name: "Apply" }));
    expect(editor.getActiveStyles().backgroundColor).toBe("#123456");
    expect(within(panel()!).queryByLabelText("Hex color")).toBeNull();
    expect(row("Background")).toBeInTheDocument();
    expect(root().contains(document.activeElement)).toBe(true);
  });

  it("自訂頁的「返回」回到色票頁、不套用", async () => {
    await mountSelected();
    openColors();
    fireEvent.click(within(row("Text")).getByRole("button", { name: "Custom…" }));
    await waitFor(() => within(panel()!).getByLabelText("Hex color"));
    fireEvent.click(within(panel()!).getByRole("button", { name: "Back" }));
    expect(row("Text")).toBeInTheDocument();
    expect(editor.getActiveStyles().textColor).toBeUndefined();
  });

  it.each([
    ["再按一次顏色鈕", () => fireEvent.click(colorsButton())],
    ["按返回", () => fireEvent.click(within(root()).getByRole("button", { name: "Back" }))],
  ])("%s：回到 format 模式、焦點回編輯器、選取原樣保留", async (_name, leave) => {
    await mountSelected();
    const before = { from: editor.prosemirrorState.selection.from, to: editor.prosemirrorState.selection.to };
    openColors();
    fireEvent.click(swatch("Text", "Red"));
    leave();
    expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "format");
    expect(panel()).toBeNull();
    expect(inEditor()).toBe(true);
    expect({ from: editor.prosemirrorState.selection.from, to: editor.prosemirrorState.selection.to }).toEqual(before);
    expect(colorsButton()).toHaveAttribute("aria-pressed", "false");
  });

  describe("色盤高度", () => {
    let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
    let frames: Array<() => void>;
    const setKeyboard = (inset: number) => {
      viewport.height = 800 - inset;
      act(() => {
        viewport.dispatchEvent(new Event("resize"));
        frames.splice(0).forEach((run) => run());
      });
    };
    beforeEach(() => {
      viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
      vi.stubGlobal("innerHeight", 800);
      frames = [];
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
    });
    afterEach(() => {
      Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
    });
    const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 260)));

    it("鍵盤穩定開著時記下高度；鍵盤收起後色盤用記下的高度，工具列貼在色盤上方", async () => {
      await mount([P("hello world", "a")], <MobileToolbarSpacer />);
      act(() => editor.focus());
      selectInBlock(editor, "a", 0, 5);
      setKeyboard(310);
      await settle();
      formatMode();
      openColors();
      setKeyboard(0);
      expect(panel()!.style.minHeight).toBe("310px");
      expect(root().style.bottom).toBe("0px");
      // 色盤佔掉的高度也要讓文件尾端留出來
      expect(document.querySelector<HTMLElement>("[data-mobile-toolbar-spacer]")!.style.height).toBe("370px");
      fireEvent.click(colorsButton());
      expect(panel()).toBeNull();
      expect(document.querySelector<HTMLElement>("[data-mobile-toolbar-spacer]")!.style.height).toBe("60px");
    });

    it("鍵盤高度還在變動（收起動畫中途）不記", async () => {
      await mount([P("hello world", "a")]);
      act(() => editor.focus());
      setKeyboard(310);
      await settle();
      setKeyboard(200);
      setKeyboard(120);
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
      setKeyboard(0);
      await settle();
      selectInBlock(editor, "a", 0, 5);
      formatMode();
      openColors();
      expect(panel()!.style.minHeight).toBe("310px");
    });

    it("沒有記錄時用預設高度", async () => {
      await mountSelected();
      openColors();
      expect(panel()!.style.minHeight).toBe("280px");
    });
  });

  it("色盤開著時點內文（編輯器取回焦點）：回到 format 模式、色盤收起", async () => {
    await mountSelected();
    openColors();
    expect(panel()).not.toBeNull();
    act(() => editor.focus());
    expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "format");
    expect(panel()).toBeNull();
  });

  it("色盤開著時選取有反白 decoration、關掉後沒有；AI 框那把 key 不受影響", async () => {
    await mountSelected();
    const extension = editor.getExtension(ShowSelectionExtension)!;
    act(() => extension.showSelection(true, SELECTION_AI_HIGHLIGHT_KEY));
    expect(editor.domElement!.hasAttribute(MOBILE_COLOR_PANEL_OPEN_ATTR)).toBe(false);
    openColors();
    expect(editor.domElement!.hasAttribute(MOBILE_COLOR_PANEL_OPEN_ATTR)).toBe(true);
    expect([...extension.store.state.enabledSet].sort()).toEqual([MOBILE_COLOR_PANEL_HIGHLIGHT_KEY, SELECTION_AI_HIGHLIGHT_KEY].sort());
    const shown = Array.from(editor.domElement!.querySelectorAll("[data-show-selection]")).map((node) => node.textContent);
    expect(shown.join("")).toBe("hello");
    fireEvent.click(colorsButton());
    expect(editor.domElement!.hasAttribute(MOBILE_COLOR_PANEL_OPEN_ATTR)).toBe(false);
    expect([...extension.store.state.enabledSet]).toEqual([SELECTION_AI_HIGHLIGHT_KEY]);
  });

  it("按返回離開色盤：自己那把反白 key 與屬性一定關掉", async () => {
    await mountSelected();
    const extension = editor.getExtension(ShowSelectionExtension)!;
    openColors();
    expect(extension.store.state.enabledSet.size).toBe(1);
    fireEvent.click(button("Back"));
    expect(extension.store.state.enabledSet.size).toBe(0);
    expect(editor.domElement!.hasAttribute(MOBILE_COLOR_PANEL_OPEN_ATTR)).toBe(false);
  });

  it("色盤開著時，游標避讓的下緣預留色盤高加工具列外框高", async () => {
    await mountSelected();
    const margin = () => (editor.prosemirrorView!.props as { scrollMargin?: { bottom?: number } }).scrollMargin?.bottom;
    expect(margin()).toBe(68);
    openColors();
    expect(margin()).toBe(280 + 68);
    fireEvent.click(colorsButton());
    expect(margin()).toBe(68);
  });

  it("「自訂…」頁比記下的高度高：spacer 與游標避讓改用量到的高度", async () => {
    let report: () => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          report = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    await mount([P("hello world", "a")], <MobileToolbarSpacer />);
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 5);
    formatMode();
    openColors();
    Object.defineProperty(panel()!, "offsetHeight", { value: 420, configurable: true });
    act(() => report());
    expect(document.querySelector<HTMLElement>("[data-mobile-toolbar-spacer]")!.style.height).toBe("480px");
    expect((editor.prosemirrorView!.props as { scrollMargin?: { bottom?: number } }).scrollMargin?.bottom).toBe(488);
  });

  it("minHeight 不超過可視高度扣掉工具列；轉向後重算", async () => {
    vi.stubGlobal("innerHeight", 800);
    await mountSelected();
    openColors();
    expect(panel()!.style.minHeight).toBe("280px");
    vi.stubGlobal("innerHeight", 300);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(panel()!.style.minHeight).toBe("188px");
  });

  it("突變守衛：移進工具列的焦點只能是工具列內的元素", async () => {
    await mountSelected();
    openColors();
    expect(document.activeElement!.closest("[data-mobile-edit-toolbar]")).toBe(root());
  });
});

describe("連結（真的對話框）", () => {
  function LinkHost({ target }: { target: AnyEditor }) {
    const { t } = useTranslation();
    const ref = useRef(target);
    const state = useLinkMenuState(ref, t);
    return (
      <>
        <MobileEditToolbar editor={target} onCreateLink={state.openLinkDialog} />
        <LinkDialog
          editor={target}
          open={state.linkDialogOpen}
          onOpenChange={state.setLinkDialogOpen}
          onSubmit={state.handleLinkInsert}
          initialText={state.linkPrefill.text}
          initialUrl={state.linkPrefill.url}
        />
      </>
    );
  }

  async function mountLinkHost() {
    editor = createTestEditor([P("hello world", "a")]);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost target={editor} /> });
  }

  it("選了字按連結：對話框預填那段字；送出（文字沒改）→ 只加連結、粗體保留、選取還在、焦點回編輯器", async () => {
    await mountLinkHost();
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 5);
    formatMode();
    fireEvent.click(button("Bold"));
    fireEvent.click(button("Create link"));
    const textField = await screen.findByLabelText(i18n.t("note.link.textLabel"));
    expect(textField).toHaveValue("hello");
    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "https://example.com" } });
    fireEvent.submit(textField.closest("form")!);
    const content = editor.getBlock("a")!.content as { type: string; href?: string; content?: { text: string; styles: Record<string, unknown> }[] }[];
    const link = content.find((item) => item.type === "link")!;
    expect(link.href).toBe("https://example.com");
    expect(link.content).toEqual([{ type: "text", text: "hello", styles: { bold: true } }]);
    await waitFor(() => expect(inEditor()).toBe(true));
    expect(editor.getSelectedText()).toBe("hello");
  });

  it("游標在連結裡：網址預填成那個連結的網址", async () => {
    editor = createTestEditor([{ id: "a", type: "paragraph", content: [{ type: "link", href: "https://example.com", content: [{ type: "text", text: "site", styles: {} }] }] } as never]);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost target={editor} /> });
    act(() => editor.focus());
    placeCursor(editor, "a", 2);
    formatMode();
    fireEvent.click(button("Create link"));
    expect(await screen.findByLabelText(i18n.t("note.link.urlLabel"))).toHaveValue("https://example.com");
  });
});

describe("BlockNoteScope（工具列在 BlockNoteView 外面，與正式版同位置）", () => {
  it("顏色鈕的 A 與色盤都在自己的 .bn-root 底下，不是編輯器的那一個", async () => {
    editor = createTestEditor([P("hello world", "a")]);
    stubAiFetch({ actions: [] });
    render(
      <MemoryRouter>
        <ThemeProvider>
          <QueryClientProvider client={new QueryClient()}>
            <AiSessionProvider editor={editor} noteId="n" editable>
              <NoteEditorView editor={editor} editable theme="light" noteId="n" getItems={() => Promise.resolve([])} getSlashItems={() => Promise.resolve([])} />
              <MobileEditToolbar editor={editor} />
            </AiSessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 5);
    formatMode();
    const editorScope = editor.domElement!.closest(".bn-root");
    expect(editorScope).not.toBeNull();
    const iconScope = button("Colors").querySelector(".bn-color-icon")!.closest(".bn-root");
    expect(iconScope).not.toBeNull();
    expect(iconScope).not.toBe(editorScope);
    expect(root().contains(iconScope)).toBe(true);
    fireEvent.click(button("Colors"));
    const panelScope = document.querySelector("[data-mobile-color-panel]")!.closest(".bn-root");
    expect(panelScope).not.toBeNull();
    expect(panelScope).not.toBe(editorScope);
    expect(panelScope!.getAttribute("data-color-scheme")).toBe("light");
  });
});

describe("連結（編輯既有連結、空白）", () => {
  function LinkHost2({ target }: { target: AnyEditor }) {
    const { t } = useTranslation();
    const ref = useRef(target);
    const state = useLinkMenuState(ref, t);
    return (
      <>
        <MobileEditToolbar editor={target} onCreateLink={state.openLinkDialog} />
        <LinkDialog
          editor={target}
          open={state.linkDialogOpen}
          onOpenChange={state.setLinkDialogOpen}
          onSubmit={state.handleLinkInsert}
          initialText={state.linkPrefill.text}
          initialUrl={state.linkPrefill.url}
        />
      </>
    );
  }
  const submit = async (url: string) => {
    const field = await screen.findByLabelText(i18n.t("note.link.urlLabel"));
    fireEvent.change(field, { target: { value: url } });
    fireEvent.submit(field.closest("form")!);
  };
  const flatten = (content: { type: string; href?: string; text?: string; content?: { text: string }[] }[]) =>
    content.map((item) => (item.type === "link" ? `link(${item.href}):${item.content!.map((c) => c.text).join("")}` : item.text));

  it("游標在既有連結裡改網址：文字不變、只換 href、不會多出字", async () => {
    editor = createTestEditor([
      { id: "a", type: "paragraph", content: [{ type: "link", href: "https://old.example", content: [{ type: "text", text: "site", styles: {} }] }, { type: "text", text: " tail", styles: {} }] } as never,
    ]);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    placeCursor(editor, "a", 2);
    formatMode();
    fireEvent.click(button("Create link"));
    expect(await screen.findByLabelText(i18n.t("note.link.textLabel"))).toHaveValue("site");
    await submit("https://new.example");
    expect(flatten(editor.getBlock("a")!.content as never)).toEqual(["link(https://new.example):site", " tail"]);
  });

  it("選取帶尾端空白、文字不改：整段文字逐字不變", async () => {
    editor = createTestEditor([P("hello world", "a")]);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 6);
    formatMode();
    fireEvent.click(button("Create link"));
    await submit("https://example.com");
    expect(flatten(editor.getBlock("a")!.content as never)).toEqual(["link(https://example.com):hello ", "world"]);
  });
  const LINK_DOC = [
    { id: "a", type: "paragraph", content: [{ type: "text", text: "x ", styles: {} }, { type: "link", href: "https://old.example", content: [{ type: "text", text: "site", styles: {} }] }, { type: "text", text: " tail", styles: {} }] } as never,
  ];

  it("選取剛好是整條連結：文字與網址都預填、連結鈕是按下狀態", async () => {
    editor = createTestEditor(LINK_DOC);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    selectInBlock(editor, "a", 2, 6);
    formatMode();
    expect(button("Create link")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button("Create link"));
    expect(await screen.findByLabelText(i18n.t("note.link.textLabel"))).toHaveValue("site");
    expect(screen.getByLabelText(i18n.t("note.link.urlLabel"))).toHaveValue("https://old.example");
  });

  it("連結在段首、選取剛好是整條連結：同樣預填、鈕按下", async () => {
    editor = createTestEditor([
      { id: "a", type: "paragraph", content: [{ type: "link", href: "https://old.example", content: [{ type: "text", text: "site", styles: {} }] }, { type: "text", text: " tail", styles: {} }] } as never,
    ]);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 4);
    formatMode();
    expect(button("Create link")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button("Create link"));
    expect(await screen.findByLabelText(i18n.t("note.link.urlLabel"))).toHaveValue("https://old.example");
  });

  it("游標在連結前、後：不算在連結裡（鈕不亮）", async () => {
    editor = createTestEditor(LINK_DOC);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    formatMode();
    placeCursor(editor, "a", 2);
    expect(button("Create link")).toHaveAttribute("aria-pressed", "false");
    placeCursor(editor, "a", 6);
    expect(button("Create link")).toHaveAttribute("aria-pressed", "false");
    placeCursor(editor, "a", 4);
    expect(button("Create link")).toHaveAttribute("aria-pressed", "true");
  });

  it("選取從連結中間拉到連結外：當一般選取，新連結剛好涵蓋選取的字", async () => {
    editor = createTestEditor(LINK_DOC);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor, children: <LinkHost2 target={editor} /> });
    act(() => editor.focus());
    selectInBlock(editor, "a", 4, 8);
    formatMode();
    expect(button("Create link")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button("Create link"));
    expect(await screen.findByLabelText(i18n.t("note.link.textLabel"))).toHaveValue("te t");
    await submit("https://new.example");
    expect(flatten(editor.getBlock("a")!.content as never)).toEqual(["x ", "link(https://old.example):si", "link(https://new.example):te t", "ail"]);
  });
});

describe("色盤長高時把選取捲出來", () => {
  it("色盤實際高度變大（例如進「自訂…」頁）：送一筆 scrollIntoView，編輯器沒有焦點也送", async () => {
    let report: () => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          report = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    await mount([P("hello world", "a")]);
    act(() => editor.focus());
    selectInBlock(editor, "a", 0, 5);
    formatMode();
    const dispatch = vi.spyOn(editor.prosemirrorView!, "dispatch");
    const scrolled = () => dispatch.mock.calls.filter(([tr]) => (tr as { scrolledIntoView: boolean }).scrolledIntoView).length;
    fireEvent.click(button("Colors"));
    expect(editor.domElement!.contains(document.activeElement)).toBe(false);
    const afterOpen = scrolled();
    expect(afterOpen).toBeGreaterThan(0);
    const panel = document.querySelector<HTMLElement>("[data-mobile-color-panel]")!;
    Object.defineProperty(panel, "offsetHeight", { value: 420, configurable: true });
    act(() => report());
    expect(scrolled()).toBe(afterOpen + 1);
    Object.defineProperty(panel, "offsetHeight", { value: 300, configurable: true });
    act(() => report());
    expect(scrolled()).toBe(afterOpen + 1);
  });
});
