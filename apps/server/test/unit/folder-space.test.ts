import { describe, expect, it } from "vitest";
import {
  folderSpaceLockKey,
  folderSpaceOfRow,
  newNoteFolderConsistent,
  noteFolderSpace,
  sameFolderSpace,
  sortedSpaceLockKeys,
  toFolderSpaceDto,
} from "../../src/folders/space.js";

const U = "0b6f3a2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b";
const G = "ffffffff-1c4d-4e5f-8a9b-0c1d2e3f4a5b";

describe("structure lock keys", () => {
  it("uppercase and lowercase ids give the same key", () => {
    expect(folderSpaceLockKey({ kind: "personal", ownerId: U.toUpperCase() })).toBe(
      folderSpaceLockKey({ kind: "personal", ownerId: U }),
    );
    expect(folderSpaceLockKey({ kind: "group", groupId: G.toUpperCase() })).toBe(`knotebook.folders:group:${G}`);
  });
  it("three prefixes", () => {
    expect(folderSpaceLockKey({ kind: "personal", ownerId: U })).toBe(`knotebook.folders:personal:${U}`);
    expect(folderSpaceLockKey({ kind: "shared", ownerId: U })).toBe(`knotebook.folders:shared:${U}`);
    expect(folderSpaceLockKey({ kind: "group", groupId: G })).toBe(`knotebook.folders:group:${G}`);
  });
  it("sortedSpaceLockKeys de-duplicates (including case variants) and sorts by key string", () => {
    expect(
      sortedSpaceLockKeys([
        { kind: "personal", ownerId: U },
        { kind: "group", groupId: G },
        { kind: "personal", ownerId: U.toUpperCase() },
        { kind: "group", groupId: G },
      ]),
    ).toEqual([`knotebook.folders:group:${G}`, `knotebook.folders:personal:${U}`]);
  });
});

describe("space of rows and notes", () => {
  it("folderSpaceOfRow, three kinds", () => {
    expect(folderSpaceOfRow({ kind: "personal", ownerId: U, groupId: null })).toEqual({ kind: "personal", ownerId: U });
    expect(folderSpaceOfRow({ kind: "shared", ownerId: U, groupId: null })).toEqual({ kind: "shared", ownerId: U });
    expect(folderSpaceOfRow({ kind: "group", ownerId: null, groupId: G })).toEqual({ kind: "group", groupId: G });
  });
  it("folderSpaceOfRow inconsistent -> throws", () => {
    expect(() => folderSpaceOfRow({ kind: "group", ownerId: null, groupId: null })).toThrow();
    expect(() => folderSpaceOfRow({ kind: "group", ownerId: U, groupId: G })).toThrow();
    expect(() => folderSpaceOfRow({ kind: "personal", ownerId: null, groupId: null })).toThrow();
    expect(() => folderSpaceOfRow({ kind: "personal", ownerId: U, groupId: G })).toThrow();
    expect(() => folderSpaceOfRow({ kind: "other", ownerId: U, groupId: null })).toThrow();
  });
  it("noteFolderSpace: personal note -> personal, group note -> group", () => {
    expect(noteFolderSpace({ ownerId: U, groupId: null })).toEqual({ kind: "personal", ownerId: U });
    expect(noteFolderSpace({ ownerId: null, groupId: G })).toEqual({ kind: "group", groupId: G });
    expect(() => noteFolderSpace({ ownerId: null, groupId: null })).toThrow();
  });
  it("sameFolderSpace", () => {
    expect(sameFolderSpace({ kind: "personal", ownerId: U }, { kind: "personal", ownerId: U.toUpperCase() })).toBe(true);
    expect(sameFolderSpace({ kind: "personal", ownerId: U }, { kind: "shared", ownerId: U })).toBe(false);
    expect(sameFolderSpace({ kind: "personal", ownerId: U }, { kind: "personal", ownerId: G })).toBe(false);
    expect(sameFolderSpace({ kind: "group", groupId: G }, { kind: "group", groupId: G })).toBe(true);
    expect(sameFolderSpace({ kind: "group", groupId: G }, { kind: "group", groupId: U })).toBe(false);
  });
  it("newNoteFolderConsistent: a group folder needs the same groupId (case-insensitive); a personal folder carries no groupId; shared never works", () => {
    expect(newNoteFolderConsistent({ kind: "group", groupId: G }, G)).toBe(true);
    expect(newNoteFolderConsistent({ kind: "group", groupId: G }, G.toUpperCase())).toBe(true);
    expect(newNoteFolderConsistent({ kind: "group", groupId: G }, U)).toBe(false);
    expect(newNoteFolderConsistent({ kind: "group", groupId: G }, undefined)).toBe(false);
    expect(newNoteFolderConsistent({ kind: "personal", ownerId: U }, undefined)).toBe(true);
    expect(newNoteFolderConsistent({ kind: "personal", ownerId: U }, G)).toBe(false);
    expect(newNoteFolderConsistent({ kind: "shared", ownerId: U }, undefined)).toBe(false);
    expect(newNoteFolderConsistent({ kind: "shared", ownerId: U }, G)).toBe(false);
  });
  it("toFolderSpaceDto does not output ownerId", () => {
    expect(toFolderSpaceDto({ kind: "personal", ownerId: U })).toEqual({ kind: "personal" });
    expect(toFolderSpaceDto({ kind: "shared", ownerId: U })).toEqual({ kind: "shared" });
    expect(toFolderSpaceDto({ kind: "group", groupId: G })).toEqual({ kind: "group", groupId: G });
  });
});
