import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as Y from "yjs";
import i18n from "@/i18n";
import { NOOP_VERSIONS, VersionsProvider, type VersionsContextValue } from "@/lib/versions-context";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { ThemeProvider } from "@/theme";
import type { OutlineHeading } from "@/components/outline/headings";
import type { NoteOutlineProps } from "@/components/outline/NoteOutline";
import { OUTLINE_PINNED_STORAGE_KEY } from "@/components/outline/outline-pin";
import type { OutlineBox } from "@/components/outline/use-outline-box";
import { resetNoteWidthsForTest, setNoteWidth } from "@/components/note-width";
import { ARTICLE_COLUMN_MAX, articleColumn, type ArticleColumnState } from "@/components/ui/article-column";
import { NoteEditor } from "./NoteEditor";

const WIDE_BOX: OutlineBox = { width: 1072, height: 700, columnRight: 991.5 };

const outline = vi.hoisted(() => ({
  headings: [] as OutlineHeading[],
  props: [] as NoteOutlineProps[],
  box: null as OutlineBox | null,
  /** Renders in which `useOutlineBox` got both elements (the real hook measures only then). */
  measured: 0,
}));

vi.mock("@/components/outline/use-outline-headings", () => ({
  useOutlineHeadings: () => outline.headings,
}));
// Like the real hook: nothing to measure until both elements are passed in.
vi.mock("@/components/outline/use-outline-box", () => ({
  useOutlineBox: (scrollEl: HTMLElement | null, columnEl: HTMLElement | null) => {
    if (scrollEl === null || columnEl === null) return null;
    outline.measured += 1;
    return outline.box;
  },
}));
vi.mock("@/components/outline/NoteOutline", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/outline/NoteOutline")>();
  return {
    ...original,
    NoteOutline: (props: NoteOutlineProps) => {
      outline.props.push(props);
      return <div data-testid="outline-stub" />;
    },
  };
});
// The versions panel itself is not under test here; keep it from fetching.
vi.mock("@/components/versions/VersionsLazy", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/versions/VersionsLazy")>();
  return { ...original, VersionsPanel: () => <div data-testid="versions-panel-stub" /> };
});

const HEADINGS: OutlineHeading[] = [
  { id: "h-intro", level: 1, text: "Intro" },
  { id: "h-usage", level: 2, text: "Usage" },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(json({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

async function renderAt(tier: LayoutTier, versions: Partial<VersionsContextValue> = {}, previewSlot?: ReactNode) {
  stubLayoutTier(tier);
  const doc = new Y.Doc();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (v: Partial<VersionsContextValue>, preview: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <VersionsProvider value={{ ...NOOP_VERSIONS, enabled: true, noteId: "note-1", ...v }}>
          <NoteEditor
            doc={doc}
            provider={{ awareness: null } as never}
            editable
            user={{ id: "u1", name: "alice" }}
            noteId="note-1"
            headerSlot={<div data-testid="header-marker">header</div>}
            previewSlot={preview}
          />
        </VersionsProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
  const utils = render(tree(versions, previewSlot));
  const editor = await screen.findByTestId("note-editor");
  // 大綱出現滿一個畫格後欄才有釘住過場：先過一個畫格，之後的斷言看的是穩定下來的樣子。
  await nextFrame();
  // 欄 → 流程包裝 → 捲動容器。
  const scroll = editor.parentElement!.parentElement!.parentElement!;
  /** Re-renders with new versions state or preview, picking up whatever `outline.box` is now. */
  const update = (v: Partial<VersionsContextValue> = versions, preview: ReactNode = previewSlot) => utils.rerender(tree(v, preview));
  return { ...utils, doc, scroll, update };
}

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
const stub = () => screen.queryByTestId("outline-stub");
const lastProps = () => outline.props[outline.props.length - 1]!;
const column = () => screen.getByTestId("article-column");
const PIN_TRANSITION = "transition-[max-width,left]";
const PINNED_MAX = ARTICLE_COLUMN_MAX["standard-pinned"].split(" ")[0]!;

/**
 * The column carries exactly the width-chain classes of `state` and none of the other states' widths;
 * with `motion` the pin transition is on, without it the column has neither the transition nor `left-0`.
 */
function expectColumn(state: ArticleColumnState, motion = true) {
  const expected = articleColumn(state, { pinMotion: motion }).split(" ");
  expect(column()).toHaveClass(...expected);
  const others = (Object.keys(ARTICLE_COLUMN_MAX) as ArticleColumnState[])
    .filter((s) => s !== state)
    .flatMap((s) => ARTICLE_COLUMN_MAX[s].split(" "))
    .filter((c) => !expected.includes(c));
  for (const c of others) expect(column()).not.toHaveClass(c);
  if (!motion) {
    expect(column()).not.toHaveClass(PIN_TRANSITION);
    expect(column()).not.toHaveClass("left-0");
  }
}

/**
 * Starts recording; the returned function stops and gives every class string the column has had since, in order
 * (from attribute mutation records), ending with the current one. Each commit that changes the class is one entry.
 */
function trackColumnClasses(): () => string[] {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((list) => records.push(...list));
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  return () => {
    records.push(...observer.takeRecords());
    observer.disconnect();
    const own = records.filter((r) => (r.target as HTMLElement).dataset?.testid === "article-column");
    return [...own.map((r) => r.oldValue ?? ""), column().className];
  };
}

describe("NoteEditor：右側標題大綱的掛載條件", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    stubFetch();
    outline.headings = HEADINGS;
    outline.props = [];
    outline.box = WIDE_BOX;
    outline.measured = 0;
    resetNoteWidthsForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("沒有標題 → 不掛，也不量版面", async () => {
    outline.headings = [];
    const { doc } = await renderAt("docked");
    expect(stub()).toBeNull();
    expect(outline.measured).toBe(0);
    doc.destroy();
  });

  it("有標題、固定段 → 掛一份，在頁首槽位之後、捲動容器之前；拿到捲動容器，泡泡在", async () => {
    const { doc, scroll } = await renderAt("docked");
    expect(screen.getAllByTestId("outline-stub")).toHaveLength(1);
    const header = document.querySelector("[data-note-header-slot]")!;
    expect(header.compareDocumentPosition(stub()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stub()!.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 錨點不在捲動容器裡（細線不隨內文捲）。
    expect(scroll.contains(stub())).toBe(false);
    expect(stub()!.parentElement).toBe(scroll.parentElement);
    expect(scroll).toHaveClass("overflow-y-auto");
    const props = lastProps();
    expect(props.scrollEl).toBe(scroll);
    expect(props.headings).toBe(HEADINGS);
    expect(props.box).toEqual({ width: 1072, height: 700, columnRight: 991.5 });
    expect(props.bubbleShown).toBe(true);
    // 沒有釘住偏好：標準寬、容器夠寬，可以釘但沒釘。
    expect(props.pinned).toBe(false);
    expect(props.pinAvailable).toBe(true);
    expectColumn("standard");
    doc.destroy();
  });

  it("版本預覽中 → 不掛", async () => {
    const { doc } = await renderAt("docked", {}, <div data-testid="preview-marker">preview</div>);
    expect(screen.getByTestId("preview-marker")).toBeInTheDocument();
    expect(stub()).toBeNull();
    doc.destroy();
  });

  it("版本面板開著：浮動段（面板蓋在卡上）不掛；固定段（面板是第三欄）掛、沒有泡泡", async () => {
    const overlay = await renderAt("overlay", { panelOpen: true, mode: "panel" });
    expect(stub()).toBeNull();
    overlay.unmount();
    overlay.doc.destroy();

    outline.props = [];
    const docked = await renderAt("docked", { panelOpen: true, mode: "panel" });
    expect(stub()).not.toBeNull();
    expect(lastProps().bubbleShown).toBe(false);
    docked.doc.destroy();
  });

  it("浮動段、面板沒開 → 掛（平板寬度照常有大綱）", async () => {
    const { doc } = await renderAt("overlay");
    expect(stub()).not.toBeNull();
    expect(lastProps().bubbleShown).toBe(true);
    doc.destroy();
  });

  it("手機段 → 不掛，也不量版面", async () => {
    const { doc } = await renderAt("phone");
    expect(stub()).toBeNull();
    expect(outline.measured).toBe(0);
    doc.destroy();
  });

  it("沒有版本功能（檢視者）→ 掛、沒有泡泡", async () => {
    const { doc } = await renderAt("docked", { enabled: false, noteId: null });
    expect(stub()).not.toBeNull();
    expect(lastProps().bubbleShown).toBe(false);
    doc.destroy();
  });
});

describe("NoteEditor：釘住大綱", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    window.localStorage.setItem(OUTLINE_PINNED_STORAGE_KEY, "1");
    stubFetch();
    outline.headings = HEADINGS;
    outline.props = [];
    outline.box = WIDE_BOX;
    outline.measured = 0;
    resetNoteWidthsForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetNoteWidthsForTest();
  });

  it("標準寬、容器 1072、偏好釘住 → 欄換成釘住那一態（含過場），大綱拿到 pinned、pinAvailable", async () => {
    const { doc } = await renderAt("docked");
    expectColumn("standard-pinned");
    expect(lastProps().pinned).toBe(true);
    expect(lastProps().pinAvailable).toBe(true);
    doc.destroy();
  });

  it("版本預覽中 → 沒有大綱，欄回到未釘住的標準寬、沒有過場", async () => {
    const { doc } = await renderAt("docked", {}, <div data-testid="preview-marker">preview</div>);
    expect(stub()).toBeNull();
    expectColumn("standard", false);
    doc.destroy();
  });

  it("640-1279 版本面板浮在卡上 → 沒有大綱，欄回到未釘住的標準寬、沒有過場", async () => {
    const { doc } = await renderAt("overlay", { panelOpen: true, mode: "panel" });
    expect(stub()).toBeNull();
    expectColumn("standard", false);
    doc.destroy();
  });

  it("開筆記：欄第一次換成釘住寬度的那一次沒有過場（不從標準寬滑過去）；過一個畫格後按釘選才有過場", async () => {
    const history = trackColumnClasses();
    const { doc } = await renderAt("docked");
    const values = history();
    const firstPinned = values.find((c) => c.split(" ").includes(PINNED_MAX));
    expect(firstPinned, values.join("\n")).toBeDefined();
    expect(firstPinned!.split(" ")).not.toContain(PIN_TRANSITION);
    // 過了一個畫格（renderAt 已等過）：過場打開。
    expectColumn("standard-pinned");

    act(() => lastProps().onPinnedChange(false));
    expectColumn("standard");
    act(() => lastProps().onPinnedChange(true));
    expectColumn("standard-pinned");
    doc.destroy();
  });

  it("離開版本預覽、關掉浮動版本面板：大綱回來時欄直接是釘住寬度，沒有過場；一個畫格後才有", async () => {
    const preview = await renderAt("docked", {}, <div data-testid="preview-marker">preview</div>);
    let history = trackColumnClasses();
    preview.update({}, null);
    expect(stub()).not.toBeNull();
    let values = history();
    expect(values[values.length - 1]!.split(" ")).toContain(PINNED_MAX);
    for (const c of values) expect(c.split(" ")).not.toContain(PIN_TRANSITION);
    await nextFrame();
    expectColumn("standard-pinned");
    preview.unmount();
    preview.doc.destroy();

    const overlay = await renderAt("overlay", { panelOpen: true, mode: "panel" });
    history = trackColumnClasses();
    overlay.update({ panelOpen: false, mode: "panel" });
    expect(stub()).not.toBeNull();
    values = history();
    expect(values[values.length - 1]!.split(" ")).toContain(PINNED_MAX);
    for (const c of values) expect(c.split(" ")).not.toContain(PIN_TRANSITION);
    await nextFrame();
    expectColumn("standard-pinned");
    overlay.doc.destroy();
  });

  it("釘住中開預覽再離開、開浮動面板再關：回來那一次一樣沒有過場（不沿用先前打開的過場）", async () => {
    const note = await renderAt("docked");
    expectColumn("standard-pinned");
    note.update({}, <div data-testid="preview-marker">preview</div>);
    expectColumn("standard", false);
    await nextFrame();
    let history = trackColumnClasses();
    note.update({}, null);
    let values = history();
    expect(values[values.length - 1]!.split(" ")).toContain(PINNED_MAX);
    for (const c of values) expect(c.split(" ")).not.toContain(PIN_TRANSITION);
    await nextFrame();
    expectColumn("standard-pinned");
    note.unmount();
    note.doc.destroy();

    const tablet = await renderAt("overlay");
    expectColumn("standard-pinned");
    tablet.update({ panelOpen: true, mode: "panel" });
    expectColumn("standard", false);
    await nextFrame();
    history = trackColumnClasses();
    tablet.update({ panelOpen: false, mode: "panel" });
    values = history();
    expect(values[values.length - 1]!.split(" ")).toContain(PINNED_MAX);
    for (const c of values) expect(c.split(" ")).not.toContain(PIN_TRANSITION);
    tablet.doc.destroy();
  });

  it("容器 912 放不下 640 的欄 → 退回細線、偏好照舊；寬回 1072 → 自動再釘", async () => {
    outline.box = { ...WIDE_BOX, width: 912, columnRight: 836 };
    const { doc, update } = await renderAt("docked");
    expectColumn("standard");
    expect(lastProps().pinAvailable).toBe(false);
    expect(lastProps().pinned).toBe(false);
    expect(window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY)).toBe("1");

    outline.box = WIDE_BOX;
    update();
    expectColumn("standard-pinned");
    expect(lastProps().pinned).toBe(true);
    doc.destroy();
  });

  it("固定段開版本面板、容器 1072 → 740 → 退回細線；關面板、寬回 1072 → 再釘", async () => {
    const { doc, update } = await renderAt("docked");
    expectColumn("standard-pinned");

    outline.box = { ...WIDE_BOX, width: 740, columnRight: 710 };
    update({ panelOpen: true, mode: "panel" });
    expect(stub()).not.toBeNull();
    expect(lastProps().pinned).toBe(false);
    expect(lastProps().pinAvailable).toBe(false);
    expectColumn("standard");

    outline.box = WIDE_BOX;
    update({});
    expect(lastProps().pinned).toBe(true);
    expectColumn("standard-pinned");
    expect(window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY)).toBe("1");
    doc.destroy();
  });

  it("筆記改寬版 → 欄是寬版、不能釘；改回標準 → 再釘", async () => {
    const { doc } = await renderAt("docked");
    expectColumn("standard-pinned");

    act(() => setNoteWidth("note-1", "wide"));
    expectColumn("wide");
    expect(lastProps().pinAvailable).toBe(false);
    expect(lastProps().pinned).toBe(false);

    act(() => setNoteWidth("note-1", "standard"));
    expectColumn("standard-pinned");
    expect(lastProps().pinned).toBe(true);
    doc.destroy();
  });

  it("沒有偏好 → 可以釘但沒釘；按釘選（onPinnedChange(true)）→ 記住偏好、欄換成釘住那一態", async () => {
    window.localStorage.removeItem(OUTLINE_PINNED_STORAGE_KEY);
    const { doc } = await renderAt("docked");
    expect(lastProps().pinAvailable).toBe(true);
    expect(lastProps().pinned).toBe(false);
    expectColumn("standard");

    act(() => lastProps().onPinnedChange(true));
    expect(window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY)).toBe("1");
    expect(lastProps().pinned).toBe(true);
    expectColumn("standard-pinned");

    act(() => lastProps().onPinnedChange(false));
    expect(window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY)).toBeNull();
    expectColumn("standard");
    doc.destroy();
  });
});
