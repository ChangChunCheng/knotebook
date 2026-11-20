import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, editorLocator, loginAs, reEscape } from "./helpers.js";

/** The block outer (`.bn-block-outer`) whose text is exactly `text`. */
function blockOuter(page: Page, text: string): Locator {
  const root = editorLocator(page);
  return root
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${reEscape(text)}$`) }) })
    .last();
}

async function blockIdOf(page: Page, text: string): Promise<string> {
  const id = await blockOuter(page, text).getAttribute("data-id");
  expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  return id!;
}

/** The highlight overlay sits outside the editable and covers the block; it must outlive ProseMirror redraws. */
async function expectAnchorFlash(page: Page, blockId: string): Promise<void> {
  const overlay = page.locator(`.kn-anchor-flash[data-anchor-flash="${blockId}"]`);
  await expect(overlay).toBeAttached({ timeout: 15_000 });
  const geo = await overlay.evaluate((el, id) => {
    const block = document.querySelector(`.bn-block-outer[data-id="${id}"]`)!.getBoundingClientRect();
    const o = el.getBoundingClientRect();
    return {
      dTop: Math.abs(o.top - block.top),
      dLeft: Math.abs(o.left - block.left),
      dWidth: Math.abs(o.width - block.width),
      dHeight: Math.abs(o.height - block.height),
      inEditable: el.closest('[contenteditable="true"], .ProseMirror') !== null,
    };
  }, blockId);
  expect(geo.inEditable).toBe(false);
  for (const d of [geo.dTop, geo.dLeft, geo.dWidth, geo.dHeight]) expect(d).toBeLessThanOrEqual(1);
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function callTool(anon: APIRequestContext, origin: string, pat: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await anon.post(`${origin}/api/mcp`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.status(), await res.text()).toBe(200);
  const rpc = (await res.json()) as { result?: ToolResult };
  expect(rpc.result, JSON.stringify(rpc)).toBeDefined();
  expect(rpc.result!.isError, JSON.stringify(rpc)).not.toBe(true);
  return rpc.result!;
}

interface OutlineEntry {
  sectionId: string;
  heading: string;
}

test("64-1 block link: after edit_note replace_section rewrites another sentence of the section, the open tab keeps the block's id and #b-<id> still scrolls to and highlights it (#551)", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // Cookie-less context: the PAT is the only credential the MCP requests carry.
  const anon = await browser.newContext();
  let patId: string | undefined;
  const page = await context.newPage();
  try {
    await loginAs(page, ADMIN.email, ADMIN.password);
    const origin = new URL(page.url()).origin;
    const created = await page.request.post("/api/auth/tokens", {
      data: { name: `e2e-551-${randomBytes(4).toString("hex")}`, scope: "notes:read notes:write", expiresInDays: 30 },
    });
    expect(created.status(), await created.text()).toBe(201);
    const token = (await created.json()) as { id: string; token: string };
    patId = token.id;
    const pat = token.token;

    const paras = Array.from({ length: 30 }, (_, i) => `para ${i + 1}`);
    const note = await page.request.post("/api/notes", {
      data: { title: `E2E 551 ${Date.now()}-${randomBytes(3).toString("hex")}`, content: `# Intro\n\nintro\n\n# Target\n\n${paras.join("\n\n")}\n` },
    });
    expect(note.status(), await note.text()).toBe(201);
    const dto = (await note.json()) as { id: string; slug: string; ownerHandle: string };
    const noteUrl = `/n/${dto.ownerHandle}/${dto.slug}`;

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(noteUrl);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    await expect(blockOuter(page, "para 25")).toBeVisible({ timeout: 15_000 });
    const targetId = await blockIdOf(page, "para 25");

    const outline = await callTool(anon.request, origin, pat, "read_note_outline", { note_id: dto.id });
    const sections = outline.structuredContent!.sections as OutlineEntry[];
    const target = sections.find((s) => s.heading === "Target");
    expect(target, JSON.stringify(sections)).toBeDefined();

    const section = (await callTool(anon.request, origin, pat, "read_note_section", { note_id: dto.id, section_id: target!.sectionId })).structuredContent as {
      section: { markdown: string; fingerprint?: string };
      truncated: boolean;
    };
    expect(section.truncated).toBe(false);
    expect(section.section.fingerprint).toBeTruthy();
    expect(section.section.markdown).toMatch(/^para 3$/m);

    const edited = await callTool(anon.request, origin, pat, "edit_note", {
      note_id: dto.id,
      op: "replace_section",
      section_id: target!.sectionId,
      markdown: section.section.markdown.replace(/^para 3$/m, "para 3 rewritten"),
      if_match: section.section.fingerprint,
    });
    const after = (edited.structuredContent!.outline as { sections: OutlineEntry[] }).sections;
    expect(after.find((s) => s.heading === "Target")?.sectionId).toBe(target!.sectionId);

    // The open tab receives the rewrite through the live doc; its UniqueID runs on that update and must leave the kept id alone.
    await expect(editorLocator(page).getByText("para 3 rewritten", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(blockOuter(page, "para 25")).toHaveAttribute("data-id", targetId);

    const fresh = await context.newPage();
    const freshErrors: string[] = [];
    fresh.on("pageerror", (e) => freshErrors.push(e.message));
    await fresh.goto(`${noteUrl}#b-${targetId}`);
    await expect(fresh.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    await expectAnchorFlash(fresh, targetId);
    const landed = fresh.locator(`.bn-block-outer[data-id="${targetId}"]`);
    await expect(landed).toBeInViewport();
    await expect(landed).toHaveText("para 25");
    expect(freshErrors).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    try {
      if (patId) await page.request.delete(`/api/auth/tokens/${patId}`);
    } finally {
      await anon.close();
      await context.close();
    }
  }
});
