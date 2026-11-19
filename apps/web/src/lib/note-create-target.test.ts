import { describe, expect, it } from "vitest";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import { adminRole, customRole, groupDto, memberRole, OWNER_PERMS } from "@/test/fixtures";
import { folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { indexFolders } from "@/components/sidebar/folder-index";
import { createTargetFor } from "./note-create-target";

function note(over: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Plan",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "plan",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "alice",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
    ...over,
  };
}

function groupNote(groupId: string, over: Partial<NoteDto> = {}): NoteDto {
  return note({ ownerId: null, ownerHandle: null, role: "editor", groupId, group: { id: groupId, name: "Team" }, ...over });
}

function ctx(groups: GroupDto[], folders: FolderDto[]) {
  return { groups, folders: indexFolders(folders) };
}

describe("createTargetFor", () => {
  const team = groupDto({ id: "g1", name: "Team" }, memberRole());
  const viewerGroup = groupDto({ id: "g2", name: "Readers" }, customRole());
  const createOnly = groupDto({ id: "g3", name: "Drop box" }, customRole({ permissions: { ...customRole().permissions, create: true } }));

  it("personal, root: empty target (created at the personal root)", () => {
    expect(createTargetFor(note(), ctx([], []))).toEqual({});
  });

  it("personal, in a folder: carries folderId", () => {
    const folders = [folderDto({ id: "f1", name: "Projects" })];
    expect(createTargetFor(note({ folderId: "f1" }), ctx([], folders))).toEqual({ folderId: "f1" });
  });

  it("personal, folder missing from the index (just deleted, list not refetched yet): not shown, does not fall back to the root", () => {
    expect(createTargetFor(note({ folderId: "gone" }), ctx([], []))).toBeNull();
  });

  it("personal, folder with createNote false: not shown", () => {
    const folders = [folderDto({ id: "f1", name: "Projects", permissions: { manage: true, deleteNotes: true, createNote: false } })];
    expect(createTargetFor(note({ folderId: "f1" }), ctx([], folders))).toBeNull();
  });

  it("group root: member (can create and edit) -> carries groupId", () => {
    expect(createTargetFor(groupNote("g1"), ctx([team], []))).toEqual({ groupId: "g1" });
  });

  it("group root: admin -> carries groupId", () => {
    const admin = groupDto({ id: "g1", name: "Team" }, adminRole());
    expect(createTargetFor(groupNote("g1"), ctx([admin], []))).toEqual({ groupId: "g1" });
  });

  it("group root: viewer role -> null", () => {
    expect(createTargetFor(groupNote("g2", { permissions: { ...OWNER_PERMS, edit: false } }), ctx([viewerGroup], []))).toBeNull();
  });

  it("group root: custom role that can create but not edit -> null (same rule as the sidebar group '+')", () => {
    expect(createTargetFor(groupNote("g3"), ctx([createOnly], []))).toBeNull();
  });

  it("group, in a folder: carries groupId and folderId", () => {
    const folders = [groupFolder({ id: "gf1", name: "Specs", groupId: "g1" })];
    expect(createTargetFor(groupNote("g1", { folderId: "gf1" }), ctx([team], folders))).toEqual({ groupId: "g1", folderId: "gf1" });
  });

  it("group, folder createNote false or missing from the index: null", () => {
    const folders = [groupFolder({ id: "gf1", name: "Specs", groupId: "g1", create: false })];
    expect(createTargetFor(groupNote("g1", { folderId: "gf1" }), ctx([team], folders))).toBeNull();
    expect(createTargetFor(groupNote("g1", { folderId: "gone" }), ctx([team], []))).toBeNull();
  });

  it("group not in groups (just left, list not refetched yet): null", () => {
    expect(createTargetFor(groupNote("g1"), ctx([], []))).toBeNull();
  });

  it("shared with me, root: null", () => {
    expect(createTargetFor(note({ role: "editor", ownerId: "u2", ownerHandle: "bob" }), ctx([], []))).toBeNull();
  });

  it("shared with me, in my folder: still null", () => {
    const folders = [sharedFolder({ id: "sf1", name: "From others" })];
    expect(createTargetFor(note({ role: "viewer", ownerId: "u2", ownerHandle: "bob", folderId: "sf1" }), ctx([], folders))).toBeNull();
  });
});
