import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { SuggestionMenu } from "@blocknote/core";
import { FilePanelExtension, FormattingToolbarExtension } from "@blocknote/core/extensions";
import { REWRITE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { useAiSession, type AiSessionValue } from "@/components/ai/AiSession";
import { contentStart, createTestEditor, placeCursor, renderAiHost, selectInBlock, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { CB, IMG, P } from "@/test/columns-fixtures";
import { STICKY_TOP_VAR } from "@/lib/page-scroll";
import { MobileEditToolbar } from "./MobileEditToolbar";
import { MobileToolbarButton } from "./MobileToolbarButton";
import { MobileToolbarSpacer } from "./MobileToolbarSpacer";

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}

let editor: AnyEditor;

let rerenderHost!: ReturnType<typeof renderAiHost>["rerenderHost"];

async function mount(opts: { actions?: AiActionDto[]; editable?: boolean; doc?: unknown[] } = {}) {
  const actions = opts.actions ?? [REWRITE];
  editor = createTestEditor(opts.doc ?? [P("hello world", "a"), P("second", "b")]);
  stubAiFetch({ actions });
  ({ rerenderHost } = renderAiHost({
    editor,
    editable: opts.editable,
    children: (
      <>
        <MobileEditToolbar editor={editor} />
        <Probe />
      </>
    ),
  }));
  await waitFor(() => expect(session.actions).toHaveLength(actions.length));
}

const mountWith = (doc: unknown[]) => mount({ doc });

const root_ = () => document.querySelector("[data-mobile-edit-toolbar]");
const root = () => document.querySelector<HTMLElement>("[data-mobile-edit-toolbar]")!;
const button = (name: string) => within(root()).getByRole("button", { name });
const labels = () => within(root()).getAllByRole("button").map((b) => b.getAttribute("aria-label"));

const MAIN_ROW = ["AI", "Insert block", "Text formatting", "Insert image", "Change block type", "Undo", "Redo", "Hide keyboard"];

describe("MobileEditToolbar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("主列項目依序：AI、插入、Aa、圖片、轉換區塊、復原、重做、收起鍵盤", async () => {
    await mount();
    expect(labels()).toEqual(MAIN_ROW);
    expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "main");
    expect(root()).toHaveAttribute("role", "toolbar");
  });

  it("沒有 AI 動作：沒有 AI 鈕，其餘照舊", async () => {
    await mount({ actions: [] });
    expect(labels()).toEqual(MAIN_ROW.slice(1));
  });

  it("不可編輯：沒有 AI 鈕", async () => {
    await mount({ editable: false });
    expect(labels()).toEqual(MAIN_ROW.slice(1));
  });

  it("每顆鈕 44×44（class）", async () => {
    await mount();
    for (const b of within(root()).getAllByRole("button")) expect(b).toHaveClass("size-11");
  });

  it("按下：mousedown 被擋（編輯器不失焦），pointerdown 不擋（WebKit 擋了就不發 click）；收起鍵盤那顆也一樣", async () => {
    await mount();
    for (const name of MAIN_ROW) {
      expect(fireEvent.mouseDown(button(name)), `${name} mousedown`).toBe(false);
      expect(fireEvent.pointerDown(button(name)), `${name} pointerdown`).toBe(true);
    }
  });

  it("收起鍵盤：焦點離開編輯器", async () => {
    await mount();
    act(() => editor.focus());
    expect(editor.domElement!.contains(document.activeElement)).toBe(true);
    fireEvent.mouseDown(button("Hide keyboard"));
    expect(editor.domElement!.contains(document.activeElement)).toBe(true);
    fireEvent.click(button("Hide keyboard"));
    expect(editor.domElement!.contains(document.activeElement)).toBe(false);
  });

  it("AI：沒有選取 → aria-disabled，點了不開框；選了文字 → 可按，點了開框", async () => {
    await mount();
    placeCursor(editor, "a", 2);
    expect(button("AI")).toHaveAttribute("aria-disabled", "true");
    expect(button("AI")).not.toBeDisabled();
    fireEvent.click(button("AI"));
    expect(session.state.phase).toBe("idle");
    selectInBlock(editor, "a", 0, 5);
    expect(button("AI")).not.toHaveAttribute("aria-disabled");
    fireEvent.click(button("AI"));
    expect(session.state.phase).toBe("input");
  });

  describe("＋插入", () => {
    it("游標在有字的段落：後面插一段空段落、游標移過去、開 slash 選單，原本的字不動", async () => {
      await mount();
      placeCursor(editor, "a", 5);
      const menu = editor.getExtension(SuggestionMenu)!;
      expect(menu.shown()).toBe(false);
      fireEvent.click(button("Insert block"));
      expect(menu.shown()).toBe(true);
      expect(editor.document).toHaveLength(3);
      expect(editor.document[0]!.id).toBe("a");
      expect(JSON.stringify(editor.document[0]!.content)).toContain("hello world");
      expect(editor.document[1]!.content).toEqual([]);
      expect(editor.getTextCursorPosition().block.id).toBe(editor.document[1]!.id);
    });

    it("游標在空段落：就在那裡開，不多插區塊、不插字", async () => {
      await mountWith([P("", "e"), P("second", "b")]);
      placeCursor(editor, "e", 0);
      fireEvent.click(button("Insert block"));
      expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);
      expect(editor.document).toHaveLength(2);
      expect(editor.document[0]!.content).toEqual([]);
    });

    it("選了文字再按：選取的字還在（不被換成 /）", async () => {
      await mount();
      selectInBlock(editor, "a", 0, 5);
      fireEvent.click(button("Insert block"));
      expect(JSON.stringify(editor.document[0]!.content)).toContain("hello world");
      expect(JSON.stringify(editor.document)).not.toContain('"/"');
    });

    it("選到圖片再按：圖片還在，後面多一段空段落", async () => {
      await mountWith([P("x", "x"), IMG("img"), P("z", "z")]);
      act(() => {
        editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
      });
      fireEvent.click(button("Insert block"));
      expect(editor.document.map((block) => block.type)).toEqual(["paragraph", "image", "paragraph", "paragraph"]);
      expect(editor.document[1]!.id).toBe("img");
      expect(editor.document[2]!.content).toEqual([]);
    });

    it("空的程式碼區塊再按：後面多一段空段落、游標在新的那段、選單開（程式碼裡選單不會開）", async () => {
      await mountWith([CB("c"), P("z", "z")]);
      placeCursor(editor, "c", 0);
      fireEvent.click(button("Insert block"));
      expect(editor.document.map((block) => block.type)).toEqual(["codeBlock", "paragraph", "paragraph"]);
      expect(editor.getTextCursorPosition().block.id).toBe(editor.document[1]!.id);
      expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);
    });

    it("程式碼區塊裡再按：沒有字面的 /，後面多一段空段落並開選單", async () => {
      await mountWith([{ id: "c", type: "codeBlock", content: "let x" } as never, P("z", "z")]);
      placeCursor(editor, "c", 3);
      fireEvent.click(button("Insert block"));
      expect(JSON.stringify(editor.document[0]!.content)).not.toContain("/");
      expect(editor.document[1]!.type).toBe("paragraph");
      expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);
    });
  });

  it("圖片：在游標所在區塊之後插入圖片區塊並開檔案面板，並收起浮動格式工具列", async () => {
    await mount();
    placeCursor(editor, "a", 3);
    const formatting = editor.getExtension(FormattingToolbarExtension)!;
    fireEvent.click(button("Insert image"));
    const images = editor.document.filter((block) => block.type === "image");
    expect(images).toHaveLength(1);
    expect(editor.document[1]!.type).toBe("image");
    expect(editor.getExtension(FilePanelExtension)!.store.state).toBe(images[0]!.id);
    expect(formatting.store.state).toBe(false);
  });

  it("圖片：選到圖片再按 → 插在它後面，原圖還在", async () => {
    await mountWith([P("x", "x"), IMG("img"), P("z", "z")]);
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    fireEvent.click(button("Insert image"));
    expect(editor.document.map((block) => block.type)).toEqual(["paragraph", "image", "image", "paragraph"]);
    expect(editor.document[1]!.id).toBe("img");
    expect(editor.getExtension(FilePanelExtension)!.store.state).toBe(editor.document[2]!.id);
  });

  it("復原、重做呼叫編輯器的 undo／redo", async () => {
    await mount();
    const undo = vi.spyOn(editor, "undo");
    const redo = vi.spyOn(editor, "redo");
    fireEvent.click(button("Undo"));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).not.toHaveBeenCalled();
    fireEvent.click(button("Redo"));
    expect(redo).toHaveBeenCalledTimes(1);
  });

  describe("模式", () => {
    it("Aa → format 模式：只剩「返回」＋格式鈕；返回 → 主列", async () => {
      await mount();
      fireEvent.click(button("Text formatting"));
      expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "format");
      expect(labels()[0]).toBe("Back");
      expect(labels()).not.toContain("Insert block");
      fireEvent.click(button("Back"));
      expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "main");
      expect(labels()).toEqual(MAIN_ROW);
    });

    it("¶ → blockType 模式：以「返回」開頭", async () => {
      await mount();
      fireEvent.click(button("Change block type"));
      expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "blockType");
      expect(labels()[0]).toBe("Back");
      fireEvent.click(button("Back"));
      expect(root()).toHaveAttribute("data-mobile-toolbar-mode", "main");
    });

    it("子模式的鈕一樣不搶焦點（mousedown 被擋）", async () => {
      await mount();
      fireEvent.click(button("Text formatting"));
      for (const b of within(root()).getAllByRole("button")) expect(fireEvent.mouseDown(b)).toBe(false);
    });

    it("format 模式的粗體鈕套到選取", async () => {
      await mount();
      selectInBlock(editor, "a", 0, 5);
      fireEvent.click(button("Text formatting"));
      fireEvent.click(button("Bold"));
      expect(editor.getActiveStyles().bold).toBe(true);
    });
  });

  describe("跟著鍵盤", () => {
    let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
    let frames: Array<() => void>;

    function setKeyboard(inset: number) {
      viewport.height = 800 - inset;
      act(() => {
        viewport.dispatchEvent(new Event("resize"));
        frames.splice(0).forEach((run) => run());
      });
    }

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

    it("bottom 等於鍵盤高度；鍵盤收起時加 safe area 底距", async () => {
      await mount();
      expect(root().style.bottom).toBe("0px");
      expect(root().className).toContain("pb-[calc(0.5rem+env(safe-area-inset-bottom))]");
      setKeyboard(300);
      expect(root().style.bottom).toBe("300px");
      expect(root().className).not.toContain("safe-area-inset-bottom");
      expect(root().className).toContain("pb-2");
      setKeyboard(0);
      expect(root().style.bottom).toBe("0px");
    });

    it("編輯器捲動的下緣預留鍵盤高加工具列外框高、其餘邊保留原值；卸載後等於掛上前", async () => {
      editor = createTestEditor([P("hello world", "a")]);
      stubAiFetch({ actions: [] });
      ({ rerenderHost } = renderAiHost({ editor, children: <Probe /> }));
      const props = () => editor.prosemirrorView!.props as { scrollMargin?: Partial<Record<string, number>>; scrollThreshold?: Partial<Record<string, number>> };
      const before = { scrollMargin: props().scrollMargin, scrollThreshold: props().scrollThreshold };
      rerenderHost({
        children: (
          <>
            <MobileEditToolbar editor={editor} />
            <Probe />
          </>
        ),
      });
      expect(props().scrollMargin).toEqual({ top: 72, right: 0, bottom: 68, left: 0 });
      setKeyboard(300);
      expect(props().scrollMargin?.bottom).toBe(368);
      expect(props().scrollMargin?.top).toBe(before.scrollMargin?.top);
      expect(props().scrollThreshold?.bottom).toBe(368);
      rerenderHost({ children: <Probe /> });
      expect(root_()).toBeNull();
      expect({ scrollMargin: props().scrollMargin, scrollThreshold: props().scrollThreshold }).toEqual(before);
    });

    it("頁首釘在頁面頂端（手機上捲的是文件）：上緣的 margin 與 threshold 都加上頁首高；卸載後還原", async () => {
      document.documentElement.style.setProperty(STICKY_TOP_VAR, "90px");
      try {
        editor = createTestEditor([P("hello world", "a")]);
        stubAiFetch({ actions: [] });
        ({ rerenderHost } = renderAiHost({ editor, children: <Probe /> }));
        const props = () => editor.prosemirrorView!.props as { scrollMargin?: Partial<Record<string, number>>; scrollThreshold?: Partial<Record<string, number>> };
        const before = { scrollMargin: props().scrollMargin, scrollThreshold: props().scrollThreshold };
        rerenderHost({
          children: (
            <>
              <MobileEditToolbar editor={editor} />
              <Probe />
            </>
          ),
        });
        expect(props().scrollMargin).toEqual({ top: 162, right: 0, bottom: 68, left: 0 });
        expect(props().scrollThreshold?.top).toBe(90);
        rerenderHost({ children: <Probe /> });
        expect({ scrollMargin: props().scrollMargin, scrollThreshold: props().scrollThreshold }).toEqual(before);
      } finally {
        document.documentElement.style.removeProperty(STICKY_TOP_VAR);
      }
    });

    it("鍵盤升起且編輯器有焦點：補一次捲動到游標；沒有焦點、或鍵盤收起時不補", async () => {
      await mount();
      const dispatch = vi.spyOn(editor.prosemirrorView!, "dispatch");
      const scrolled = () => dispatch.mock.calls.filter(([tr]) => (tr as { scrolledIntoView: boolean }).scrolledIntoView).length;
      setKeyboard(300);
      expect(scrolled()).toBe(0);
      setKeyboard(0);
      act(() => editor.focus());
      setKeyboard(300);
      expect(scrolled()).toBe(1);
      setKeyboard(0);
      expect(scrolled()).toBe(1);
    });
  });
});

describe("MobileToolbarButton", () => {
  it("停用用 aria-disabled：沒有原生 disabled、點擊不呼叫 onClick、mousedown 仍被擋", () => {
    const onClick = vi.fn();
    const view = render(
      <MobileToolbarButton label="Stuck" disabled onClick={onClick}>
        x
      </MobileToolbarButton>,
    );
    const stuck = view.getByRole("button", { name: "Stuck" });
    expect(stuck).not.toBeDisabled();
    expect(stuck).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(stuck);
    expect(onClick).not.toHaveBeenCalled();
    expect(fireEvent.mouseDown(stuck)).toBe(false);
  });
});

describe("MobileToolbarSpacer", () => {
  let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
  beforeEach(() => {
    viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      cb();
      return 1;
    });
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
  });

  it("aria-hidden；高度＝鍵盤高加工具列外框高（safe area 由內文卡的下內距給，這裡不加）", () => {
    const view = render(<MobileToolbarSpacer />);
    const spacer = () => view.container.querySelector<HTMLElement>("[data-mobile-toolbar-spacer]")!;
    expect(spacer()).toHaveAttribute("aria-hidden", "true");
    expect(spacer().style.height).toBe("60px");
    viewport.height = 500;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(spacer().style.height).toBe("360px");
  });
});
