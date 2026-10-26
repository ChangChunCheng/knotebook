import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { GroupDto, GroupMemberDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import { ADMIN_ROLE, GROUP_ADMIN, GROUP_MEMBER, ME, MEMBER_ROLE, ROLES, callsTo, fail, groupFetch, member, ok, renderGroupRoute } from "./group-test-utils";

// 成員批次加入：貼多個地址（逗號／分號／空白／換行）與「從其他群組匯入」，兩條都逐一 `PUT …/members`、
// 結果分類列在表單下方。純函式（拆解、分類、停下）由 bulk-add.test.ts 守。

const URL_MEMBERS = `/api/groups/${GROUP_ADMIN.id}/members`;
const SOURCE: GroupDto = { ...GROUP_MEMBER, name: "Team Source" };

function putBodies(fetchMock: ReturnType<typeof vi.fn>): Array<{ email: string; roleId?: string }> {
  return callsTo(fetchMock, "PUT", URL_MEMBERS).map((init) => JSON.parse(String(init.body)) as { email: string; roleId?: string });
}

/** `PUT` 依 email 回：known 裡的 → 201 並加進名單；`dup@` → 409；`boom@` → 500；`slow@` → 429；其他 → 404 user_not_found。 */
function membersServer(initial: GroupMemberDto[], known: string[], extra: (url: string, method: string) => Response | null = () => null) {
  let members = [...initial];
  const fetchMock = groupFetch(() => [GROUP_ADMIN, SOURCE], () => members, (url, method, init) => {
    const custom = extra(url, method);
    if (custom) return custom;
    if (url === URL_MEMBERS && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { email: string; roleId?: string };
      if (body.email === "dup@example.com") return fail(409, "already_member");
      if (body.email === "boom@example.com") return fail(500, "internal");
      if (body.email === "slow@example.com") return fail(429, "too_many_requests");
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

async function openMembers(fetchMock: ReturnType<typeof vi.fn>) {
  renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
  const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
  const roleSelect = await within(dialog).findByLabelText("Role for new member");
  await waitFor(() => expect(roleSelect).toHaveValue(MEMBER_ROLE.id));
  await within(dialog).findByText(ME.email);
  return dialog;
}

describe("成員批次加入", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("貼多個地址：去重、已在名單的不送；逐一 PUT（同一個角色）；結果分類列出；輸入框清空", async () => {
    const initial = [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)];
    const fetchMock = membersServer(initial, ["carol@example.com", "dave@example.com"]);
    const dialog = await openMembers(fetchMock);

    fireEvent.change(within(dialog).getByLabelText("Role for new member"), { target: { value: ADMIN_ROLE.id } });
    const input = within(dialog).getByLabelText("Email address");
    fireEvent.change(input, { target: { value: "carol@example.com, ghost@example.com; Carol@Example.com BOB@example.com dave@example.com nope" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    const status = await within(dialog).findByText(/Added \(2\):/);
    expect(putBodies(fetchMock)).toEqual([
      { email: "carol@example.com", roleId: ADMIN_ROLE.id },
      { email: "ghost@example.com", roleId: ADMIN_ROLE.id },
      { email: "dave@example.com", roleId: ADMIN_ROLE.id },
    ]);
    const summary = status.closest('[role="status"]') as HTMLElement;
    expect(summary.querySelector('[data-outcome="added"]')).toHaveTextContent("carol@example.com, dave@example.com");
    expect(summary.querySelector('[data-outcome="notFound"]')).toHaveTextContent("No account with this email (1): ghost@example.com");
    expect(summary.querySelector('[data-outcome="alreadyMember"]')).toHaveTextContent("Already members (1): BOB@example.com");
    expect(summary.querySelector('[data-outcome="invalid"]')).toHaveTextContent("Not an email address (1): nope");
    expect(input).toHaveValue("");
    // 失效後名單重抓：新成員出現，角色是選的那個
    await waitFor(() => expect(within(dialog).getByLabelText("Role for dave@example.com")).toHaveValue(ADMIN_ROLE.id));
    expect(within(dialog).getByLabelText("Role for new member")).toHaveValue(MEMBER_ROLE.id);

    fireEvent.click(within(summary).getByRole("button", { name: "Dismiss" }));
    expect(within(dialog).queryByText(/Added \(2\):/)).not.toBeInTheDocument();
  });

  it("單一地址仍走原本的單人流程（錯誤是表單下的 alert）；單一個不像 email 的字不送出", async () => {
    const fetchMock = membersServer([member(ME.id, ME.email, "Me", ADMIN_ROLE)], []);
    const dialog = await openMembers(fetchMock);
    const input = within(dialog).getByLabelText("Email address");

    fireEvent.change(input, { target: { value: "ghost@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("We couldn't find that user.");
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("“nope” doesn't look like an email address.");
    expect(putBodies(fetchMock)).toHaveLength(1);
  });

  it("貼上含換行的一欄地址 → 換行變逗號（單行輸入框原本會把換行吃掉）", async () => {
    const fetchMock = membersServer([member(ME.id, ME.email, "Me", ADMIN_ROLE)], []);
    const dialog = await openMembers(fetchMock);
    const input = within(dialog).getByLabelText("Email address") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "x@example.com, " } });
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => "a@example.com\r\nb@example.com\n" } });
    expect(input).toHaveValue("x@example.com, a@example.com, b@example.com");
  });

  it("非預期錯誤（500）→ 停下：其後不送；失敗與未處理的放回輸入框；顯示原因", async () => {
    const fetchMock = membersServer([member(ME.id, ME.email, "Me", ADMIN_ROLE)], ["carol@example.com", "dave@example.com"]);
    const dialog = await openMembers(fetchMock);
    const input = within(dialog).getByLabelText("Email address");
    fireEvent.change(input, { target: { value: "carol@example.com, boom@example.com, dave@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    expect(await within(dialog).findByText(/^Stopped: Something went wrong/)).toBeInTheDocument();
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "boom@example.com"]);
    const summary = within(dialog).getByRole("status");
    expect(summary.querySelector('[data-outcome="failed"]')).toHaveTextContent("boom@example.com");
    expect(summary.querySelector('[data-outcome="notProcessed"]')).toHaveTextContent("dave@example.com");
    expect(input).toHaveValue("boom@example.com, dave@example.com");
  });

  it("429 → 停下並說明是節流、稍後再加其餘的", async () => {
    const fetchMock = membersServer([member(ME.id, ME.email, "Me", ADMIN_ROLE)], ["carol@example.com"]);
    const dialog = await openMembers(fetchMock);
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "carol@example.com slow@example.com later@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText(/server is limiting requests/)).toBeInTheDocument();
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "slow@example.com"]);
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("slow@example.com, later@example.com");
  });

  it("從其他群組匯入：列其他群組 → 選一個 → 勾選清單（預設全勾，排除已在這裡的人與自己）→ 取消一位 → 確認 → 依序 PUT（加人表單選的角色）", async () => {
    const initial = [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)];
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
    const dialog = await openMembers(fetchMock);
    fireEvent.change(within(dialog).getByLabelText("Role for new member"), { target: { value: ADMIN_ROLE.id } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    expect(within(importDialog).getByText(/added to this group as Admin\. This is a one-time copy/)).toBeInTheDocument();
    const source = within(importDialog).getByLabelText("Group to import from");
    // 只列其他群組（不含目前這個）
    expect(within(source).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a group…", "Team Source"]);
    fireEvent.change(source, { target: { value: SOURCE.id } });

    const list = await within(importDialog).findByRole("list", { name: "People to add" });
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(["carol@example.com", "dave@example.com", "erin@example.com"]);
    for (const box of boxes) expect(box).toBeChecked();
    expect(within(importDialog).getByRole("button", { name: "Add 3 people" })).toBeEnabled();

    fireEvent.click(within(list).getByRole("checkbox", { name: "dave@example.com" }));
    fireEvent.click(within(importDialog).getByRole("button", { name: "Add 2 people" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import members from another group" })).not.toBeInTheDocument());
    expect(await within(dialog).findByText(/Added \(2\):/)).toBeInTheDocument();
    expect(putBodies(fetchMock)).toEqual([
      { email: "carol@example.com", roleId: ADMIN_ROLE.id },
      { email: "erin@example.com", roleId: ADMIN_ROLE.id },
    ]);
    await waitFor(() => expect(within(dialog).getByText("erin@example.com")).toBeInTheDocument());
  });

  it("匯入：全選框可全部取消（確認鈕 disabled）再全選；沒有其他群組時說明", async () => {
    const sourceMembers = [member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), member("u-dave", "dave@example.com", "Dave", MEMBER_ROLE)];
    const fetchMock = membersServer([member(ME.id, ME.email, "Me", ADMIN_ROLE)], [], (url, method) =>
      url === `/api/groups/${SOURCE.id}/members` && method === "GET" ? ok(sourceMembers) : null,
    );
    const dialog = await openMembers(fetchMock);
    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    fireEvent.change(within(importDialog).getByLabelText("Group to import from"), { target: { value: SOURCE.id } });
    const all = await within(importDialog).findByRole("checkbox", { name: "Select all (2)" });
    fireEvent.click(all);
    expect(within(importDialog).getByRole("button", { name: "Add 0 people" })).toBeDisabled();
    fireEvent.click(all);
    expect(within(importDialog).getByRole("button", { name: "Add 2 people" })).toBeEnabled();
    fireEvent.click(within(importDialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import members from another group" })).not.toBeInTheDocument());
    expect(putBodies(fetchMock)).toHaveLength(0);
  });

  it("匯入：我不在其他群組 → 說明文字、沒有下拉", async () => {
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)]);
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    expect(within(importDialog).getByText("You're not in any other group.")).toBeInTheDocument();
    expect(within(importDialog).queryByLabelText("Group to import from")).not.toBeInTheDocument();
  });

  it("沒有管理成員的權限 → 沒有匯入鈕", async () => {
    renderGroupRoute(`/groups/${GROUP_MEMBER.id}`, groupFetch(() => [GROUP_MEMBER], () => [member(ME.id, ME.email, "Me", MEMBER_ROLE)]));
    const dialog = await screen.findByRole("dialog", { name: GROUP_MEMBER.name });
    await within(dialog).findByText(ME.email);
    expect(within(dialog).queryByRole("button", { name: "Import from another group…" })).not.toBeInTheDocument();
  });
});
