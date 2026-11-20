import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GroupDto, GroupMemberDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { chooseOption, optionLabels, selectedValue } from "@/test/ui-select";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { adminRole, customRole, groupDto, memberRole } from "@/test/fixtures";
import { trashItem, trashList } from "@/test/trash-fixtures";
import { DeleteGroupDialog } from "./DeleteGroupDialog";
import { FOLDER_LIST_EMPTY, folderDto, groupFolder } from "@/test/folder-fixtures";

const GROUP: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole({ memberCount: 2 }));
const ADMIN = adminRole();
const MEMBER = memberRole();

function member(userId: string, displayName: string, role: typeof ADMIN): GroupMemberDto {
  return { userId, email: `${displayName.toLowerCase()}@example.com`, displayName, roleId: role.id, builtin: role.builtin, avatar: null };
}

/** Server order: built-in admins first. */
const MEMBERS: GroupMemberDto[] = [member("u-me", "Me", ADMIN), member("u-bob", "Bob", ADMIN), member("u-cat", "Cat", MEMBER)];

function note(id: string, groupId: string | null) {
  return { id, groupId };
}
/** Three notes, two of which belong to GROUP. */
const NOTES = [note("n1", GROUP.id), note("n2", GROUP.id), note("n3", null)];

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}

type Calls = Array<{ method: string; url: string; body: unknown }>;

/** #181: trash items - GROUP's, another group's, and personal ones. */
const inGroup = (id: string) => trashItem({ id, title: id, group: { id: GROUP.id, name: GROUP.name } });
const OTHER_GROUP_TRASH = trashItem({ id: "t-other", title: "t-other", group: { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Other" } });
const PERSONAL_TRASH = trashItem({ id: "t-mine", title: "t-mine" });

/** A custom role that can manage the group and delete but cannot edit: it does not see the group trash. */
const NO_TRASH_GROUP: GroupDto = groupDto(
  { id: GROUP.id, name: GROUP.name },
  customRole({ permissions: { ...customRole().permissions, manageGroup: true, edit: false, delete: true } }),
);

interface Setup {
  members?: () => Response | Promise<Response>;
  notes?: () => Response | Promise<Response>;
  trash?: () => Response | Promise<Response>;
  del?: () => Response;
  group?: GroupDto;
  /** `GET /api/folders` (empty list by default). */
  folders?: () => Response | Promise<Response>;
}

function renderDialog(setup: Setup = {}, props: { onDeleted?: () => void; onOpenChange?: (open: boolean) => void } = {}) {
  const calls: Calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (method === "GET" && url === `/api/groups/${GROUP.id}/members`) return Promise.resolve((setup.members ?? (() => fakeResponse(200, MEMBERS)))());
      if (url === "/api/folders") {
        if (setup.folders) return Promise.resolve(setup.folders());
        return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (method === "GET" && url === "/api/notes") return Promise.resolve((setup.notes ?? (() => fakeResponse(200, NOTES)))());
      if (method === "GET" && url === "/api/trash") return Promise.resolve((setup.trash ?? (() => fakeResponse(200, trashList([]))))());
      if (method === "DELETE" && url === `/api/groups/${GROUP.id}`) return Promise.resolve((setup.del ?? (() => fakeResponse(204)))());
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  const onOpenChange = props.onOpenChange ?? vi.fn();
  const onDeleted = props.onDeleted ?? vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // How callers mount it: `open && <DeleteGroupDialog .../>` - unmounted after onOpenChange(false)
  const group = setup.group ?? GROUP;
  function Host() {
    return <DeleteGroupDialog group={group} onOpenChange={onOpenChange} onDeleted={onDeleted} />;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <Host />
      <Toaster />
    </QueryClientProvider>,
  );
  return { calls, onOpenChange, onDeleted, queryClient };
}

/**
 * Waits for a query to leave pending, then lets react-query's notification batch (setTimeout 0) finish: untrusted (NoCount) looks the same as "not loaded yet",
 * so without waiting for it to settle the assertion would pass before loading.
 */
async function settled(queryClient: QueryClient, key: readonly string[]): Promise<void> {
  await waitFor(() => expect(queryClient.getQueryState(key)?.status).not.toBe("pending"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const deleteCalls = (calls: Calls) => calls.filter((c) => c.method === "DELETE");
const confirmButton = () => screen.getByRole("button", { name: "Delete group" });

describe("DeleteGroupDialog (#175)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("clicking outside the dialog does not close it and the chosen successor stays (form-type guard)", async () => {
    const { onOpenChange } = renderDialog();
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitForAdminOptions(select);
    await chooseOption(select, "Bob (bob@example.com)");
    await clickOutside();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(selectedValue(screen.getByLabelText("Admin who gets the notes"))).toBe("u-bob");
  });

  it("default: transfer selected, the dropdown lists only the two built-in admins with the first selected (may be yourself); the description carries the note count 2 and the selected person's name; the confirm button is enabled", async () => {
    renderDialog();
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitForAdminOptions(select);
    expect(await optionLabels(select)).toEqual(["Me (me@example.com)", "Bob (bob@example.com)"]);
    expect(selectedValue(select)).toBe("u-me");
    expect(screen.getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Delete everything" })).not.toBeChecked();
    await waitFor(() => expect(screen.getByText(/^2 notes will become Me's personal notes\./)).toBeInTheDocument());
    expect(confirmButton()).not.toBeDisabled();
  });

  it("choosing Bob sends DELETE {mode:'transfer', transferTo: Bob's userId}; on success the dialog closes (onOpenChange(false)) and onDeleted is called once", async () => {
    const { calls, onOpenChange, onDeleted } = renderDialog();
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitForAdminOptions(select);
    await chooseOption(select, "Bob (bob@example.com)");
    await waitFor(() => expect(screen.getByText(/^2 notes will become Bob's personal notes\./)).toBeInTheDocument());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(deleteCalls(calls)).toHaveLength(1));
    expect(deleteCalls(calls)[0].body).toEqual({ mode: "transfer", transferTo: "u-bob" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("switching to delete-all: the confirm button stays disabled until the acknowledgement is checked; submits {mode:'delete'}", async () => {
    const { calls, onDeleted } = renderDialog();
    await screen.findByLabelText("Admin who gets the notes");
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(screen.getByText(/^2 notes, their attachments and their edit history are permanently deleted/)).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(confirmButton());
    expect(deleteCalls(calls)).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" }));
    expect(confirmButton()).not.toBeDisabled();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(deleteCalls(calls)).toHaveLength(1));
    expect(deleteCalls(calls)[0].body).toEqual({ mode: "delete" });
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it("after checking, switching back to transfer and then to delete-all: the checkbox is cleared and the confirm button is disabled again", async () => {
    renderDialog();
    await screen.findByLabelText("Admin who gets the notes");
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" }));
    expect(confirmButton()).not.toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Give them to an admin" }));
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" })).not.toBeChecked();
    expect(confirmButton()).toBeDisabled();
  });

  it("409 not_admin: toast errors.not_admin, the dialog stays, the member list is refetched (second members GET)", async () => {
    const { calls, onOpenChange, onDeleted } = renderDialog({
      del: () => fakeResponse(409, { error: { code: "not_admin", message: "x" } }),
    });
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitForAdminOptions(select);
    const membersGets = () => calls.filter((c) => c.method === "GET" && c.url === `/api/groups/${GROUP.id}/members`).length;
    expect(membersGets()).toBe(1);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText("The notes can only be handed to one of the group's admins. Pick someone who is still an admin.")).toBeInTheDocument());
    await waitFor(() => expect(membersGets()).toBe(2));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
  });

  it("409 server_busy: toast errors.server_busy, the dialog stays, the confirm button can be pressed again", async () => {
    const { calls, onOpenChange } = renderDialog({
      del: () => fakeResponse(409, { error: { code: "server_busy", message: "x" } }),
    });
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitForAdminOptions(select);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText("The server is busy. Please try again shortly.")).toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    // the member list is not refetched (only not_admin refetches)
    expect(calls.filter((c) => c.method === "GET" && c.url === `/api/groups/${GROUP.id}/members`)).toHaveLength(1);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(deleteCalls(calls)).toHaveLength(2));
  });

  it("404 not_found: toast, the dialog stays", async () => {
    const { onOpenChange, onDeleted } = renderDialog({
      del: () => fakeResponse(404, { error: { code: "not_found", message: "x" } }),
    });
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitForAdminOptions(select);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText(i18n.t("errors.not_found"))).toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
  });

  it("['notes'] not loaded yet: the description uses the version without numbers; group with 0 notes: shows the no-notes text, both modes remain selectable, default is transfer", async () => {
    // note count not loaded: the notes request is left hanging
    const never = new Promise<Response>(() => {});
    renderDialog({ notes: () => never as unknown as Response });
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitForAdminOptions(select);
    expect(screen.getByText(/^The group's notes will become Me's personal notes\./)).toBeInTheDocument();
    expect(screen.queryByText(/\b0 notes?\b/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(screen.getByText(/^The group's notes \(including those in its trash\), their attachments and their edit history are permanently deleted — they don't go to the trash\./)).toBeInTheDocument();
  });

  it("group with 0 notes: the description is \"This group has no notes.\", default transfer, both modes still selectable", async () => {
    renderDialog({ notes: () => fakeResponse(200, [note("n3", null)]) });
    await screen.findByLabelText("Admin who gets the notes");
    await waitFor(() => expect(screen.getByText("This group has no notes.")).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(screen.getByText("This group has no notes.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" })).toBeInTheDocument();
  });

  it("member list error: shows adminsUnavailable, the transfer-mode confirm button is disabled; after switching to delete-all and checking, it can be submitted", async () => {
    const { calls } = renderDialog({ members: () => fakeResponse(500, { error: { code: "internal", message: "x" } }) });
    await waitFor(() => expect(screen.getByText("Couldn't load the group's admins.")).toBeInTheDocument());
    expect(await optionLabels(screen.getByLabelText("Admin who gets the notes"))).toEqual([]);
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" }));
    expect(confirmButton()).not.toBeDisabled();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(deleteCalls(calls)).toHaveLength(1));
    expect(deleteCalls(calls)[0].body).toEqual({ mode: "delete" });
  });

  it("the dialog's accessible description is the consequence sentence (both modes, both locales; the zh transfer sentence says any public link is also closed)", async () => {
    renderDialog();
    await screen.findByLabelText("Admin who gets the notes");
    const dialog = screen.getByRole("dialog", { name: "Delete group?" });
    await waitFor(() => expect(dialog).toHaveAccessibleDescription(/^2 notes will become Me's personal notes\..*any public links on them are turned off\.$/));
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(dialog).toHaveAccessibleDescription(/^2 notes, their attachments and their edit history are permanently deleted/);
    await i18n.changeLanguage("zh-TW");
    fireEvent.click(await screen.findByRole("radio", { name: "轉移給管理員" }));
    await waitFor(() => expect(dialog).toHaveAccessibleDescription(/^2 篇筆記會變成 Me 的個人筆記.*其他成員會失去存取，若有公開連結也會關閉。$/));
  });

  it("the radiogroup has a readable name; the two radios and the checkbox are found by label", async () => {
    renderDialog();
    await screen.findByLabelText("Admin who gets the notes");
    expect(screen.getByRole("radiogroup", { name: "What happens to the notes in this group" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Give them to an admin" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" })).toBeInTheDocument();
  });
});

const TRASH_NOTE =
  /^Group notes in the trash go to Me's personal trash, and their retention period still counts from when they were deleted; their public links are turned off too\.$/;
const queryTrashNote = () => screen.queryByText(/^Group notes in the trash go to /);
const DELETE_NO_COUNT =
  /^The group's notes \(including those in its trash\), their attachments and their edit history are permanently deleted — they don't go to the trash\. This can't be undone\.$/;
const TRANSFER_NO_COUNT = /^The group's notes will become Me's personal notes\./;

/** Both built-in admins are in the dropdown. */
async function waitForAdminOptions(select: HTMLElement): Promise<void> {
  await waitFor(() => expect(selectedValue(select)).not.toBe(""));
  expect(await optionLabels(select)).toHaveLength(2);
}

async function adminsLoaded(): Promise<void> {
  const select = await screen.findByLabelText("Admin who gets the notes");
  await waitForAdminOptions(select);
}
const toDeleteMode = () => fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));

describe("DeleteGroupDialog: trash note count and transfer description (#181)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("group trash has 1 (another group's and personal ones do not count) + 2 live: transfer says \"3 notes\" + the trash sentence; delete-all says \"3 notes (including 1 in the trash)\"", async () => {
    renderDialog({ trash: () => fakeResponse(200, trashList([inGroup("t1"), OTHER_GROUP_TRASH, PERSONAL_TRASH])) });
    await adminsLoaded();
    await waitFor(() => expect(screen.getByText(/^3 notes will become Me's personal notes\./)).toBeInTheDocument());
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(
      screen.getByText(/^3 notes \(including 1 in the trash\), their attachments and their edit history are permanently deleted — they don't go to the trash\. This can't be undone\.$/),
    ).toBeInTheDocument();
  });

  it("group trash has 0 (only another group's and personal ones) + 2 live: transfer has no trash sentence; delete-all says \"2 notes, ... - they don't go to the trash.\"", async () => {
    const { queryClient } = renderDialog({ trash: () => fakeResponse(200, trashList([OTHER_GROUP_TRASH, PERSONAL_TRASH])) });
    await adminsLoaded();
    await settled(queryClient, ["trash"]);
    await waitFor(() => expect(screen.getByText(/^2 notes will become Me's personal notes\./)).toBeInTheDocument());
    expect(queryTrashNote()).not.toBeInTheDocument();
    toDeleteMode();
    expect(
      screen.getByText(/^2 notes, their attachments and their edit history are permanently deleted — they don't go to the trash\. This can't be undone\.$/),
    ).toBeInTheDocument();
  });

  it("can manage the group and delete but not edit (cannot see the group trash): no number - transfer \"The group's notes will become...\" + the trash sentence; delete-all \"(including those in its trash)\"", async () => {
    // The server does not return group trash items for this kind of role; the list has only the user's own personal items
    const { queryClient } = renderDialog({ group: NO_TRASH_GROUP, trash: () => fakeResponse(200, trashList([PERSONAL_TRASH])) });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    await settled(queryClient, ["trash"]);
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
  });

  it("can manage the group and edit but not delete (cannot see the group trash): no number - transfer + the trash sentence; delete-all \"(including those in its trash)\"", async () => {
    const group = groupDto(
      { id: GROUP.id, name: GROUP.name },
      customRole({ permissions: { ...customRole().permissions, manageGroup: true, edit: true, delete: false } }),
    );
    const { queryClient } = renderDialog({ group, trash: () => fakeResponse(200, trashList([PERSONAL_TRASH])) });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    await settled(queryClient, ["trash"]);
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
  });

  it("site admin who is not a member (myRole: null; ['notes'] has no note of this group): no number, and does not say \"This group has no notes.\"", async () => {
    const group = groupDto({ id: GROUP.id, name: GROUP.name }, null);
    const { queryClient } = renderDialog({
      group,
      notes: () => fakeResponse(200, [note("n3", null)]),
      trash: () => fakeResponse(200, trashList([PERSONAL_TRASH])),
    });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    await settled(queryClient, ["trash"]);
    expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
  });

  it("trash list truncated: no number (same as when the group trash is not visible)", async () => {
    const { queryClient } = renderDialog({ trash: () => fakeResponse(200, trashList([inGroup("t1")], { truncated: true })) });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    await settled(queryClient, ["trash"]);
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
  });

  it("trash load failure (500): no number", async () => {
    const { queryClient } = renderDialog({ trash: () => fakeResponse(500, { error: { code: "internal", message: "x" } }) });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    await settled(queryClient, ["trash"]);
    expect(queryClient.getQueryState(["trash"])?.status).toBe("error");
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
  });

  it("trash still loading (request left hanging): no number, and neither \"0 notes\" nor \"This group has no notes.\" appears", async () => {
    const never = new Promise<Response>(() => {});
    const { queryClient } = renderDialog({ trash: () => never });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    expect(queryClient.getQueryState(["trash"])?.status).toBe("pending");
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
    expect(screen.queryByText(/\b0 notes?\b/)).not.toBeInTheDocument();
    expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
  });

  describe("0 live notes", () => {
    const noLive = () => fakeResponse(200, [note("n3", null)]);

    it("trash trusted and 0: \"This group has no notes.\" (both modes), transfer has no trash sentence", async () => {
      const { queryClient } = renderDialog({ notes: noLive });
      await adminsLoaded();
      await settled(queryClient, ["trash"]);
      await waitFor(() => expect(screen.getByText("This group has no notes.")).toBeInTheDocument());
      expect(queryTrashNote()).not.toBeInTheDocument();
      toDeleteMode();
      expect(screen.getByText("This group has no notes.")).toBeInTheDocument();
    });

    it("trash not trusted (group trash not visible): does not say \"This group has no notes.\", uses the version without numbers + the trash sentence", async () => {
      const { queryClient } = renderDialog({ group: NO_TRASH_GROUP, notes: noLive });
      await adminsLoaded();
      await settled(queryClient, ["notes"]);
      await settled(queryClient, ["trash"]);
      expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
      expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
      expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
      toDeleteMode();
      expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
      expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
    });

    it("2 in the trash: delete-all \"2 notes (including 2 in the trash)\"; transfer \"2 notes\" + the trash sentence", async () => {
      renderDialog({ notes: noLive, trash: () => fakeResponse(200, trashList([inGroup("t1"), inGroup("t2")])) });
      await adminsLoaded();
      await waitFor(() => expect(screen.getByText(/^2 notes will become Me's personal notes\./)).toBeInTheDocument());
      expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
      toDeleteMode();
      expect(screen.getByText(/^2 notes \(including 2 in the trash\), their attachments and their edit history are permanently deleted/)).toBeInTheDocument();
      expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
    });

    it("1 in the trash: delete-all uses the singular \"1 note (including 1 in the trash), its attachments ... - it doesn't go to the trash.\"", async () => {
      renderDialog({ notes: noLive, trash: () => fakeResponse(200, trashList([inGroup("t1")])) });
      await adminsLoaded();
      await waitFor(() => expect(screen.getByText(/^1 note will become Me's personal note\./)).toBeInTheDocument());
      toDeleteMode();
      expect(
        screen.getByText(/^1 note \(including 1 in the trash\), its attachments and its edit history are permanently deleted — it doesn't go to the trash\. This can't be undone\.$/),
      ).toBeInTheDocument();
    });
  });
});

// Folders (last row): in transfer mode, when the group has folders, an extra sentence says where they go.
describe("DeleteGroupDialog: transfer description for group folders", () => {
  const OTHER_GROUP_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const FOLDERS_NOTE_EN = "The group's folders move into Me's notes, under a folder named after the group.";
  const FOLDERS_NOTE_ZH = "群組的資料夾會放進 Me 的「我的筆記」，在一個以群組名命名的資料夾底下。";
  const foldersReply = (folders: unknown[]) => () => fakeResponse(200, { folders });
  const WITH_GROUP_FOLDER = foldersReply([groupFolder({ id: "gf1", name: "Reports", groupId: GROUP.id }), folderDto({ id: "pf1", name: "Mine" })]);
  const queryFoldersNote = () => screen.queryByText(/^The group's folders move into /);

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.changeLanguage("en");
  });

  it("group has folders, transfer mode: the sentence verbatim (en)", async () => {
    renderDialog({ folders: WITH_GROUP_FOLDER });
    await adminsLoaded();
    expect(await screen.findByText(FOLDERS_NOTE_EN, { exact: true })).toBeInTheDocument();
    // the original transfer description is unchanged
    expect(screen.getByText(/^2 notes will become Me's personal notes\./)).toBeInTheDocument();
  });

  it("group has folders, transfer mode: the sentence verbatim (zh-TW)", async () => {
    await i18n.changeLanguage("zh-TW");
    renderDialog({ folders: WITH_GROUP_FOLDER });
    const select = await screen.findByRole("combobox");
    await waitForAdminOptions(select);
    expect(await screen.findByText(FOLDERS_NOTE_ZH, { exact: true })).toBeInTheDocument();
  });

  it("only another group's and personal folders: no such sentence", async () => {
    const { queryClient } = renderDialog({
      folders: foldersReply([groupFolder({ id: "of1", name: "Other", groupId: OTHER_GROUP_ID }), folderDto({ id: "pf1", name: "Mine" })]),
    });
    await adminsLoaded();
    await settled(queryClient, ["folders"]);
    expect(queryFoldersNote()).not.toBeInTheDocument();
  });

  it("group has folders, delete-all mode: no such sentence", async () => {
    const { queryClient } = renderDialog({ folders: WITH_GROUP_FOLDER });
    await adminsLoaded();
    await settled(queryClient, ["folders"]);
    expect(screen.getByText(FOLDERS_NOTE_EN, { exact: true })).toBeInTheDocument();
    toDeleteMode();
    expect(queryFoldersNote()).not.toBeInTheDocument();
  });

  it("GET /api/folders fails (500): no such sentence, the rest as usual", async () => {
    const { queryClient } = renderDialog({ folders: () => fakeResponse(500, { error: { code: "internal", message: "x" } }) });
    await adminsLoaded();
    await settled(queryClient, ["folders"]);
    expect(queryClient.getQueryState(["folders"])?.status).toBe("error");
    expect(queryFoldersNote()).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/^2 notes will become Me's personal notes\./)).toBeInTheDocument());
    expect(confirmButton()).not.toBeDisabled();
  });
});
