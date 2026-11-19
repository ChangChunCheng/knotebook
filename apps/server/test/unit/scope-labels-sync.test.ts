/** #239: UI names quoted inside model-facing strings equal the labels (web's management.en.json); names quoted in help text equal the labels. Since #181 the zh-TW labels and quotes are pinned here too. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COPY_NEEDS_MOVE_MESSAGE } from "../../src/mcp/tools/copy-note.js";
import { MOVE_NEEDS_MOVE_MESSAGE } from "../../src/mcp/tools/move-note-to-group.js";
import { DELETE_SCOPE_MESSAGE, INSUFFICIENT_SCOPE_MESSAGE } from "../../src/mcp/write-scope.js";
import { mcpInstructions } from "../../src/mcp/server-info.js";

type Messages = { settings: { account: Record<string, string>; authorization: { mcp: Record<string, string> } } };
// settings.account.* and settings.authorization.* live in web's lazy string bundles (management.*.json), not the main file.
const load = (file: string) =>
  JSON.parse(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../../web/src/i18n/${file}`), "utf8")
  ) as Messages;
const en = load("management.en.json");
const zh = load("management.zh-TW.json");
const EDIT = en.settings.account.apiTokensScopeEdit!;
const MOVE = en.settings.account.apiTokensScopeMove!;
const DELETE = en.settings.account.apiTokensScopeDelete!;
const ZH_EDIT = zh.settings.account.apiTokensScopeEdit!;
const ZH_MOVE = zh.settings.account.apiTokensScopeMove!;
const ZH_DELETE = zh.settings.account.apiTokensScopeDelete!;

describe("#239: label literals and quoted names", () => {
  it("label literals", () => {
    expect(EDIT).toBe("Create and edit notes");
    expect(MOVE).toBe("Move to groups (can't be undone)");
    expect(DELETE).toBe("Move to trash (can be restored)");
  });
  it("names quoted in model-facing strings match the labels verbatim", () => {
    expect(COPY_NEEDS_MOVE_MESSAGE).toContain(`turn on "${MOVE}" (notes:move)`);
    expect(MOVE_NEEDS_MOVE_MESSAGE).toContain(`turn on "${MOVE}" (notes:move)`);
    expect(DELETE_SCOPE_MESSAGE).toContain(`turn on "${DELETE}" (notes:delete)`);
    expect(INSUFFICIENT_SCOPE_MESSAGE).toContain(`"${EDIT}"`);
    expect(mcpInstructions(false, false)).toContain(`"${EDIT}"`);
    expect(mcpInstructions(false, true)).toContain(`"${EDIT}"`);
  });
  it("names quoted in help text match the labels verbatim", () => {
    expect(en.settings.account.apiTokensScopeMoveHint).toContain(`"${EDIT}"`);
    expect(en.settings.account.apiTokensDescription).toContain(`"${EDIT}"`);
    expect(en.settings.account.apiTokensDescription).toContain(`"${MOVE}"`);
    expect(en.settings.account.apiTokensDescription).toContain(`also needs "${DELETE}"`);
  });
  // The delete help mirrors the move help and ends with the same "needs Edit ticked too" sentence (the sentence itself is unchanged; the template appends it).
  it("move and delete help both end with the same \"needs Edit ticked too\" sentence", () => {
    const tail = `Requires "${EDIT}".`;
    expect(en.settings.account.apiTokensScopeMoveHint!.endsWith(` ${tail}`)).toBe(true);
    expect(en.settings.account.apiTokensScopeDeleteHintRequiresEdit).toBe(`{{hint}} ${tail}`);
  });
});

describe("#181 zh-TW labels and quotes", () => {
  it("zh label literals match the quotes in the help sentences", () => {
    expect(ZH_MOVE).toBe("移到群組（無法復原）");
    expect(ZH_DELETE).toBe("移到垃圾桶（可還原）");
    for (const l of [ZH_EDIT, ZH_MOVE, ZH_DELETE]) expect(zh.settings.account.apiTokensDescription).toContain(`「${l}」`);
    expect(zh.settings.account.apiTokensScopeMoveHint).toContain(`「${ZH_EDIT}」`);
  });
  it("zh move and delete help both end with the same \"needs Edit ticked too\" sentence", () => {
    const tail = `需同時勾選「${ZH_EDIT}」。`;
    expect(zh.settings.account.apiTokensScopeMoveHint!.endsWith(`。${tail}`)).toBe(true);
    expect(zh.settings.account.apiTokensScopeDeleteHintRequiresEdit).toBe(`{{hint}}${tail}`);
  });
});

// The delete-permission help must not read as "no permanent data loss": notes left in the trash can still be permanently deleted later
// (site setting, or a person on the web). Both locales pin the new sentence and pin that the old closing sentence is gone.
describe("#181 delete-permission help: notes in the trash can still be permanently deleted", () => {
  it("toggle help", () => {
    expect(en.settings.account.apiTokensScopeDeleteHint).toBe(
      "Can't delete notes permanently, but notes left in the trash can still be deleted permanently later, by the site's trash setting or by someone in the web app."
    );
    expect(zh.settings.account.apiTokensScopeDeleteHint).toBe(
      "不能永久刪除筆記；但留在垃圾桶的筆記之後仍可能被永久刪除（依站台的垃圾桶設定，或有人在網頁上刪除）。"
    );
  });
  // Also pins that "once the retention period has passed they will be deleted" no longer appears: it is false when the site never auto-empties (retention days NULL).
  it("permission summary in the connection guide", () => {
    expect(en.settings.authorization.mcp.scopes).toContain(
      "no tool here deletes a note permanently, but a note left in the trash can still be deleted permanently later, by the site's trash setting or by someone in the web app."
    );
    expect(en.settings.authorization.mcp.scopes).not.toContain("nothing here deletes a note permanently");
    expect(en.settings.authorization.mcp.scopes).not.toContain("once the site's trash period passes");
    expect(zh.settings.authorization.mcp.scopes).toContain(
      "這裡沒有工具會永久刪除筆記，但留在垃圾桶的筆記之後仍可能被永久刪除——依站台的垃圾桶設定，或有人在網頁上刪除）"
    );
    expect(zh.settings.authorization.mcp.scopes).not.toContain("這裡沒有任何工具會永久刪除筆記）");
    expect(zh.settings.authorization.mcp.scopes).not.toContain("過了站台的保留期會被永久刪除");
  });
});
