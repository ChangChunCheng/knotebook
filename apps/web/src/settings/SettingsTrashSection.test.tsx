import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TrashSettingsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { TRASH_SETTINGS_QUERY_KEY } from "@/api/trash";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { SiteTrashGroup } from "./SettingsTrashSection";

// Site trash settings (#181). Renders `SiteTrashGroup` alone, and queries always go through the trash region; the page-level arrangement is in SettingsStorageSection.test.tsx.

const URL_ = "/api/admin/trash/settings";
const EN_DESCRIPTION =
  "Notes moved to the trash are permanently deleted once they've been there longer than this (checked once an hour). If you shorten it, notes already past the new limit are deleted starting at the next check (up to 2,000 per check).";
const ZH_DESCRIPTION =
  "筆記移到垃圾桶後，超過保留天數會自動永久刪除（每小時檢查一次）。縮短天數時，已超過新天數的筆記會從下一次檢查開始刪除（每次最多 2,000 篇）。";
const INVALID = "Use a whole number from 1 to 3650.";

function res(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

interface Server {
  settings: TrashSettingsDto;
  get?: () => Promise<Response>;
  patch?: (body: unknown) => Response | Promise<Response>;
}

function setup(server: Server) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === URL_ && method === "GET") return server.get ? server.get() : Promise.resolve(res(200, server.settings));
    if (url === URL_ && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as TrashSettingsDto;
      return Promise.resolve(server.patch ? server.patch(body) : res(200, body));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SiteTrashGroup />
      <Toaster />
    </QueryClientProvider>,
  );
  const patches = () =>
    fetchMock.mock.calls
      .filter(([u, i]) => String(u) === URL_ && ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "PATCH")
      .map(([, i]) => String((i as RequestInit).body));
  return { fetchMock, queryClient, patches };
}

const area = () => within(screen.getByRole("region", { name: i18n.t("admin.trash.title") }));
const daysField = () => area().getByLabelText("Days to keep");
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("SiteTrashGroup (site trash settings, #181)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET 7 -> title Trash, switch checked, days 7, the description sentence (exact version, including at most 2,000 notes per run)", async () => {
    setup({ settings: { retentionDays: 7 } });
    expect(await screen.findByRole("switch", { name: "Delete automatically" })).toHaveAttribute("aria-checked", "true");
    expect(area().getByRole("heading", { level: 2, name: "Trash" })).toBeInTheDocument();
    expect(area().getByRole("switch", { name: "Delete automatically" })).toHaveAttribute("aria-checked", "true");
    expect(daysField()).toHaveValue("7");
    expect(area().getByText(EN_DESCRIPTION)).toBeInTheDocument();
  });

  it("change to 30 -> Save -> PATCH {retentionDays:30}, toast", async () => {
    const { patches } = setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "30" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Trash settings saved", { exact: true })).toBeInTheDocument();
    expect(patches()).toEqual(['{"retentionDays":30}']);
    expect(area().queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Save is disabled while the PATCH hangs (no resend); recovers after the response", async () => {
    let release: (r: Response) => void = () => {};
    const { patches } = setup({
      settings: { retentionDays: 7 },
      patch: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "30" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual(['{"retentionDays":30}']));
    expect(area().getByRole("button", { name: "Save" })).toBeDisabled();
    release(res(200, { retentionDays: 30 }));
    await waitFor(() => expect(area().getByRole("button", { name: "Save" })).not.toBeDisabled());
  });

  it("0 / 3651 / abc / 1.5 / empty -> inline error, not sent; changing the text clears the error", async () => {
    const { patches } = setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "Delete automatically" });
    for (const value of ["0", "3651", "abc", "1.5", ""]) {
      fireEvent.change(daysField(), { target: { value } });
      // Changing the field clears the previous group's error - the alert below only appears when this group is submitted
      expect(area().queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.click(area().getByRole("button", { name: "Save" }));
      expect(await area().findByRole("alert")).toHaveTextContent(INVALID);
    }
    await tick();
    expect(patches()).toEqual([]);
  });

  it("toggling the switch after an inline error appears -> the error disappears", async () => {
    setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "0" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    expect(await area().findByRole("alert")).toHaveTextContent(INVALID);
    fireEvent.click(area().getByRole("switch", { name: "Delete automatically" }));
    expect(area().queryByRole("alert")).not.toBeInTheDocument();
  });

  it("boundaries 1 and 3650 -> both send a PATCH", async () => {
    const { patches } = setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "1" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual(['{"retentionDays":1}']));
    await waitFor(() => expect(area().getByRole("button", { name: "Save" })).not.toBeDisabled());
    fireEvent.change(daysField(), { target: { value: "3650" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual(['{"retentionDays":1}', '{"retentionDays":3650}']));
    expect(area().queryByRole("alert")).not.toBeInTheDocument();
  });

  it("after a successful save the local value is cleared: if the server later changes to 40 and it refetches -> the field shows 40", async () => {
    const server: Server = { settings: { retentionDays: 7 } };
    const { queryClient } = setup(server);
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "30" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await screen.findByText("Trash settings saved", { exact: true });
    server.settings = { retentionDays: 40 };
    await queryClient.invalidateQueries({ queryKey: TRASH_SETTINGS_QUERY_KEY });
    await waitFor(() => expect(daysField()).toHaveValue("40"));
  });

  it("after a successful save the local switch is also cleared: server was null -> turn on and save 30 -> server goes back to null, refetch -> the switch is unchecked", async () => {
    const server: Server = { settings: { retentionDays: null } };
    const { queryClient } = setup(server);
    fireEvent.click(await screen.findByRole("switch", { name: "Delete automatically" }));
    fireEvent.change(daysField(), { target: { value: "30" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await screen.findByText("Trash settings saved", { exact: true });
    server.settings = { retentionDays: null };
    await queryClient.invalidateQueries({ queryKey: TRASH_SETTINGS_QUERY_KEY });
    await waitFor(() => expect(area().getByRole("switch", { name: "Delete automatically" })).toHaveAttribute("aria-checked", "false"));
    expect(area().queryByLabelText("Days to keep")).not.toBeInTheDocument();
  });

  it("turning the switch off -> the days field disappears -> Save -> PATCH {retentionDays:null}", async () => {
    const { patches } = setup({ settings: { retentionDays: 7 } });
    fireEvent.click(await screen.findByRole("switch", { name: "Delete automatically" }));
    expect(area().getByRole("switch", { name: "Delete automatically" })).toHaveAttribute("aria-checked", "false");
    expect(area().queryByLabelText("Days to keep")).not.toBeInTheDocument();
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual(['{"retentionDays":null}']));
    expect(await screen.findByText("Trash settings saved", { exact: true })).toBeInTheDocument();
  });

  it("typing an invalid days value then turning the switch off -> Save still sends {retentionDays:null}, no inline error (days aren't validated while off)", async () => {
    const { patches } = setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "abc" } });
    fireEvent.click(area().getByRole("switch", { name: "Delete automatically" }));
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual(['{"retentionDays":null}']));
    await screen.findByText("Trash settings saved", { exact: true });
    expect(area().queryByRole("alert")).not.toBeInTheDocument();
  });

  it("server null -> switch unchecked, no days field; turning on -> days field defaults to 7; no PATCH without pressing Save", async () => {
    const { patches } = setup({ settings: { retentionDays: null } });
    const sw = await screen.findByRole("switch", { name: "Delete automatically" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(area().queryByLabelText("Days to keep")).not.toBeInTheDocument();
    fireEvent.click(sw);
    expect(daysField()).toHaveValue("7");
    await tick();
    expect(patches()).toEqual([]);
  });

  it("PATCH 400 -> inline errors.invalid_body", async () => {
    setup({ settings: { retentionDays: 7 }, patch: () => res(400, { error: { code: "invalid_body", message: "x" } }) });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "9" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    expect(await area().findByRole("alert")).toHaveTextContent(i18n.t("errors.invalid_body"));
  });

  it("GET 500 -> role=alert inside the same-titled region", async () => {
    setup({ settings: { retentionDays: 7 }, get: () => Promise.resolve(res(500, { error: { code: "boom", message: "x" } })) });
    expect(await area().findByRole("alert")).toHaveTextContent(i18n.t("errors.fallback"));
    expect(area().queryByRole("switch")).not.toBeInTheDocument();
  });

  it("GET hangs -> Loading... inside the same-titled region", async () => {
    setup({ settings: { retentionDays: 7 }, get: () => new Promise<Response>(() => {}) });
    expect(area().getByText("Loading…")).toBeInTheDocument();
    expect(area().queryByRole("switch")).not.toBeInTheDocument();
  });

  it("zh-TW description sentence is verbatim the exact version (deletes from the next check, at most 2,000 notes per run)", async () => {
    await i18n.changeLanguage("zh-TW");
    setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "自動永久刪除" });
    expect(area().getByText(ZH_DESCRIPTION)).toBeInTheDocument();
  });
});
