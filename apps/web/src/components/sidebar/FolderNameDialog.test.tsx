import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { folderDto } from "@/test/folder-fixtures";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "./collapse";
import { __resetFolderSortForTests } from "./folder-sort";
import { FolderNameDialog, type FolderCreateParent } from "./FolderNameDialog";

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** POST / PATCH /api/folders: `reply` decides the response; each call's method, url and body are recorded. */
function stubFolders(reply: () => Response = () => json(folderDto({ id: "new", name: "x" }), 201)) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (url.startsWith("/api/folders") && method !== "GET") return Promise.resolve(reply());
      return Promise.resolve(json({ folders: [] }));
    }),
  );
  return calls;
}

/** An opener outside the dialog is not managed by React; each case removes it itself (the whole body cannot be cleared: Radix's portal must be left for RTL cleanup to unmount). */
const openers: HTMLElement[] = [];

type HostProps =
  | { mode: "create"; parent: FolderCreateParent }
  | { mode: "rename"; folder: ReturnType<typeof folderDto>; stack?: { onClosed: (finalName: string) => void; focusTarget: () => HTMLElement | null } };

/** Like the NoteList host: unmounts on close. The opener is a button outside the dialog (the target of focus return). */
function renderDialog(props: HostProps, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const opener = document.createElement("button");
  opener.textContent = "opener";
  document.body.appendChild(opener);
  openers.push(opener);
  const ref = { current: opener as HTMLElement | null };
  function Host() {
    const [open, setOpen] = useState(true);
    return open ? <FolderNameDialog {...props} open onOpenChange={setOpen} returnFocusRef={ref} /> : null;
  }
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Host />
    </QueryClientProvider>,
  );
  return { view, opener, queryClient };
}

const input = () => screen.getByRole("textbox", { name: "Folder name" });
const submit = (name: "Create" | "Save" = "Create") => screen.getByRole("button", { name });
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const PERSONAL: FolderCreateParent = { space: { kind: "personal" } };
const posted = (calls: ReturnType<typeof stubFolders>) => calls.filter((c) => c.method !== "GET");

describe("FolderNameDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const opener of openers.splice(0)) opener.remove();
    await i18n.changeLanguage("en");
  });

  it("create: blank -> submit disabled; \"  A  \" -> body {name: A, space: personal} (the trimmed string is sent)", async () => {
    const calls = stubFolders();
    renderDialog({ mode: "create", parent: PERSONAL });
    expect(submit()).toBeDisabled();
    type("   ");
    expect(submit()).toBeDisabled();
    type("  A  ");
    fireEvent.click(submit());
    await waitFor(() => expect(posted(calls)).toEqual([{ method: "POST", url: "/api/folders", body: { name: "A", space: { kind: "personal" } } }]));
  });

  it("81 CJK characters: inline limit error, not sent; 80 emoji (160 code units, 80 code points): can be sent", async () => {
    const calls = stubFolders();
    renderDialog({ mode: "create", parent: PERSONAL });
    type("字".repeat(81));
    expect(screen.getByRole("alert")).toHaveTextContent("Names can be at most 80 characters");
    expect(submit()).toBeDisabled();
    fireEvent.submit(input().closest("form")!);
    expect(posted(calls)).toEqual([]);
    const emoji = "😀".repeat(80);
    expect(emoji.length).toBe(160);
    type(emoji);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(submit());
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect((posted(calls)[0]!.body as { name: string }).name).toBe(emoji);
  });

  it("a control character inside the text (U+2028, bidi): inline error verbatim, not sent; leading/trailing control characters are trimmed and then it can be sent", async () => {
    const calls = stubFolders();
    renderDialog({ mode: "create", parent: PERSONAL });
    for (const bad of ["A\u0007B", "A\u2028B", "A\u202EB"]) {
      type(bad);
      expect(screen.getByRole("alert")).toHaveTextContent("Names can't contain line breaks or control characters");
      expect(submit()).toBeDisabled();
    }
    fireEvent.submit(input().closest("form")!);
    expect(posted(calls)).toEqual([]);
    type("\tA\t");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(submit());
    await waitFor(() => expect(posted(calls)).toEqual([{ method: "POST", url: "/api/folders", body: { name: "A", space: { kind: "personal" } } }]));
  });

  it("409 folder_name_taken: inline error, the dialog stays open", async () => {
    stubFolders(() => json({ error: { code: "folder_name_taken", message: "x" } }, 409));
    renderDialog({ mode: "create", parent: PERSONAL });
    type("A");
    fireEvent.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent("There's already a folder with this name here.");
    expect(screen.getByRole("dialog", { name: "New folder" })).toBeInTheDocument();
  });

  it("rename: prefilled with the old name, sends PATCH {name: B}", async () => {
    const calls = stubFolders(() => json(folderDto({ id: "f1", name: "B" })));
    renderDialog({ mode: "rename", folder: folderDto({ id: "f1", name: "A" }) });
    expect(input()).toHaveValue("A");
    type("B");
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(posted(calls)).toEqual([{ method: "PATCH", url: "/api/folders/f1", body: { name: "B" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("create (parent = folder P) success: ['folders'] is invalidated, the collapse keys of P and its ancestors (taken from the index in the cache) are deleted", async () => {
    stubFolders();
    setCollapsed("folder:P", true);
    setCollapsed("folder:GP", true);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["folders"], [folderDto({ id: "GP", name: "GP" }), folderDto({ id: "P", name: "P", parentId: "GP" })]);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    renderDialog({ mode: "create", parent: { folderId: "P" } }, queryClient);
    type("Child");
    fireEvent.click(submit());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(spy).toHaveBeenCalledWith({ queryKey: ["folders"] });
    expect(isCollapsed("folder:P")).toBe(false);
    expect(localStorage.getItem("sidebar.collapsed.folder:P")).toBeNull();
    expect(isCollapsed("folder:GP")).toBe(false);
  });

  it("closing returns focus to the opener; if the opener is unmounted nothing throws", async () => {
    stubFolders();
    const { opener } = renderDialog({ mode: "create", parent: PERSONAL });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());

    const second = renderDialog({ mode: "create", parent: PERSONAL });
    second.opener.remove();
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))).not.toThrow();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("zh: titles for create folder and rename folder, and the folder name field", async () => {
    await i18n.changeLanguage("zh-TW");
    stubFolders();
    const first = renderDialog({ mode: "create", parent: PERSONAL });
    expect(screen.getByRole("dialog", { name: "新增資料夾" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "資料夾名稱" })).toBeInTheDocument();
    first.view.unmount();
    renderDialog({ mode: "rename", folder: folderDto({ id: "f1", name: "A" }) });
    expect(screen.getByRole("dialog", { name: "重新命名資料夾" })).toBeInTheDocument();
  });

  it("creating a folder from a collapsed group row succeeds: group:G is written as expanded", async () => {
    const calls = stubFolders();
    setCollapsed("group:G", true);
    renderDialog({ mode: "create", parent: { space: { kind: "group", groupId: "G" } } });
    type("Reports");
    fireEvent.click(submit());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted(calls)[0]!.body).toEqual({ name: "Reports", space: { kind: "group", groupId: "G" } });
    expect(isCollapsed("group:G")).toBe(false);
  });
});

/** The stacked-folder rename form. */
describe("FolderNameDialog stacked folder rename", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const opener of openers.splice(0)) opener.remove();
  });

  const NEW2 = folderDto({ id: "n2", name: "New folder 2" });

  /** The new folder row's button outside the dialog (focusTarget returns it). */
  function stackHooks() {
    const row = document.createElement("button");
    row.textContent = "row";
    document.body.appendChild(row);
    openers.push(row);
    return { row, onClosed: vi.fn<(finalName: string) => void>(), focusTarget: vi.fn(() => row as HTMLElement | null) };
  }

  it("with stack and the name \"New folder 2\": the input is fully selected on open (0-12)", () => {
    stubFolders();
    const hooks = stackHooks();
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    expect(input()).toHaveValue("New folder 2");
    expect((input() as HTMLInputElement).selectionStart).toBe(0);
    expect((input() as HTMLInputElement).selectionEnd).toBe(12);
  });

  it("changing to \" Q3 \" and submitting: PATCH {name: Q3}; after closing onClosed(\"Q3\") once", async () => {
    const calls = stubFolders(() => json(folderDto({ id: "n2", name: "Q3" })));
    const hooks = stackHooks();
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    type(" Q3 ");
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted(calls)).toEqual([{ method: "PATCH", url: "/api/folders/n2", body: { name: "Q3" } }]);
    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("Q3");
  });

  it("name unchanged (including only added leading/trailing whitespace) then Save: no PATCH, the dialog closes, onClosed(\"New folder 2\") once; a rename without stack still sends PATCH", async () => {
    const calls = stubFolders(() => json(NEW2));
    const hooks = stackHooks();
    const first = renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    type("  New folder 2 ");
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted(calls)).toEqual([]);
    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("New folder 2");
    first.view.unmount();

    renderDialog({ mode: "rename", folder: NEW2 });
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(posted(calls)).toEqual([{ method: "PATCH", url: "/api/folders/n2", body: { name: "New folder 2" } }]));
  });

  it("Cancel: no PATCH, onClosed(\"New folder 2\") once", async () => {
    const calls = stubFolders();
    const hooks = stackHooks();
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    type("Changed but cancelled");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted(calls)).toEqual([]);
    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("New folder 2");
  });

  it("Esc: onClosed(\"New folder 2\") once", async () => {
    stubFolders();
    const hooks = stackHooks();
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("New folder 2");
  });

  it("after closing, focus goes to the element returned by focusTarget() (not the opener)", async () => {
    stubFolders();
    const hooks = stackHooks();
    const { opener } = renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(hooks.row).toHaveFocus());
    expect(opener).not.toHaveFocus();
    expect(hooks.focusTarget).toHaveBeenCalled();
  });

  it("PATCH 409: the dialog stays open and onClosed is not called", async () => {
    stubFolders(() => json({ error: { code: "folder_name_taken", message: "x" } }, 409));
    const hooks = stackHooks();
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    type("Taken");
    fireEvent.click(submit("Save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("There's already a folder with this name here.");
    expect(screen.getByRole("dialog", { name: "Rename folder" })).toBeInTheDocument();
    expect(hooks.onClosed).not.toHaveBeenCalled();
  });

  /** Submits "Q3" and closes the dialog with Esc while the PATCH is pending; returns the function that releases the PATCH (`reply` decides the response). */
  async function escWhileRenaming(hooks: ReturnType<typeof stackHooks>, reply: () => Response) {
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET").toUpperCase() === "GET") return Promise.resolve(json({ folders: [] }));
        return new Promise<Response>((resolve) => {
          release = () => resolve(reply());
        });
      }),
    );
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    type("Q3");
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(release).toBeDefined());
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    return async () => {
      await act(async () => {
        release!();
      });
    };
  }

  it("Esc before the PATCH returns: nothing is reported yet; after PATCH success onClosed(\"Q3\") (the final name) once", async () => {
    const hooks = stackHooks();
    const release = await escWhileRenaming(hooks, () => json(folderDto({ id: "n2", name: "Q3" })));
    expect(hooks.onClosed).not.toHaveBeenCalled();

    await release();

    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("Q3");
  });

  it("Esc before the PATCH returns, then the PATCH gets 409: onClosed(\"New folder 2\") (name unchanged) once", async () => {
    const hooks = stackHooks();
    const release = await escWhileRenaming(hooks, () => json({ error: { code: "folder_name_taken", message: "x" } }, 409));
    expect(hooks.onClosed).not.toHaveBeenCalled();

    await release();

    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("New folder 2");
  });

  it("rename without stack: the input is not fully selected (selectionStart === selectionEnd); closing returns focus to the opener as before", async () => {
    stubFolders();
    const { opener } = renderDialog({ mode: "rename", folder: NEW2 });
    const el = input() as HTMLInputElement;
    expect(el.selectionStart).toBe(el.selectionEnd);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
