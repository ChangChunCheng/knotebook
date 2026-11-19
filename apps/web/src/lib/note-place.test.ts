import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { FolderDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { indexFolders } from "@/components/sidebar/folder-index";
import { folderDto } from "@/test/folder-fixtures";
import { personalNote } from "@/test/select-fixtures";
import { placeNoteWithUndo } from "./note-place";

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

type Reply = { status: number; body: unknown };
const fail = (status: number, code: string): Reply => ({ status, body: { error: { code, message: "x" } } });

const PUT_URL = "/api/notes/n1/folder";

function stubPut(replies: Reply[]) {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT" && url === PUT_URL) {
        bodies.push(JSON.parse(String(init?.body)));
        const reply = replies.shift();
        if (reply === undefined) throw new Error("no more replies");
        return Promise.resolve(fakeResponse(reply.status, reply.body));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return bodies;
}

const A: FolderDto = folderDto({ id: "A", name: "A" });
const A1: FolderDto = folderDto({ id: "A1", name: "A1", parentId: "A" });
const B: FolderDto = folderDto({ id: "B", name: "B" });
const INDEX = indexFolders([A, A1, B]);

const PLACED_A1: NoteDto = personalNote({ id: "n1", title: "Note", folderId: "A1" });
const PLACED_ROOT: NoteDto = personalNote({ id: "n1", title: "Note", folderId: null });
const PLACED_B: NoteDto = personalNote({ id: "n1", title: "Note", folderId: "B" });

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["folders"], [A, A1, B]);
  render(createElement(Toaster));
  return { queryClient, t: i18n.t.bind(i18n) };
}

/** The toast currently on screen (the Radix Toast Root is an `<li>`). */
function toastItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("ol li"));
}

function toastRoot(title: string): HTMLElement {
  return screen.getByText(title, { exact: true }).closest("li") as HTMLElement;
}

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

describe("placeNoteWithUndo", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("moving into A1: PUT {folderId:A1} -> 'Moved to' toast naming A1, with Undo; A and A1 expand; ['note','n1'] is the response dto", async () => {
    const bodies = stubPut([{ status: 200, body: PLACED_A1 }]);
    const { queryClient, t } = setup();
    setCollapsed("folder:A", true);
    setCollapsed("folder:A1", true);

    await act(() => placeNoteWithUndo({ noteId: "n1", from: "B", to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t }));

    expect(bodies).toEqual([{ folderId: "A1" }]);
    expect(await screen.findByText("Moved to “A1”", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(isCollapsed("folder:A")).toBe(false);
    expect(isCollapsed("folder:A1")).toBe(false);
    expect(queryClient.getQueryData(["note", "n1"])).toEqual(PLACED_A1);
  });

  it("back to the root: body {folderId:null}, 'Moved to' toast naming Top level", async () => {
    const bodies = stubPut([{ status: 200, body: PLACED_ROOT }]);
    const { queryClient, t } = setup();

    await act(() =>
      placeNoteWithUndo({ noteId: "n1", from: "A1", to: { folderId: null, name: t("folders.dest.topLevel") }, index: INDEX, queryClient, t }),
    );

    expect(bodies).toEqual([{ folderId: null }]);
    expect(await screen.findByText("Moved to “Top level”", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("404 folder_not_found -> destructive toast 'Folder not found.', no Undo, ['folders'] invalidated, sent once", async () => {
    const bodies = stubPut([fail(404, "folder_not_found")]);
    const { queryClient, t } = setup();
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(false);

    await act(() => placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t }));

    expect(await screen.findByText("Folder not found.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Folder not found.")).toHaveClass("bg-destructive");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it("pressing Undo -> PUT {folderId:<from>}; on success the original toast disappears and no new toast appears", async () => {
    const bodies = stubPut([
      { status: 200, body: PLACED_A1 },
      { status: 200, body: PLACED_B },
    ]);
    const { queryClient, t } = setup();
    await act(() => placeNoteWithUndo({ noteId: "n1", from: "B", to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t }));
    expect(toastItems()).toHaveLength(1);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(bodies).toEqual([{ folderId: "A1" }, { folderId: "B" }]));
    await waitFor(() => expect(queryClient.getQueryData(["note", "n1"])).toEqual(PLACED_B));
    await act(async () => {});
    expect(screen.queryByText("Moved to “A1”", { exact: true })).toBeNull();
    expect(toastItems()).toHaveLength(0);
  });

  it("Undo returning 404 -> destructive error toast, Undo sent once", async () => {
    const bodies = stubPut([{ status: 200, body: PLACED_A1 }, fail(404, "folder_not_found")]);
    const { queryClient, t } = setup();
    await act(() => placeNoteWithUndo({ noteId: "n1", from: "B", to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t }));

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Folder not found.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Folder not found.")).toHaveClass("bg-destructive");
    await act(async () => {});
    expect(bodies).toEqual([{ folderId: "A1" }, { folderId: "B" }]);
  });

  it("zh: name = the folder's short name 'A' -> the screen shows 「已移到「A」」 and 「復原」", async () => {
    await i18n.changeLanguage("zh-TW");
    stubPut([{ status: 200, body: { ...PLACED_A1, folderId: "A" } }]);
    const { queryClient, t } = setup();

    await act(() => placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A", name: "A" }, index: INDEX, queryClient, t }));

    expect(await screen.findByText("已移到「A」", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "復原" })).toBeInTheDocument();
  });

  it("409 folder_too_deep: the error text carries the limit and does not contain {{max}}", async () => {
    stubPut([fail(409, "folder_too_deep")]);
    const { queryClient, t } = setup();

    await act(() => placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t }));

    const message = await screen.findByText(/^Folders can be at most .* levels deep\.$/);
    expect(message.textContent).not.toContain("{{max}}");
    expect(message.textContent).toMatch(/at most \d+ levels/);
  });
});

// Drag-drop placement: with optimistic, ['notes'] is updated before the PUT and rolled back on failure; ⋮ does not use optimistic, so its behaviour is unchanged.
describe("placeNoteWithUndo optimistic", () => {
  const CACHED: NoteDto[] = [personalNote({ id: "n1", title: "Note", folderId: null }), personalNote({ id: "n2", title: "Other", folderId: "B" })];

  function stubDeferredPut() {
    const bodies: unknown[] = [];
    let respond: (reply: Reply) => void = () => {
      throw new Error("PUT not sent yet");
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "PUT" && url === PUT_URL) {
          bodies.push(JSON.parse(String(init?.body)));
          return new Promise<Response>((resolve) => {
            respond = (reply) => resolve(fakeResponse(reply.status, reply.body));
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return { bodies, respond: (reply: Reply) => respond(reply) };
  }

  const folderOf = (queryClient: QueryClient, id: string) => queryClient.getQueryData<NoteDto[]>(["notes"])?.find((note) => note.id === id)?.folderId;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("optimistic: before the PUT responds, n1's folderId in ['notes'] is already A1 and the other notes are unchanged; after the response the toast shows as usual", async () => {
    const { bodies, respond } = stubDeferredPut();
    const { queryClient, t } = setup();
    queryClient.setQueryData(["notes"], CACHED);

    const done = placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t, optimistic: true });
    await waitFor(() => expect(bodies).toEqual([{ folderId: "A1" }]));

    expect(folderOf(queryClient, "n1")).toBe("A1");
    expect(folderOf(queryClient, "n2")).toBe("B");
    respond({ status: 200, body: PLACED_A1 });
    await act(() => done);
    expect(await screen.findByText("Moved to “A1”", { exact: true })).toBeInTheDocument();
  });

  it("optimistic + PUT 404 -> ['notes'] returns to the snapshot, error toast 'Folder not found.'", async () => {
    const { bodies, respond } = stubDeferredPut();
    const { queryClient, t } = setup();
    queryClient.setQueryData(["notes"], CACHED);

    const done = placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t, optimistic: true });
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(folderOf(queryClient, "n1")).toBe("A1");
    respond(fail(404, "folder_not_found"));
    await act(() => done);

    expect(queryClient.getQueryData(["notes"])).toEqual(CACHED);
    expect(await screen.findByText("Folder not found.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Folder not found.")).toHaveClass("bg-destructive");
  });

  it("without optimistic (the kebab menu) -> ['notes'] is unchanged before the PUT responds", async () => {
    const { bodies, respond } = stubDeferredPut();
    const { queryClient, t } = setup();
    queryClient.setQueryData(["notes"], CACHED);

    const done = placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t });
    await waitFor(() => expect(bodies).toHaveLength(1));

    expect(queryClient.getQueryData(["notes"])).toEqual(CACHED);
    respond({ status: 200, body: PLACED_A1 });
    await act(() => done);
  });

  it("optimistic but ['notes'] has no cache -> the PUT is still sent, and on failure ['notes'] is not written", async () => {
    const { bodies, respond } = stubDeferredPut();
    const { queryClient, t } = setup();

    const done = placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t, optimistic: true });
    await waitFor(() => expect(bodies).toEqual([{ folderId: "A1" }]));
    respond(fail(403, "forbidden"));
    await act(() => done);

    expect(queryClient.getQueryData(["notes"])).toBeUndefined();
    expect(await screen.findByText("You don't have permission to do that.", { exact: true })).toBeInTheDocument();
  });

  it("optimistic + n2 changed elsewhere during the PUT -> a failed PUT restores only n1, n2's new value stays", async () => {
    const { bodies, respond } = stubDeferredPut();
    const { queryClient, t } = setup();
    queryClient.setQueryData(["notes"], CACHED);

    const done = placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t, optimistic: true });
    await waitFor(() => expect(bodies).toHaveLength(1));
    queryClient.setQueryData<NoteDto[]>(["notes"], (list) => list?.map((note) => (note.id === "n2" ? { ...note, folderId: "A" } : note)));
    respond(fail(403, "forbidden"));
    await act(() => done);

    expect(folderOf(queryClient, "n1")).toBeNull();
    expect(folderOf(queryClient, "n2")).toBe("A");
  });

  it("optimistic + PUT 403 -> ['notes'] is invalidated (the cancelled refetch must be made up)", async () => {
    const { bodies, respond } = stubDeferredPut();
    const { queryClient, t } = setup();
    queryClient.setQueryData(["notes"], CACHED);
    expect(queryClient.getQueryState(["notes"])?.isInvalidated).toBe(false);

    const done = placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t, optimistic: true });
    await waitFor(() => expect(bodies).toHaveLength(1));
    respond(fail(403, "forbidden"));
    await act(() => done);

    expect(queryClient.getQueryState(["notes"])?.isInvalidated).toBe(true);
  });

  it("optimistic cancels ['notes'] itself: an in-flight ['notes','n1','versions'] keeps fetching", async () => {
    const { bodies, respond } = stubDeferredPut();
    const { queryClient, t } = setup();
    queryClient.setQueryData(["notes"], CACHED);
    queryClient.fetchQuery({ queryKey: ["notes", "n1", "versions"], queryFn: () => new Promise<never>(() => {}) }).catch(() => {});
    await waitFor(() => expect(queryClient.getQueryState(["notes", "n1", "versions"])?.fetchStatus).toBe("fetching"));

    const done = placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t, optimistic: true });
    await waitFor(() => expect(bodies).toHaveLength(1));

    expect(queryClient.getQueryState(["notes", "n1", "versions"])?.fetchStatus).toBe("fetching");
    respond({ status: 200, body: PLACED_A1 });
    await act(() => done);
  });

  it("optimistic: before the PUT responds, the target A1 and its ancestor A are already written as expanded", async () => {
    const { bodies, respond } = stubDeferredPut();
    const { queryClient, t } = setup();
    queryClient.setQueryData(["notes"], CACHED);
    setCollapsed("folder:A", true);
    setCollapsed("folder:A1", true);

    const done = placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t, optimistic: true });
    await waitFor(() => expect(bodies).toHaveLength(1));

    expect(isCollapsed("folder:A")).toBe(false);
    expect(isCollapsed("folder:A1")).toBe(false);
    respond({ status: 200, body: PLACED_A1 });
    await act(() => done);
  });
});
