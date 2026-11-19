import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { GroupDto, GroupMemberDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import { clickOutside } from "@/test/outside-click";
import { chooseOption, displayedLabel, optionLabels, selectedValue } from "@/test/ui-select";
import {
  ADMIN_ROLE, GROUP_ADMIN, GROUP_MEMBER, ME, MEMBER_ROLE, ROLES, callsTo, fail, groupFetch, member, ok, renderGroupRoute,
} from "./group-test-utils";

// Batch add members: pasting several addresses (comma/semicolon/space/newline) and "import from another group" both open the same dialog (BulkAddDialog),
// which PUTs `.../members` one by one, with progress (plus stop) and the result inside the dialog. The pure functions (splitting, classifying, stopping, abort) are covered by bulk-add.test.ts.

const URL_MEMBERS = `/api/groups/${GROUP_ADMIN.id}/members`;
const SOURCE: GroupDto = { ...GROUP_MEMBER, name: "Team Source" };

function putBodies(fetchMock: ReturnType<typeof vi.fn>): Array<{ email: string; roleId?: string }> {
  return callsTo(fetchMock, "PUT", URL_MEMBERS).map((init) => JSON.parse(String(init.body)) as { email: string; roleId?: string });
}

type Extra = (url: string, method: string, body: { email: string; roleId?: string } | null) => Response | Promise<Response> | null;

/**
 * `PUT` responds by email: those in `known` -> 201 and added to the list; `dup@` -> 409 already_member; `boom@` -> 500; `slow@` -> 429;
 * `nope403@` -> 403 forbidden; `norole@` -> 404 role_not_found; anything else -> 404 user_not_found. `extra` is matched first (it may return a Promise to control timing).
 */
function membersServer(initial: GroupMemberDto[], known: string[], extra: Extra = () => null) {
  let members = [...initial];
  const fetchMock = groupFetch(() => [GROUP_ADMIN, SOURCE], () => members, (url, method, init) => {
    const body = url === URL_MEMBERS && method === "PUT" ? (JSON.parse(String(init?.body)) as { email: string; roleId?: string }) : null;
    const custom = extra(url, method, body);
    if (custom) return custom;
    if (body) {
      if (body.email === "dup@example.com") return fail(409, "already_member");
      if (body.email === "boom@example.com") return fail(500, "internal");
      if (body.email === "slow@example.com") return fail(429, "too_many_requests");
      if (body.email === "nope403@example.com") return fail(403, "forbidden");
      if (body.email === "norole@example.com") return fail(404, "role_not_found");
      if (!known.includes(body.email)) return fail(404, "user_not_found");
      const role = ROLES.find((r) => r.id === body.roleId) ?? MEMBER_ROLE;
      const added = member(`u-${body.email}`, body.email, body.email.split("@")[0]!, role);
      members = [...members, added];
      return ok(added, 201);
    }
    return null;
  });
  return fetchMock;
}

/** Manually released response: the `PUT` before `release(res)` stays pending. */
function deferred() {
  let release!: (res: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function openMembers(fetchMock: ReturnType<typeof vi.fn>) {
  const view = renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
  const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
  const roleSelect = await within(dialog).findByLabelText("Role for new member");
  await waitFor(() => expect(selectedValue(roleSelect)).toBe(MEMBER_ROLE.id));
  await within(dialog).findByText(ME.email);
  return { dialog, view };
}

function submitEmails(dialog: HTMLElement, value: string) {
  fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
}

/** Result screen: waits for "Done" and returns the dialog. */
async function resultDialog(name = "Add members") {
  const bulkDialog = await screen.findByRole("dialog", { name });
  await within(bulkDialog).findByRole("button", { name: "Done" });
  return bulkDialog;
}

/** The description line visible on the result screen (stop reason / left in the input); the live region holds another copy (sr-only), which does not count. */
function resultMessage(bulkDialog: HTMLElement): HTMLElement | null {
  return bulkDialog.querySelector("[data-result-message]");
}

function outcomeRow(bulkDialog: HTMLElement, outcome: string): HTMLElement | null {
  return bulkDialog.querySelector(`[data-outcome="${outcome}"]`);
}

/** Title and email list (one per line) of a category; null when the category is absent. */
function outcomeSummary(bulkDialog: HTMLElement, outcome: string): { label: string; emails: string[] } | null {
  const row = outcomeRow(bulkDialog, outcome);
  if (!row) return null;
  return {
    label: row.firstElementChild?.textContent ?? "",
    emails: within(row).queryAllByRole("listitem").map((li) => li.textContent ?? ""),
  };
}

const ME_ADMIN = () => member(ME.id, ME.email, "Me", ADMIN_ROLE);

describe("batch add members", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pasting several addresses opens the \"Add members\" dialog: deduplicated, those already in the list are not sent; PUTs one by one (same role); the result is classified; those not added stay in the input and the role is not reset", async () => {
    const initial = [ME_ADMIN(), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)];
    const fetchMock = membersServer(initial, ["carol@example.com", "dave@example.com"]);
    const { dialog } = await openMembers(fetchMock);

    await chooseOption(within(dialog).getByLabelText("Role for new member"), "Admin");
    const input = within(dialog).getByLabelText("Email address");
    submitEmails(dialog, "carol@example.com, ghost@example.com; Carol@Example.com BOB@example.com dave@example.com nope");

    const bulkDialog = await resultDialog();
    expect(within(bulkDialog).getByText("These addresses are added to this group as Admin.")).toBeInTheDocument();
    expect(putBodies(fetchMock)).toEqual([
      { email: "carol@example.com", roleId: ADMIN_ROLE.id },
      { email: "ghost@example.com", roleId: ADMIN_ROLE.id },
      { email: "dave@example.com", roleId: ADMIN_ROLE.id },
    ]);
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (2):", emails: ["carol@example.com", "dave@example.com"] });
    expect(outcomeSummary(bulkDialog, "notFound")).toEqual({ label: "No account with this email (1):", emails: ["ghost@example.com"] });
    expect(outcomeSummary(bulkDialog, "alreadyMember")).toEqual({ label: "Already members (1):", emails: ["BOB@example.com"] });
    expect(outcomeSummary(bulkDialog, "invalid")).toEqual({ label: "Not an email address (1):", emails: ["nope"] });
    expect(resultMessage(bulkDialog)).toHaveTextContent(/^The addresses that weren't added are left in the email box/);
    // Those with no account or a malformed address stay in the input (in original input order) and the role is not reset (they still need adding)
    expect(input).toHaveValue("ghost@example.com, nope");
    expect(selectedValue(within(dialog).getByLabelText("Role for new member"))).toBe(ADMIN_ROLE.id);
    // After invalidation the list is refetched: the new members appear, with the selected role
    await waitFor(() => expect(selectedValue(within(dialog).getByLabelText("Role for dave@example.com"))).toBe(ADMIN_ROLE.id));
    // The settings modal has no result box (only the dialog does)
    expect(within(dialog).queryByText(/Added \(2\)/)).not.toBeInTheDocument();
  });

  it("live region: present as soon as the dialog opens; when done it announces only the stop reason and the count per category (no email list); finishing closes it and focus returns to the input", async () => {
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"], (_url, _method, body) =>
      body?.email === "carol@example.com" ? put.promise : null,
    );
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com ghost@example.com");

    const bulkDialog = await screen.findByRole("dialog", { name: "Add members" });
    const live = within(bulkDialog).getByRole("status");
    expect(live).toHaveTextContent(/^$/);
    expect(within(bulkDialog).getByText("Processed 0 of 2")).toBeInTheDocument();
    await waitFor(() => expect(within(bulkDialog).getByRole("button", { name: "Stop" })).toHaveFocus());
    await act(async () => put.release(ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201)));

    await resultDialog();
    expect(within(bulkDialog).getByRole("status")).toBe(live);
    expect(live).toHaveTextContent(
      "The addresses that weren't added are left in the email box so you can fix them and try again. Added: 1. No account with this email: 1.",
    );
    expect(live).not.toHaveTextContent("@");
    expect(within(bulkDialog).getByRole("button", { name: "Done" })).toHaveFocus();

    fireEvent.click(within(bulkDialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add members" })).not.toBeInTheDocument());
    await waitFor(() => expect(within(dialog).getByLabelText("Email address")).toHaveFocus());
  });

  it("all added: the input is cleared and the role reset; no \"left in the input\" note", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    await chooseOption(within(dialog).getByLabelText("Role for new member"), "Admin");
    submitEmails(dialog, "carol@example.com\tdave@example.com");
    const bulkDialog = await resultDialog();
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (2):", emails: ["carol@example.com", "dave@example.com"] });
    expect(resultMessage(bulkDialog)).toBeNull();
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("");
    expect(selectedValue(within(dialog).getByLabelText("Role for new member"))).toBe(MEMBER_ROLE.id);
    // The note uses the role from when the run started (the role was reset after the run, the note does not follow)
    expect(within(bulkDialog).getByText("These addresses are added to this group as Admin.")).toBeInTheDocument();
  });

  it("1 valid address + 1 non-email word: also goes through the batch dialog (not the single-person flow), the malformed one is listed in the result", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com nope");
    const bulkDialog = await resultDialog();
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (1):", emails: ["carol@example.com"] });
    expect(outcomeSummary(bulkDialog, "invalid")).toEqual({ label: "Not an email address (1):", emails: ["nope"] });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("nope");
  });

  it("clicking outside the dialog while running neither closes nor aborts (dismissOnOutside={false})", async () => {
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"], (_url, _method, body) =>
      body?.email === "carol@example.com" ? put.promise : null,
    );
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com dave@example.com");
    const bulkDialog = await screen.findByRole("dialog", { name: "Add members" });
    await within(bulkDialog).findByRole("button", { name: "Stop" });
    // A full "click outside" sequence (sending only pointerdown has no effect in this Radix version, see test/outside-click.ts)
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Add members" })).toBeInTheDocument();
    expect(within(bulkDialog).getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => put.release(ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201)));
    const result = await resultDialog();
    expect(outcomeSummary(result, "added")?.emails).toEqual(["carol@example.com", "dave@example.com"]);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "dave@example.com"]);
  });

  it("server returns 409 already_member (someone the list has not caught up with): recorded as already a member, continues with the next", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "dup@example.com, carol@example.com");
    const bulkDialog = await resultDialog();
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["dup@example.com", "carol@example.com"]);
    expect(outcomeSummary(bulkDialog, "alreadyMember")).toEqual({ label: "Already members (1):", emails: ["dup@example.com"] });
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (1):", emails: ["carol@example.com"] });
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("");
  });

  it("the input has aria-describedby: the description says several addresses can be entered at once", async () => {
    const { dialog } = await openMembers(membersServer([ME_ADMIN()], []));
    expect(within(dialog).getByLabelText("Email address")).toHaveAccessibleDescription(
      "You can enter several addresses at once, separated by commas, semicolons, spaces or line breaks (full-width commas and semicolons and the enumeration comma “、” work too).",
    );
  });

  it("a single address still goes through the original single-person flow (the error is an alert under the form, no dialog opens); a single non-email word is not submitted", async () => {
    const fetchMock = membersServer([ME_ADMIN()], []);
    const { dialog } = await openMembers(fetchMock);
    const input = within(dialog).getByLabelText("Email address");

    submitEmails(dialog, "ghost@example.com");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("We couldn't find that user.");
    expect(screen.queryByRole("dialog", { name: "Add members" })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("“nope” doesn't look like an email address.");
    expect(putBodies(fetchMock)).toHaveLength(1);
  });

  it("pasting a column of addresses with line breaks turns the line breaks into commas (a single-line input would otherwise drop them)", async () => {
    const { dialog } = await openMembers(membersServer([ME_ADMIN()], []));
    const input = within(dialog).getByLabelText("Email address") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "x@example.com, " } });
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => "a@example.com\r\nb@example.com\n" } });
    expect(input).toHaveValue("x@example.com, a@example.com, b@example.com");
  });

  it("unexpected error (500) stops: nothing is sent after it; those not added go back to the input; the reason is shown in the dialog", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com, boom@example.com, dave@example.com");

    const bulkDialog = await resultDialog();
    expect(resultMessage(bulkDialog)).toHaveTextContent(/^Stopped: Something went wrong/);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "boom@example.com"]);
    expect(outcomeRow(bulkDialog, "failed")).toHaveTextContent("boom@example.com");
    expect(outcomeRow(bulkDialog, "notProcessed")).toHaveTextContent("dave@example.com");
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("boom@example.com, dave@example.com");
  });

  it("403 forbidden (management rights revoked) and 404 role_not_found (role deleted) stop with the reason explained", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "nope403@example.com carol@example.com");
    let bulkDialog = await resultDialog();
    expect(resultMessage(bulkDialog)).toHaveTextContent("Stopped: You don't have permission to do that. The addresses that weren't added are back in the email box.");
    expect(outcomeRow(bulkDialog, "notProcessed")).toHaveTextContent("carol@example.com");
    fireEvent.click(within(bulkDialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add members" })).not.toBeInTheDocument());

    submitEmails(dialog, "norole@example.com carol@example.com");
    bulkDialog = await resultDialog();
    expect(resultMessage(bulkDialog)).toHaveTextContent(/^Stopped: We couldn't find that role\./);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["nope403@example.com", "norole@example.com"]);
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("norole@example.com, carol@example.com");
  });

  it("429 stops and explains it is throttling, add the rest later", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com slow@example.com later@example.com");
    const bulkDialog = await resultDialog();
    expect(resultMessage(bulkDialog)).toHaveTextContent(/server is limiting requests/);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "slow@example.com"]);
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("slow@example.com, later@example.com");
  });

  it("stop button: the one being sent finishes then it stops, the rest are recorded as not processed and go back to the input; the input is readOnly while running", async () => {
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com", "erin@example.com"], (_url, _method, body) =>
      body?.email === "dave@example.com" ? put.promise : null,
    );
    const { dialog } = await openMembers(fetchMock);
    const input = within(dialog).getByLabelText("Email address");
    submitEmails(dialog, "carol@example.com, dave@example.com, erin@example.com");

    const bulkDialog = await screen.findByRole("dialog", { name: "Add members" });
    expect(await within(bulkDialog).findByText("Processed 1 of 3")).toBeInTheDocument();
    expect(input).toHaveAttribute("readonly");
    // While readOnly a paste (with line breaks, which goes through the custom paste handling) does not change the value either
    fireEvent.paste(input, { clipboardData: { getData: () => "x@example.com\ny@example.com" } });
    expect(input).toHaveValue("carol@example.com, dave@example.com, erin@example.com");
    fireEvent.click(within(bulkDialog).getByRole("button", { name: "Stop" }));
    expect(within(bulkDialog).getByRole("button", { name: "Stopping…" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => put.release(ok(member("u-dave", "dave@example.com", "Dave", MEMBER_ROLE), 201)));

    await resultDialog();
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "dave@example.com"]);
    expect(resultMessage(bulkDialog)).toHaveTextContent("Stopped. The addresses that weren't added are back in the email box.");
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (2):", emails: ["carol@example.com", "dave@example.com"] });
    expect(outcomeSummary(bulkDialog, "notProcessed")).toEqual({ label: "Not processed (1):", emails: ["erin@example.com"] });
    expect(input).toHaveValue("erin@example.com");
    expect(input).not.toHaveAttribute("readonly");
  });

  it("closing the dialog midway (X) = stop: nothing more is sent, unprocessed ones go back to the input, focus returns to the input; the import cannot be opened again while winding down", async () => {
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"], (_url, _method, body) =>
      body?.email === "carol@example.com" ? put.promise : null,
    );
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com dave@example.com");
    const bulkDialog = await screen.findByRole("dialog", { name: "Add members" });
    await within(bulkDialog).findByRole("button", { name: "Stop" });

    fireEvent.click(within(bulkDialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add members" })).not.toBeInTheDocument());
    const input = within(dialog).getByLabelText("Email address");
    await waitFor(() => expect(input).toHaveFocus());
    // Still waiting for carol's request: the import button is blocking (aria-disabled, pressing does not open)
    const importButton = within(dialog).getByRole("button", { name: "Import from another group…" });
    expect(importButton).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(importButton);
    expect(screen.queryByRole("dialog", { name: "Import members from another group" })).not.toBeInTheDocument();

    await act(async () => put.release(ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201)));
    await waitFor(() => expect(input).toHaveValue("dave@example.com"));
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com"]);
    expect(screen.queryByRole("dialog", { name: "Add members" })).not.toBeInTheDocument();
    expect(importButton).not.toHaveAttribute("aria-disabled");
  });

  it("unmounting midway (group modal closed): nothing is sent after the one in flight", async () => {
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"], (_url, _method, body) =>
      body?.email === "carol@example.com" ? put.promise : null,
    );
    const { dialog, view } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com dave@example.com");
    await within(await screen.findByRole("dialog", { name: "Add members" })).findByRole("button", { name: "Stop" });

    view.unmount();
    await act(async () => put.release(ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com"]);
  });

  it("re-entry guard: submitting twice in the same tick runs only one round (each address is sent once, the result shows as usual)", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "carol@example.com dave@example.com" } });
    const form = within(dialog).getByLabelText("Email address").closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    const bulkDialog = await resultDialog();
    expect(outcomeSummary(bulkDialog, "added")?.emails).toEqual(["carol@example.com", "dave@example.com"]);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "dave@example.com"]);
  });

  it("result list: one email per line; only a category with more than 5 scrolls (tabIndex + named by the category title), 5 or fewer do not scroll", async () => {
    const six = Array.from({ length: 6 }, (_, i) => `u${i + 1}@example.com`);
    const five = Array.from({ length: 5 }, (_, i) => `g${i + 1}@nowhere.test`);
    const fetchMock = membersServer([ME_ADMIN()], six);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, [...six, ...five].join(" "));
    const bulkDialog = await resultDialog();

    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (6):", emails: six });
    expect(outcomeSummary(bulkDialog, "notFound")).toEqual({ label: "No account with this email (5):", emails: five });

    const scrolling = within(outcomeRow(bulkDialog, "added")!).getByRole("list");
    expect(scrolling).toHaveAttribute("tabindex", "0");
    expect(scrolling).toHaveAccessibleName("Added (6):");
    expect(scrolling.className).toContain("overflow-y-auto");
    expect(scrolling).toHaveClass("leading-5", "text-muted-foreground");

    const plain = within(outcomeRow(bulkDialog, "notFound")!).getByRole("list");
    expect(plain).not.toHaveAttribute("tabindex");
    expect(plain).not.toHaveAttribute("aria-labelledby");
    expect(plain.className).not.toContain("overflow-y-auto");
    expect(plain).toHaveClass("leading-5", "text-muted-foreground");
    expect(within(bulkDialog).getByRole("status")).not.toHaveTextContent("@");
  });

  it("import from another group: lists other groups -> choose one -> checklist (all checked by default, excluding those already here and yourself) -> uncheck one -> confirm -> the same dialog switches to progress and result -> done, focus returns to the import button", async () => {
    const initial = [ME_ADMIN(), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)];
    const sourceMembers = [
      member(ME.id, ME.email, "Me", MEMBER_ROLE),
      member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE),
      member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE),
      member("u-dave", "dave@example.com", "Dave", MEMBER_ROLE),
      member("u-erin", "erin@example.com", "Erin", ADMIN_ROLE),
    ];
    const fetchMock = membersServer(initial, ["carol@example.com", "erin@example.com"], (url, method) =>
      url === `/api/groups/${SOURCE.id}/members` && method === "GET" ? ok(sourceMembers) : null,
    );
    const { dialog } = await openMembers(fetchMock);
    await chooseOption(within(dialog).getByLabelText("Role for new member"), "Admin");

    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    expect(within(importDialog).getByText(/added to this group as Admin\. This is a one-time copy/)).toBeInTheDocument();
    const source = within(importDialog).getByLabelText("Group to import from");
    expect(displayedLabel(source)).toBe("Choose a group…");
    expect(await optionLabels(source)).toEqual(["Team Source"]);
    await chooseOption(source, "Team Source");

    const list = await within(importDialog).findByRole("list", { name: "People to add" });
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(["carol@example.com", "dave@example.com", "erin@example.com"]);
    for (const box of boxes) expect(box).toBeChecked();
    expect(within(importDialog).getByRole("button", { name: "Add 3 people" })).toBeEnabled();

    fireEvent.click(within(list).getByRole("checkbox", { name: "dave@example.com" }));
    fireEvent.click(within(importDialog).getByRole("button", { name: "Add 2 people" }));

    const bulkDialog = await resultDialog("Import members from another group");
    expect(bulkDialog).toBe(importDialog);
    expect(outcomeSummary(bulkDialog, "added")?.emails).toEqual(["carol@example.com", "erin@example.com"]);
    expect(putBodies(fetchMock)).toEqual([
      { email: "carol@example.com", roleId: ADMIN_ROLE.id },
      { email: "erin@example.com", roleId: ADMIN_ROLE.id },
    ]);
    // Role reset rule is the same as for the input: nothing goes back to the input -> reset; the description still uses the role from when the run started
    expect(selectedValue(within(dialog).getByLabelText("Role for new member"))).toBe(MEMBER_ROLE.id);
    expect(within(bulkDialog).getByText(/added to this group as Admin\./)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText("erin@example.com")).toBeInTheDocument());

    fireEvent.click(within(bulkDialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import members from another group" })).not.toBeInTheDocument());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Import from another group…" })).toHaveFocus());
  });

  it("import path: after confirming, focus moves to Stop; stopping (500) appends those not added after the input's original content", async () => {
    const sourceMembers = [
      member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE),
      member("u-boom", "boom@example.com", "Boom", MEMBER_ROLE),
      member("u-dave", "dave@example.com", "Dave", MEMBER_ROLE),
    ];
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"], (url, method, body) => {
      if (url === `/api/groups/${SOURCE.id}/members` && method === "GET") return ok(sourceMembers);
      return body?.email === "carol@example.com" ? put.promise : null;
    });
    const { dialog } = await openMembers(fetchMock);
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "typed@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    await chooseOption(within(importDialog).getByLabelText("Group to import from"), "Team Source");
    fireEvent.click(await within(importDialog).findByRole("button", { name: "Add 3 people" }));
    // The confirm button is replaced: focus must not fall to body, it moves to Stop
    await waitFor(() => expect(within(importDialog).getByRole("button", { name: "Stop" })).toHaveFocus());
    await act(async () => put.release(ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201)));

    const bulkDialog = await resultDialog("Import members from another group");
    expect(resultMessage(bulkDialog)).toHaveTextContent(/^Stopped: Something went wrong/);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "boom@example.com"]);
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("typed@example.com, boom@example.com, dave@example.com");
  });

  it("import fully succeeded but the input still has addresses the user typed: the role is not reset (those still need the chosen role), the input is unchanged", async () => {
    const sourceMembers = [member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE)];
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"], (url, method) =>
      url === `/api/groups/${SOURCE.id}/members` && method === "GET" ? ok(sourceMembers) : null,
    );
    const { dialog } = await openMembers(fetchMock);
    await chooseOption(within(dialog).getByLabelText("Role for new member"), "Admin");
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "typed@example.com " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    await chooseOption(within(importDialog).getByLabelText("Group to import from"), "Team Source");
    fireEvent.click(await within(importDialog).findByRole("button", { name: "Add 1 person" }));

    const bulkDialog = await resultDialog("Import members from another group");
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (1):", emails: ["carol@example.com"] });
    expect(selectedValue(within(dialog).getByLabelText("Role for new member"))).toBe(ADMIN_ROLE.id);
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("typed@example.com ");
  });

  it("import: loading the source group's members fails: the dialog shows the error, no checklist", async () => {
    const fetchMock = membersServer([ME_ADMIN()], [], (url, method) =>
      url === `/api/groups/${SOURCE.id}/members` && method === "GET" ? fail(500, "internal") : null,
    );
    const { dialog } = await openMembers(fetchMock);
    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    await chooseOption(within(importDialog).getByLabelText("Group to import from"), "Team Source");
    expect(await within(importDialog).findByRole("alert")).toHaveTextContent("An unexpected error occurred.");
    expect(within(importDialog).queryByRole("list", { name: "People to add" })).not.toBeInTheDocument();
  });

  it("import: the select-all box can uncheck everything (confirm disabled) and check all again; cancel closes without sending", async () => {
    const sourceMembers = [member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), member("u-dave", "dave@example.com", "Dave", MEMBER_ROLE)];
    const fetchMock = membersServer([ME_ADMIN()], [], (url, method) =>
      url === `/api/groups/${SOURCE.id}/members` && method === "GET" ? ok(sourceMembers) : null,
    );
    const { dialog } = await openMembers(fetchMock);
    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    await chooseOption(within(importDialog).getByLabelText("Group to import from"), "Team Source");
    const all = await within(importDialog).findByRole("checkbox", { name: "Select all (2)" });
    fireEvent.click(all);
    expect(within(importDialog).getByRole("button", { name: "Add 0 people" })).toBeDisabled();
    fireEvent.click(all);
    expect(within(importDialog).getByRole("button", { name: "Add 2 people" })).toBeEnabled();
    fireEvent.click(within(importDialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import members from another group" })).not.toBeInTheDocument());
    expect(putBodies(fetchMock)).toHaveLength(0);
  });

  it("import: I am in no other group: an explanation text, no dropdown", async () => {
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => [ME_ADMIN()]);
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    expect(within(importDialog).getByText("You're not in any other group.")).toBeInTheDocument();
    expect(within(importDialog).queryByLabelText("Group to import from")).not.toBeInTheDocument();
  });

  it("no permission to manage members: no import button", async () => {
    renderGroupRoute(`/groups/${GROUP_MEMBER.id}`, groupFetch(() => [GROUP_MEMBER], () => [member(ME.id, ME.email, "Me", MEMBER_ROLE)]));
    const dialog = await screen.findByRole("dialog", { name: GROUP_MEMBER.name });
    await within(dialog).findByText(ME.email);
    expect(within(dialog).queryByRole("button", { name: "Import from another group…" })).not.toBeInTheDocument();
  });
});
