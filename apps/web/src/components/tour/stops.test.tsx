import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { AiActionDto, NoteDto, UserDto } from "@knotebook/shared";
import type { CollabState } from "@/collab/connection";
import i18n from "@/i18n";
import tourEn from "@/i18n/tour.en.json";
import tourZhTW from "@/i18n/tour.zh-TW.json";
import shortcutsEn from "@/i18n/shortcuts.en.json";
import shortcutsZhTW from "@/i18n/shortcuts.zh-TW.json";
import { ActiveNoteProvider } from "@/lib/active-note";
import { useIsPhone } from "@/lib/layout-tiers";
import { getShellControls } from "@/lib/tour-bridge";
import { findDrawerButton, findTourTarget, findUserMenuTrigger } from "@/lib/tour-find";
import { tourTarget, type TourTargetId } from "@/lib/tour-targets";
import { useVersionsController, VersionsProvider } from "@/lib/versions-context";
import { ThemeProvider } from "@/theme";
import { AppShell, SidebarDrawerButton } from "@/components/AppShell";
import { BackToListButton } from "@/components/BackToListButton";
import { NoteBrowseBar } from "@/components/NoteBrowseBar";
import { CornerStack } from "@/components/CornerStack";
import { NarrowTopBar } from "@/components/NarrowTopBar";
import { NoteMenu } from "@/components/NoteMenu";
import { ShareDialog } from "@/components/ShareDialog";
import { OWNER_PERMS } from "@/test/fixtures";
import { stubLayoutTier } from "@/test/layout-tier";
import { FOLDER_LIST_EMPTY, folderDto } from "@/test/folder-fixtures";
import type { FolderListDto } from "@knotebook/shared";
import { stopTitle } from "./sequence";
import { FULL_TOUR, prepareStop, STOPS, stopBody, stopScreen, stopShownIn, stopTarget, type StopContext, type StopId } from "./stops";

// 測試宿主照筆記頁的接線：真的 AppShell（側欄、搜尋框、tab 列、新增鈕、使用者選單），
// 主內容區放筆記頁頁首用的同一批元件（「‹」、漢堡鈕、分享、⋮）、右下角的版本泡泡與手機底部的圓形鈕。
// 版面一律經 `stubLayoutTier` 換（`docked`＝寬視窗、`overlay`＝側欄浮動、`phone`＝手機）。

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  handle: "tester",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const NOTE: NoteDto = {
  id: "77777777-7777-7777-7777-777777777777",
  title: "Tour Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "tour-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const CONNECTED: CollabState = { phase: "connected", role: "owner" };

function json(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
}

function stubFetch(folders: FolderListDto = FOLDER_LIST_EMPTY) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return json([]);
      if (url === "/api/auth/me") return json(USER);
      if (url === "/api/folders") return json(folders);
      if (url === "/api/notes" && method === "GET") return json([NOTE]);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** 寬視窗或側欄浮動（640～1279）；手機另用 `stubLayoutTier("phone")`。 */
function stubViewport(narrow: boolean) {
  stubLayoutTier(narrow ? "overlay" : "docked");
}

function NotePageStandIn({ withShare }: { withShare: boolean }) {
  const versions = useVersionsController({ noteId: NOTE.id, enabled: true });
  const phone = useIsPhone();
  return (
    <VersionsProvider value={versions}>
      <header>
        <BackToListButton />
        <SidebarDrawerButton />
        {withShare && <ShareDialog note={NOTE} />}
        <NoteMenu note={NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />
      </header>
      <CornerStack />
      {/* 手機筆記畫面底部的圓形鈕（筆記頁只在手機掛，同 NotePage）。 */}
      {phone && <NoteBrowseBar note={NOTE} />}
      {/* 示範筆記裡現成的 `[[` 連結。 */}
      <a href="/somewhere" {...tourTarget("wikilink")}>
        linked note
      </a>
      {/* 示範筆記裡用 `/` 插的流程圖。 */}
      <div {...tourTarget("flowchart")}>a flowchart</div>
      {/* 框選後浮出的格式工具列（真的是 portal 出來的浮層，這裡直接放在頁面裡）。 */}
      <div data-kb-formatting-toolbar-popover="">
        <button type="button" aria-label="Bold">
          B
        </button>
        <button type="button" aria-label="AI">
          AI
        </button>
      </div>
    </VersionsProvider>
  );
}

async function renderPage({
  withShare = true,
  home = false,
  inert = false,
  at = `/n/${NOTE.ownerHandle}/${NOTE.slug}`,
}: { withShare?: boolean; home?: boolean; inert?: boolean; at?: string } = {}) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[at]}>
          <ActiveNoteProvider>
            <Routes>
              {/* 首頁（手機上就是清單畫面）。 */}
              <Route path="/" element={<AppShell inert={inert}>{null}</AppShell>} />
              <Route
                path="/n/:handle/:slug"
                element={
                  <AppShell inert={inert}>
                    {home ? <NarrowTopBar /> : <NotePageStandIn withShare={withShare} />}
                  </AppShell>
                }
              />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  // 使用者選單要等 /api/auth/me 回來才有名稱。
  await screen.findByRole("button", { name: USER.displayName });
}

const AI_ACTION: AiActionDto = { id: "rewrite", name: "Rewrite", applyMode: "preview", kind: "quick" };

function ctx(searchQuery = "", aiActions: readonly AiActionDto[] = []): StopContext {
  return { searchQuery, aiActions, sampleNoteId: NOTE.id, liveStops: false };
}

const aside = () => document.querySelector<HTMLElement>("aside[data-sidebar-instance]")!;
const pageHeader = () => document.querySelector<HTMLElement>("main header")!;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem("sidebar.tab");
});

describe("站點表", () => {
  it("完整導覽的順序；每個站點恰好出現一次", () => {
    expect(FULL_TOUR).toEqual(["tabs", "newNote", "folders", "search", "header", "versions", "wikilink", "ai", "slash", "userMenu"]);
    expect(Object.keys(STOPS).sort()).toEqual([...FULL_TOUR].sort());
    for (const id of FULL_TOUR) expect(STOPS[id].id).toBe(id);
  });

  it.each([
    ["en", tourEn],
    ["zh-TW", tourZhTW],
  ] as const)("%s：每站的標題、說明（含側欄浮動與手機的說明）都有字", (_lang, bundle) => {
    for (const stop of Object.values(STOPS)) {
      for (const key of [stop.titleKey, stop.bodyKey, stop.narrowBodyKey, stop.phoneTitleKey, stop.phoneBodyKey].filter((k) => k !== undefined)) {
        const value = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundle);
        expect(typeof value === "string" && value.length > 0, key).toBe(true);
      }
    }
  });
});

describe("寬視窗：目標", () => {
  beforeEach(() => stubViewport(false));

  it("每站都找得到，而且是側欄卡片／頁首裡的那一顆", async () => {
    await renderPage();
    const side = within(aside());
    const header = within(pageHeader());
    // folders 的目標在「我的筆記」標題列；預設 tab 就是我的筆記。
    await waitFor(() => expect(stopTarget(STOPS.folders, ctx())).toHaveLength(1));

    const expected: Record<StopId, HTMLElement[]> = {
      tabs: [side.getByRole("tablist")],
      newNote: [side.getByRole("button", { name: "New note" })],
      folders: [side.getByRole("button", { name: "New folder" })],
      search: [side.getByRole("textbox", { name: "Search notes" })],
      header: [header.getByRole("button", { name: "Share" }), header.getByRole("button", { name: "More" })],
      versions: [screen.getByTestId("versions-bubble")],
      wikilink: [screen.getByRole("link", { name: "linked note" })],
      ai: [screen.getByRole("button", { name: "AI" })],
      slash: [screen.getByText("a flowchart")],
      userMenu: [side.getByRole("button", { name: "Ann" })],
    };
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual(expected[id]);
  });

  it("頁面上沒有目標時回空陣列", () => {
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual([]);
  });

  it("頁首的寬度鈕看得到時一起挖亮（分享、寬度、⋮），被容器查詢收起（量不到尺寸）時只挖亮分享與 ⋮", () => {
    const make = (id: string, size: number) => {
      const el = document.createElement("button");
      el.setAttribute("data-kb-tour-target", id);
      el.getBoundingClientRect = () => new DOMRect(0, 0, size, size);
      document.body.append(el);
      return el;
    };
    const share = make("share", 30);
    const width = make("noteWidth", 30);
    const more = make("noteMenu", 30);
    expect(stopTarget(STOPS.header, ctx())).toEqual([share, width, more]);
    width.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    expect(stopTarget(STOPS.header, ctx())).toEqual([share, more]);
    for (const el of [share, width, more]) el.remove();
  });

  it("頁首要分享鈕與 ⋮ 都在才算找到（只找到一顆不挖亮）", async () => {
    await renderPage({ withShare: false });
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    expect(stopTarget(STOPS.header, ctx())).toEqual([]);
  });

  it("說明用寬視窗那一句", () => {
    const t = i18n.getFixedT("en");
    for (const stop of Object.values(STOPS)) expect(stopBody(t, stop), stop.id).toBe(stopBody(t, stop, "wide"));
  });
});

describe("側欄浮動（640～1279）：目標", () => {
  beforeEach(() => stubViewport(true));

  it("側欄裡的站改指頁首的漢堡鈕；版本仍指右下角的泡泡（640 以上都有）；頁首不變", async () => {
    await renderPage();
    const header = within(pageHeader());
    const hamburger = header.getByRole("button", { name: "Open sidebar" });
    const more = header.getByRole("button", { name: "More" });
    const expected: Record<StopId, HTMLElement[]> = {
      tabs: [hamburger],
      newNote: [hamburger],
      folders: [hamburger],
      search: [hamburger],
      header: [header.getByRole("button", { name: "Share" }), more],
      versions: [screen.getByTestId("versions-bubble")],
      wikilink: [screen.getByRole("link", { name: "linked note" })],
      ai: [screen.getByRole("button", { name: "AI" })],
      slash: [screen.getByText("a flowchart")],
      userMenu: [hamburger],
    };
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual(expected[id]);
  });

  it("說明：有窄視窗那一句的站用它", () => {
    const narrowOnes = Object.values(STOPS).filter((s) => s.narrowBodyKey !== undefined).map((s) => s.id);
    expect(narrowOnes.sort()).toEqual(["folders", "newNote", "search", "tabs", "userMenu"]);
    const t = i18n.getFixedT("en");
    for (const stop of Object.values(STOPS)) expect(stopBody(t, stop), stop.id).toBe(stopBody(t, stop, "floating"));
  });
});

describe("手機：目標", () => {
  beforeEach(() => stubLayoutTier("phone"));

  /** 手機清單畫面頂列（頭像在這裡）。 */
  const topBar = () => within(document.querySelector<HTMLElement>("[data-phone-top-bar]")!);

  it("清單上的站在清單畫面指真的東西：tab 列、右下的新增筆記鈕、我的筆記標題列的新增資料夾鈕、左下的搜尋鈕、頂列的頭像", async () => {
    await renderPage({ at: "/" });
    const side = within(aside());
    await waitFor(() => expect(stopTarget(STOPS.folders, ctx())).toHaveLength(1));
    const expected: Partial<Record<StopId, HTMLElement[]>> = {
      tabs: [side.getByRole("tablist")],
      newNote: [side.getByRole("button", { name: "New note" })],
      folders: [side.getByRole("button", { name: "New folder" })],
      search: [side.getByRole("button", { name: "Search notes" })],
      userMenu: [topBar().getByRole("button", { name: USER.displayName })],
    };
    for (const [id, els] of Object.entries(expected)) expect(stopTarget(STOPS[id as StopId], ctx()), id).toEqual(els);
    expect(stopTarget(STOPS.newNote, ctx())[0]).toHaveAttribute("data-phone-fab", "new-note");
    expect(stopTarget(STOPS.search, ctx())[0]).toHaveAttribute("data-phone-fab", "search");
  });

  it("筆記畫面上的站：頁首的分享與 ⋮、版本改指 ⋮（手機沒有泡泡）、[[ 與 / 的成品；AI 站沒有目標", async () => {
    await renderPage();
    const header = within(pageHeader());
    const more = header.getByRole("button", { name: "More" });
    const expected: Partial<Record<StopId, HTMLElement[]>> = {
      header: [header.getByRole("button", { name: "Share" }), more],
      versions: [more],
      wikilink: [screen.getByRole("link", { name: "linked note" })],
      ai: [],
      slash: [screen.getByText("a flowchart")],
    };
    for (const [id, els] of Object.entries(expected)) expect(stopTarget(STOPS[id as StopId], ctx("", [AI_ACTION])), id).toEqual(els);
    expect(findDrawerButton()).toBeNull();
    expect(screen.queryByTestId("versions-bubble")).not.toBeInTheDocument();
  });

  it("筆記畫面上清單不可互動：tab 列、資料夾鈕、頭像在那裡查不到（要先回清單）", async () => {
    await renderPage();
    for (const id of ["tabs", "folders", "userMenu"] as const) expect(stopTarget(STOPS[id], ctx()), id).toEqual([]);
  });

  it("哪一站在哪個畫面：手機分清單與示範筆記，其他版面一律在示範筆記上", () => {
    expect(FULL_TOUR.filter((id) => stopScreen(STOPS[id], "phone") === "list")).toEqual(["tabs", "newNote", "folders", "search", "userMenu"]);
    for (const layout of ["wide", "floating"] as const) expect(FULL_TOUR.filter((id) => stopScreen(STOPS[id], layout) === "list")).toEqual([]);
  });

  it("手機上沒有的站只有 AI；其他版面每站都在", () => {
    expect(FULL_TOUR.filter((id) => !stopShownIn(STOPS[id], "phone"))).toEqual(["ai"]);
    for (const layout of ["wide", "floating"] as const) expect(FULL_TOUR.filter((id) => !stopShownIn(STOPS[id], layout))).toEqual([]);
  });

  it("prepare 照跑（沒有抽屜）：新增筆記、資料夾先切到我的筆記，畫面留在清單", async () => {
    localStorage.setItem("sidebar.tab", "recent");
    await renderPage({ at: "/" });
    const controls = getShellControls()!;
    act(() => prepareStop(STOPS.folders, ctx()));
    expect(controls.getTab()).toBe("myNotes");
    await waitFor(() => expect(stopTarget(STOPS.folders, ctx())).toHaveLength(1));
    expect(aside()).toHaveAttribute("data-phone-list-shown");
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });

  it("prepare 只換 tab、不換畫面：在筆記畫面上跑也不會被帶回清單（換畫面由導覽自己做）", async () => {
    localStorage.setItem("sidebar.tab", "recent");
    await renderPage();
    act(() => prepareStop(STOPS.newNote, ctx()));
    expect(getShellControls()!.getTab()).toBe("myNotes");
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("main header")).not.toBeNull();
    expect(aside()).not.toHaveAttribute("data-phone-list-shown");
  });

  it("說明與標題：預設讀目前的版面；手機有自己那一句的站用它", () => {
    const phoneOnes = Object.values(STOPS).filter((s) => s.phoneBodyKey !== undefined).map((s) => s.id);
    expect(phoneOnes.sort()).toEqual(["folders", "header", "newNote", "search", "slash", "tabs", "userMenu", "versions"]);
    const t = i18n.getFixedT("en");
    for (const stop of Object.values(STOPS)) {
      expect(stopBody(t, stop), stop.id).toBe(stopBody(t, stop, "phone"));
      expect(stopTitle(t, stop), stop.id).toBe(stopTitle(t, stop, "phone"));
    }
  });
});

// 資料夾名稱是使用者自己取的：取成跟任何目標同名，也不能把目標搶走。
const COLLIDING_NAMES = [USER.displayName, "New note", "New folder", "Search notes", "Share", "More", "Open sidebar", "Sidebar sections", "Version history"];

describe("使用者內容撞名", () => {
  beforeEach(() => {
    stubViewport(false);
    stubFetch({ folders: COLLIDING_NAMES.map((name, i) => folderDto({ id: `f-${i}`, name })) });
  });

  /** tabpanel 裡、名稱撞上目標的資料夾元素（一般模式是資料夾列；選取模式是帶 `aria-label` 的資料夾鈕）。標題列的動作鈕不算。 */
  function collidingInPanel(): Element[] {
    const panel = aside().querySelector("[role=tabpanel]")!;
    return Array.from(panel.querySelectorAll("button, input")).filter(
      (el) =>
        el.closest("[data-sidebar-header]") === null &&
        COLLIDING_NAMES.includes(el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""),
    );
  }

  /** 側欄卡片裡、tabpanel 外、名稱是 `name` 的那顆鈕（帳號列、底部的新增筆記）。 */
  function outsidePanel(name: string): HTMLElement {
    const found = within(aside())
      .getAllByRole("button", { name })
      .filter((el) => el.closest("[role=tabpanel]") === null);
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  function targetsOf(): Map<StopId, Element[]> {
    return new Map(FULL_TOUR.map((id) => [id, stopTarget(STOPS[id], ctx())]));
  }

  it("一般模式：每站仍指原本的目標，沒有一站指到資料夾", async () => {
    await renderPage();
    const side = within(aside());
    await waitFor(() => expect(collidingInPanel().length).toBeGreaterThanOrEqual(COLLIDING_NAMES.length));
    const colliding = collidingInPanel();
    const targets = targetsOf();
    for (const [id, els] of targets) for (const el of els) expect(colliding, id).not.toContain(el);
    expect(targets.get("userMenu")).toEqual([outsidePanel(USER.displayName)]);
    expect(targets.get("newNote")).toEqual([outsidePanel("New note")]);
    expect(targets.get("search")).toEqual([side.getByRole("textbox", { name: "Search notes" })]);
  });

  it("選取模式：資料夾鈕以資料夾名當 aria-label，仍不會被當成目標", async () => {
    await renderPage();
    const side = within(aside());
    await waitFor(() => expect(side.getByRole("button", { name: "Select" })).toBeEnabled());
    act(() => side.getByRole("button", { name: "Select" }).click());
    await side.findByRole("button", { name: "Done" });
    // 撞名真的成立：選取樹裡有 aria-label 就是使用者名稱的資料夾鈕，而且在 DOM 裡排在帳號列前面。
    const folderButton = await waitFor(() => {
      const el = collidingInPanel().find((e) => e.getAttribute("aria-label") === USER.displayName);
      expect(el).toBeDefined();
      return el!;
    });
    const account = findUserMenuTrigger()!;
    expect(folderButton.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const colliding = collidingInPanel();
    for (const [id, els] of targetsOf()) for (const el of els) expect(colliding, id).not.toContain(el);
    expect(account).toBe(outsidePanel(USER.displayName));
    expect(stopTarget(STOPS.userMenu, ctx())).toEqual([account]);
  });
});

describe("背景不可互動（簡報模式的 AppShell inert）", () => {
  const ALL_IDS: TourTargetId[] = ["tabs", "newNote", "newFolder", "search", "share", "noteMenu", "versions", "userMenu", "drawerButton", "wikilink", "flowchart"];

  it.each([false, true])("側欄浮動＝%s：十一個目標都查不到", async (narrow) => {
    stubViewport(narrow);
    await renderPage({ inert: true });
    // 元素都還在 DOM 裡（帶著屬性），只是在 inert 範圍內。版本泡泡在側欄浮動時（640～1279）也在。
    for (const id of ALL_IDS) {
      expect(document.querySelector(`[data-kb-tour-target="${id}"]`), id).not.toBeNull();
    }
    for (const id of ALL_IDS) expect(findTourTarget(id), id).toBeNull();
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual([]);
  });
});

describe("手機：背景不可互動", () => {
  it("「‹」與底部的圓形鈕也查不到", async () => {
    stubLayoutTier("phone");
    await renderPage({ inert: true });
    await waitFor(() => expect(document.querySelector('[data-kb-tour-target="phoneNewNote"]')).not.toBeNull());
    for (const id of ["backToList", "phoneNewNote", "phoneSearch", "share", "noteMenu"] as const) {
      expect(document.querySelector(`[data-kb-tour-target="${id}"]`), id).not.toBeNull();
      expect(findTourTarget(id), id).toBeNull();
    }
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual([]);
  });
});

describe("漢堡鈕", () => {
  it("沒有筆記頁頁首的頁面（窄版頂列）也找得到", async () => {
    stubViewport(true);
    await renderPage({ home: true });
    expect(document.querySelector("main header")).toBeNull();
    expect(findDrawerButton()).toBe(within(document.querySelector("main")!).getByRole("button", { name: "Open sidebar" }));
    expect(stopTarget(STOPS.userMenu, ctx())).toEqual([findDrawerButton()]);
  });
});

describe("側欄兩份：抽屜開著取抽屜那份，關著取固定卡片那份", () => {
  beforeEach(() => stubViewport(true));

  it("使用者選單、搜尋框、tab 列；抽屜開著時頁首的漢堡鈕被蓋住、查不到", async () => {
    await renderPage();
    const card = aside();
    expect(findUserMenuTrigger()?.closest("aside")).toBe(card);
    expect(findTourTarget("search")?.closest("aside")).toBe(card);
    expect(findDrawerButton()).toBe(within(pageHeader()).getByRole("button", { name: "Open sidebar" }));

    act(() => within(pageHeader()).getByRole("button", { name: "Open sidebar" }).click());
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await within(drawer).findByRole("button", { name: USER.displayName });
    for (const id of ["userMenu", "search", "tabs"] as const) {
      expect(findTourTarget(id), id).not.toBeNull();
      expect(drawer.contains(findTourTarget(id)), id).toBe(true);
    }
    expect(findDrawerButton()).toBeNull();

    act(() => getShellControls()!.closeDrawer());
    await waitFor(() => expect(document.querySelector("[data-sidebar-drawer]")).toBeNull());
    expect(findUserMenuTrigger()?.closest("aside")).toBe(card);
    expect(findDrawerButton()).not.toBeNull();
  });
});

describe("prepare", () => {
  it("寬視窗：newNote、folders 先切到「我的筆記」並結束選取模式", async () => {
    stubViewport(false);
    localStorage.setItem("sidebar.tab", "recent");
    await renderPage();
    for (const id of ["newNote", "folders"] as const) {
      act(() => getShellControls()!.showTab("recent"));
      const controls = getShellControls()!;
      const endSelection = vi.spyOn(controls, "endSelectionIfActive");
      act(() => prepareStop(STOPS[id], ctx()));
      expect(controls.getTab(), id).toBe("myNotes");
      expect(endSelection, id).toHaveBeenCalledTimes(1);
      endSelection.mockRestore();
    }
    // 切 tab 之後「新增資料夾」才出現在標題列。
    await waitFor(() => expect(stopTarget(STOPS.folders, ctx())).toHaveLength(1));
  });

  it("側欄浮動：不跑 prepare——tab 不變、抽屜維持關閉", async () => {
    stubLayoutTier("overlay");
    localStorage.setItem("sidebar.tab", "recent");
    await renderPage();
    const controls = getShellControls()!;
    const showTab = vi.spyOn(controls, "showTab");
    const endSelection = vi.spyOn(controls, "endSelectionIfActive");
    for (const id of FULL_TOUR) act(() => prepareStop(STOPS[id], ctx()));
    expect(showTab).not.toHaveBeenCalled();
    expect(endSelection).not.toHaveBeenCalled();
    expect(controls.getTab()).toBe("recent");
    expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });

  it("沒有登記的側欄時什麼都不做、不拋錯", () => {
    stubViewport(false);
    expect(getShellControls()).toBeNull();
    for (const id of FULL_TOUR) expect(() => prepareStop(STOPS[id], ctx())).not.toThrow();
  });
});

describe("precondition", () => {
  it("搜尋框有字時 tabs、folders、search 不成立（搜尋中 tab 列與標題列不渲染，也不清掉使用者的字）；其他站照常", () => {
    const applies = (q: string) => FULL_TOUR.filter((id) => STOPS[id].precondition?.(ctx(q, [AI_ACTION])) ?? true);
    expect(applies("")).toEqual(FULL_TOUR);
    expect(applies("ab")).toEqual(["newNote", "header", "versions", "wikilink", "ai", "slash", "userMenu"]);
    // 空白也算搜尋中（同 AppShell 的判準）。
    expect(applies(" ")).toEqual(["newNote", "header", "versions", "wikilink", "ai", "slash", "userMenu"]);
  });
});

describe("AI 站的 precondition", () => {
  const applies = (aiActions: readonly AiActionDto[]) => STOPS.ai.precondition?.(ctx("", aiActions)) ?? true;

  it("站台有 AI 動作才成立；沒有（載入失敗、未設定）就整站略過", () => {
    expect(applies([AI_ACTION])).toBe(true);
    expect(applies([])).toBe(false);
  });

  it("沒有 AI 動作：完整導覽少掉 AI 站", () => {
    const planned = FULL_TOUR.filter((id) => STOPS[id].precondition?.(ctx("", [])) ?? true);
    expect(planned).toEqual(["tabs", "newNote", "folders", "search", "header", "versions", "wikilink", "slash", "userMenu"]);
  });
});

// 說明文字：每站的標題與說明、快捷鍵的修飾鍵、說明裡提到的名稱與介面上的名稱一致。
describe("說明文字", () => {
  const TITLES: Record<"en" | "zh-TW", Record<StopId, string>> = {
    en: {
      tabs: "Sidebar sections",
      newNote: "New note",
      folders: "Folders",
      search: "Search",
      header: "Share and more",
      versions: "Version history",
      wikilink: "Link to another note",
      ai: "Ask AI about a selection",
      slash: "Insert blocks with /",
      userMenu: "Forgot how something works?",
    },
    "zh-TW": {
      tabs: "側欄分類",
      newNote: "新增筆記",
      folders: "資料夾",
      search: "搜尋",
      header: "分享與更多動作",
      versions: "版本歷史",
      wikilink: "連到別篇筆記",
      ai: "框選文字叫 AI",
      slash: "用 / 插入各種區塊",
      userMenu: "忘了怎麼用？",
    },
  };

  /** 手機另有標題的站（手機沒有側欄）。 */
  const PHONE_TITLES: Record<"en" | "zh-TW", Partial<Record<StopId, string>>> = {
    en: { tabs: "Lists of notes" },
    "zh-TW": { tabs: "筆記清單" },
  };

  /** 寬視窗說明裡一定要有的片段（快捷鍵用 `{mod}` 代表修飾鍵）。 */
  const WIDE_PARTS: Record<"en" | "zh-TW", Record<StopId, string[]>> = {
    en: {
      tabs: ["hover over one to see its name"],
      newNote: ["Click here to create a note", "My notes"],
      folders: ["My notes header", "Move to…"],
      search: ["{mod}K", "titles and note text"],
      header: ["invites others to view or edit", "icon next to Share", "⋮ → \"Width\"", "Standard, Wide and Full width"],
      versions: ["{mod}S", "bottom-right corner"],
      wikilink: ["Type [[", "Mentioned in"],
      ai: ["AI button", "toolbar"],
      slash: ["Type /", "flowchart", "side-by-side columns", "\"2 columns\"", "divider between columns"],
      userMenu: ["{mod}/", "open Help from here", "shortcuts, the feature tour and what's new"],
    },
    "zh-TW": {
      tabs: ["滑鼠停在上面就會顯示名稱"],
      newNote: ["按這裡新增一篇筆記", "我的筆記"],
      folders: ["我的筆記", "移動到…"],
      search: ["{mod}K", "標題和內文"],
      header: ["邀請別人一起看或一起編輯", "「分享」旁邊的圖示", "⋮ →「寬度」", "標準、寬或全寬"],
      versions: ["{mod}S", "右下角"],
      wikilink: ["打 [[", "提及"],
      ai: ["「AI」鈕", "工具列"],
      slash: ["打 /", "流程圖", "並排 2 欄", "拖欄與欄之間的分隔線"],
      userMenu: ["{mod}/", "從這裡打開「說明」", "快捷鍵、功能導覽和這一版新增"],
    },
  };

  /** 側欄浮動（640～1279）時說明裡一定要有的片段；沒列的站沿用寬視窗那句。 */
  const FLOATING_PARTS: Record<"en" | "zh-TW", Partial<Record<StopId, string[]>>> = {
    en: {
      tabs: ["Open the sidebar from here"],
      newNote: ["bottom of the sidebar", "Open the sidebar from here"],
      folders: ["Move to…", "Open the sidebar from here"],
      search: ["{mod}K", "open the sidebar from here"],
      userMenu: ["{mod}/", "open Help from the menu at the bottom-left of the sidebar", "Open the sidebar from here"],
    },
    "zh-TW": {
      tabs: ["點這裡打開側欄"],
      newNote: ["側欄底部", "點這裡打開側欄"],
      folders: ["移動到…", "點這裡打開側欄"],
      search: ["{mod}K", "點這裡打開側欄"],
      userMenu: ["{mod}/", "從側欄左下角的選單打開「說明」", "點這裡打開側欄"],
    },
  };

  /** 手機說明裡一定要有的片段；沒列的站沿用寬視窗那句（AI 站手機不停，不看）。 */
  const PHONE_PARTS: Record<"en" | "zh-TW", Partial<Record<StopId, string[]>>> = {
    en: {
      tabs: ["This row of icons", "lists of notes"],
      newNote: ["Tap here to create a note", "same folder or group", "My notes"],
      folders: ["Tap this button in the My notes header", "Move to…"],
      search: ["Tap here to search", "titles and note text"],
      header: ["invites others to view or edit"],
      versions: ["\"Version history\" in the ⋮ menu", "save a version yourself"],
      slash: ["Type /", "flowchart"],
      userMenu: ["Tap your avatar here", "Help", "shortcuts, the feature tour and what's new"],
    },
    "zh-TW": {
      tabs: ["這排圖示", "筆記清單"],
      newNote: ["點這裡新增一篇筆記", "同一個資料夾或群組", "我的筆記"],
      folders: ["點「我的筆記」標題列的這顆鈕", "移動到…"],
      search: ["點這裡就能搜尋", "標題和內文"],
      header: ["邀請別人一起看或一起編輯"],
      versions: ["⋮ 選單裡的「版本歷史」", "自己儲存一個版本"],
      slash: ["打 /", "流程圖"],
      userMenu: ["點這裡的頭像", "「說明」", "快捷鍵、功能導覽和這一版新增"],
    },
  };

  /** 只在側欄浮動時出現的「打開側欄」補句；寬視窗與手機的說明不能混進去。 */
  const FLOATING_SENTENCE = { en: /open the sidebar/i, "zh-TW": /打開側欄/ } as const;
  /** 手機沒有側欄、沒有角落的泡泡，也多半沒有鍵盤與滑鼠；清單上的站就在清單上指真的東西，不必叫人先按「‹」：手機的說明不提這些。 */
  const NOT_ON_PHONE = {
    en: /sidebar|bottom-right|bottom-left|\bPress\b|\bClick\b|hover|\bdrag\b|‹/i,
    "zh-TW": /側欄|右下角|左下角|按 Ctrl|按 ⌘|滑鼠|拖|‹/,
  } as const;

  const withMod = (parts: string[], mod: string) => parts.map((p) => p.replace("{mod}", mod));

  afterEach(() => vi.unstubAllGlobals());

  it.each(["en", "zh-TW"] as const)("%s：每站的標題與說明（寬、側欄浮動、手機）", (lng) => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const t = i18n.getFixedT(lng);
    for (const id of FULL_TOUR) {
      const stop = STOPS[id];
      expect(stopTitle(t, stop, "wide"), id).toBe(TITLES[lng][id]);
      expect(stopTitle(t, stop, "floating"), id).toBe(TITLES[lng][id]);
      expect(stopTitle(t, stop, "phone"), id).toBe(PHONE_TITLES[lng][id] ?? TITLES[lng][id]);

      const wide = stopBody(t, stop, "wide");
      for (const part of withMod(WIDE_PARTS[lng][id], "Ctrl+")) expect(wide, `${id} wide`).toContain(part);
      expect(wide, `${id} wide`).not.toMatch(FLOATING_SENTENCE[lng]);

      const floating = stopBody(t, stop, "floating");
      const floatingParts = FLOATING_PARTS[lng][id];
      if (floatingParts === undefined) {
        expect(floating, `${id} floating`).toBe(wide);
      } else {
        expect(floating, `${id} floating`).not.toBe(wide);
        for (const part of withMod(floatingParts, "Ctrl+")) expect(floating, `${id} floating`).toContain(part);
      }

      if (!stopShownIn(stop, "phone")) continue;
      const phone = stopBody(t, stop, "phone");
      const phoneParts = PHONE_PARTS[lng][id];
      if (phoneParts === undefined) {
        expect(phone, `${id} phone`).toBe(wide);
      } else {
        expect(phone, `${id} phone`).not.toBe(wide);
        expect(phone, `${id} phone`).not.toBe(floating);
        for (const part of phoneParts) expect(phone, `${id} phone`).toContain(part);
      }
      expect(phone, `${id} phone`).not.toMatch(FLOATING_SENTENCE[lng]);
      expect(phone, `${id} phone`).not.toMatch(NOT_ON_PHONE[lng]);
      expect(phone, `${id} phone`).not.toContain("Ctrl+");
    }
  });

  it.each(["en", "zh-TW"] as const)("%s：站 6 在側欄浮動時也指右下角的泡泡（640 以上都有），說明不提 ⋮；手機改講 ⋮ 裡的「版本歷史」", (lng) => {
    const t = i18n.getFixedT(lng);
    const wide = stopBody(t, STOPS.versions, "wide");
    expect(stopBody(t, STOPS.versions, "floating")).toBe(wide);
    expect(wide).toMatch(/右下角|bottom-right/);
    expect(wide).not.toContain("⋮");
    const phone = stopBody(t, STOPS.versions, "phone");
    expect(phone).toContain("⋮");
    expect(phone).toContain(t("note.menu.versions"));
  });

  it.each(["en", "zh-TW"] as const)("%s：Mac 顯示 ⌘、其他平台顯示 Ctrl+，沒有未代入的 {{mod}}；手機的說明不提快捷鍵", (lng) => {
    const t = i18n.getFixedT(lng);
    const all = (layout: "wide" | "floating") => FULL_TOUR.map((id) => stopBody(t, STOPS[id], layout)).join("\n");
    for (const layout of ["wide", "floating"] as const) {
      vi.stubGlobal("navigator", { platform: "MacIntel" });
      const mac = all(layout);
      expect(mac).toContain("⌘K");
      expect(mac).toContain("⌘/");
      expect(mac).not.toContain("Ctrl");
      vi.stubGlobal("navigator", { platform: "Win32" });
      const other = all(layout);
      expect(other).toContain("Ctrl+K");
      expect(other).toContain("Ctrl+/");
      expect(other).not.toContain("⌘");
      for (const text of [mac, other]) expect(text).not.toContain("{{");
    }
    for (const platform of ["MacIntel", "Win32"]) {
      vi.stubGlobal("navigator", { platform });
      const phone = FULL_TOUR.filter((id) => stopShownIn(STOPS[id], "phone"))
        .map((id) => stopBody(t, STOPS[id], "phone"))
        .join("\n");
      expect(phone).not.toMatch(/⌘|Ctrl|\{\{/);
    }
  });

  it("說明裡提到的名稱與介面上的名稱一致（兩種語言）", () => {
    for (const lng of ["en", "zh-TW"] as const) {
      const t = i18n.getFixedT(lng);
      const body = (id: StopId) => stopBody(t, STOPS[id], "wide");
      const floatingBody = (id: StopId) => stopBody(t, STOPS[id], "floating");
      const phoneBody = (id: StopId) => stopBody(t, STOPS[id], "phone");
      // 站 1：舉例提到的分頁名稱要與側欄一致（不鎖分頁數量）。
      for (const key of ["sidebar.myNotes", "sidebar.workspace", "sidebar.shared", "sidebar.trash"]) {
        for (const text of [body("tabs"), floatingBody("tabs"), phoneBody("tabs")]) expect(text, `${lng} ${key}`).toContain(t(key));
      }
      // 站 2：新增筆記的鈕名（側欄底部那顆）；放進的地方是「我的筆記」。
      expect(stopTitle(t, STOPS.newNote)).toBe(t("home.newNote"));
      expect(floatingBody("newNote")).toContain(t("home.newNote"));
      expect(body("newNote")).toContain(t("sidebar.myNotes"));
      expect(phoneBody("newNote")).toContain(t("sidebar.myNotes"));
      // 站 3：筆記 ⋮ 選單裡的「移動到…」、標題列在「我的筆記」。
      for (const text of [body("folders"), phoneBody("folders")]) {
        expect(text).toContain(t("note.menu.moveTo"));
        expect(text).toContain(t("sidebar.myNotes"));
      }
      // 站 5：分享鈕與 ⋮ 裡的四個項目（手機的 ⋮ 也有）；寬度子選單與它的三個選項只在 640 以上的 ⋮ 裡，手機不提。
      expect(body("header")).toContain(t("share.button"));
      for (const key of ["note.menu.present", "note.menu.aiEdits", "note.menu.moveTo", "note.menu.copyTo"]) {
        expect(body("header"), `${lng} ${key}`).toContain(t(key));
        expect(phoneBody("header"), `${lng} ${key}`).toContain(t(key));
      }
      for (const key of ["note.width.label", "note.width.standard", "note.width.wide", "note.width.full"]) {
        expect(body("header"), `${lng} ${key}`).toContain(t(key));
        expect(floatingBody("header"), `${lng} ${key}`).toContain(t(key));
      }
      expect(phoneBody("header")).not.toContain(t("note.width.label"));
      // 站 10：入口叫「說明」，與使用者選單那一格一致。
      for (const text of [body("userMenu"), floatingBody("userMenu"), phoneBody("userMenu")]) expect(text).toContain(t("userMenu.help"));
      // 站 10 提到的三頁，名稱要跟說明視窗左欄的頁名一致。
      const nav = (lng === "en" ? shortcutsEn : shortcutsZhTW).helpGuide.nav;
      for (const text of [body("userMenu"), floatingBody("userMenu"), phoneBody("userMenu")]) {
        if (lng === "en") {
          const lower = text.toLowerCase();
          expect(lower).toContain(nav.tour.toLowerCase());
          expect(lower).toContain(nav.whatsNew.toLowerCase());
          expect(lower).toContain(nav.shortcuts.toLowerCase().replace("keyboard ", ""));
        } else {
          for (const name of [nav.tour, nav.whatsNew, nav.shortcuts]) expect(text).toContain(name);
        }
      }
    }
  });

  it.each(["en", "zh-TW"] as const)("%s：站點文案沒有拿快捷鍵介紹當入口名稱", (lng) => {
    const t = i18n.getFixedT(lng);
    const text = FULL_TOUR.flatMap((id) => (["wide", "floating", "phone"] as const).map((layout) => stopBody(t, STOPS[id], layout))).join("\n");
    expect(text).not.toMatch(/Keyboard shortcuts|快捷鍵介紹/);
  });
});
