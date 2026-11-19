import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { baseLabel, baseLabelOrDeleted, currentSubtitle, shortVersionId, versionLabel, versionName } from "./version-labels";

const ID = "3F2A9C1E-7b4d-4e8a-9c21-5d6e7f8a9b0c";
const en = i18n.getFixedT("en");
const zh = i18n.getFixedT("zh-TW");

describe("version labels (#272)", () => {
  it("shortVersionId: the first 7 characters of the uuid, lowercase", () => {
    expect(shortVersionId(ID)).toBe("3f2a9c1");
  });

  it("versionLabel: with a name -> 'name (short id)' (same for auto and manual); without a name -> a name derived from the uuid", () => {
    expect(versionLabel({ id: ID, name: "定稿" })).toBe("定稿 (3f2a9c1)");
    expect(versionLabel({ id: ID, name: null })).toBe("plucky-finch (3f2a9c1)");
    expect(versionName({ id: ID, name: null })).toBe("plucky-finch");
    expect(versionName({ id: ID, name: "定稿" })).toBe("定稿");
  });

  it("baseLabel, three states: not deleted -> the label; deleted with an id -> derived name + short id + (deleted) (not the original name); deleted before the upgrade (id null) -> a deleted version", () => {
    expect(baseLabel(en, { id: ID, name: "定稿", deleted: false })).toBe("定稿 (3f2a9c1)");
    expect(baseLabel(en, { id: ID, name: "定稿", deleted: true })).toBe("plucky-finch (3f2a9c1) (deleted)");
    expect(baseLabel(en, { id: null, name: null, deleted: true })).toBe("a deleted version");
    expect(baseLabel(zh, { id: ID, name: null, deleted: true })).toBe("plucky-finch (3f2a9c1)（已刪除）");
  });

  it("currentSubtitle: no base / based on (no changes, with changes) / base deleted", () => {
    expect(currentSubtitle(en, { baseSeq: null, base: null, dirty: true, nextSeq: 1, autoEnabled: true })).toBe("No base version");
    expect(currentSubtitle(en, { baseSeq: 3, base: { id: ID, name: null, deleted: false }, dirty: false, nextSeq: 4, autoEnabled: true })).toBe("Based on plucky-finch (3f2a9c1) · no changes");
    expect(currentSubtitle(zh, { baseSeq: 3, base: { id: ID, name: "定稿", deleted: true }, dirty: true, nextSeq: 4, autoEnabled: true })).toBe("沿自 plucky-finch (3f2a9c1)（已刪除） · 有未儲存的修改");
  });

  it("baseLabelOrDeleted: baseSeq present but no base (DTO drift) -> treated as a deleted version, never left blank (shared by the current state and the row's second line)", () => {
    expect(baseLabelOrDeleted(en, null)).toBe("a deleted version");
    expect(baseLabelOrDeleted(en, { id: ID, name: null, deleted: false })).toBe("plucky-finch (3f2a9c1)");
    expect(currentSubtitle(en, { baseSeq: 3, base: null, dirty: false, nextSeq: 4, autoEnabled: true })).toBe("Based on a deleted version · no changes");
  });
});
