import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { canonicalNotePath, type FolderDto, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import type { CollabState } from "@/collab/connection";
import { NotePageControlsContext, type NotePageControls } from "@/lib/note-page-controls";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { folderDto, sharedFolder } from "@/test/folder-fixtures";
import { clickOutside } from "@/test/outside-click";
import { personalNote, sharedNote } from "@/test/select-fixtures";
import { __resetCollapseForTests } from "./collapse";
import { __resetFolderSortForTests } from "./folder-sort";
import { FolderDeleteDialog } from "./FolderDeleteDialog";

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

const A = folderDto({ id: "A", name: "A" });
const A1 = folderDto({ id: "A1", name: "A1", parentId: "A" });
const B = folderDto({ id: "B", name: "B" });
const SF = sharedFolder({ id: "SF", name: "SF" });
const P1 = personalNote({ id: "p1", title: "p1", folderId: "A" });
const P2 = personalNote({ id: "p2", title: "p2", folderId: "A1" });
const S1 = sharedNote({ id: "s1", title: "s1", folderId: "SF" });
const S2 = sharedNote({ id: "s2", title: "s2", folderId: "SF" });

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface ServerOpts {
  /** `GET /api/trash` retentionDays; `"pending"` = never responds. */
  retention?: number | null | "pending";
  del?: () => Response | Promise<Response>;
  restore?: (ids: string[], call: number) => Response;
  onDelete?: () => void;
}

function stubServer(opts: ServerOpts = {}) {
  const calls: Array<{ key: string; body: unknown }> = [];
  let restoreCall = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method === "GET") {
        if (url === "/api/notes") return Promise.resolve(json([P1, P2, S1, S2]));
        if (url === "/api/groups") return Promise.resolve(json([]));
        if (url === "/api/folders") return Promise.resolve(json({ folders: [A, A1, B, SF] }));
        if (url === "/api/trash") {
          if (opts.retention === "pending") return new Promise<Response>(() => {});
          return Promise.resolve(json({ retentionDays: opts.retention === undefined ? 7 : opts.retention, items: [], truncated: false }));
        }
        return Promise.resolve(json({ error: { code: "not_found", message: "x" } }, 404));
      }
      calls.push({ key: `${method} ${url}`, body });
      if (method === "DELETE" && url.startsWith("/api/folders/")) {
        opts.onDelete?.();
        return Promise.resolve(opts.del ? opts.del() : json({ trashedNoteIds: [], deletedFolderIds: [] }));
      }
      if (url === "/api/trash/restore") {
        restoreCall += 1;
        const ids = (body as { ids: string[] }).ids;
        return Promise.resolve(opts.restore ? opts.restore(ids, restoreCall) : json({ restored: [], skipped: [] }));
      }
      return Promise.resolve(json({ error: { code: "not_found", message: "x" } }, 404));
    }),
  );
  return calls;
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderDialog(folder: FolderDto, opts: { controls?: NotePageControls; path?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Host() {
    const [open, setOpen] = useState(true);
    return open ? <FolderDeleteDialog folder={folder} open onOpenChange={setOpen} /> : null;
  }
  const tree = opts.controls ? (
    <NotePageControlsContext.Provider value={opts.controls}>
      <Host />
    </NotePageControlsContext.Provider>
  ) : (
    <Host />
  );
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[opts.path ?? "/somewhere"]}>
        {tree}
        <LocationProbe />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const location = () => screen.getByTestId("location").textContent;
const dialog = () => screen.queryByRole("dialog");
const deleted = (ids: string[]) => () => json({ trashedNoteIds: ids, deletedFolderIds: ["A", "A1"] });
const DF3_A = "The folder and its 1 subfolder will be deleted. The 2 notes in it will move to the trash. Notes in the trash are permanently deleted after 7 days. Restoring from the trash rebuilds the folders along the original path.";

function controls(state: CollabState): NotePageControls {
  return { noteId: "p2", state, leavingRef: { current: false }, openEdits: () => {} };
}

describe("FolderDeleteDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("with notes: title, body, submit sends DELETE /api/folders/A, then toast + Undo", async () => {
    const calls = stubServer({ del: deleted(["p1", "p2"]) });
    renderDialog(A);
    expect(screen.getByRole("dialog", { name: "Delete folder “A”?" })).toBeInTheDocument();
    expect(await screen.findByText(DF3_A)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Folder deleted; 2 notes moved to the trash")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(calls.map((c) => c.key)).toEqual(["DELETE /api/folders/A"]);
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("Undo POSTs /api/trash/restore with body {ids: trashedNoteIds}", async () => {
    const calls = stubServer({ del: deleted(["p1", "p2"]), restore: () => json({ restored: [P1, P2], skipped: [] }) });
    renderDialog(A);
    await screen.findByText(DF3_A);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls.filter((c) => c.key === "POST /api/trash/restore").map((c) => c.body)).toEqual([{ ids: ["p1", "p2"] }]));
  });

  it("no notes: toast \"Folder deleted\", no Undo", async () => {
    stubServer({ del: deleted([]) });
    renderDialog(B);
    expect(await screen.findByText("This folder will be deleted. There are no notes in it.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Folder deleted", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("shared: title Remove folder, button Remove, the toast reports the number of placements, no Undo", async () => {
    stubServer();
    renderDialog(SF);
    expect(screen.getByRole("dialog", { name: "Remove folder “SF”?" })).toBeInTheDocument();
    await screen.findByText(/its 2 shared notes go back/);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Folder removed; 2 shared notes moved back to the top level")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("403 folder_delete_blocked: error toast, dialog closes", async () => {
    stubServer({ del: () => json({ error: { code: "folder_delete_blocked", message: "x" } }, 403) });
    renderDialog(A);
    await screen.findByText(DF3_A);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("This folder has notes you can't delete.")).toBeInTheDocument();
    await waitFor(() => expect(dialog()).toBeNull());
  });

  describe("cannot be closed while submitting, both buttons disabled", () => {
    async function startHeld() {
      let release: () => void = () => {};
      const held = new Promise<Response>((resolve) => (release = () => resolve(deleted(["p1", "p2"])())));
      stubServer({ del: () => held });
      renderDialog(A);
      await screen.findByText(DF3_A);
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled());
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      return release;
    }

    it("Esc", async () => {
      const release = await startHeld();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(dialog()).not.toBeNull();
      release();
      await waitFor(() => expect(dialog()).toBeNull());
    });

    it("the close button", async () => {
      const release = await startHeld();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(dialog()).not.toBeNull();
      release();
      await waitFor(() => expect(dialog()).toBeNull());
    });

    it("clicking outside", async () => {
      const release = await startHeld();
      await clickOutside();
      expect(dialog()).not.toBeNull();
      release();
      await waitFor(() => expect(dialog()).toBeNull());
    });
  });

  it("Undo of 250 notes where the second batch gets 429: the error toast's description is \"Restored 200 notes\"", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `n${i}`);
    stubServer({
      del: deleted(ids),
      restore: (batch, call) =>
        call === 1
          ? json({ restored: batch.map((id) => personalNote({ id, title: id })), skipped: [] })
          : json({ error: { code: "rate_limited", message: "x" } }, 429),
    });
    renderDialog(A);
    await screen.findByText(DF3_A);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 200 notes")).toBeInTheDocument();
  });

  it("retention days not yet loaded: purgeUnknown; loaded as null: purgeNever", async () => {
    stubServer({ retention: "pending" });
    renderDialog(A);
    expect(await screen.findByText(/when the trash's keeping period ends\./)).toBeInTheDocument();
  });

  it("retention days null: purgeNever", async () => {
    stubServer({ retention: null });
    renderDialog(A);
    expect(await screen.findByText(/aren't deleted automatically\./)).toBeInTheDocument();
  });

  it("the open note is in the subtree: leavingRef is already set on submit, success navigates home, one toast, Undo navigates back to that note", async () => {
    const ctl = controls({ phase: "connected", role: "owner" });
    let leavingAtDelete: boolean | null = null;
    stubServer({
      del: deleted(["p1", "p2"]),
      onDelete: () => {
        leavingAtDelete = ctl.leavingRef.current;
      },
      restore: () => json({ restored: [P1, P2], skipped: [] }),
    });
    renderDialog(A, { controls: ctl, path: canonicalNotePath(P2) });
    await screen.findByText(DF3_A);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Folder deleted; 2 notes moved to the trash")).toBeInTheDocument();
    expect(leavingAtDelete).toBe(true);
    await waitFor(() => expect(location()).toBe("/"));
    expect(document.querySelectorAll('li[data-swipe-direction][data-state="open"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(location()).toBe(canonicalNotePath(P2 as NoteDto)));
  });

  it("the open note is inside the removed shared folder: it does not leave: location unchanged, leavingRef stays false, one toast", async () => {
    const ctl: NotePageControls = { noteId: "s1", state: { phase: "connected", role: "editor" }, leavingRef: { current: false }, openEdits: () => {} };
    let leavingAtDelete: boolean | null = null;
    stubServer({
      onDelete: () => {
        leavingAtDelete = ctl.leavingRef.current;
      },
    });
    renderDialog(SF, { controls: ctl, path: canonicalNotePath(S1) });
    await screen.findByText(/its 2 shared notes go back/);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Folder removed; 2 shared notes moved back to the top level")).toBeInTheDocument();
    await waitFor(() => expect(dialog()).toBeNull());
    expect(leavingAtDelete).toBe(false);
    expect(ctl.leavingRef.current).toBe(false);
    expect(location()).toBe(canonicalNotePath(S1));
    expect(document.querySelectorAll('li[data-swipe-direction][data-state="open"]')).toHaveLength(1);
  });

  it("the open note is in the subtree and the request fails with 500 (non-terminal): leavingRef is reset to false, no navigation", async () => {
    const ctl = controls({ phase: "connected", role: "owner" });
    stubServer({ del: () => json({ error: { code: "internal", message: "x" } }, 500) });
    renderDialog(A, { controls: ctl, path: canonicalNotePath(P2) });
    await screen.findByText(DF3_A);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(ctl.leavingRef.current).toBe(false);
    expect(location()).toBe(canonicalNotePath(P2));
  });

  it("the open note is in the subtree and the request fails with 500 (terminal): navigates home", async () => {
    const ctl = controls({ phase: "deleted" });
    stubServer({ del: () => json({ error: { code: "internal", message: "x" } }, 500) });
    renderDialog(A, { controls: ctl, path: canonicalNotePath(P2) });
    await screen.findByText(DF3_A);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(location()).toBe("/"));
  });
});
