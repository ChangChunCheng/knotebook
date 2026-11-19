import type { GroupDto, GroupRoleDto } from "@knotebook/shared";

/**
 * Not `` t(`groups.role.${role}`) ``: `myRole` is an object, so it would render
 * `groups.role.[object Object]`, which neither tsc nor lint catches. Built-in roles have a NULL `name`.
 */
export function roleLabel(t: (key: string) => string, role: Pick<GroupRoleDto, "builtin" | "name">): string {
  if (role.builtin === "admin") return t("groups.role.admin");
  if (role.builtin === "member") return t("groups.role.member");
  return role.name ?? "";
}

export function canCreateAndEdit(group: GroupDto): boolean {
  return group.myRole?.permissions.create === true && group.myRole.permissions.edit === true;
}
