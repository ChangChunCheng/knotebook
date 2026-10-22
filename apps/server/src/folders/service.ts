/**
 * 資料夾的服務層（spec docs/superpowers/specs/2026-10-22-folders-design.md §5.5、§5.7、§5.11）：REST 與 PR-3d 的 MCP 共用的唯一入口。
 * 每支的形一律是「名稱 → 交易外快速判（§5.5 I2 入口順序）→ 扣 `edit` 桶 → 縫 → 交易（`folders/tx/*`，S14：callback 整段一個
 * `xInTx`）→ catch 映射」。失敗一律回 HTTP 對應的錯誤形（REST 直接送；MCP 之後以 code 映射）。HTTP 層訊息中文（附錄 C）。
 * 含 `.transaction(` ⇒ 在 S14 的 `ROUTE_FILES`（④ 計數）。
 */
import type { ErrorCode, FolderDto, FolderSpaceDto } from "@knotebook/shared";
import type { CollabHooks } from "../collab/hooks.js";
import type { Db } from "../db/index.js";
import { isFolderSpaceViolation, isRetryableTxError, uniqueViolationConstraint } from "../db/pg-errors.js";
import { GROUP_NOT_FOUND_MESSAGE } from "../groups/queries.js";
import type { GroupHookCtx, GroupTestHook } from "../groups/test-hook.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { TxAbort } from "../http/tx-abort.js";
import { loadCreateTarget } from "../notes/create-target.js";
import { UUID_RE } from "../notes/service.js";
import { normalizeFolderName, type FolderNameResult } from "./names.js";
import { folderPermissions } from "./permissions.js";
import { listVisibleFolders, resolveFolderAccess, toFolderDto } from "./queries.js";
import type { FolderSpace } from "./space.js";
import {
  createFolderInTx,
  FOLDER_FORBIDDEN_MESSAGE,
  FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE,
  FOLDER_NOT_FOUND_MESSAGE,
  type CreateFolderInput,
} from "./tx/create-folder.js";

const NAME_MESSAGES: Record<Extract<FolderNameResult, { ok: false }>["reason"], string> = {
  unstorable: "資料夾名稱含有無法儲存的字元",
  control: "名稱不能包含換行或控制字元",
  length: "資料夾名稱須為 1 到 80 個字",
};
const FOLDER_NAME_TAKEN_MESSAGE = "這裡已經有同名資料夾";
const TOO_MANY_REQUESTS_MESSAGE = "寫入過於頻繁";
const SERVER_BUSY_MESSAGE = "伺服器忙碌，請稍後再試";

export interface FolderServiceDeps {
  db: Db;
  collabHooks: CollabHooks;
  storageLockTimeoutMs: number;
  groupTestHook?: GroupTestHook;
  limiters: { edit: FixedWindowLimiter };
}

/** 一律回 HTTP 對應的錯誤形（REST 直接送，PR-3d 的 MCP 以 code 映射）。 */
export interface FolderFailure { kind: "error"; status: 400 | 403 | 404 | 409 | 429; code: ErrorCode; message: string }

const fail = (status: FolderFailure["status"], code: ErrorCode, message: string): FolderFailure => ({ kind: "error", status, code, message });

export async function listFolders(db: Db, userId: string): Promise<FolderDto[]> {
  return listVisibleFolders(db, userId);
}

/**
 * 建立（§5.7.1）。id（`parent.folderId`、`space.groupId`）由呼叫端轉小寫；這裡只驗 UUID 形。
 * 順序（§5.5 I2）：名稱 → 位置的可見性（404）→ 管理權（403）→ 扣 `edit` 桶 → `folder-authorized` 縫 → 交易（重判全部）。
 */
export async function createFolder(
  deps: FolderServiceDeps,
  input: { by: string; name: string; parent: { folderId: string } | { space: FolderSpaceDto } },
): Promise<{ kind: "ok"; folder: FolderDto } | FolderFailure> {
  const name = normalizeFolderName(input.name);
  if (!name.ok) return fail(400, "invalid_body", NAME_MESSAGES[name.reason]);

  let target: CreateFolderInput["target"];
  let hookCtx: GroupHookCtx;
  if ("folderId" in input.parent) {
    const folderId = input.parent.folderId;
    const access = await resolveFolderAccess(deps.db, input.by, folderId);
    if (access === null) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (!access.permissions.manage) return fail(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);
    target = { kind: "parent", folderId, space: access.space };
    hookCtx = { folderId, ...(access.space.kind === "group" ? { groupId: access.space.groupId } : {}) };
  } else {
    const requested = input.parent.space;
    let space: FolderSpace;
    if (requested.kind === "group") {
      // 非 UUID／不存在／非成員／角色無閱讀 → 同一個 404（S4 同形，m1）。
      if (!UUID_RE.test(requested.groupId)) return fail(404, "group_not_found", GROUP_NOT_FOUND_MESSAGE);
      space = { kind: "group", groupId: requested.groupId };
      const m = await loadCreateTarget(deps.db, input.by, requested.groupId);
      // 與交易內同一個推導（folderPermissions）：null＝看不到、!manage＝角色不能編輯。
      const perms = m === undefined ? null : folderPermissions(space, input.by, m);
      if (perms === null) return fail(404, "group_not_found", GROUP_NOT_FOUND_MESSAGE);
      if (!perms.manage) return fail(403, "forbidden", FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE);
    } else {
      space = { kind: requested.kind, ownerId: input.by };
    }
    target = { kind: "root", space };
    hookCtx = space.kind === "group" ? { groupId: space.groupId } : {};
  }

  if (!deps.limiters.edit.consume(input.by)) return fail(429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
  await deps.groupTestHook?.("folder-authorized", hookCtx);

  const txInput: CreateFolderInput = { by: input.by, name: name.name, lockTimeoutMs: deps.storageLockTimeoutMs, target };
  let out: Awaited<ReturnType<typeof createFolderInTx>>;
  try {
    out = await deps.db.transaction(tx => createFolderInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    if (err instanceof TxAbort) return fail(err.status as FolderFailure["status"], err.errCode, err.message);
    if (uniqueViolationConstraint(err) === "folders_sibling_name_idx") return fail(409, "folder_name_taken", FOLDER_NAME_TAKEN_MESSAGE);
    if (isRetryableTxError(err)) return fail(409, "server_busy", SERVER_BUSY_MESSAGE);
    // 防禦縱深：父子空間 trigger（KF002）只在預讀之後空間被改時才可能觸發，與看不到同形。
    if (isFolderSpaceViolation(err)) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    throw err;
  }
  return { kind: "ok", folder: toFolderDto(out.row, out.permissions) };
}
