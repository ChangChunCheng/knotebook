import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NoteDto, TrashItemDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { EDITOR_PERMS, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import {
  canRestoreAfterTrash,
  DAY_MS,
  remainingLabel,
  selectedTrashIds,
  splitTrashSections,
  trashDetailLine,
  trashItemTitle,
  trashResultMessage,
} from "./trash-display";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const HOUR = 3_600_000;
const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);
const iso = (ms: number) => new Date(ms).toISOString();
const SHORT = { dateStyle: "short", timeStyle: "short" } as const;

function item(over: Partial<TrashItemDto> & { id: string }): TrashItemDto {
  return {
    title: `T-${over.id}`,
    deletedAt: iso(NOW - 2 * DAY_MS),
    purgeAt: iso(NOW + 3 * DAY_MS),
    deletedBy: { handle: "tester", displayName: "Tester" },
    group: null,
    ...over,
  };
}

const GROUP = { id: "g1", name: "R&D" };
const AMY = { handle: "amy", displayName: "Amy" };

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("remainingLabel", () => {
  const at = (ms: number) => remainingLabel(iso(NOW + ms), NOW, t);

  it("TD1 ceil、最小 1；null → null", () => {
    expect(at(3.5 * DAY_MS)).toBe("4 days left");
    expect(at(DAY_MS)).toBe("1 day left");
    expect(at(DAY_MS + 1)).toBe("2 days left");
    expect(at(23 * HOUR)).toBe("1 day left");
    expect(at(-2 * HOUR)).toBe("1 day left");
    expect(at(7 * DAY_MS - 60_000)).toBe("7 days left");
    expect(remainingLabel(null, NOW, t)).toBeNull();
  });

  it("TD1 zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(at(3.5 * DAY_MS)).toBe("剩 4 天");
  });
});

describe("trashDetailLine", () => {
  const line = (i: TrashItemDto, locale = "en") => trashDetailLine(i, { now: NOW, t, locale });
  const deletedDate = new Date(NOW - 2 * DAY_MS).toLocaleDateString("en");

  it("TD2 個人：只有時間段；NULL 保留天數 → 刪除日期", () => {
    expect(line(item({ id: "p" }))).toBe("3 days left");
    expect(line(item({ id: "p", purgeAt: null }))).toBe(`Deleted ${deletedDate}`);
  });

  it("TD2 工作坊：群組名 · 刪除者 · 剩餘", () => {
    expect(line(item({ id: "w", group: GROUP, deletedBy: AMY }))).toBe("R&D · Deleted by Amy · 3 days left");
  });

  it("TD2 工作坊：刪除者帳號已刪", () => {
    expect(line(item({ id: "w", group: GROUP, deletedBy: null }))).toBe("R&D · Deleted by a deleted account · 3 days left");
  });

  it("TD2 工作坊＋NULL 保留天數：時間段只放日期", () => {
    expect(line(item({ id: "w", group: GROUP, deletedBy: AMY, purgeAt: null }))).toBe(`R&D · Deleted by Amy · ${deletedDate}`);
  });

  it("TD2 zh-TW 工作坊", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(line(item({ id: "w", group: GROUP, deletedBy: AMY }), "zh-TW")).toBe("R&D · Amy 刪除 · 剩 3 天");
  });
});

describe("trashItemTitle", () => {
  it("TD3 有 purgeAt：兩個時間；NULL：只有移入時間", () => {
    const i = item({ id: "a" });
    const deletedAt = new Date(i.deletedAt).toLocaleString("en", SHORT);
    const purgeAt = new Date(i.purgeAt!).toLocaleString("en", SHORT);
    const withPurge = trashItemTitle(i, { t, locale: "en" });
    expect(withPurge).toContain(deletedAt);
    expect(withPurge).toContain(purgeAt);
    const noPurge = trashItemTitle({ ...i, purgeAt: null }, { t, locale: "en" });
    expect(noPurge).toContain(deletedAt);
    expect(noPurge).not.toContain(purgeAt);
    expect(noPurge).not.toContain("to be permanently deleted");
  });
});

describe("splitTrashSections", () => {
  it("TD4 個人在前、各區保留輸入順序；不改輸入陣列", () => {
    const w1 = item({ id: "w1", group: GROUP });
    const p1 = item({ id: "p1" });
    const w2 = item({ id: "w2", group: GROUP });
    const p2 = item({ id: "p2" });
    const input = [w1, p1, w2, p2];
    const sections = splitTrashSections(input);
    expect(sections.personal).toEqual([p1, p2]);
    expect(sections.workspace).toEqual([w1, w2]);
    expect(sections.order).toEqual(["note:p1", "note:p2", "note:w1", "note:w2"]);
    expect(input).toEqual([w1, p1, w2, p2]);
  });
});

describe("selectedTrashIds", () => {
  it("TD7 照清單順序（個人在前）、略過不在清單的鍵", () => {
    const w1 = item({ id: "w1", group: GROUP });
    const p1 = item({ id: "p1" });
    const p2 = item({ id: "p2" });
    // 勾選順序 w1 → p2 → p1，外加一個清單上沒有的鍵（重抓後消失）。
    const keys = new Set(["note:w1", "note:gone", "note:p2", "note:p1"]);
    expect(selectedTrashIds([w1, p1, p2], keys)).toEqual(["p1", "p2", "w1"]);
    expect(selectedTrashIds([w1, p1, p2], new Set(["note:gone"]))).toEqual([]);
  });
});

describe("canRestoreAfterTrash", () => {
  const groupNote = (permissions: NoteDto["permissions"]): Pick<NoteDto, "group" | "permissions"> => ({ group: GROUP, permissions });

  it("TD5 個人恆可；群組要 edit 且 delete", () => {
    expect(canRestoreAfterTrash({ group: null, permissions: VIEWER_PERMS })).toBe(true);
    expect(canRestoreAfterTrash(groupNote(OWNER_PERMS))).toBe(true);
    expect(canRestoreAfterTrash(groupNote({ ...VIEWER_PERMS, delete: true }))).toBe(false);
    expect(canRestoreAfterTrash(groupNote({ ...EDITOR_PERMS, delete: false }))).toBe(false);
  });
});

describe("trashResultMessage", () => {
  it("TD6 en：skipped 為 0 不加後綴", () => {
    expect(trashResultMessage("restore", 2, 0, t)).toBe("Restored 2 notes");
    expect(trashResultMessage("restore", 1, 1, t)).toBe("Restored 1 note, 1 no longer in the trash");
    expect(trashResultMessage("purge", 3, 0, t)).toBe("Permanently deleted 3 notes");
  });

  it("TD6 zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(trashResultMessage("restore", 1, 2, t)).toBe("已還原 1 篇，2 篇已不在垃圾桶");
  });
});
