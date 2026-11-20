import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { IDP_CONTROL_ORIGIN } from "../ports.js";
import { ADMIN, createUserViaInvite, loginAs, randomEmail } from "./helpers.js";

/**
 * All measuring happens in one in-page evaluate (getBoundingClientRect; header text extents via Range). A cell's "content left
 * edge" = the left edge of its last child element (cell content is always wrapped in a single flex-1 min-w-0 child; the column
 * name used on phones comes before it and is hidden from sm up). Column kinds are inferred from the column index: with an
 * enabled column it is the last column and the actions column is left of it; without an enabled column the actions column is
 * last.
 * The three personal-settings tables are measured with a new user created by an SSO first login: the e2e stack has one OIDC
 * provider that lets new accounts in on first login ("SSO"), so "Sign-in methods" has only 1 row; the PAT creation quota is
 * per user, so a new user does not draw on the admin's quota.
 * Cleanup: at the end the API deletes the tokens, groups, plans, sign-in providers, AI actions and providers it created and
 * revokes the invitations it created; users have no delete API and stay (names carry a random code).
 */

const RUN = randomUUID().slice(0, 8);
const ROOT_CONTROL_URL = `${IDP_CONTROL_ORIGIN}/control/next-login`;
const LAST_ACTIVE_HEADER = "Last active"; // must match the English string merged in #267's i18n
const CUSTOM_LABEL = "t26-custom";

const N = {
  providerA: `T26 Anthropic ${RUN}`,
  providerB: `T26 Compatible ${RUN}`,
  modelA1: `T26 Model One ${RUN}`,
  modelA2: `T26 Model Two has a longer display name ${RUN}`,
  modelB1: `T26 Model Three ${RUN}`,
  action: `T26 Action ${RUN}`,
  idpA: `T26 IdP A ${RUN}`,
  idpB: `T26 IdP B ${RUN}`,
  planA: `T26 Plan A ${RUN}`,
  planB: `T26 Plan B ${RUN}`,
  groupA: `T26 Group A ${RUN}`,
  groupB: `T26 Group B ${RUN}`,
  tokenPlain: `T26 token plain ${RUN}`,
  tokenLabeled: `T26 token labeled ${RUN}`,
  ssoUser: `T26 SSO ${RUN}`,
  inviteShort: `T26 invitation ${RUN}`,
  inviteLong: `T26-long-invitation-note-without-spaces-${RUN}`,
} as const;
const SHORT_EMAIL = `s${RUN}@e2e.local`;
const LONG_EMAIL = `e2e-settings-table-long-address-${randomUUID()}@e2e.local`;
const SSO_EMAIL = randomEmail();
const USER_PASSWORD = "e2e-t26-user-password";

interface TableSpec {
  /** Accessible name of the table (and of the top-level table's scroll box) */
  label: string;
  /** Column names (forced order; the actions column is sr-only text, which textContent still reads) */
  headers: string[];
  /** Number of buttons in the actions column (0 = no actions column). */
  buttons: number;
  enabled: boolean;
  minRows: number;
}

const T = {
  providers: { label: "Providers", headers: ["Name", "Type", "Base URL", "Models", "Actions", "Enabled"], buttons: 3, enabled: true, minRows: 2 },
  actions: { label: "Actions", headers: ["Name", "Apply mode", "Model", "Actions", "Enabled"], buttons: 4, enabled: true, minRows: 2 },
  authProviders: { label: "Sign-in services", headers: ["Service", "Issuer", "Linked", "Creates accounts", "Actions", "Enabled"], buttons: 4, enabled: true, minRows: 2 },
  users: { label: "Users", headers: ["User", "Email", "Storage", LAST_ACTIVE_HEADER, "Role", "Plan", "Actions", "Enabled"], buttons: 1, enabled: true, minRows: 2 },
  adminGroups: { label: "Groups", headers: ["Name", "Members", "Created", "Storage", "Plan"], buttons: 0, enabled: false, minRows: 2 },
  plans: { label: "Storage plans", headers: ["Name", "Limit", "Users", "Groups", "Spaces over limit", "Actions"], buttons: 2, enabled: false, minRows: 2 },
  members: { label: "Members", headers: ["Name", "Email", "Role", "Actions"], buttons: 1, enabled: false, minRows: 2 },
  tokens: { label: "API tokens", headers: ["Name", "Label", "Permissions", "Last used", "Expires", "Actions"], buttons: 2, enabled: false, minRows: 2 },
  invites: { label: "Invitations", headers: ["Invitation", "Status", "Expires", "Used by", "Actions"], buttons: 1, enabled: false, minRows: 2 },
  signInMethods: { label: "Sign-in methods", headers: ["Service", "Linked", "Last used", "Actions"], buttons: 1, enabled: false, minRows: 1 },
  myGroups: { label: "Groups", headers: ["Group", "My role", "Permissions"], buttons: 0, enabled: false, minRows: 2 },
} satisfies Record<string, TableSpec>;

interface PanelPage {
  path: string;
  tables: Array<{ spec: TableSpec; own: string[] }>;
}

interface Created {
  providers: string[];
  actions: string[];
  authProviders: string[];
  plans: string[];
  groups: string[];
  tokens: string[];
  invites: string[];
}

interface CellGeometry {
  width: number;
  height: number;
  innerLeft: number;
  buttonCount: number;
  buttonsRight: number | null;
  switchCenter: number | null;
}
interface RowGeometry {
  name: string;
  right: number;
  height: number;
  borderBottom: number;
  cells: CellGeometry[];
}
interface TableGeometry {
  headers: Array<{ text: string; left: number; center: number }>;
  rows: RowGeometry[];
}
interface Stop {
  row: string;
  control: string;
  overlap: number;
}

const content = (page: Page) => page.locator("[data-management-content]");
const tableOf = (page: Page, spec: TableSpec) => content(page).getByRole("table", { name: spec.label, exact: true });
const boxOf = (page: Page, spec: TableSpec) => content(page).getByRole("region", { name: spec.label, exact: true });

async function call<R>(page: Page, method: "post" | "patch" | "put", url: string, data: unknown): Promise<R> {
  const res = await page.request[method](url, { data });
  const text = await res.text();
  expect(res.ok(), `${method.toUpperCase()} ${url} → HTTP ${res.status()} ${text}`).toBe(true);
  return (text === "" ? undefined : JSON.parse(text)) as R;
}

async function signInSsoUser(page: Page): Promise<void> {
  const control = await page.request.put(ROOT_CONTROL_URL, {
    data: { sub: `e2e-t26-${randomUUID()}`, email: SSO_EMAIL, email_verified: true, name: N.ssoUser },
  });
  expect(control.ok(), `fake-idp control → HTTP ${control.status()}`).toBe(true);
  await page.goto("/login");
  await page.getByRole("link", { name: "Sign in with SSO", exact: true }).click();
  await expect(page, "SSO 首登要自動建帳並進站（SSO 服務要開自動建帳）").toHaveURL(/\/$/, { timeout: 20_000 });
}

/** Seeds data for all tables; returns group A's id (the page of the members table). */
async function seed(admin: Page, sso: Page, created: Created): Promise<string> {
  // AI: two providers of different types (A has two models, B one). Models and the custom action are created disabled and non-default, so they do not affect other specs' AI resolution.
  const providerA = await call<{ id: string }>(admin, "post", "/api/admin/ai/providers", {
    name: N.providerA,
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
  });
  created.providers.push(providerA.id);
  const providerB = await call<{ id: string }>(admin, "post", "/api/admin/ai/providers", {
    name: N.providerB,
    type: "openai_compatible",
    baseUrl: "http://ai-stub:9500/fast",
  });
  created.providers.push(providerB.id);
  const models: Array<[string, string, string]> = [
    [providerA.id, "t26-a1", N.modelA1],
    [providerA.id, "t26-a2", N.modelA2],
    [providerB.id, "t26-b1", N.modelB1],
  ];
  for (const [providerId, modelId, displayName] of models) {
    await call(admin, "post", "/api/admin/ai/models", { providerId, modelId, displayName, isDefault: false, enabled: false });
  }
  const listed = await admin.request.get("/api/admin/ai/actions");
  expect(listed.ok(), `GET /api/admin/ai/actions → HTTP ${listed.status()}`).toBe(true);
  const { actions } = (await listed.json()) as { actions: Array<{ sortOrder: number }> };
  const action = await call<{ id: string }>(admin, "post", "/api/admin/ai/actions", {
    name: N.action,
    systemPrompt: "Rewrite the text.",
    userTemplate: "Rewrite:\n{{text}}",
    modelId: null,
    applyMode: "preview",
    sortOrder: Math.max(0, ...actions.map((item) => item.sortOrder)) + 1,
    enabled: false,
  });
  created.actions.push(action.id);

  created.authProviders.push(
    (await call<{ id: string }>(admin, "post", "/api/admin/auth/providers", { template: "oidc", displayName: N.idpA, issuerUrl: "http://fake-idp:9400/t26-a", clientId: "t26-a" })).id,
  );
  created.authProviders.push(
    (await call<{ id: string }>(admin, "post", "/api/admin/auth/providers", { template: "gitlab", displayName: N.idpB, issuerUrl: "https://gitlab.example.com/t26", clientId: "t26-b" })).id,
  );

  // Users: email lengths differ a lot; the long one's display name is also a long run without spaces.
  await createUserViaInvite(admin, { email: SHORT_EMAIL, password: USER_PASSWORD, displayName: "T26 Short" });
  await createUserViaInvite(admin, {
    email: LONG_EMAIL,
    password: USER_PASSWORD,
    displayName: `T26-long-display-name-without-any-spaces-${RUN}`,
  });

  // Invitations: two unused ones with the note carrying RUN, one of them a long note without spaces (within the 100 code point limit).
  for (const label of [N.inviteShort, N.inviteLong]) {
    const invite = await call<{ invite: { id: string } }>(admin, "post", "/api/admin/invites", { expiresInDays: 1, label });
    created.invites.push(invite.invite.id);
  }

  created.plans.push((await call<{ id: string }>(admin, "post", "/api/admin/storage-plans", { name: N.planA, quotaBytes: 1048576 })).id);
  created.plans.push((await call<{ id: string }>(admin, "post", "/api/admin/storage-plans", { name: N.planB, quotaBytes: null })).id);

  // Group A: admin + three people; group B: admin + the SSO user (the SSO user is in both, so My groups has 2 rows).
  const groupA = await call<{ id: string }>(admin, "post", "/api/groups", { name: N.groupA });
  created.groups.push(groupA.id);
  const groupB = await call<{ id: string }>(admin, "post", "/api/groups", { name: N.groupB });
  created.groups.push(groupB.id);
  for (const email of [SHORT_EMAIL, LONG_EMAIL, SSO_EMAIL]) await call(admin, "put", `/api/groups/${groupA.id}/members`, { email });
  await call(admin, "put", `/api/groups/${groupB.id}/members`, { email: SSO_EMAIL });

  created.tokens.push((await call<{ id: string }>(sso, "post", "/api/auth/tokens", { name: N.tokenPlain, scope: "notes:read", expiresInDays: null })).id);
  const labeled = await call<{ id: string }>(sso, "post", "/api/auth/tokens", { name: N.tokenLabeled, scope: "notes:read notes:write", expiresInDays: 30 });
  created.tokens.push(labeled.id);
  await call(sso, "patch", `/api/auth/tokens/${labeled.id}`, { agentLabel: CUSTOM_LABEL });
  return groupA.id;
}

/** Cleanup: runs even on failure and never throws itself (does not mask the body's original error). */
async function cleanup(admin: Page, sso: Page, created: Created): Promise<void> {
  const attempt = async (what: string, run: () => Promise<{ ok(): boolean; status(): number }>): Promise<void> => {
    try {
      const res = await run();
      if (!res.ok()) console.warn(`[26 cleanup] ${what} → HTTP ${res.status()}`);
    } catch (err) {
      console.warn(`[26 cleanup] ${what} threw:`, err);
    }
  };
  for (const id of created.tokens) await attempt(`token ${id}`, () => sso.request.delete(`/api/auth/tokens/${id}`));
  for (const id of created.invites) await attempt(`invite ${id}`, () => admin.request.delete(`/api/admin/invites/${id}`));
  for (const id of created.groups) await attempt(`group ${id}`, () => admin.request.delete(`/api/groups/${id}`, { data: { mode: "delete" } }));
  for (const id of created.plans) await attempt(`plan ${id}`, () => admin.request.delete(`/api/admin/storage-plans/${id}`));
  for (const id of created.authProviders) await attempt(`auth provider ${id}`, () => admin.request.delete(`/api/admin/auth/providers/${id}`));
  for (const id of created.actions) await attempt(`ai action ${id}`, () => admin.request.delete(`/api/admin/ai/actions/${id}`));
  for (const id of created.providers) await attempt(`ai provider ${id}`, () => admin.request.delete(`/api/admin/ai/providers/${id}`));
}

async function openPanel(page: Page, path: string, specs: TableSpec[]): Promise<void> {
  await page.goto(path);
  for (const spec of specs) await expect(tableOf(page, spec), `${path}：要看得到「${spec.label}」表`).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function expectOwnRows(page: Page, spec: TableSpec, own: string[]): Promise<void> {
  const table = tableOf(page, spec);
  for (const name of own) await expect(table.getByRole("row", { name, exact: true }), `「${spec.label}」要有自建的「${name}」列`).toHaveCount(1);
}

async function measure(table: Locator): Promise<TableGeometry> {
  return table.evaluate((tableEl) => {
    const header = tableEl.querySelector(':scope > [role="row"]');
    if (header === null) throw new Error("找不到表頭列");
    const headers = Array.from(header.querySelectorAll(':scope > [role="columnheader"]')).map((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell.firstElementChild!);
      const r = range.getBoundingClientRect();
      return { text: (cell.textContent ?? "").trim(), left: r.left, center: r.left + r.width / 2 };
    });
    const rows = Array.from(tableEl.querySelectorAll(':scope > [role="row"][aria-labelledby]')).map((row) => {
      const rr = row.getBoundingClientRect();
      const cells = Array.from(row.querySelectorAll(':scope > [role="cell"]')).map((cell) => {
        const cr = cell.getBoundingClientRect();
        const rights = Array.from(cell.querySelectorAll('button:not([role="switch"])')).map((button) => button.getBoundingClientRect().right);
        const toggle = cell.querySelector('[role="switch"]');
        const sr = toggle?.getBoundingClientRect();
        return {
          width: cr.width,
          height: cr.height,
          // The content wrapper is the last child: the column name used on phones (display:none from sm up) comes before it.
          innerLeft: cell.lastElementChild!.getBoundingClientRect().left,
          buttonCount: rights.length,
          buttonsRight: rights.length > 0 ? Math.max(...rights) : null,
          switchCenter: sr === undefined ? null : sr.left + sr.width / 2,
        };
      });
      return {
        name: document.getElementById(row.getAttribute("aria-labelledby")!)?.textContent ?? "",
        right: rr.right,
        height: rr.height,
        borderBottom: parseFloat(getComputedStyle(row).borderBottomWidth),
        cells,
      };
    });
    return { headers, rows };
  });
}

function checkTable(spec: TableSpec, g: TableGeometry, where: string): void {
  const label = `${where}「${spec.label}」`;
  expect(g.headers.map((h) => h.text), `${label} 欄名順序`).toEqual(spec.headers);
  expect(g.rows.length, `${label} 列數`).toBeGreaterThanOrEqual(spec.minRows);
  const count = spec.headers.length;
  const enabledIndex = spec.enabled ? count - 1 : -1;
  const actionsIndex = spec.buttons > 0 ? (spec.enabled ? count - 2 : count - 1) : -1;
  for (const row of g.rows) {
    const at = `${label} 列「${row.name}」`;
    expect(row.cells, `${at} 的 cell 數`).toHaveLength(count);
    for (let i = 0; i < count; i += 1) {
      if (i === enabledIndex || i === actionsIndex) continue;
      expect(Math.abs(row.cells[i]!.innerLeft - g.headers[i]!.left), `${at} 第 ${i + 1} 欄（${spec.headers[i]}）左緣 vs 表頭文字`).toBeLessThanOrEqual(1);
    }
    if (enabledIndex >= 0) {
      const cell = row.cells[enabledIndex]!;
      expect(Math.abs(cell.width - 56), `${at} 啟用欄軌寬（實量 ${cell.width}）`).toBeLessThanOrEqual(0.5);
      expect(cell.switchCenter, `${at} 啟用欄要有 switch`).not.toBeNull();
      expect(Math.abs(cell.switchCenter! - g.headers[enabledIndex]!.center), `${at} 開關中心 vs 表頭文字中心`).toBeLessThanOrEqual(1);
    }
    if (actionsIndex >= 0) {
      const cell = row.cells[actionsIndex]!;
      const last = actionsIndex === count - 1;
      const expected = spec.buttons * 32 + (spec.buttons - 1) * 4 + (last ? 12 : 0);
      expect(Math.abs(cell.width - expected), `${at} 操作欄 cell 寬（實量 ${cell.width}、應為 ${expected}）`).toBeLessThanOrEqual(0.5);
      if (last && cell.buttonsRight !== null) {
        expect(Math.abs(cell.buttonsRight - (row.right - 12)), `${at} 最後一顆鈕右緣 vs 列右緣−12`).toBeLessThanOrEqual(1);
      }
    }
    const primary = row.cells[0]!;
    expect(Math.abs(primary.height - (row.height - row.borderBottom)), `${at} 主欄 cell 高度 vs 列內容高`).toBeLessThanOrEqual(0.5);
  }
  if (actionsIndex >= 0) {
    const rights = g.rows.map((row) => row.cells[actionsIndex]!.buttonsRight).filter((right): right is number => right !== null);
    if (spec.minRows >= 2) expect(rights.length, `${label} 至少兩列有操作鈕`).toBeGreaterThanOrEqual(2);
    expect(Math.max(...rights) - Math.min(...rights), `${label} 各列鈕群右緣`).toBeLessThanOrEqual(1);
  }
}

async function checkSubTable(page: Page, providerName: string, minRows: number, where: string): Promise<void> {
  const parent = await tableOf(page, T.providers)
    .getByRole("row", { name: providerName, exact: true })
    .evaluate((row) => {
      const cells = Array.from(row.querySelectorAll(':scope > [role="cell"]'));
      const toggle = cells[cells.length - 1]!.querySelector('[role="switch"]')!.getBoundingClientRect();
      const rights = Array.from(cells[cells.length - 2]!.querySelectorAll("button")).map((button) => button.getBoundingClientRect().right);
      return { switchCenter: toggle.left + toggle.width / 2, buttonsRight: Math.max(...rights) };
    });
  const children = await content(page)
    .getByRole("table", { name: `Models – ${providerName}`, exact: true })
    .evaluate((tableEl) =>
      Array.from(tableEl.querySelectorAll(':scope > [role="row"][aria-labelledby]')).map((row) => {
        const cells = Array.from(row.querySelectorAll(':scope > [role="cell"]'));
        const toggle = cells[cells.length - 1]!.querySelector('[role="switch"]')!.getBoundingClientRect();
        const rights = Array.from(cells[cells.length - 2]!.querySelectorAll("button")).map((button) => button.getBoundingClientRect().right);
        return {
          name: document.getElementById(row.getAttribute("aria-labelledby")!)?.textContent ?? "",
          switchCenter: toggle.left + toggle.width / 2,
          buttonsRight: Math.max(...rights),
          rowHeight: row.getBoundingClientRect().height,
          borderBottom: parseFloat(getComputedStyle(row).borderBottomWidth),
          primaryHeight: cells[0]!.getBoundingClientRect().height,
        };
      }),
    );
  expect(children.length, `${where}「Models – ${providerName}」列數`).toBeGreaterThanOrEqual(minRows);
  for (const child of children) {
    expect(Math.abs(child.switchCenter - parent.switchCenter), `${where} 子列「${child.name}」開關中心 vs 父列`).toBeLessThanOrEqual(1);
    expect(Math.abs(child.buttonsRight - parent.buttonsRight), `${where} 子列「${child.name}」鈕群右緣 vs 父列`).toBeLessThanOrEqual(1);
    // Primary cell height = row height - computed bottom border width (the sub-table's last row draws no bottom border, so 0).
    expect(Math.abs(child.primaryHeight - (child.rowHeight - child.borderBottom)), `${where} 子列「${child.name}」主欄 cell 高度 vs 列內容高`).toBeLessThanOrEqual(0.5);
  }
}

async function expectNoPanelHScroll(page: Page, where: string): Promise<void> {
  const m = await content(page).evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    pageScrollWidth: document.documentElement.scrollWidth,
    pageClientWidth: document.documentElement.clientWidth,
  }));
  expect(m.scrollWidth, `${where}：管理面板內容區不得橫向捲動（scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}）`).toBeLessThanOrEqual(m.clientWidth);
  expect(m.pageScrollWidth, `${where}：整頁不得橫向捲動`).toBeLessThanOrEqual(m.pageClientWidth);
}

async function expectOverflowing(page: Page, spec: TableSpec, where: string): Promise<void> {
  const m = await boxOf(page, spec).evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(m.scrollWidth, `${where}「${spec.label}」必須溢出（避免 sticky 與遮擋檢查空轉）：scrollWidth ${m.scrollWidth}、clientWidth ${m.clientWidth}`).toBeGreaterThan(
    m.clientWidth,
  );
}

async function expectStickyAfterScrollRight(page: Page, where: string): Promise<string[]> {
  const results = await content(page).evaluate((root) =>
    Array.from(root.querySelectorAll('[role="region"]'))
      .filter((box) => box.querySelector(':scope > [role="table"]') !== null && box.scrollWidth > box.clientWidth)
      .map((box) => {
        box.scrollLeft = box.scrollWidth;
        const left = box.getBoundingClientRect().left;
        const table = box.querySelector(':scope > [role="table"]')!;
        const firstCells = Array.from(table.querySelectorAll(':scope > [role="row"]:not([aria-label]) > :first-child'));
        return { label: box.getAttribute("aria-label") ?? "", offsets: firstCells.map((cell) => cell.getBoundingClientRect().left - left) };
      }),
  );
  for (const result of results) {
    expect(result.offsets.length, `${where}「${result.label}」要量到主欄格`).toBeGreaterThan(0);
    for (const offset of result.offsets) {
      expect(Math.abs(offset), `${where}「${result.label}」捲到最右後主欄左緣 − 捲動框左緣`).toBeLessThanOrEqual(1);
    }
  }
  return results.map((result) => result.label);
}

/**
 * Occlusion check: scroll to the far right; each row (sub-table rows included, whose reference cell = its parent row's
 * top-level primary cell) is scrolled into view vertically only; every button (switch included) in a row overlaps the
 * reference cell horizontally by <= 0.5px; for non-natively-disabled ones, the hit test at the centre must not land on the
 * reference cell or any sticky cell.
 */
async function expectNotCovered(page: Page, spec: TableSpec, where: string): Promise<void> {
  const results = await boxOf(page, spec).evaluate((box) => {
    const scroller = box.closest("[data-management-content]")!;
    box.scrollLeft = box.scrollWidth;
    const table = box.querySelector(':scope > [role="table"]')!;
    const stickyCells = Array.from(table.querySelectorAll('[role="cell"], [role="columnheader"]')).filter(
      (cell) => getComputedStyle(cell).position === "sticky",
    );
    const items: Array<{ row: Element; ref: Element }> = [];
    for (const row of Array.from(table.querySelectorAll(':scope > [role="row"][aria-labelledby]'))) {
      const ref = row.querySelector(':scope > [role="cell"]')!;
      items.push({ row, ref });
      let next = row.nextElementSibling;
      while (next !== null && next.hasAttribute("aria-label")) {
        for (const child of Array.from(next.querySelectorAll('[role="table"] > [role="row"][aria-labelledby]'))) items.push({ row: child, ref });
        next = next.nextElementSibling;
      }
    }
    const out: Array<{ row: string; control: string; overlap: number; covered: boolean; landed: boolean }> = [];
    for (const { row, ref } of items) {
      const cr = scroller.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      scroller.scrollTop += rr.top + rr.height / 2 - (cr.top + cr.height / 2);
      const refRect = ref.getBoundingClientRect();
      const name = document.getElementById(row.getAttribute("aria-labelledby")!)?.textContent ?? "";
      for (const control of Array.from(row.querySelectorAll(':scope > [role="cell"] button'))) {
        const r = control.getBoundingClientRect();
        const overlap = Math.max(0, Math.min(r.right, refRect.right) - Math.max(r.left, refRect.left));
        // Hit test (non-natively-disabled): the centre must hit an element (null = not inside the viewport, i.e. the measurement
        // did not scroll into place - red, not idle), what it hits must be this control itself (or its child), and must not land
        // on the reference cell or any sticky cell. Natively disabled ones get no hit test; landed / covered are recorded as passing.
        let covered = false;
        let landed = true;
        if (!(control as HTMLButtonElement).disabled) {
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          landed = hit !== null && control.contains(hit);
          covered = hit !== null && (ref.contains(hit) || stickyCells.some((cell) => cell.contains(hit)));
        }
        out.push({ row: name, control: control.getAttribute("aria-label") ?? control.getAttribute("role") ?? control.tagName, overlap, covered, landed });
      }
    }
    return out;
  });
  expect(results.length, `${where}「${spec.label}」要有控制項可檢查`).toBeGreaterThan(0);
  for (const result of results) {
    expect(result.overlap, `${where}「${spec.label}」列「${result.row}」的「${result.control}」與該列主欄格水平重疊`).toBeLessThanOrEqual(0.5);
    expect(result.covered, `${where}「${spec.label}」列「${result.row}」的「${result.control}」中心點被主欄／sticky 格蓋住`).toBe(false);
    expect(result.landed, `${where}「${spec.label}」列「${result.row}」的「${result.control}」中心點的命中元素不是它自己（null＝不在視窗內）`).toBe(true);
  }
}

async function expectPhoneCards(page: Page, spec: TableSpec, where: string): Promise<void> {
  const viewportWidth = page.viewportSize()!.width;
  const m = await boxOf(page, spec).evaluate((box) => {
    const table = box.querySelector(':scope > [role="table"]')!;
    const controls = Array.from(table.querySelectorAll("button, [role=switch]")).filter((el) => el.getClientRects().length > 0);
    return {
      scrollWidth: box.scrollWidth,
      clientWidth: box.clientWidth,
      sticky: Array.from(table.querySelectorAll('[role="cell"], [role="columnheader"]')).filter((cell) => getComputedStyle(cell).position === "sticky").length,
      rows: table.querySelectorAll('[role="row"][aria-labelledby]').length,
      controls: controls.map((el) => {
        const r = el.getBoundingClientRect();
        const row = el.closest('[role="row"][aria-labelledby]');
        return {
          row: row === null ? "" : (document.getElementById(row.getAttribute("aria-labelledby")!)?.textContent ?? ""),
          control: el.getAttribute("aria-label") ?? el.getAttribute("role") ?? el.tagName,
          left: r.left,
          right: r.right,
        };
      }),
    };
  });
  expect(m.scrollWidth, `${where}「${spec.label}」不得橫捲（scrollWidth ${m.scrollWidth}、clientWidth ${m.clientWidth}）`).toBeLessThanOrEqual(m.clientWidth);
  expect(m.sticky, `${where}「${spec.label}」手機沒有 sticky 格`).toBe(0);
  expect(m.rows, `${where}「${spec.label}」要有列`).toBeGreaterThan(0);
  // A table with an actions or enabled column must have controls (a table without, e.g. rows with only links, is only checked for no horizontal scroll)
  if (spec.buttons > 0 || spec.enabled) expect(m.controls.length, `${where}「${spec.label}」要有控制項可檢查`).toBeGreaterThan(0);
  for (const control of m.controls) {
    expect(control.left, `${where}「${spec.label}」列「${control.row}」的「${control.control}」左緣`).toBeGreaterThanOrEqual(0);
    expect(control.right, `${where}「${spec.label}」列「${control.row}」的「${control.control}」右緣`).toBeLessThanOrEqual(viewportWidth);
  }

  const total = await tableOf(page, spec).evaluate((table) => {
    const focusable = Array.from(table.querySelectorAll("button:not([disabled]), [role=switch]:not([disabled])")).filter((el) => el.getClientRects().length > 0);
    table.ownerDocument.querySelectorAll("[data-e2e-stop]").forEach((el) => el.removeAttribute("data-e2e-stop"));
    focusable.forEach((el, index) => el.setAttribute("data-e2e-stop", String(index)));
    (focusable[0] as HTMLElement | undefined)?.focus();
    return focusable.length;
  });
  if (total === 0) return;
  const visited = new Set<string>();
  const first = await page.evaluate(() => document.activeElement?.getAttribute("data-e2e-stop") ?? null);
  if (first !== null) visited.add(first);
  for (let i = 0; i < total * 3 + 5 && visited.size < total; i += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => document.activeElement?.getAttribute("data-e2e-stop") ?? null);
    if (stop !== null) visited.add(stop);
  }
  expect(visited.size, `${where}「${spec.label}」Tab 要走到全部 ${total} 個控制項`).toBe(total);
}

async function focusedStop(table: Locator): Promise<Stop | null> {
  return table.evaluate((tableEl) => {
    const active = document.activeElement;
    if (active === null || !tableEl.contains(active)) return null;
    const row = active.closest('[role="row"][aria-labelledby]');
    if (row === null) return null;
    const ref = row.querySelector(':scope > [role="cell"]')!;
    const a = active.getBoundingClientRect();
    const s = ref.getBoundingClientRect();
    return {
      row: document.getElementById(row.getAttribute("aria-labelledby")!)?.textContent ?? "",
      control: active.getAttribute("aria-label") ?? active.getAttribute("role") ?? active.tagName,
      overlap: Math.max(0, Math.min(a.right, s.right) - Math.max(a.left, s.left)),
    };
  });
}

async function tabStops(page: Page, table: Locator, max: number, stopAfter: (stop: Stop) => boolean): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press("Tab");
    const stop = await focusedStop(table);
    if (stop === null) break;
    stops.push(stop);
    if (stopAfter(stop)) break;
  }
  return stops;
}

async function expectUsersTabUncovered(page: Page, width: number): Promise<void> {
  await boxOf(page, T.users).evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  const table = tableOf(page, T.users);
  await table.locator(':scope > [role="row"][aria-labelledby]').first().getByRole("switch").focus();
  const stops = await tabStops(page, table, 40, () => false);
  expect(new Set(stops.map((stop) => stop.row)).size, `${width}「Users」Tab 要走過至少兩列`).toBeGreaterThanOrEqual(2);
  for (const stop of stops) {
    expect(stop.overlap, `${width}「Users」Tab 到列「${stop.row}」的「${stop.control}」與 sticky 主欄水平重疊`).toBeLessThanOrEqual(0.5);
  }
}

/**
 * AI actions table scrolled to the far right; press Tab repeatedly from the scroll box to the custom action's row (4 buttons)
 * "Move up" - the leftmost button of the whole actions column (built-in rows have only 3 buttons placed to the right; the
 * first actions cell is used only by the custom row; at the far right the left half of this cell is under the sticky name
 * column while the button is still entirely inside the scroll box, and browsers do not scroll on focus, so it appears only
 * through the focus-scroll compensation of the SettingsTable scroll box). The first row's Move up is natively disabled at the
 * list boundary and Tab skips it, so the first stop is the first row's Move down.
 * Measure the horizontal overlap with the sticky primary column at every stop.
 */
async function expectActionsTabUncovered(page: Page, width: number): Promise<void> {
  const box = boxOf(page, T.actions);
  await box.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect(box, `${width}「Actions」捲動框溢出時要可聚焦`).toHaveAttribute("tabindex", "0");
  const table = tableOf(page, T.actions);
  // Precondition of the end point: the custom row's first actions button is Move up, and it is the leftmost button of the whole actions column (its left edge = the minimum of every row's first button's left edge).
  const target = await table.evaluate((tableEl, ownName) => {
    const firsts = Array.from(tableEl.querySelectorAll(':scope > [role="row"][aria-labelledby]')).map((row) => {
      const cells = row.querySelectorAll(':scope > [role="cell"]');
      const first = cells[cells.length - 2]?.querySelector("button") ?? null;
      return {
        row: document.getElementById(row.getAttribute("aria-labelledby")!)?.textContent ?? "",
        control: first?.getAttribute("aria-label") ?? "",
        left: first === null ? Number.POSITIVE_INFINITY : first.getBoundingClientRect().left,
      };
    });
    const own = firsts.find((item) => item.row === ownName);
    return { control: own?.control ?? null, left: own?.left ?? null, minLeft: Math.min(...firsts.map((item) => item.left)) };
  }, N.action);
  expect(target.control, `${width}「Actions」自建列「${N.action}」操作欄的第一顆要是 Move up`).toMatch(/^Move up/);
  expect(target.left! - target.minLeft, `${width}「Actions」自建列的 Move up 要是操作欄最左的鈕`).toBeLessThanOrEqual(0.5);
  await box.focus();
  const firstRow = await table
    .locator(':scope > [role="row"][aria-labelledby]')
    .first()
    .evaluate((row) => document.getElementById(row.getAttribute("aria-labelledby")!)?.textContent ?? "");
  const stops = await tabStops(page, table, 40, (stop) => stop.row === N.action && stop.control === target.control);
  expect(stops[0]?.row, `${width}「Actions」從捲動框按 Tab 的第一站在第一列`).toBe(firstRow);
  expect(
    stops.some((stop) => stop.row === N.action && stop.control === target.control),
    `${width}「Actions」要走到自建列「${N.action}」最左的「Move up」`,
  ).toBe(true);
  for (const stop of stops) {
    expect(stop.overlap, `${width}「Actions」Tab 到列「${stop.row}」的「${stop.control}」與 sticky 主欄水平重疊`).toBeLessThanOrEqual(0.5);
  }
}

test("26 settings tables geometry guard", async ({ browser }) => {
  test.setTimeout(300_000);
  const created: Created = { providers: [], actions: [], authProviders: [], plans: [], groups: [], tokens: [], invites: [] };
  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ssoContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const adminPage = await adminContext.newPage();
  const ssoPage = await ssoContext.newPage();
  try {
    let groupAId = "";
    await test.step("seed data (admin API + a user from SSO first login)", async () => {
      await loginAs(adminPage, ADMIN.email, ADMIN.password);
      await expect(adminPage).toHaveURL(/\/$/);
      await signInSsoUser(ssoPage);
      groupAId = await seed(adminPage, ssoPage, created);
    });

    const adminPages: PanelPage[] = [
      {
        path: "/admin/ai",
        tables: [
          { spec: T.providers, own: [N.providerA, N.providerB, N.modelA1, N.modelA2, N.modelB1] },
          { spec: T.actions, own: [N.action] },
        ],
      },
      { path: "/admin/login", tables: [{ spec: T.authProviders, own: [N.idpA, N.idpB] }] },
      {
        path: "/admin/users",
        tables: [
          { spec: T.users, own: [SHORT_EMAIL, LONG_EMAIL, SSO_EMAIL] },
          { spec: T.invites, own: [N.inviteShort, N.inviteLong] },
        ],
      },
      { path: "/admin/groups", tables: [{ spec: T.adminGroups, own: [N.groupA, N.groupB] }] },
      { path: "/admin/storage", tables: [{ spec: T.plans, own: [N.planA, N.planB] }] },
      { path: `/groups/${groupAId}`, tables: [{ spec: T.members, own: [ADMIN.email, SHORT_EMAIL, LONG_EMAIL, SSO_EMAIL] }] },
    ];
    const ssoPages: PanelPage[] = [
      { path: "/settings/authorization", tables: [{ spec: T.tokens, own: [N.tokenPlain, N.tokenLabeled] }] },
      { path: "/settings/login", tables: [{ spec: T.signInMethods, own: ["SSO"] }] },
      { path: "/settings/groups", tables: [{ spec: T.myGroups, own: [N.groupA, N.groupB] }] },
    ];

    await test.step("1280x800: top-level table alignment, models sub-table, AI agents page across tables, content area has no horizontal scroll", async () => {
      for (const [page, pages] of [
        [adminPage, adminPages],
        [ssoPage, ssoPages],
      ] as const) {
        for (const { path, tables } of pages) {
          await openPanel(page, path, tables.map((table) => table.spec));
          await expectNoPanelHScroll(page, `1280 ${path}`);
          const geometries: TableGeometry[] = [];
          for (const { spec, own } of tables) {
            await expectOwnRows(page, spec, own);
            const geometry = await measure(tableOf(page, spec));
            checkTable(spec, geometry, `1280 ${path}`);
            geometries.push(geometry);
          }
          if (path === "/admin/ai") {
            await checkSubTable(page, N.providerA, 2, "1280");
            await checkSubTable(page, N.providerB, 1, "1280");
            for (const spec of [T.providers, T.actions]) {
              const m = await boxOf(page, spec).evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
              expect(m.scrollWidth, `1280 AI 代理頁「${spec.label}」捲動框不得溢出（實量 scrollWidth ${m.scrollWidth}、clientWidth ${m.clientWidth}）`).toBeLessThanOrEqual(
                m.clientWidth,
              );
            }
            const centers = geometries.flatMap((geometry) => geometry.rows.map((row) => row.cells[row.cells.length - 1]!.switchCenter!));
            expect(Math.max(...centers) - Math.min(...centers), "1280 AI 代理頁：供應商表與動作表的開關中心").toBeLessThanOrEqual(1);
            const actionButtonCounts = new Set(geometries[1]!.rows.map((row) => row.cells[3]!.buttonCount));
            expect(actionButtonCounts.size, "1280「Actions」要同時有內建（3 鈕）與自建（4 鈕）的列").toBeGreaterThanOrEqual(2);
          }
          if (path === "/settings/authorization") {
            const labeled = tableOf(page, T.tokens).getByRole("row", { name: N.tokenLabeled, exact: true });
            await expect(labeled.getByText(CUSTOM_LABEL, { exact: true }), "「API tokens」要有一支自訂 label 的 token").toHaveCount(1);
            const plain = tableOf(page, T.tokens).getByRole("row", { name: N.tokenPlain, exact: true });
            await expect(plain.getByText(CUSTOM_LABEL, { exact: true }), "另一支是派生 label").toHaveCount(0);
          }
        }
      }
    });

    await test.step("1024x768: content area has no horizontal scroll, must overflow, sticky, occlusion, Tab", async () => {
      await adminPage.setViewportSize({ width: 1024, height: 768 });
      await ssoPage.setViewportSize({ width: 1024, height: 768 });
      for (const [page, pages] of [
        [adminPage, adminPages],
        [ssoPage, ssoPages],
      ] as const) {
        for (const { path, tables } of pages) {
          await openPanel(page, path, tables.map((table) => table.spec));
          await expectNoPanelHScroll(page, `1024 ${path}`);
          if (path === "/admin/users") await expectOverflowing(page, T.users, "1024");
          const checked = await expectStickyAfterScrollRight(page, `1024 ${path}`);
          if (path === "/admin/users") {
            expect(checked, "1024 sticky 檢查要涵蓋「Users」").toContain(T.users.label);
            await expectNotCovered(page, T.users, "1024");
            await expectUsersTabUncovered(page, 1024);
          }
          if (path === "/admin/ai") {
            await expectOverflowing(page, T.providers, "1024");
            expect(checked, "1024 sticky 檢查要涵蓋「Providers」").toContain(T.providers.label);
            await expectNotCovered(page, T.providers, "1024");
            if (checked.includes(T.actions.label)) await expectActionsTabUncovered(page, 1024);
          }
        }
      }
    });

    await test.step("390x844: every table is a card: no horizontal scroll, no sticky, every row's actions inside the viewport, Tab reaches every control", async () => {
      await adminPage.setViewportSize({ width: 390, height: 844 });
      await ssoPage.setViewportSize({ width: 390, height: 844 });
      for (const [page, pages] of [
        [adminPage, adminPages],
        [ssoPage, ssoPages],
      ] as const) {
        for (const { path, tables } of pages) {
          await openPanel(page, path, tables.map((table) => table.spec));
          await expectNoPanelHScroll(page, `390 ${path}`);
          for (const { spec } of tables) await expectPhoneCards(page, spec, `390 ${path}`);
        }
      }
    });
  } finally {
    await cleanup(adminPage, ssoPage, created);
    await adminContext.close();
    await ssoContext.close();
  }
});
