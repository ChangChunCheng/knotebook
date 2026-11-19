import type { GroupDto, GroupRoleDto, NotePermissions } from "@knotebook/shared";

/**
 * Shared shapes of the web test fixtures. `NoteDto.permissions` and
 * `GroupDto.myRole` (an object) are fields added / reshaped in #175; copying them by hand per file is error-prone, so they live here.
 *
 * The permissions shapes correspond to the server's `notes/service.ts` triple (owner / per-person-shared editor / viewer);
 * a group note's permissions are derived from the group role flags, so tests expand and override whatever combination they need.
 */
export const OWNER_PERMS: NotePermissions = {
  read: true,
  edit: true,
  delete: true,
  manageShares: true,
  managePublicLink: true,
  changeSlug: true,
  moveToGroup: true,
};

export const EDITOR_PERMS: NotePermissions = {
  read: true,
  edit: true,
  delete: false,
  manageShares: false,
  managePublicLink: false,
  changeSlug: false,
  moveToGroup: false,
};

export const VIEWER_PERMS: NotePermissions = { ...EDITOR_PERMS, edit: false };

export function adminRole(overrides: Partial<GroupRoleDto> = {}): GroupRoleDto {
  return {
    id: "r-admin",
    builtin: "admin",
    name: null,
    permissions: {
      read: true,
      create: true,
      edit: true,
      delete: true,
      managePublicLink: true,
      manageMembers: true,
      manageGroup: true,
    },
    memberCount: 1,
    ...overrides,
  };
}

/** Read / create / edit true, the rest false: same shape as the built-in role seeded by migration 0012. */
export function memberRole(overrides: Partial<GroupRoleDto> = {}): GroupRoleDto {
  return {
    id: "r-member",
    builtin: "member",
    name: null,
    permissions: {
      read: true,
      create: true,
      edit: true,
      delete: false,
      managePublicLink: false,
      manageMembers: false,
      manageGroup: false,
    },
    memberCount: 1,
    ...overrides,
  };
}

/**
 * Builds a `GroupDto` from a role: the two `canManage*` take the role flags (the OR for a non-member site admin isn't simulated here - override to test that shape).
 */
export function groupDto(base: { id: string; name: string; createdAt?: string }, role: GroupRoleDto | null): GroupDto {
  return {
    id: base.id,
    name: base.name,
    myRole: role,
    canManageMembers: role?.permissions.manageMembers ?? false,
    canManageGroup: role?.permissions.manageGroup ?? false,
    createdAt: base.createdAt ?? "2026-09-01T00:00:00.000Z",
    autoVersions: true,
  };
}

export function customRole(overrides: Partial<GroupRoleDto> = {}): GroupRoleDto {
  return {
    id: "r-custom",
    builtin: null,
    name: "Reader",
    permissions: {
      read: true,
      create: false,
      edit: false,
      delete: false,
      managePublicLink: false,
      manageMembers: false,
      manageGroup: false,
    },
    memberCount: 0,
    ...overrides,
  };
}
