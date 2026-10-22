import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SidebarTab } from "@/lib/sidebar-tab";
import i18n from "@/i18n";
import { SidebarTabProvider } from "@/lib/sidebar-tab";
import { trashList } from "@/test/trash-fixtures";
import { SidebarTabList } from "./SidebarTabList";
import { SidebarFooter } from "./SidebarFooter";

// 側欄底部（plan T4）：新增筆記／垃圾桶保留天數說明；`useTrash()` 只在垃圾桶 tab 才掛（讀碼發現 28）。

afterEach(() => {
  localStorage.clear();
});

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubTrash(retentionDays: number | null = 7, list?: "pending" | number) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      urls.push(`${method} ${url}`);
      if (url === "/api/trash" && method === "GET") {
        if (list === "pending") return new Promise<Response>(() => {});
        if (typeof list === "number") return Promise.resolve(fakeResponse({ error: { code: "internal", message: "x" } }, list));
        return Promise.resolve(fakeResponse(trashList([], { retentionDays })));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return urls;
}

function renderFooter(tab: SidebarTab, props: { searching?: boolean; newNotePending?: boolean } = {}) {
  localStorage.setItem("sidebar.tab", tab);
  const onCreateNote = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SidebarTabProvider>
        <SidebarTabList idBase="t" />
        <SidebarFooter searching={props.searching ?? false} onCreateNote={onCreateNote} newNotePending={props.newNotePending ?? false} />
      </SidebarTabProvider>
    </QueryClientProvider>,
  );
  return { onCreateNote };
}

describe("SidebarFooter", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SF1 垃圾桶 tab：保留 7 天的說明句、沒有 New note", async () => {
    stubTrash(7);
    renderFooter("trash");
    expect(await screen.findByTestId("trash-footer")).toHaveTextContent(/^Permanently deleted 7 days after deletion$/);
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  });

  it("SF1 保留 1 天：單數", async () => {
    stubTrash(1);
    renderFooter("trash");
    expect(await screen.findByTestId("trash-footer")).toHaveTextContent(/^Permanently deleted 1 day after deletion$/);
  });

  it("SF1 不自動刪（null）", async () => {
    stubTrash(null);
    renderFooter("trash");
    expect(await screen.findByTestId("trash-footer")).toHaveTextContent(/^The trash isn't emptied automatically$/);
  });

  it("SF2 一般 tab：New note，按下呼叫 onCreateNote", async () => {
    stubTrash();
    const { onCreateNote } = renderFooter("myNotes");
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(onCreateNote).toHaveBeenCalledTimes(1);
  });

  it("SF2 newNotePending → disabled", () => {
    stubTrash();
    renderFooter("myNotes", { newNotePending: true });
    expect(screen.getByRole("button", { name: "New note" })).toBeDisabled();
  });

  it.each([
    ["載入中", "pending" as const],
    ["失敗", 500],
  ])("SF5 垃圾桶 tab %s → 沒有說明句、留 h-7 佔位（版面不跳）", async (_label, list) => {
    const urls = stubTrash(7, list);
    renderFooter("trash");
    await waitFor(() => expect(urls).toContain("GET /api/trash"));
    await act(async () => {});
    expect(screen.queryByTestId("trash-footer")).toBeNull();
    expect(document.querySelector("div.h-7")).not.toBeNull();
  });

  it("SF3 垃圾桶 tab 但搜尋中 → New note、沒有說明句", async () => {
    const urls = stubTrash();
    renderFooter("trash", { searching: true });
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.queryByTestId("trash-footer")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls).not.toContain("GET /api/trash");
  });

  it("SF4 一般 tab 不打 GET /api/trash；切到垃圾桶才打一次", async () => {
    const urls = stubTrash();
    renderFooter("myNotes");
    expect(await screen.findByRole("button", { name: "New note" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls).not.toContain("GET /api/trash");

    fireEvent.click(screen.getByRole("tab", { name: "Trash" }));
    expect(await screen.findByTestId("trash-footer")).toBeInTheDocument();
    await waitFor(() => expect(urls.filter((url) => url === "GET /api/trash")).toHaveLength(1));
  });
});
