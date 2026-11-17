import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
import { NoteEditor } from "./NoteEditor";

const outline = vi.hoisted(() => ({
  headings: [] as OutlineHeading[],
  props: [] as NoteOutlineProps[],
}));

vi.mock("@/components/outline/use-outline-headings", () => ({
  useOutlineHeadings: () => outline.headings,
}));
vi.mock("@/components/outline/use-outline-box", () => ({
  useOutlineBox: () => ({ width: 1072, height: 700, columnRight: 991.5 }),
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
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <VersionsProvider value={{ ...NOOP_VERSIONS, enabled: true, noteId: "note-1", ...versions }}>
          <NoteEditor
            doc={doc}
            provider={{ awareness: null } as never}
            editable
            user={{ id: "u1", name: "alice" }}
            noteId="note-1"
            headerSlot={<div data-testid="header-marker">header</div>}
            previewSlot={previewSlot}
          />
        </VersionsProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  const editor = await screen.findByTestId("note-editor");
  // 欄 → 流程包裝 → 捲動容器。
  const scroll = editor.parentElement!.parentElement!.parentElement!;
  return { ...utils, doc, scroll };
}

const stub = () => screen.queryByTestId("outline-stub");
const lastProps = () => outline.props[outline.props.length - 1]!;

describe("NoteEditor：右側標題大綱的掛載條件", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    stubFetch();
    outline.headings = HEADINGS;
    outline.props = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("沒有標題 → 不掛", async () => {
    outline.headings = [];
    const { doc } = await renderAt("docked");
    expect(stub()).toBeNull();
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
    expect(props.pinned).toBe(false);
    expect(props.pinAvailable).toBe(false);
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

  it("手機段 → 不掛", async () => {
    const { doc } = await renderAt("phone");
    expect(stub()).toBeNull();
    doc.destroy();
  });

  it("沒有版本功能（檢視者）→ 掛、沒有泡泡", async () => {
    const { doc } = await renderAt("docked", { enabled: false, noteId: null });
    expect(stub()).not.toBeNull();
    expect(lastProps().bubbleShown).toBe(false);
    doc.destroy();
  });
});
