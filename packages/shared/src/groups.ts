import type { AvatarRef } from "./avatar.js";

export interface GroupRolePermissions {
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  managePublicLink: boolean;
  manageMembers: boolean;
  manageGroup: boolean;
}

export type BuiltinGroupRole = "admin" | "member";

export interface GroupRoleDto {
  id: string;
  builtin: BuiltinGroupRole | null;
  /** null for built-in roles (DB group_roles_name_chk). */
  name: string | null;
  permissions: GroupRolePermissions;
  memberCount: number;
}

/** `myRole` is null only for a non-member site admin (only in the PATCH /api/groups/:id response). Web must use the `canManage*` flags, which include site admins. */
export interface GroupDto {
  id: string;
  name: string;
  myRole: GroupRoleDto | null;
  canManageMembers: boolean;
  canManageGroup: boolean;
  createdAt: string;
  autoVersions: boolean;
}

/** `transferTo` must hold the built-in admin role. */
export type DeleteGroupBody = { mode: "transfer"; transferTo: string } | { mode: "delete" };

export interface GroupMemberDto {
  userId: string;
  email: string;
  displayName: string;
  roleId: string;
  builtin: BuiltinGroupRole | null;
  avatar: AvatarRef | null;
}

export interface NoteGroupDto {
  id: string;
  name: string;
}
