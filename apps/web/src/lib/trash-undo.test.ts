import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ApiFail } from "@/api/client";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { EDITOR_PERMS, OWNER_PERMS } from "@/test/fixtures";
import { folderDto } from "@/test/folder-fixtures";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { showTrashedToast } from "./trash-undo";

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const PERSONAL: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  permissions: OWNER_PERMS,
  folderId: null,
};

const GROUP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function groupNote(id: string, perms: NoteDto["permissions"]): NoteDto {
  return {
    ...PERSONAL,
    id,
    slug: `g-${id.slice(0, 4)}`,
    ownerId: null,
    ownerHandle: null,
    role: "editor",
    groupId: GROUP_ID,
    group: { id: GROUP_ID, name: "Workshop A" },
    permissions: perms,
  };
}
const GROUP_DELETE_ONLY = groupNote("22222222-2222-2222-2222-222222222222", { ...EDITOR_PERMS, edit: false, delete: true });
const GROUP_EDIT_DELETE = groupNote("33333333-3333-3333-3333-333333333333", { ...EDITOR_PERMS, edit: true, delete: true });

const HINT = "Members of the group whose role can both edit and delete notes can restore it.";

type RestoreReply = { status: 200; body: unknown } | { status: number; body: unknown };

function stubRestore(reply: RestoreReply) {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/trash/restore" && method === "POST") {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(fakeResponse({ ok: reply.status < 400, status: reply.status, json: () => Promise.resolve(reply.body) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return bodies;
}

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigate = vi.fn();
  render(createElement(Toaster));
  return { queryClient, navigate, t: i18n.t.bind(i18n) };
}

/** Radix Toast Root (`<li>`): the variant class sits on it. */
function toastRoot(title: string): HTMLElement {
  return screen.getByText(title, { exact: true }).closest("li") as HTMLElement;
}

describe("showTrashedToast / undoTrash", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("personal note: title 'Moved to the trash', has Undo, no hint sentence", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false }));

    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.queryByText(HINT, { exact: true })).toBeNull();
  });

  it("group note delete-only (edit false): no Undo, has the hint sentence", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [GROUP_DELETE_ONLY], queryClient, navigate, t, reopen: false }));

    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(HINT, { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("several notes: mixed (one delete-only) -> no Undo; both restorable -> Undo, pressing it sends two ids", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [PERSONAL, GROUP_DELETE_ONLY], queryClient, navigate, t, reopen: false }));
    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    act(() => dismissAllToasts());

    const bodies = stubRestore({ status: 200, body: { restored: [PERSONAL, GROUP_EDIT_DELETE], skipped: [] } });
    act(() => showTrashedToast({ notes: [PERSONAL, GROUP_EDIT_DELETE], queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(bodies).toEqual([{ ids: [PERSONAL.id, GROUP_EDIT_DELETE.id] }]));
  });

  it("undo succeeds + reopen: toast 'Restored 1 note' (not destructive), navigate(canonical) once", async () => {
    const { queryClient, navigate, t } = setup();
    stubRestore({ status: 200, body: { restored: [PERSONAL], skipped: [] } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Restored 1 note")).not.toHaveClass("bg-destructive");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(canonicalNotePath(PERSONAL));
  });

  it("undo succeeds, reopen false: does not navigate", async () => {
    const { queryClient, navigate, t } = setup();
    stubRestore({ status: 200, body: { restored: [PERSONAL], skipped: [] } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("already gone from the trash (all skipped): destructive toast 'Restored 0 notes, 1 no longer in the trash', does not navigate", async () => {
    const { queryClient, navigate, t } = setup();
    stubRestore({ status: 200, body: { restored: [], skipped: [{ id: PERSONAL.id, reason: "not_found" }] } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    const title = "Restored 0 notes, 1 no longer in the trash";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("seed before navigate: when navigating, the persistent [\"note\", id] entry is already success (the 404 error state left by moving to the trash is overwritten)", async () => {
    const { queryClient, navigate, t } = setup();
    queryClient.setQueryData(["note", PERSONAL.id], PERSONAL);
    await queryClient
      .fetchQuery({ queryKey: ["note", PERSONAL.id], queryFn: () => Promise.reject(new ApiFail(404, "in_trash", "x")), retry: false })
      .catch(() => {});
    expect(queryClient.getQueryState(["note", PERSONAL.id])?.status).toBe("error");

    const statusAtNavigate: (string | undefined)[] = [];
    navigate.mockImplementation(() => {
      statusAtNavigate.push(queryClient.getQueryState(["note", PERSONAL.id])?.status);
    });
    stubRestore({ status: 200, body: { restored: [PERSONAL], skipped: [] } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(statusAtNavigate).toEqual(["success"]);
  });

  it("undo fails (500): toast errors.fallback, no navigation, [\"trash\"] still invalidated", async () => {
    const { queryClient, navigate, t } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    // The code is not in errors.*, so errors.fallback is used (errors.internal has its own text).
    stubRestore({ status: 500, body: { error: { code: "unexpected_failure", message: "x" } } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText("An unexpected error occurred.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["trash"] }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("undo fails (409 server_busy): toast shows the errors.server_busy text by error code (not the generic text), destructive, no navigation", async () => {
    const { queryClient, navigate, t } = setup();
    // restoreTrashIds wraps the error in TrashBatchError: unwrap it (trashErrorCause) to get the code.
    stubRestore({ status: 409, body: { error: { code: "server_busy", message: "x" } } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    const title = "The server is busy. Please try again shortly.";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    expect(screen.queryByText("An unexpected error occurred.", { exact: true })).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("title: title verbatim, still has Undo", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false, title: "Moved 2 notes to the trash" }));

    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("not restorable + description: the description is 'X ' followed by the hint, no Undo", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [GROUP_DELETE_ONLY], queryClient, navigate, t, reopen: false, description: "X" }));

    expect(await screen.findByText(`X ${HINT}`, { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("reopenId overrides the inferred one: two notes, reopenId=b -> after undo navigates once to b's canonical path", async () => {
    const { queryClient, navigate, t } = setup();
    stubRestore({ status: 200, body: { restored: [PERSONAL, GROUP_EDIT_DELETE], skipped: [] } });
    act(() =>
      showTrashedToast({ notes: [PERSONAL, GROUP_EDIT_DELETE], queryClient, navigate, t, reopen: false, reopenId: GROUP_EDIT_DELETE.id }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith(canonicalNotePath(GROUP_EDIT_DELETE));
  });

  it("variant destructive: the toast root has bg-destructive", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false, variant: "destructive" }));

    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Moved to the trash")).toHaveClass("bg-destructive");
  });

  it("undoIds are merged into the restore body, deduplicated; notes: [] + undoIds -> has Undo", async () => {
    const { queryClient, navigate, t } = setup();
    const bodies = stubRestore({ status: 200, body: { restored: [PERSONAL], skipped: [] } });
    act(() => showTrashedToast({ notes: [PERSONAL], undoIds: [PERSONAL.id, "x2"], queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(bodies).toEqual([{ ids: [PERSONAL.id, "x2"] }]));
    act(() => dismissAllToasts());

    act(() => showTrashedToast({ notes: [], undoIds: ["y1"], queryClient, navigate, t, reopen: false, title: "Folder gone" }));
    expect(await screen.findByText("Folder gone", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("failure midway through batching, partial already restored 200 -> the error toast description is 'Restored 200 notes'", async () => {
    const { queryClient, navigate, t } = setup();
    const ids = Array.from({ length: 250 }, (_, i) => `n${i}`);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const batch = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
        call += 1;
        if (String(input) !== "/api/trash/restore") throw new Error(`unexpected fetch: ${String(input)}`);
        if (call === 1) return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ restored: batch.map((id) => ({ ...PERSONAL, id })), skipped: [] }) }));
        return Promise.resolve(fakeResponse({ ok: false, status: 429, json: () => Promise.resolve({ error: { code: "rate_limited", message: "x" } }) }));
      }),
    );
    act(() => showTrashedToast({ notes: [], undoIds: ids, queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 200 notes", { exact: true })).toBeInTheDocument();
  });

  /** `POST /api/trash/restore` takes `restoreReplies` in order (repeating the last once used up); `GET /api/folders` returns `folders`. */
  function stubRestoreAndFolders(restoreReplies: Array<(batch: string[]) => Response>, folders: unknown[]) {
    const folderGets: string[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/folders" && method === "GET") {
          folderGets.push(url);
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ folders }) }));
        }
        if (url === "/api/trash/restore" && method === "POST") {
          const batch = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
          const reply = restoreReplies[Math.min(call, restoreReplies.length - 1)]!;
          call += 1;
          return Promise.resolve(reply(batch));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return folderGets;
  }
  const ok = (body: unknown) => fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(body) });

  it("undo succeeds -> a previously collapsed folder:A is expanded", async () => {
    const { queryClient, navigate, t } = setup();
    const inA = { ...PERSONAL, folderId: "A" };
    const folderGets = stubRestoreAndFolders([() => ok({ restored: [inA], skipped: [] })], [folderDto({ id: "A", name: "A" })]);
    setCollapsed("folder:A", true);
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(isCollapsed("folder:A")).toBe(false));
    expect(folderGets).toHaveLength(1);
  });

  it("failure midway through batching -> folders of the notes already restored are expanded, the rest untouched", async () => {
    const { queryClient, navigate, t } = setup();
    const ids = Array.from({ length: 250 }, (_, i) => `n${i}`);
    const folderGets = stubRestoreAndFolders(
      [
        (batch) => ok({ restored: batch.map((id, i) => ({ ...PERSONAL, id, folderId: i === 0 ? "A" : null })), skipped: [] }),
        () => fakeResponse({ ok: false, status: 429, json: () => Promise.resolve({ error: { code: "rate_limited", message: "x" } }) }),
      ],
      [folderDto({ id: "A", name: "A" }), folderDto({ id: "B", name: "B" })],
    );
    setCollapsed("folder:A", true);
    setCollapsed("folder:B", true);
    act(() => showTrashedToast({ notes: [], undoIds: ids, queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 200 notes", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(isCollapsed("folder:A")).toBe(false));
    expect(isCollapsed("folder:B")).toBe(true);
    expect(folderGets).toHaveLength(1);
  });

  it("restorable + description: the description is shown as is (no hint appended), still has Undo", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false, description: "X" }));

    expect(await screen.findByText("X", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(`X ${HINT}`, { exact: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
});
