import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto, TrashItemDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider, useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { hoverReveal } from "@/components/ui/reveal";
import { OWNER_PERMS } from "@/test/fixtures";
import { TRASH_ME, trashItem, trashList } from "@/test/trash-fixtures";
import { TrashPanel } from "./TrashPanel";

// 垃圾桶 tab 的面板（平常）、確認框（plan T4）。選取模式的畫面在 T5。

afterEach(() => {
  localStorage.clear();
});

/** session 假回應：完整 UserDto，handle／displayName 對齊 `TRASH_ME`（清空框的「含其他成員」比的是 handle）。 */
const USER: UserDto = {
  id: "u1",
  email: "tester@example.com",
  handle: TRASH_ME.handle,
  displayName: TRASH_ME.displayName,
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
};

const AMY = { handle: "amy", displayName: "Amy" };
const RD = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "R&D" };

const P1 = trashItem({ id: "p1", title: "p1" }, { deletedDaysAgo: 0 });
const P2 = trashItem({ id: "p2", title: "p2" }, { deletedDaysAgo: 1 });
const W1 = trashItem({ id: "w1", title: "w1", group: RD, deletedBy: AMY }, { deletedDaysAgo: 2 });

/** 還原成功回的 NoteDto（只要 id 對；`useRestoreTrash` 會拿去蓋常駐層）。 */
function restoredNote(item: TrashItemDto): NoteDto {
  return {
    id: item.id,
    title: item.title,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: item.id,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    permissions: OWNER_PERMS,
  };
}

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

type Reply = { status: number; body: unknown };

interface ServerOpts {
  items?: TrashItemDto[];
  truncated?: boolean;
  /** `GET /api/trash`：`"pending"`＝永不回；數字＝該狀態碼的錯誤。 */
  list?: "pending" | number;
  /** 預設：把清單上有的當作還原成功、其餘略過，並從清單拿掉。 */
  restore?: (ids: string[]) => Reply;
  /** 預設同上（purge）。`call` 從 1 起算。 */
  purge?: (ids: string[], call: number) => Reply;
  /** 有給時，restore／purge 的預設回應等它 resolve 才回（測送出中的狀態）。 */
  hold?: Promise<void>;
}

function stubServer(opts: ServerOpts = {}) {
  let items = [...(opts.items ?? [])];
  const calls: { method: string; url: string; body: unknown }[] = [];
  let purgeCall = 0;
  const take = (ids: string[]) => {
    const hit = items.filter((item) => ids.includes(item.id));
    items = items.filter((item) => !ids.includes(item.id));
    const skipped = ids.filter((id) => !hit.some((item) => item.id === id)).map((id) => ({ id, reason: "not_in_trash" }));
    return { hit, skipped };
  };
  const after = (make: () => Response) => (opts.hold ? opts.hold.then(make) : Promise.resolve(make()));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/trash" && method === "GET") {
        if (opts.list === "pending") return new Promise<Response>(() => {});
        if (typeof opts.list === "number") return Promise.resolve(fakeResponse({ error: { code: "internal", message: "x" } }, opts.list));
        return Promise.resolve(fakeResponse(trashList(items, { truncated: opts.truncated ?? false })));
      }
      if (url === "/api/trash/restore" && method === "POST") {
        const ids = (body as { ids: string[] }).ids;
        const reply = opts.restore?.(ids);
        if (reply) return Promise.resolve(fakeResponse(reply.body, reply.status));
        return after(() => {
          const { hit, skipped } = take(ids);
          return fakeResponse({ restored: hit.map(restoredNote), skipped });
        });
      }
      if (url === "/api/trash/purge" && method === "POST") {
        const ids = (body as { ids: string[] }).ids;
        purgeCall += 1;
        const reply = opts.purge?.(ids, purgeCall);
        if (reply) {
          if (reply.status < 400) take(ids);
          return Promise.resolve(fakeResponse(reply.body, reply.status));
        }
        return after(() => {
          const { hit, skipped } = take(ids);
          return fakeResponse({ purged: hit.map((item) => item.id), skipped });
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return {
    calls,
    posts: (path: string) => calls.filter((call) => call.method === "POST" && call.url === path).map((call) => call.body),
    /** 換掉伺服器端的清單（下一次 GET 生效）。 */
    setItems: (next: TrashItemDto[]) => {
      items = [...next];
    },
  };
}

/** 選取 probe：讀 state context，按鈕勾一篇。 */
function SelectionProbe() {
  const { selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  return (
    <>
      <span data-testid="selecting">{String(selection.active)}</span>
      <span data-testid="selected-count">{selection.keys.size}</span>
      <button type="button" data-testid="toggle-p1" onClick={() => updateSelection({ type: "toggle", key: "note:p1" })}>
        toggle p1
      </button>
    </>
  );
}

function renderPanel() {
  localStorage.setItem("sidebar.tab", "trash");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // session 先放進快取：清空框的「含其他成員」要比對 handle，不讓它和清單的到達順序賽跑。
  queryClient.setQueryData(SESSION_QUERY_KEY, USER);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <div role="tabpanel">
              <TrashPanel />
            </div>
            <SelectionProbe />
            <input aria-label="outside" />
          </SidebarTabProvider>
          <Toaster />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient };
}

const panel = () => screen.getByRole("tabpanel", { hidden: true });
const header = () => panel().querySelector("[data-sidebar-header]") as HTMLElement;
const list = () => panel().querySelector("[data-sidebar-list]") as HTMLElement;
const row = (id: string) => panel().querySelector(`li[data-node-id="${id}"]`) as HTMLElement;
/** 列的第二行（灰字）。 */
const detail = (id: string) => row(id).querySelector(".text-muted-foreground") as HTMLElement;

/** Radix Toast Root（`<li>`）——variant 的 class 掛在它身上。 */
function toastRoot(title: string): HTMLElement {
  return screen.getByText(title, { exact: true }).closest("li") as HTMLElement;
}

async function openRowMenu(title: string): Promise<HTMLElement> {
  // Radix DropdownMenu 的 trigger 只聽 pointerdown。
  fireEvent.pointerDown(within(panel()).getByRole("button", { name: `Actions for ${title}` }), { button: 0 });
  return screen.findByRole("menu");
}

const BUSY = "The server is busy. Please try again shortly.";

describe("TrashPanel（平常）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("TP1 標題列：Trash · 3 notes、Select（24px 圖示鈕）與 Empty（紅字）可按", async () => {
    stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(header()).toHaveTextContent("Trash · 3 notes"));

    const select = within(header()).getByRole("button", { name: "Select" });
    expect(select).toHaveAttribute("title", "Select");
    expect(select.querySelector('svg[data-icon="select"]')).not.toBeNull();
    expect(select).toHaveClass("h-6", "w-6");
    expect(select).toBeEnabled();
    const empty = within(header()).getByRole("button", { name: "Empty" });
    expect(empty).toHaveClass("text-destructive");
    expect(empty).toBeEnabled();

    // 「選取」只送 start（畫面在 T5）。
    fireEvent.click(select);
    expect(screen.getByTestId("selecting")).toHaveTextContent("true");
  });

  it("TP1 0 篇：兩顆 disabled、The trash is empty.、沒有列", async () => {
    stubServer({ items: [] });
    renderPanel();
    expect(await within(panel()).findByText("The trash is empty.", { exact: true })).toBeInTheDocument();
    expect(header()).toHaveTextContent("Trash · 0 notes");
    expect(within(header()).getByRole("button", { name: "Select" })).toBeDisabled();
    expect(within(header()).getByRole("button", { name: "Empty" })).toBeDisabled();
    expect(within(panel()).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("TP1 載入中：標題 Trash、兩顆 disabled", async () => {
    stubServer({ list: "pending" });
    renderPanel();
    expect(await within(panel()).findByText("Loading…", { exact: true })).toBeInTheDocument();
    expect(within(header()).getByText("Trash", { exact: true })).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Select" })).toBeDisabled();
    expect(within(header()).getByRole("button", { name: "Empty" })).toBeDisabled();
  });

  it("TP11 選取模式中再按 Select 不重送 start（已勾的不被清空）", async () => {
    stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(header()).toHaveTextContent("Trash · 3 notes"));
    const select = within(header()).getByRole("button", { name: "Select" });
    fireEvent.click(select);
    fireEvent.click(screen.getByTestId("toggle-p1"));
    expect(screen.getByTestId("selected-count")).toHaveTextContent("1");

    fireEvent.click(select);
    expect(screen.getByTestId("selecting")).toHaveTextContent("true");
    expect(screen.getByTestId("selected-count")).toHaveTextContent("1");
  });

  it("TP2 兩區：Personal 在前、區內照 server 順序；只有一區時另一區的區標不渲染", async () => {
    stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    const headings = within(panel()).getAllByRole("heading", { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(["Personal", "Workspace"]);
    const personal = within(panel()).getByRole("list", { name: "Personal" });
    expect([...personal.querySelectorAll("li[data-node-id]")].map((li) => li.getAttribute("data-node-id"))).toEqual(["p1", "p2"]);
    const workspace = within(panel()).getByRole("list", { name: "Workspace" });
    expect([...workspace.querySelectorAll("li[data-node-id]")].map((li) => li.getAttribute("data-node-id"))).toEqual(["w1"]);
  });

  it("TP2 只有個人項目 → 沒有 Workspace 區標", async () => {
    stubServer({ items: [P1, P2] });
    renderPanel();
    await waitFor(() => expect(row("p2")).not.toBeNull());
    expect(within(panel()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Personal"]);
  });

  it("TP2 只有工作坊項目 → 沒有 Personal 區標；清空框也沒有 Personal 列", async () => {
    stubServer({ items: [W1] });
    renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    expect(within(panel()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Workspace"]);
    fireEvent.click(within(header()).getByRole("button", { name: "Empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Workspace: 1 note (including some deleted by other members)",
    ]);
  });

  it("TP3 列：第二行、title、不是連結、data-node-*", async () => {
    stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    expect(detail("p1")).toHaveTextContent(/^3 days left$/);
    expect(detail("w1")).toHaveTextContent(/^R&D · Deleted by Amy · 3 days left$/);
    expect(row("p1").getAttribute("title")).toContain("Moved to the trash");
    expect(within(panel()).queryAllByRole("link")).toHaveLength(0);
    for (const id of ["p1", "p2", "w1"]) {
      expect(row(id)).toHaveAttribute("data-node-kind", "note");
      expect(row(id)).toHaveAttribute("data-node-id", id);
    }
  });

  it("TP4 列動作：還原鈕 hover 浮出＋圖示；⋮ 選單兩項帶圖示、永久刪除紅字", async () => {
    stubServer({ items: [P1, P2, W1] });
    renderPanel();
    const restore = await within(panel()).findByRole("button", { name: "Restore p1" });
    expect(restore).toHaveClass(...hoverReveal("noterow").split(" "));
    expect(restore).toHaveClass("h-6", "w-6");
    expect(restore).toHaveAttribute("title", "Restore");
    expect(restore.querySelector('svg[data-icon="restore"]')).not.toBeNull();
    expect(within(panel()).getByRole("button", { name: "Actions for p1" })).toHaveClass(...hoverReveal("noterow").split(" "));

    const menu = await openRowMenu("p1");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Restore", "Delete permanently"]);
    expect(items[0].querySelector('svg[data-icon="restore"]')).not.toBeNull();
    expect(items[1].querySelector('svg[data-icon="trash"]')).not.toBeNull();
    expect(items[1]).toHaveClass("text-destructive");
  });

  it("TP5 還原：POST ids、toast、清單重抓、焦點回清單", async () => {
    const server = stubServer({ items: [P1, P2, W1] });
    renderPanel();
    fireEvent.click(await within(panel()).findByRole("button", { name: "Restore p1" }));

    await waitFor(() => expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1"] }]));
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Restored 1 note")).not.toHaveClass("bg-destructive");
    await waitFor(() => expect(row("p1")).toBeNull());
    expect(header()).toHaveTextContent("Trash · 2 notes");
    await waitFor(() => expect(list()).toHaveFocus());
  });

  it("TP5 還原全被略過：Restored 0 notes, 1 no longer in the trash（destructive）", async () => {
    stubServer({ items: [P1], restore: (ids) => ({ status: 200, body: { restored: [], skipped: ids.map((id) => ({ id, reason: "not_in_trash" })) } }) });
    renderPanel();
    fireEvent.click(await within(panel()).findByRole("button", { name: "Restore p1" }));
    const title = "Restored 0 notes, 1 no longer in the trash";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
  });

  it("TP5c 還原等回應期間焦點已移到面板外 → 完成後不搶回清單", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer({ items: [P1, P2], hold });
    renderPanel();
    fireEvent.click(await within(panel()).findByRole("button", { name: "Restore p1" }));
    const outside = screen.getByRole("textbox", { name: "outside" });
    outside.focus();
    await act(async () => {
      release();
    });
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(row("p1")).toBeNull());
    expect(outside).toHaveFocus();
  });

  it("TP5d 焦點在面板內（列的還原鈕上）→ 還原完成後焦點回清單", async () => {
    stubServer({ items: [P1, P2] });
    renderPanel();
    const restore = await within(panel()).findByRole("button", { name: "Restore p1" });
    restore.focus();
    fireEvent.click(restore);
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(list()).toHaveFocus());
  });

  it("TP5b 連點還原只送一次；⋮ 的「還原」同一條路", async () => {
    const server = stubServer({ items: [P1, P2] });
    renderPanel();
    const restore = await within(panel()).findByRole("button", { name: "Restore p1" });
    fireEvent.click(restore);
    fireEvent.click(restore);
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await act(async () => {});
    expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1"] }]);

    const menu = await openRowMenu("p2");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1"] }, { ids: ["p2"] }]));
  });

  it("TP12 還原失敗（第一批就失敗）：錯誤標題、沒有「Restored 0 notes」描述", async () => {
    stubServer({ items: [P1], restore: () => ({ status: 500, body: { error: { code: "internal", message: "x" } } }) });
    renderPanel();
    fireEvent.click(await within(panel()).findByRole("button", { name: "Restore p1" }));
    const title = "Something went wrong. Please try again.";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    expect(screen.queryByText(/^Restored \d+ notes?/)).toBeNull();
  });

  it("TP6 單篇永久刪除：確認框、取消不送且焦點回 ⋮、確認才送、焦點回清單", async () => {
    const server = stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(row("p1")).not.toBeNull());
    const trigger = within(panel()).getByRole("button", { name: "Actions for p1" });

    let menu = await openRowMenu("p1");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently" }));
    let dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    expect(within(dialog).getByText("The notes and their attachments will be permanently deleted. This can't be undone.", { exact: true })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.posts("/api/trash/purge")).toEqual([]);
    await waitFor(() => expect(trigger).toHaveFocus());

    menu = await openRowMenu("p1");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently" }));
    dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["p1"] }]));
    expect(await screen.findByText("Permanently deleted 1 note", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(list()).toHaveFocus());
    await waitFor(() => expect(row("p1")).toBeNull());
    expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["p1"] }]);
  });

  it("TP6b 送出中確認鈕 disabled，回應後關框", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer({ items: [P1], hold });
    renderPanel();
    await waitFor(() => expect(row("p1")).not.toBeNull());
    const menu = await openRowMenu("p1");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("TP6c 送出後、回應前取消並對另一列開框 → 第一發回來不關第二個框", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubServer({ items: [P1, P2], hold });
    renderPanel();
    await waitFor(() => expect(row("p2")).not.toBeNull());
    let menu = await openRowMenu("p1");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently" }));
    let dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["p1"] }]));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    menu = await openRowMenu("p2");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently" }));
    dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    await act(async () => {
      release();
    });
    expect(await screen.findByText("Permanently deleted 1 note", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(row("p1")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Permanently delete 1 note?" })).toBe(dialog);
  });

  it("TP7 清空：框內分區篇數與「含其他成員」逐區判斷；確認送清單上全部 id（順序同清單）", async () => {
    const server = stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    const empty = within(header()).getByRole("button", { name: "Empty" });

    fireEvent.click(empty);
    let dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getByText("3 notes and their attachments will be permanently deleted. This can't be undone.", { exact: true })).toBeInTheDocument();
    const lines = within(dialog).getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toEqual(["Personal: 2 notes", "Workspace: 1 note (including some deleted by other members)"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.posts("/api/trash/purge")).toEqual([]);
    await waitFor(() => expect(empty).toHaveFocus());

    fireEvent.click(empty);
    dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["p1", "p2", "w1"] }]));
    expect(await screen.findByText("Permanently deleted 3 notes", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await within(panel()).findByText("The trash is empty.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(list()).toHaveFocus());
  });

  it("TP7b 清空框開著時清單被重抓成 0 篇 → 確認不送請求、不報 0 篇、直接關框", async () => {
    const server = stubServer({ items: [P1] });
    const { queryClient } = renderPanel();
    await waitFor(() => expect(row("p1")).not.toBeNull());
    fireEvent.click(within(header()).getByRole("button", { name: "Empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    server.setItems([]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    });
    // react-query 以 setTimeout(0) 通知 observer，要等下一個 macrotask 才重繪。
    expect(await within(dialog).findByText("0 notes and their attachments will be permanently deleted. This can't be undone.", { exact: true })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {});
    expect(server.posts("/api/trash/purge")).toEqual([]);
    expect(screen.queryByText(/^Permanently deleted/)).toBeNull();
  });

  it("TP7c 清空送出後、回應前取消又重開清空框 → 第一發回來不關新開的框", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubServer({ items: [P1, P2], hold });
    renderPanel();
    await waitFor(() => expect(row("p2")).not.toBeNull());
    const empty = within(header()).getByRole("button", { name: "Empty" });
    fireEvent.click(empty);
    let dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(server.posts("/api/trash/purge")).toHaveLength(1));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(empty);
    dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    await act(async () => {
      release();
    });
    expect(await screen.findByText("Permanently deleted 2 notes", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(row("p1")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Empty the trash?" })).toBe(dialog);
  });

  it("TP7 250 篇（全個人、我刪的）：分兩批 200＋50；框內沒有 Workspace 列", async () => {
    const many = Array.from({ length: 250 }, (_, i) => trashItem({ id: `n${String(i).padStart(3, "0")}`, title: `n${i}` }));
    const server = stubServer({ items: many });
    renderPanel();
    await waitFor(() => expect(header()).toHaveTextContent("Trash · 250 notes"));
    fireEvent.click(within(header()).getByRole("button", { name: "Empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Personal: 250 notes"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(server.posts("/api/trash/purge")).toHaveLength(2));
    const [a, b] = server.posts("/api/trash/purge") as { ids: string[] }[];
    expect(a.ids).toEqual(many.slice(0, 200).map((item) => item.id));
    expect(b.ids).toEqual(many.slice(200).map((item) => item.id));
    expect(await screen.findByText("Permanently deleted 250 notes", { exact: true })).toBeInTheDocument();
  });

  it("TP7 個人區有一篇刪除者帳號已刪（deletedBy: null）→ Personal 列帶「含其他成員」", async () => {
    const orphan = trashItem({ id: "p3", title: "p3", deletedBy: null }, { deletedDaysAgo: 3 });
    stubServer({ items: [P1, orphan] });
    renderPanel();
    await waitFor(() => expect(row("p3")).not.toBeNull());
    fireEvent.click(within(header()).getByRole("button", { name: "Empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Personal: 2 notes (including some deleted by other members)",
    ]);
  });

  it("TP7 中途失敗（250 篇、第二批 409）：框關閉、錯誤 toast 報已完成 200 篇、沒有成功形的 toast", async () => {
    const many = Array.from({ length: 250 }, (_, i) => trashItem({ id: `n${String(i).padStart(3, "0")}`, title: `n${i}` }));
    const server = stubServer({
      items: many,
      purge: (ids, call) =>
        call === 1
          ? { status: 200, body: { purged: ids, skipped: [] } }
          : { status: 409, body: { error: { code: "server_busy", message: "x" } } },
    });
    renderPanel();
    await waitFor(() => expect(header()).toHaveTextContent("Trash · 250 notes"));
    fireEvent.click(within(header()).getByRole("button", { name: "Empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByText(BUSY, { exact: true })).toBeInTheDocument();
    expect(server.posts("/api/trash/purge")).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const root = toastRoot(BUSY);
    expect(root).toHaveClass("bg-destructive");
    expect(within(root).getByText("Permanently deleted 200 notes", { exact: true })).toBeInTheDocument();
    // 「Permanently deleted …」只出現在錯誤 toast 的描述裡，沒有另一則成功形的 toast。
    expect(screen.getAllByText(/^Permanently deleted \d+ notes?$/)).toHaveLength(1);
    await waitFor(() => expect(header()).toHaveTextContent("Trash · 50 notes"));
  });

  it("TP8 GET /api/trash 500 → role=alert", async () => {
    stubServer({ list: 500 });
    renderPanel();
    expect(await within(panel()).findByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
    expect(within(header()).getByRole("button", { name: "Empty" })).toBeDisabled();
  });

  it("TP8b 背景重抓失敗（快取仍有舊清單）→ role=alert、兩顆 disabled", async () => {
    const opts: ServerOpts = { items: [P1, W1] };
    stubServer(opts);
    const { queryClient } = renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    expect(within(header()).getByRole("button", { name: "Empty" })).toBeEnabled();
    opts.list = 500;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    });
    expect(await within(panel()).findByRole("alert")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Select" })).toBeDisabled();
    expect(within(header()).getByRole("button", { name: "Empty" })).toBeDisabled();
  });

  it("TP9 truncated：清單末尾一行灰字；false 時沒有", async () => {
    stubServer({ items: [P1, W1], truncated: true });
    renderPanel();
    const note = await within(list()).findByText("Only the 1,000 most recently deleted notes are listed.", { exact: true });
    expect(list().lastElementChild).toBe(note);
  });

  it("TP9 truncated false：沒有那行", async () => {
    stubServer({ items: [P1, W1], truncated: false });
    renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    expect(within(list()).queryByText("Only the 1,000 most recently deleted notes are listed.")).toBeNull();
  });

  it("TP10 zh-TW：標題、工作坊第二行、清空鈕與清空框的分區行", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      stubServer({ items: [P1, P2, W1] });
      renderPanel();
      await waitFor(() => expect(header()).toHaveTextContent("垃圾桶 · 3 篇"));
      expect(detail("w1")).toHaveTextContent(/^R&D · Amy 刪除 · 剩 3 天$/);
      const empty = within(header()).getByRole("button", { name: "清空" });
      fireEvent.click(empty);
      const dialog = await screen.findByRole("dialog", { name: "清空垃圾桶？" });
      expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["個人 2 篇", "工作坊 1 篇（含其他成員刪除的）"]);
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
