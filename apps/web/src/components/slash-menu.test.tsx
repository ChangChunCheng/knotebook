import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterSuggestionItems } from "@blocknote/core";
import i18n from "@/i18n";
import { PHONE_EDIT_TOOLBAR_CLEARANCE_PX } from "@/components/ai/SelectionAiController";
import { P, mountEditor, row, shape, type AnyEditor } from "@/test/columns-fixtures";

/**
 * `/` slash 選單裡的 mermaid 項與連結項（issue #94、#99）。
 *
 * 這裡 mock 掉 BlockNote 的兩支 API，只驗**我們的組合邏輯**——尤其是
 * 「有沒有把預設項一起帶上」：接管 `/` 選單最典型的失效就是只回自己的項，
 * 靜默把整個內建選單換掉（比照 `collab/schema.ts` 對 `inlineContentSpecs`
 * 整組覆寫的同款雷）。
 *
 * ⚠ **假的預設項一定要帶 `group`**。第一版沒帶，於是 `lastIndexOf(group)` 永遠是 -1，
 * 五條測試全部走 `-1` 的 fallback 分支、生產環境走的卻是另一條——把整條組合邏輯換成
 * `return [item]`（＝上面說的那個最典型失效）測試照樣全綠（突變實測）。
 * 群組名與順序照 BlockNote 內建 en 字典的形狀（…Advanced → Media → Others）。
 *
 * 並排項要看游標位置，所以 `editor` 是真的編輯器、
 * mock 用 importOriginal 只換掉那兩支（其餘照真）。
 */

const defaultItemsMock = vi.hoisted(() => vi.fn());
const insertMock = vi.hoisted(() => vi.fn());

vi.mock("@blocknote/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@blocknote/react")>()),
  getDefaultReactSlashMenuItems: defaultItemsMock,
}));
vi.mock("@blocknote/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@blocknote/core")>()),
  insertOrUpdateBlockForSlashMenu: insertMock,
}));

const { PHONE_SLASH_MENU_FLOATING_OPTIONS, SLASH_MENU_PHONE_BOTTOM_CLEARANCE_PX, buildSlashMenuItems, slashMenuPhoneMiddleware, withoutSlashBadges } = await import("./slash-menu");

/** 真編輯器，游標在頂層段落（並排項會出現）。「不插入 block」類斷言仍打在被 mock 的 insertMock 上。 */
let editor: AnyEditor;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function mount(content = [P("p", "p0")], cursorId = "p0"): AnyEditor {
  const m = mountEditor(content);
  cleanups.push(m.destroy);
  m.editor.setTextCursorPosition(cursorId, "end");
  return m.editor;
}
/** 這個 app 的 `translate` 回的是翻譯後字串；測試用 key 當字串即可（帶 `n` 時接在後面），但分組名要對得上假預設項。 */
const translate = (key: string, options?: Record<string, unknown>): string =>
  key === "note.mermaid.slashGroup" ? "Advanced" : options?.n !== undefined ? `${key}:${String(options.n)}` : key;
const COLUMN_TITLES = ["note.columns.slashTitle:2", "note.columns.slashTitle:3", "note.columns.slashTitle:4"];
/** 大部分測試不在乎連結項被點了會發生什麼，給個 no-op 佔位。 */
const noopInsertLink = () => {};

/** 內建項的形狀：有 group，且我們的分組（Advanced）**後面還有別的分組**。 */
const DEFAULT_ITEMS = [
  { title: "Paragraph", group: "Basic blocks" },
  { title: "Heading 1", group: "Basic blocks" },
  { title: "Table", group: "Advanced" },
  { title: "Image", group: "Media" },
  { title: "Emoji", group: "Others" },
];

/** 分組標題序列（選單只在 group 換手時畫標題）。重複出現＝畫面上多一個同名標題。 */
function groupRuns(items: { group?: string }[]): string[] {
  return items.map((item) => item.group).filter((group, index, all) => group !== all[index - 1]) as string[];
}

beforeEach(() => {
  defaultItemsMock.mockReset();
  insertMock.mockReset();
  defaultItemsMock.mockReturnValue(DEFAULT_ITEMS.map((item) => ({ ...item })));
  editor = mount();
});

/** mermaid 那一項（不能用 `.at(-1)`：它插在自己的分組裡，後面還有 Media／Others）。 */
function mermaidItem() {
  return buildSlashMenuItems(editor, translate, noopInsertLink).find((item) => item.title === "note.mermaid.slashTitle");
}

describe("buildSlashMenuItems", () => {
  it("預設項全數保留、順序不變（接管 / 選單不得把內建選單換掉）", () => {
    const titles = buildSlashMenuItems(editor, translate, noopInsertLink).map((item) => item.title);
    expect(titles.filter((title) => !title.startsWith("note."))).toEqual(
      DEFAULT_ITEMS.map((item) => item.title),
    );
  });

  it("mermaid 項與連結項插在同分組的最後一項之後（不是塞在整份清單最尾）", () => {
    const titles = buildSlashMenuItems(editor, translate, noopInsertLink).map((item) => item.title);
    expect(titles).toEqual([
      "Paragraph",
      "Heading 1",
      "Table",
      "note.mermaid.slashTitle",
      "note.link.slashTitle",
      ...COLUMN_TITLES,
      "Image",
      "Emoji",
    ]);
  });

  it("不會多出第二個同名分組標題（塞在最尾就會）", () => {
    const runs = groupRuns(buildSlashMenuItems(editor, translate, noopInsertLink));
    expect(runs).toEqual(["Basic blocks", "Advanced", "Media", "Others"]);
  });

  it("分組名在內建清單裡不存在時，退回接在最後（不會整組不見）", () => {
    const titles = buildSlashMenuItems(
      editor,
      (key, options) => (key === "note.mermaid.slashGroup" ? "不存在的分組" : translate(key, options)),
      noopInsertLink,
    ).map((i) => i.title);
    expect(titles).toEqual([...DEFAULT_ITEMS.map((item) => item.title), "note.mermaid.slashTitle", "note.link.slashTitle", ...COLUMN_TITLES]);
  });

  it("mermaid 項有中英文別名（打 diagram 或 圖表 都找得到）", () => {
    expect(mermaidItem()?.aliases).toEqual(expect.arrayContaining(["mermaid", "diagram", "flowchart", "圖表"]));
  });

  it("點下去插入的是 type:\"mermaid\" 的 block", () => {
    mermaidItem()?.onItemClick();
    expect(insertMock).toHaveBeenCalledWith(editor, { type: "mermaid" });
  });

  it("插入的 block 不帶 code prop（讓 propSchema 的 default 生效，只有一處真相）", () => {
    mermaidItem()?.onItemClick();
    const [, block] = insertMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(block).not.toHaveProperty("props");
  });

  it("連結項與圖表項在同一分組（分組鍵是共用常數）", () => {
    const items = buildSlashMenuItems(editor, translate, noopInsertLink);
    const link = items.find((i) => i.title === "note.link.slashTitle");
    const mermaid = items.find((i) => i.title === "note.mermaid.slashTitle");
    expect(link?.group).toBe(mermaid?.group);
  });

  it("點連結項會呼叫 onInsertLink，且不插入任何 block", () => {
    const onInsertLink = vi.fn();
    buildSlashMenuItems(editor, translate, onInsertLink)
      .find((i) => i.title === "note.link.slashTitle")
      ?.onItemClick();
    expect(onInsertLink).toHaveBeenCalledOnce();
    // ⚠ 打在被 mock 的 insert 上：這個檔的 `insertOrUpdateBlockForSlashMenu` 是 mock、不會真的改文件，
    // 拿 `editor.document` 前後比對永遠相等，抓不到「其實有插 block」的迴歸。
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("連結項有中英文別名（打 link 或 連結 都找得到）", () => {
    const items = buildSlashMenuItems(editor, translate, noopInsertLink);
    const link = items.find((i) => i.title === "note.link.slashTitle");
    expect(link?.aliases).toEqual(expect.arrayContaining(["link", "url", "連結"]));
  });
});

describe("並排項 /grid N", () => {
  const columnItems = <T extends { aliases?: readonly string[] }>(items: T[]) => items.filter((item) => item.aliases?.includes("grid"));

  it("SL1：三項緊接在連結項之後、與連結項同一 group", () => {
    const items = buildSlashMenuItems(editor, translate, noopInsertLink);
    const linkIndex = items.findIndex((item) => item.title === "note.link.slashTitle");
    expect(items.slice(linkIndex + 1, linkIndex + 4).map((item) => item.title)).toEqual(COLUMN_TITLES);
    expect(items.slice(linkIndex + 1, linkIndex + 4).map((item) => item.group)).toEqual(Array(3).fill(items[linkIndex]!.group));
  });

  it("SL2：別名——grid 得三項；grid3／grid 3 只得 3 欄；並排、欄、columns 各得三項", () => {
    // 標題換成不含任何查詢字的字串，命中只能來自別名（key 字串本身含 `columns`）。
    const opaque = (key: string, options?: Record<string, unknown>) => (options?.n !== undefined ? `T${String(options.n)}` : translate(key));
    const items = buildSlashMenuItems(editor, opaque, noopInsertLink);
    const titles = (query: string) => filterSuggestionItems(items, query).map((item) => item.title);
    expect(titles("grid")).toEqual(["T2", "T3", "T4"]);
    expect(titles("grid3")).toEqual(["T3"]);
    expect(titles("grid 3")).toEqual(["T3"]);
    expect(titles("並排")).toEqual(["T2", "T3", "T4"]);
    expect(titles("欄")).toEqual(["T2", "T3", "T4"]);
    expect(titles("columns")).toEqual(["T2", "T3", "T4"]);
  });

  it("SL3：游標在欄內 → 沒有這三項，其他項不變", () => {
    const top = buildSlashMenuItems(editor, translate, noopInsertLink).map((item) => item.title);
    const inColumn = mount([row([[P("a", "a1")], [P("b", "b1")]], "r")], "b1");
    const titles = buildSlashMenuItems(inColumn, translate, noopInsertLink).map((item) => item.title);
    expect(titles).toEqual(top.filter((title) => !COLUMN_TITLES.includes(title)));
  });

  it("SL4：標題與說明——zh-TW「並排 2 欄」、en「2 columns」", async () => {
    await i18n.changeLanguage("zh-TW");
    const zh = columnItems(buildSlashMenuItems(editor, i18n.t.bind(i18n), noopInsertLink));
    expect(zh.map((item) => item.title)).toEqual(["並排 2 欄", "並排 3 欄", "並排 4 欄"]);
    expect(zh[0]!.subtext).toBe("把內容分成左右並排的幾欄");
    await i18n.changeLanguage("en");
    const en = columnItems(buildSlashMenuItems(editor, i18n.t.bind(i18n), noopInsertLink));
    expect(en.map((item) => item.title)).toEqual(["2 columns", "3 columns", "4 columns"]);
    expect(en[0]!.subtext).toBe("Place blocks side by side");
  });

  it("SL5：點「2 欄」→ 在游標所在段落後面建 2 欄的列", () => {
    const target = mount([P("x", "x0")], "x0");
    buildSlashMenuItems(target, translate, noopInsertLink)
      .find((item) => item.title === "note.columns.slashTitle:2")!
      .onItemClick();
    expect(shape(target)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph)]  paragraph");
  });
});

describe("withoutSlashBadges（手機不顯示快捷鍵欄）", () => {
  const items = [
    { title: "Heading 1", badge: "Ctrl-Alt-1", onItemClick: () => {} },
    { title: "Table", onItemClick: () => {} },
  ];

  it("每一項都沒有 badge，項目數與順序不變，其餘欄位照舊", () => {
    const stripped = withoutSlashBadges(items);
    expect(stripped.map((item) => item.title)).toEqual(["Heading 1", "Table"]);
    expect(stripped.every((item) => !("badge" in item))).toBe(true);
    expect(stripped[0]!.onItemClick).toBe(items[0]!.onItemClick);
  });

  it("不改原本的項目（docked 與手機共用同一份來源）", () => {
    withoutSlashBadges(items);
    expect(items[0]!.badge).toBe("Ctrl-Alt-1");
  });
});

describe("slashMenuPhoneMiddleware（手機的高度與翻轉）", () => {
  type SizeOptions = { apply: (args: { elements: { floating: { style: Record<string, string> } }; availableHeight: number }) => void; padding: { bottom: number } };
  type PlacementOptions = { padding: { bottom: number; top: number }; allowedPlacements: string[] };
  const byName = (name: string) => slashMenuPhoneMiddleware().find((entry) => entry.name === name) as unknown as { options: [never, unknown] };

  it("size：最大高度 ＝ min(50vh, 可用高度)，可用高度為負時夾到 0", () => {
    const options = byName("size").options[0] as SizeOptions;
    const floating = { style: {} as Record<string, string> };
    options.apply({ elements: { floating }, availableHeight: 312 });
    expect(floating.style.maxHeight).toBe("min(50vh, 312px)");
    options.apply({ elements: { floating }, availableHeight: -5 });
    expect(floating.style.maxHeight).toBe("min(50vh, 0px)");
  });

  it("shift 的邊界留白也是 8（與註解的四周留白一致）", () => {
    expect((byName("shift").options[0] as { padding: number }).padding).toBe(8);
  });

  it("size 與 autoPlacement 的下緣都扣掉編輯工具列（可用高度與翻轉判斷同一條線）", () => {
    const size = byName("size").options[0] as SizeOptions;
    const placement = byName("autoPlacement").options[0] as PlacementOptions;
    expect(size.padding.bottom).toBeGreaterThanOrEqual(SLASH_MENU_PHONE_BOTTOM_CLEARANCE_PX);
    expect(placement.padding.bottom).toBe(size.padding.bottom);
    expect(placement.allowedPlacements).toEqual(["bottom-start", "top-start"]);
  });

  it("下緣留白 ＝ 編輯工具列外框高度 ＋ 8", () => {
    expect(SLASH_MENU_PHONE_BOTTOM_CLEARANCE_PX).toBe(PHONE_EDIT_TOOLBAR_CLEARANCE_PX + 8);
  });

  it("PHONE_SLASH_MENU_FLOATING_OPTIONS 把它放進 useFloatingOptions.middleware", () => {
    expect(PHONE_SLASH_MENU_FLOATING_OPTIONS.useFloatingOptions?.middleware?.map((entry) => entry && "name" in entry && entry.name)).toEqual(["offset", "autoPlacement", "shift", "size"]);
  });
});
