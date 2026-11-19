import { describe, expect, it } from "vitest";
import type { FolderPermissionsDto } from "@knotebook/shared";
import { folderPermissions, type FolderRoleFlags } from "../../src/folders/permissions.js";

const ME = "0b6f3a2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER = "ffffffff-1c4d-4e5f-8a9b-0c1d2e3f4a5b";
const G = "aaaaaaaa-1c4d-4e5f-8a9b-0c1d2e3f4a5b";

const flags = (f: Partial<FolderRoleFlags>): FolderRoleFlags => ({
  canRead: false,
  canCreate: false,
  canEdit: false,
  canDelete: false,
  ...f,
});

/** The five columns of the role expansion table (view / create-edit-move / delete empty / delete with notes / create notes), derived from the DTO. */
function columns(p: FolderPermissionsDto | null): [boolean, boolean, boolean, boolean, boolean] {
  if (p === null) return [false, false, false, false, false];
  return [true, p.manage, p.manage, p.manage && p.deleteNotes, p.createNote];
}

describe("group folder permissions (role expansion table; sixRoleScene flags + create-only + all false)", () => {
  const rows: Array<[string, FolderRoleFlags | null, FolderPermissionsDto | null, [boolean, boolean, boolean, boolean, boolean]]> = [
    // The built-in admin has all seven flags true; folders only look at four.
    ["admin", flags({ canRead: true, canCreate: true, canEdit: true, canDelete: true }), { manage: true, deleteNotes: true, createNote: true }, [true, true, true, true, true]],
    ["member (read, create, edit)", flags({ canRead: true, canCreate: true, canEdit: true }), { manage: true, deleteNotes: false, createNote: true }, [true, true, true, false, true]],
    ["editDelete (no can_create)", flags({ canRead: true, canEdit: true, canDelete: true }), { manage: true, deleteNotes: true, createNote: false }, [true, true, true, true, false]],
    ["deleteOnly", flags({ canRead: true, canDelete: true }), { manage: false, deleteNotes: true, createNote: false }, [true, false, false, false, false]],
    ["editOnly", flags({ canRead: true, canEdit: true }), { manage: true, deleteNotes: false, createNote: false }, [true, true, true, false, false]],
    ["readOnly", flags({ canRead: true }), { manage: false, deleteNotes: false, createNote: false }, [true, false, false, false, false]],
    ["create-only (read + create)", flags({ canRead: true, canCreate: true }), { manage: false, deleteNotes: false, createNote: false }, [true, false, false, false, false]],
    ["all false", flags({}), null, [false, false, false, false, false]],
    ["non-member (flags null)", null, null, [false, false, false, false, false]],
    ["no can_read (everything else true)", flags({ canCreate: true, canEdit: true, canDelete: true }), null, [false, false, false, false, false]],
  ];
  it.each(rows)("%s", (_label, f, dto, cols) => {
    const p = folderPermissions({ kind: "group", groupId: G }, ME, f);
    expect(p).toEqual(dto);
    expect(columns(p)).toEqual(cols);
  });
});

describe("personal/shared: only the owner matters, not flags", () => {
  const allTrue = flags({ canRead: true, canCreate: true, canEdit: true, canDelete: true });
  it("personal owner -> all true (also when flags are null/all false)", () => {
    const full = { manage: true, deleteNotes: true, createNote: true };
    expect(folderPermissions({ kind: "personal", ownerId: ME }, ME, null)).toEqual(full);
    expect(folderPermissions({ kind: "personal", ownerId: ME }, ME, flags({}))).toEqual(full);
  });
  it("personal non-owner -> null (also when flags are all true)", () => {
    expect(folderPermissions({ kind: "personal", ownerId: OTHER }, ME, allTrue)).toBeNull();
  });
  it("shared owner -> can manage and delete, cannot create notes", () => {
    expect(folderPermissions({ kind: "shared", ownerId: ME }, ME, null)).toEqual({ manage: true, deleteNotes: true, createNote: false });
  });
  it("shared non-owner -> null", () => {
    expect(folderPermissions({ kind: "shared", ownerId: OTHER }, ME, allTrue)).toBeNull();
  });
});
