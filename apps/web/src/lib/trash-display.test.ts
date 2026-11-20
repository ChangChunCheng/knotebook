import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  trashLocationLine,
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
    folderPath: [],
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

  it("ceil, minimum 1; null -> null", () => {
    expect(at(3.5 * DAY_MS)).toBe("4 days left");
    expect(at(DAY_MS)).toBe("1 day left");
    expect(at(DAY_MS + 1)).toBe("2 days left");
    expect(at(23 * HOUR)).toBe("1 day left");
    expect(at(-2 * HOUR)).toBe("1 day left");
    expect(at(7 * DAY_MS - 60_000)).toBe("7 days left");
    expect(remainingLabel(null, NOW, t)).toBeNull();
  });

  it("zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(at(3.5 * DAY_MS)).toBe("剩 4 天");
  });
});

describe("trashDetailLine", () => {
  const line = (i: TrashItemDto, locale = "en") => trashDetailLine(i, { now: NOW, t, locale });
  const deletedDate = new Date(NOW - 2 * DAY_MS).toLocaleDateString("en");

  it("personal: time span only; NULL retention days -> deletion date", () => {
    expect(line(item({ id: "p" }))).toBe("3 days left");
    expect(line(item({ id: "p", purgeAt: null }))).toBe(`Deleted ${deletedDate}`);
  });

  it("group: group name, deleter and remaining time joined by a middle dot", () => {
    expect(line(item({ id: "w", group: GROUP, deletedBy: AMY }))).toBe("R&D · Deleted by Amy · 3 days left");
  });

  it("group: the deleter's account was deleted", () => {
    expect(line(item({ id: "w", group: GROUP, deletedBy: null }))).toBe("R&D · Deleted by a deleted account · 3 days left");
  });

  it("group + NULL retention days: the time span holds only the date", () => {
    expect(line(item({ id: "w", group: GROUP, deletedBy: AMY, purgeAt: null }))).toBe(`R&D · Deleted by Amy · ${deletedDate}`);
  });

  it("zh-TW group", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(line(item({ id: "w", group: GROUP, deletedBy: AMY }), "zh-TW")).toBe("R&D · Amy 刪除 · 剩 3 天");
  });
});

describe("trashDetailLine x folder path", () => {
  const line = (i: TrashItemDto, locale = "en") => trashDetailLine(i, { now: NOW, t, locale });
  const RD = { id: "g2", name: "研發組" };

  it("personal [A, B], 3 days left -> folder path then days left (no 'My notes' prefix)", () => {
    expect(line(item({ id: "p", folderPath: ["A", "B"] }))).toBe("A › B · 3 days left");
  });

  it("group with one folder: en is composed from existing keys; zh puts group name, folder path, deleter and remaining time on one line", async () => {
    const w = item({ id: "w", group: RD, deletedBy: AMY, folderPath: ["團隊週報"] });
    expect(line(w)).toBe("研發組 › 團隊週報 · Deleted by Amy · 3 days left");
    await i18n.changeLanguage("zh-TW");
    expect(line(w, "zh-TW")).toBe("研發組 › 團隊週報 · Amy 刪除 · 剩 3 天");
  });
});

describe("trashLocationLine (title of the second line: gives the full path when it is too long)", () => {
  it("personal [A, B] -> path A to B (no 'My notes' prefix, no time span)", () => {
    expect(trashLocationLine(item({ id: "p", folderPath: ["A", "B"] }))).toBe("A › B");
  });

  it("group with one folder -> group name then folder path", () => {
    expect(trashLocationLine(item({ id: "w", group: { id: "g2", name: "研發組" }, deletedBy: AMY, folderPath: ["團隊週報"] }))).toBe("研發組 › 團隊週報");
  });

  it("personal root -> empty string; group root -> group name", () => {
    expect(trashLocationLine(item({ id: "r" }))).toBe("");
    expect(trashLocationLine(item({ id: "g", group: GROUP }))).toBe("R&D");
  });
});

describe("trashItemTitle", () => {
  it("with purgeAt: two times; NULL: only the moved-in time", () => {
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

describe("date formatter cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Each case uses a locale no other case used: the cache is module-level, so a locale already used is not built again.
  it("per locale, each format builds Intl.DateTimeFormat once; the deletion date is not formatted when remaining days has a value; output equals toLocale*", () => {
    const ctor = vi.spyOn(Intl, "DateTimeFormat");
    const items = [item({ id: "a" }), item({ id: "b", deletedAt: iso(NOW - 5 * DAY_MS) }), item({ id: "c", group: GROUP })];

    for (const i of items) trashDetailLine(i, { now: NOW, t, locale: "fr-CA" });
    expect(ctor).not.toHaveBeenCalled();

    const titles = items.map((i) => trashItemTitle(i, { t, locale: "fr-CA" }));
    const lines = items.map((i) => trashDetailLine({ ...i, purgeAt: null }, { now: NOW, t, locale: "fr-CA" }));
    expect(ctor).toHaveBeenCalledTimes(2);
    items.forEach((i, n) => {
      expect(titles[n]).toContain(new Date(i.deletedAt).toLocaleString("fr-CA", SHORT));
      expect(titles[n]).toContain(new Date(i.purgeAt!).toLocaleString("fr-CA", SHORT));
      expect(lines[n]).toContain(new Date(i.deletedAt).toLocaleDateString("fr-CA"));
    });

    trashItemTitle(items[0]!, { t, locale: "de-CH" });
    expect(ctor).toHaveBeenCalledTimes(3);
  });
});

describe("splitTrashSections", () => {
  it("personal first, each section keeps input order; the input array is not modified", () => {
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
  it("follows list order (personal first), skips keys not in the list", () => {
    const w1 = item({ id: "w1", group: GROUP });
    const p1 = item({ id: "p1" });
    const p2 = item({ id: "p2" });
    // Checked in the order w1, p2, p1, plus a key that is not in the list (it disappeared after a refetch).
    const keys = new Set(["note:w1", "note:gone", "note:p2", "note:p1"]);
    expect(selectedTrashIds([w1, p1, p2], keys)).toEqual(["p1", "p2", "w1"]);
    expect(selectedTrashIds([w1, p1, p2], new Set(["note:gone"]))).toEqual([]);
  });
});

describe("canRestoreAfterTrash", () => {
  const groupNote = (permissions: NoteDto["permissions"]): Pick<NoteDto, "group" | "permissions"> => ({ group: GROUP, permissions });

  it("personal is always allowed; a group needs edit and delete", () => {
    expect(canRestoreAfterTrash({ group: null, permissions: VIEWER_PERMS })).toBe(true);
    expect(canRestoreAfterTrash(groupNote(OWNER_PERMS))).toBe(true);
    expect(canRestoreAfterTrash(groupNote({ ...VIEWER_PERMS, delete: true }))).toBe(false);
    expect(canRestoreAfterTrash(groupNote({ ...EDITOR_PERMS, delete: false }))).toBe(false);
  });
});

describe("trashResultMessage", () => {
  it("en: no suffix when skipped is 0", () => {
    expect(trashResultMessage("restore", 2, 0, t)).toBe("Restored 2 notes");
    expect(trashResultMessage("restore", 1, 1, t)).toBe("Restored 1 note, 1 no longer in the trash");
    expect(trashResultMessage("purge", 3, 0, t)).toBe("Permanently deleted 3 notes");
  });

  it("zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(trashResultMessage("restore", 1, 2, t)).toBe("已還原 1 篇，2 篇已不在垃圾桶");
  });
});
