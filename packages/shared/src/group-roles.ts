// Read is implicit (the server stores can_read = true); the six flags don't imply each other.
import type { GroupRolePermissions } from "./index.js";

export const GROUP_ROLE_FLAGS = [
  "create", "edit", "delete", "managePublicLink", "manageMembers", "manageGroup",
] as const satisfies ReadonlyArray<keyof GroupRolePermissions>;
export type GroupRoleFlag = (typeof GROUP_ROLE_FLAGS)[number];
export type GroupRoleFlags = Pick<GroupRolePermissions, GroupRoleFlag>;

/** Code points, the same unit as length() in DB CHECK group_roles_name_len_chk. */
export const GROUP_ROLE_NAME_MAX = 40;

/** Must match the web's groups.role.admin/member strings in every locale (apps/web/src/i18n/index.test.ts). */
export const BUILTIN_ROLE_DISPLAY_NAMES: readonly string[] = ["Admin", "Member", "管理員", "一般成員"];

/** Does not reject characters: the server's hasUnstorableChar rejects NUL and lone surrogates first. */
export function normalizeRoleName(raw: string): string {
  return raw.trim().normalize("NFC");
}

/** Expects input already passed through normalizeRoleName. */
export function isReservedRoleName(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  return BUILTIN_ROLE_DISPLAY_NAMES.some(name => name.normalize("NFC").toLowerCase() === lower);
}
