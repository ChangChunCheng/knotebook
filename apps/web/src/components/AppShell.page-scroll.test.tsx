import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { PHONE_PAGE_SCROLL_ATTR } from "@/lib/page-scroll";
import { useSidebarTabActions } from "@/lib/sidebar-tab";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { trashList } from "@/test/trash-fixtures";
import { AppShell } from "./AppShell";
import { NoteBrowseBar } from "./NoteBrowseBar";

// 手機（< 640）上清單與筆記捲的是文件：外框不鎖高度、換畫面時的捲動位置由 AppShell 自己還原或歸零。640 起照舊。

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

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
  id: "88888888-8888-8888-8888-888888888888",
  title: "Alpha Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "alpha-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

function stubFetch(notes: NoteDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/folders") return Promise.resolve(fakeResponse(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(notes));
      if (url === "/api/trash") return Promise.resolve(fakeResponse(trashList([], { retentionDays: 7 })));
      if (url === "/api/favorites") return Promise.resolve(fakeResponse([]));
      if (url.startsWith("/api/search?")) return Promise.resolve(fakeResponse({ hits: [], nextCursor: null }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function Back() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      history-back
    </button>
  );
}

function renderAt(path: string | string[], children: ReactNode) {
  const entries = Array.isArray(path) ? path : [path];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
          <ActiveNoteProvider>
            <Routes>
              <Route path="*" element={<AppShell>{children}</AppShell>} />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** 使用者把文件捲到 `y`：改 `scrollY` 並發 scroll 事件（AppShell 由事件記下位置）。 */
function scrollPage(y: number): void {
  vi.stubGlobal("scrollY", y);
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

let scrollTo: ReturnType<typeof vi.spyOn>;
/** 最後一次 `window.scrollTo(x, y)` 的 y；沒呼叫過是 null。 */
function lastScrollY(): number | null {
  const calls = scrollTo.mock.calls;
  if (calls.length === 0) return null;
  const last = calls[calls.length - 1] as unknown[];
  return typeof last[0] === "object" ? ((last[0] as ScrollToOptions).top ?? null) : (last[1] as number);
}

function useTier(tier: LayoutTier) {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubLayoutTier(tier);
    scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

const frameOf = (container: HTMLElement) => container.querySelector<HTMLElement>(`[${PHONE_PAGE_SCROLL_ATTR}]`)!;
const asideOf = (container: HTMLElement) => container.querySelector<HTMLElement>("aside[data-sidebar-instance]")!;

describe("AppShell — 手機上文件在捲", () => {
  useTier("phone");

  it("PS1 外框帶 data-phone-page-scroll：640 起鎖視窗高、裁切（h-dvh、overflow-hidden），手機上不鎖高、縱向不裁切、橫向 clip、底色是卡片色", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/", <LocationProbe />);
    await screen.findByRole("tablist");
    const frame = frameOf(container);
    expect(frame).not.toBeNull();
    expect(frame).toHaveClass("h-dvh", "overflow-hidden", "max-sm:h-auto", "max-sm:overflow-y-visible", "max-sm:overflow-x-clip", "max-sm:bg-card");
    // hidden 會讓縱向也成為捲動容器，頂列的 sticky 就黏不住。
    expect(frame.className).not.toMatch(/max-sm:overflow-(x-)?hidden/);
    expect(frame).toContainElement(asideOf(container));
  });

  it("PS2 清單 → 筆記：文件回頂端；系統返回回清單：回到離開時的位置", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/",
      <>
        <LocationProbe />
        <Back />
      </>,
    );
    const link = await within(asideOf(container)).findByRole("link", { name: /^Alpha Note/ });
    scrollPage(420);
    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    expect(lastScrollY()).toBe(0);
    // 筆記上的捲動不改清單的記錄。
    scrollPage(2000);
    fireEvent.click(screen.getByRole("button", { name: "history-back", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(lastScrollY()).toBe(420);
  });

  it("PS3 清單上換 tab：新 tab 從頂端開始；之後在新 tab 捲到的位置照常記，進筆記再回來還原它", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/",
      <>
        <LocationProbe />
        <Back />
      </>,
    );
    const tablist = await screen.findByRole("tablist");
    scrollPage(300);
    fireEvent.click(within(tablist).getByRole("tab", { name: "Recent" }));
    expect(lastScrollY()).toBe(0);
    scrollPage(0);
    scrollTo.mockClear();
    fireEvent.click(within(tablist).getByRole("tab", { name: "My notes" }));
    expect(lastScrollY()).toBe(0);
    scrollPage(250);
    const link = await within(asideOf(container)).findByRole("link", { name: /^Alpha Note/ });
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    fireEvent.click(screen.getByRole("button", { name: "history-back", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(lastScrollY()).toBe(250);
  });

  it("PS3b 在筆記上換 tab（例如點頁首的位置）回到清單：新 tab 從頂端開始，不沿用舊 tab 的位置", async () => {
    stubFetch([NOTE]);
    function ShowRecent() {
      const { showTab } = useSidebarTabActions();
      return (
        <button type="button" onClick={() => showTab("recent")}>
          show-recent
        </button>
      );
    }
    const { container } = renderAt(
      "/",
      <>
        <LocationProbe />
        <ShowRecent />
      </>,
    );
    const link = await within(asideOf(container)).findByRole("link", { name: /^Alpha Note/ });
    scrollPage(420);
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    fireEvent.click(screen.getByRole("button", { name: "show-recent", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(lastScrollY()).toBe(0);
  });

  it("PS4 筆記上開搜尋層：主內容區藏起來、文件回頂端；Cancel 回到同一篇原本的位置", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/n/tester/alpha-note",
      <>
        <LocationProbe />
        <NoteBrowseBar note={NOTE} />
      </>,
    );
    const main = container.querySelector("main")!;
    expect(main).not.toHaveClass("max-sm:hidden");
    // 直接開在筆記上（深連結）：不捲。
    expect(scrollTo).not.toHaveBeenCalled();
    scrollPage(900);
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" }));
    expect(lastScrollY()).toBe(0);
    expect(main).toHaveClass("max-sm:hidden");
    scrollPage(150);
    fireEvent.click(within(asideOf(container)).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(main).not.toHaveClass("max-sm:hidden"));
    expect(lastScrollY()).toBe(900);
  });

  it("PS5 清單上開搜尋層再 Cancel：回到清單原本的位置", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/", <LocationProbe />);
    await screen.findByRole("tablist");
    scrollPage(510);
    fireEvent.click(within(asideOf(container)).getByRole("button", { name: "Search notes" }));
    await screen.findByRole("textbox", { name: "Search notes" });
    expect(lastScrollY()).toBe(0);
    fireEvent.click(within(asideOf(container)).getByRole("button", { name: "Cancel" }));
    await screen.findByRole("tablist");
    expect(lastScrollY()).toBe(510);
  });

  it("PS6 清單或搜尋層在畫面上時 aside 帶 data-phone-list-shown、<html> 帶 data-has-phone-list-shown（index.css 據此擋下拉重新整理）；筆記上沒有", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/n/tester/alpha-note",
      <>
        <LocationProbe />
        <NoteBrowseBar note={NOTE} />
      </>,
    );
    expect(asideOf(container)).not.toHaveAttribute("data-phone-list-shown");
    expect(document.documentElement).not.toHaveAttribute("data-has-phone-list-shown");
    expect(document.documentElement).toHaveAttribute("data-has-phone-page-scroll");
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" }));
    expect(asideOf(container)).toHaveAttribute("data-phone-list-shown");
    expect(document.documentElement).toHaveAttribute("data-has-phone-list-shown");
  });

  it("PS8 頂列 sticky 釘在頂端、不透明；清單標題列 sticky 釘在頂列下方；清單容器手機上不自己捲；垃圾桶同樣", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/", <LocationProbe />);
    const tablist = await screen.findByRole("tablist");
    const top = container.querySelector("[data-phone-top-bar]");
    expect(top).toHaveClass("max-sm:sticky", "max-sm:top-0", "max-sm:bg-card");
    const header = container.querySelector("[data-sidebar-header]");
    expect(header).toHaveClass("max-sm:sticky", "max-sm:top-[calc(3rem+env(safe-area-inset-top))]", "max-sm:bg-card");
    expect(container.querySelector("[data-sidebar-list]")).toHaveClass("overflow-y-auto", "max-sm:overflow-y-visible");
    fireEvent.click(within(tablist).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(container.querySelector("[data-sidebar-header]")).toHaveClass("max-sm:sticky"));
    await waitFor(() => expect(container.querySelector("[data-sidebar-list]")).toHaveClass("max-sm:overflow-y-visible"));
  });

  it("PS7 掛著時瀏覽器自己的捲動還原關掉（manual），卸載時還原", async () => {
    stubFetch([NOTE]);
    window.history.scrollRestoration = "auto";
    const view = renderAt("/", <LocationProbe />);
    await screen.findByRole("tablist");
    expect(window.history.scrollRestoration).toBe("manual");
    view.unmount();
    expect(window.history.scrollRestoration).toBe("auto");
  });

  it("PS9 寬度剛越過 640、React 還沒換段時文件被夾回 0 的那次 scroll 不記成清單的位置", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/",
      <>
        <LocationProbe />
        <Back />
      </>,
    );
    const link = await within(asideOf(container)).findByRole("link", { name: /^Alpha Note/ });
    scrollPage(420);
    // 媒體查詢已經不是手機、React 還沒收到通知：此刻的 scroll（被夾回 0）不算使用者的位置
    vi.stubGlobal("matchMedia", () => ({ matches: false, media: "", addEventListener: () => {}, removeEventListener: () => {} }));
    scrollPage(0);
    stubLayoutTier("phone");
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    fireEvent.click(screen.getByRole("button", { name: "history-back", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(lastScrollY()).toBe(420);
  });

  it("PS10 筆記頁的浮動鈕掛在主內容區外面（主內容區滑入時位移，fixed 的鈕不能跟著被帶走）", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/n/tester/alpha-note",
      <>
        <LocationProbe />
        <NoteBrowseBar note={NOTE} />
      </>,
    );
    const bar = screen.getByTestId("note-browse-bar");
    const main = container.querySelector("main")!;
    const slot = container.querySelector("[data-phone-fab-slot]")!;
    expect(main).not.toContainElement(bar);
    expect(slot).toContainElement(bar);
    expect(main.contains(slot)).toBe(false);
    // 不在外框（flex 列）裡：鈕的包層若成了 flex 項目，外框的 gap 會讓主內容區少一截寬度
    expect(frameOf(container).contains(slot)).toBe(false);
  });
});

describe.each(["overlay", "docked"] as const)("AppShell — %s：頁面本身不捲", (tier) => {
  useTier(tier);

  it("清單 → 筆記 → 返回都不呼叫 window.scrollTo", async () => {
    stubFetch([NOTE]);
    renderAt(
      "/",
      <>
        <LocationProbe />
        <Back />
      </>,
    );
    await screen.findByRole("tablist");
    scrollPage(0);
    const link = await screen.findByRole("link", { name: /^Alpha Note/ });
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    fireEvent.click(screen.getByRole("button", { name: "history-back" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
