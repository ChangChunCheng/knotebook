import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memo, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { useSidebarTabActions, useSidebarTabState, type SidebarTabActions } from "@/lib/sidebar-tab";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { OWNER_PERMS } from "@/test/fixtures";
import { trashList } from "@/test/trash-fixtures";

// 側欄 tab 與 AppShell 的接線（plan T2）。骨架抄 AppShell.test.tsx 的「#115 側欄抽屜」describe。

// `sidebar.tab` 會往外流到同檔後面的案，檔案頂層清（plan I3）。
afterEach(() => {
  localStorage.clear();
});

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
};

const NOTE: NoteDto = {
  id: "66666666-6666-6666-6666-666666666666",
  title: "Tab Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "tab-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  permissions: OWNER_PERMS,
};

const CREATED: NoteDto = {
  ...NOTE,
  id: "33333333-3333-3333-3333-333333333333",
  title: "Untitled",
  slug: "untitled-33333333",
};

function stubFetchWithNotes(notes: NoteDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/notes" && method === "POST") return Promise.resolve(fakeResponse(CREATED, 201));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(notes));
      if (url === "/api/trash" && method === "GET") return Promise.resolve(fakeResponse(trashList([])));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** 可控 matchMedia stub（同 AppShell.test.tsx）。 */
function stubControllableMatchMedia(initialMatches: boolean) {
  const mql = {
    matches: initialMatches,
    media: "(width < 48rem)",
    addEventListener: () => {},
    removeEventListener: () => {},
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
}

function NoteRouteProbe() {
  const { handle, slug } = useParams<{ handle: string; slug: string }>();
  return <div data-testid="note-route">{`${handle}/${slug}`}</div>;
}

function renderShell(children: ReactNode = <SidebarDrawerButton />) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <ActiveNoteProvider>
            <Routes>
              <Route path="/" element={<AppShell>{children}</AppShell>} />
              <Route path="/n/:handle/:slug" element={<NoteRouteProbe />} />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const aside = () => document.querySelector("aside") as HTMLElement;

describe("AppShell — 側欄 tab 接線", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AS1：tabpanel 的 aria-labelledby 指向選中那顆 tab，切 tab 後跟著變", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();
    await screen.findByRole("tab", { name: "My notes" });

    const panel = within(aside()).getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", within(aside()).getByRole("tab", { name: "My notes" }).id);

    fireEvent.click(within(aside()).getByRole("tab", { name: "Workspace" }));
    expect(within(aside()).getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      within(aside()).getByRole("tab", { name: "Workspace" }).id,
    );
  });

  it("AS2 兩份共用：抽屜裡切 tab，靜態卡跟著；關抽屜後仍在", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("tab", { name: "Workspace" }));

    expect(within(drawer).getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "true");
    // 抽屜開著時 Radix 把背景標 aria-hidden，靜態卡要 hidden:true 才查得到。
    expect(within(aside()).getByRole("tab", { name: "Workspace", hidden: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
    expect(within(aside()).getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "true");
  });

  it("AS3 useId 不撞：兩份實例的 aria-controls 不同、各落在自己的容器、整份 DOM 的 id 唯一", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });

    const staticControls = within(aside())
      .getByRole("tab", { name: "My notes", hidden: true })
      .getAttribute("aria-controls")!;
    const drawerControls = within(drawer).getByRole("tab", { name: "My notes" }).getAttribute("aria-controls")!;
    expect(staticControls).not.toBe(drawerControls);
    expect(aside().contains(document.getElementById(staticControls))).toBe(true);
    expect(drawer.contains(document.getElementById(drawerControls))).toBe(true);

    const ids = [...document.querySelectorAll("[role=tab], [role=tabpanel]")].map((el) => el.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("AS4 不重繪 children：切 tab、搜尋框打字都不讓只消費 actions 的子樹重跑", async () => {
    stubFetchWithNotes([NOTE]);
    let renders = 0;
    const seen: SidebarTabActions[] = [];
    const Counter = memo(function Counter() {
      renders += 1;
      seen.push(useSidebarTabActions());
      return <div>counter</div>;
    });
    renderShell(<Counter />);
    await screen.findAllByRole("link", { name: "Tab Note" });
    const baseline = renders;
    expect(baseline).toBeGreaterThan(0);

    for (const name of ["Workspace", "Shared with me", "Recent"]) {
      fireEvent.click(within(aside()).getByRole("tab", { name }));
    }
    // 搜尋輸入這兩行守的是 plan 讀碼發現 3：抽屜 context 每次 render 換新物件時，`showTab` 不可依賴 drawer（依賴它就會讓 actions 捛物件、Counter 重跑）。
    const input = within(aside()).getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "tab" } });
    fireEvent.change(input, { target: { value: "" } });

    expect(renders).toBe(baseline);
    for (const actions of seen) expect(actions).toBe(seen[0]);
  });

  it("AS5 showTab 在窄螢幕開抽屜、寬螢幕不開", async () => {
    function ShowShared() {
      const { showTab } = useSidebarTabActions();
      return (
        <button type="button" onClick={() => showTab("shared")}>
          go shared
        </button>
      );
    }

    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    const narrow = renderShell(<ShowShared />);
    fireEvent.click(await screen.findByRole("button", { name: "go shared" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(within(drawer).getByRole("tab", { name: "Shared with me" })).toHaveAttribute("aria-selected", "true");
    narrow.unmount();
    localStorage.clear();

    stubControllableMatchMedia(false);
    renderShell(<ShowShared />);
    fireEvent.click(await screen.findByRole("button", { name: "go shared" }));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
    expect(within(aside()).getByRole("tab", { name: "Shared with me" })).toHaveAttribute("aria-selected", "true");
  });

  it("AS6 重掛帶回：AppShell 卸載重掛後仍是同一個 tab", async () => {
    stubFetchWithNotes([NOTE]);
    const first = renderShell();
    fireEvent.click(await screen.findByRole("tab", { name: "Shared with me" }));
    first.unmount();

    renderShell();
    expect(await screen.findByRole("tab", { name: "Shared with me" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "My notes" })).toHaveAttribute("aria-selected", "false");
  });

  it("AS7 建筆記不切 tab（spec §5.3）", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();
    fireEvent.click(await screen.findByRole("tab", { name: "Recent" }));
    expect(localStorage.getItem("sidebar.tab")).toBe("recent");

    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    await waitFor(() => expect(screen.getByTestId("note-route")).toBeInTheDocument());
    await act(async () => {});
    expect(localStorage.getItem("sidebar.tab")).toBe("recent");
  });

  it("AS8 零筆記零群組：tablist 照常在、我的筆記選中、面板內是 EmptyState 兩句", async () => {
    stubFetchWithNotes([]);
    renderShell();
    const tablist = await within(aside()).findByRole("tablist");
    expect(tablist).toBeInTheDocument();
    expect(within(aside()).getByRole("tab", { name: "My notes" })).toHaveAttribute("aria-selected", "true");
    const panel = within(aside()).getByRole("tabpanel");
    expect(await within(panel).findByText("No notes yet.")).toBeInTheDocument();
    expect(within(panel).getByText("Create your first note to get started.")).toBeInTheDocument();
  });

  it("AS9 tabpanel 可聚焦（tabindex=0＋focus-visible ring）：沒有可聚焦內容的面板（最近空）Tab 也能停在面板上", async () => {
    stubFetchWithNotes([]);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Recent" }));
    const panel = within(aside()).getByRole("tabpanel");
    expect(await within(panel).findByText("No notes yet.")).toBeInTheDocument();
    expect(panel.querySelector("a, button, input, [tabindex]")).toBeNull(); // 面板內沒有任何可聚焦元素
    expect(panel).toHaveAttribute("tabindex", "0");
    expect(panel).toHaveClass("focus-visible:ring-2", "focus-visible:ring-ring");
    panel.focus();
    expect(panel).toHaveFocus();

    // 切 tab 後換成新的 tabpanel 屬性仍在（同一個元素跟著 tab 更新）。
    fireEvent.click(within(aside()).getByRole("tab", { name: "My notes" }));
    expect(within(aside()).getByRole("tabpanel")).toHaveAttribute("tabindex", "0");
  });

  it("AS10 開始搜尋結束選取（spec §6.10.2）：靜態搜尋框打字 → 選取結束；清空搜尋後仍不在選取", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell(<SelectionProbe />);
    fireEvent.click(await screen.findByTestId("start-select"));
    expect(screen.getByTestId("selecting")).toHaveTextContent("true");

    const input = within(aside()).getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "tab" } });
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");
  });

  it("AS11 抽屜 Esc 先結束選取：第一次 Esc 抽屜仍在、選取結束；第二次 Esc 才關抽屜", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    renderShell(
      <>
        <SidebarDrawerButton />
        <SelectionProbe />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(screen.getByTestId("start-select"));
    expect(screen.getByTestId("selecting")).toHaveTextContent("true");

    fireEvent.keyDown(document.activeElement ?? drawer, { key: "Escape" });
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBe(drawer);
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");

    fireEvent.keyDown(document.activeElement ?? drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  });

  it("AS12 抽屜 Esc 平常照關（沒有選取時）", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    renderShell(
      <>
        <SidebarDrawerButton />
        <SelectionProbe />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");
    fireEvent.keyDown(document.activeElement ?? drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  });

  it("AS13 垃圾桶 tab：tabpanel 換成 TrashPanel、底部換成保留天數說明；切回我的筆記 New note 回來", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));
    const panel = within(aside()).getByRole("tabpanel");
    expect(await within(panel).findByText("The trash is empty.", { exact: true })).toBeInTheDocument();
    expect(panel.querySelector("[data-sidebar-header]")).toHaveTextContent("Trash · 0 notes");
    expect(within(panel).queryByRole("button", { name: "New personal note" })).toBeNull();
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();
    expect(await within(aside()).findByTestId("trash-footer")).toBeInTheDocument();

    fireEvent.click(within(aside()).getByRole("tab", { name: "My notes" }));
    expect(within(aside()).getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(within(aside()).queryByTestId("trash-footer")).toBeNull();
    expect(within(within(aside()).getByRole("tabpanel")).getByRole("button", { name: "New personal note" })).toBeInTheDocument();
  });
});

/** 選取 probe：讀 state context 的 `selection.active`，按鈕進入選取模式。抽屜開著時背景被標 aria-hidden，一律以 testid 查。 */
function SelectionProbe() {
  const { selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  return (
    <>
      <span data-testid="selecting">{String(selection.active)}</span>
      <button type="button" data-testid="start-select" onClick={() => updateSelection({ type: "start" })}>
        start selecting
      </button>
    </>
  );
}
