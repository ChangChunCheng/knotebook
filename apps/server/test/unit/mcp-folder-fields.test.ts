/**
 * Folders: pure functions and constants of the shared skeleton.
 * Name/path truncation, wire budget, keyset cursor, and the table mapping `FolderFailure` to MCP errors plus the English sentences.
 * The queries (`loadFolderNames`/`loadFolderPath`) are covered by the folder integration tests.
 */
import { describe, expect, it } from "vitest";
import { FOLDER_DEPTH_MAX, FOLDER_NAME_MAX, FOLDERS_PER_SPACE_MAX, type ErrorCode } from "@knotebook/shared";
import { FOLDER_ID, folderPathCost, folderRefForModel, truncateFolderPath } from "../../src/mcp/folder-fields.js";
import {
  CREATE_BUSY_MESSAGE,
  FOLDER_BUSY_MESSAGE,
  FOLDER_CONTENT_CHANGED_MESSAGE,
  FOLDER_CYCLE_MESSAGE,
  FOLDER_DELETE_BLOCKED_MESSAGE,
  FOLDER_GROUP_NOT_FOUND_MESSAGE,
  FOLDER_LIMIT_MESSAGE,
  FOLDER_MANAGE_FORBIDDEN_MESSAGE,
  FOLDER_MOVE_CROSS_SPACE_MESSAGE,
  FOLDER_NAME_CONTROL_MESSAGE,
  FOLDER_NAME_LENGTH_MESSAGE,
  FOLDER_NAME_TAKEN_MESSAGE,
  FOLDER_NAME_UNSTORABLE_MESSAGE,
  FOLDER_NEEDS_EDIT_MESSAGE,
  FOLDER_NOT_FOUND_MESSAGE,
  FOLDER_POSITION_AMBIGUOUS_MESSAGE,
  FOLDER_RATE_LIMITED_MESSAGE,
  FOLDER_TOO_DEEP_MESSAGE,
  MOVE_TO_GROUP_FOLDER_CROSS_SPACE_MESSAGE,
  NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE,
  NOTE_FILE_FORBIDDEN_MESSAGE,
  NOTE_FOLDER_CROSS_SPACE_MESSAGE,
  folderFailureToToolError,
  folderNameErrorMessage,
  type FolderTool,
} from "../../src/mcp/folder-messages.js";
import { BAD_CURSOR_MESSAGE, decodeKeysetCursor, encodeKeysetCursor, parseCursorTimestamp } from "../../src/mcp/keyset-cursor.js";
import { MCP_FOLDER_PATH_MAX } from "../../src/mcp/limits.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../../src/mcp/note-read.js";
import { LIST_BASE_COST } from "../../src/mcp/tools/list-notes.js";
import { TRASH_BASE_COST } from "../../src/mcp/tools/list-trash.js";
import { PAGE_CUT_RESERVE, countWithinWireBudget, wireCost } from "../../src/mcp/wire-budget.js";

const Q = '"';
const EMOJI = String.fromCodePoint(0x1f600);
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ID = "11111111-2222-4333-8444-555555555555";

describe("FOLDER_ID", () => {
  it("a valid UUID is lowercased; a non-UUID is a validation error", () => {
    const hexId = "abcdef01-2345-4678-89ab-cdef01234567";
    expect(FOLDER_ID.parse(hexId.toUpperCase())).toBe(hexId);
    expect(FOLDER_ID.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("name truncation (folderRefForModel)", () => {
  it("80 CJK characters are not truncated, no flag", () => {
    const name = "資".repeat(80);
    expect(folderRefForModel(ID, name)).toEqual({ id: ID, name });
  });

  it("40 double quotes are not truncated (cost exactly 80)", () => {
    const ref = folderRefForModel(ID, Q.repeat(40));
    expect(ref).toEqual({ id: ID, name: Q.repeat(40) });
  });

  it("41 double quotes are truncated to 40 + nameTruncated: true", () => {
    expect(folderRefForModel(ID, Q.repeat(41))).toEqual({ id: ID, name: Q.repeat(40), nameTruncated: true });
  });

  it("80 emoji are truncated to 40, without splitting a surrogate pair", () => {
    const ref = folderRefForModel(ID, EMOJI.repeat(80));
    expect(ref.name).toBe(EMOJI.repeat(40));
    expect(ref.nameTruncated).toBe(true);
    expect(LONE_SURROGATE.test(ref.name)).toBe(false);
  });

  it("ordinary data has only the two keys id and name", () => {
    expect(Object.keys(folderRefForModel(ID, "Projects"))).toEqual(["id", "name"]);
    expect(Object.keys(folderRefForModel(ID, Q.repeat(40)))).toEqual(["id", "name"]);
  });
});

describe("path truncation (truncateFolderPath/folderPathCost)", () => {
  it("[] -> { path: [], truncated: false }", () => {
    expect(truncateFolderPath([])).toEqual({ path: [], truncated: false });
  });

  it("six segments of 10 CJK characters each are not truncated", () => {
    const names = Array.from({ length: 6 }, () => "資".repeat(10));
    expect(truncateFolderPath(names)).toEqual({ path: names, truncated: false });
  });

  it("six segments of 80 double quotes each -> the last 4 segments are kept (each truncated to 40), truncated, cost <= 400", () => {
    const out = truncateFolderPath(Array.from({ length: 6 }, () => Q.repeat(80)));
    expect(out.path).toEqual(Array.from({ length: 4 }, () => Q.repeat(40)));
    expect(out.truncated).toBe(true);
    expect(folderPathCost(out.path)).toBeLessThanOrEqual(MCP_FOLDER_PATH_MAX);
  });

  // The previous case has six identical segments, so it can't tell which end is dropped; here each segment starts differently and the kept ones must be the 4 leaf-side segments.
  it("dropped from the root end: six segments (one number + 79 double quotes each) keep segments 3-6", () => {
    const names = [1, 2, 3, 4, 5, 6].map(i => `${i}${Q.repeat(79)}`);
    const out = truncateFolderPath(names);
    expect(out.path).toEqual([3, 4, 5, 6].map(i => `${i}${Q.repeat(39)}`));
    expect(out.truncated).toBe(true);
  });

  it("eight segments of 27 double quotes each -> 7 segments are kept", () => {
    const out = truncateFolderPath(Array.from({ length: 8 }, () => Q.repeat(27)));
    expect(out.path).toEqual(Array.from({ length: 7 }, () => Q.repeat(27)));
    expect(out.truncated).toBe(true);
    expect(folderPathCost(out.path)).toBe(398);
  });

  it("five segments of [33,40,40,40,41] double quotes -> all 5 kept, the last truncated to 40, cost exactly 400, truncated", () => {
    const out = truncateFolderPath([33, 40, 40, 40, 41].map(n => Q.repeat(n)));
    expect(out.path).toEqual([33, 40, 40, 40, 40].map(n => Q.repeat(n)));
    expect(folderPathCost(out.path)).toBe(400);
    expect(out.truncated).toBe(true);
  });

  it("a single segment of 80 emoji -> 1 segment kept (truncated to 40) + truncated", () => {
    expect(truncateFolderPath([EMOJI.repeat(80)])).toEqual({ path: [EMOJI.repeat(40)], truncated: true });
  });

  it("cost of exactly 400 is not truncated, 401 is", () => {
    const at400 = ["a".repeat(78), "b".repeat(77), "c".repeat(77), "d".repeat(77), "e".repeat(77)];
    expect(folderPathCost(at400)).toBe(400);
    expect(truncateFolderPath(at400)).toEqual({ path: at400, truncated: false });
    const at401 = ["a".repeat(78), "b".repeat(78), "c".repeat(77), "d".repeat(77), "e".repeat(77)];
    expect(folderPathCost(at401)).toBe(401);
    expect(truncateFolderPath(at401)).toEqual({ path: at401.slice(1), truncated: true });
  });

  it("folderPathCost equals JSON.stringify(array).length - 2 exactly", () => {
    expect(folderPathCost(["a", "b"])).toBe(JSON.stringify(["a", "b"]).length - 2);
    for (const names of [[], ["x"], [Q, "\\", EMOJI], ["資料", String.fromCharCode(1), "a b"]]) {
      expect(folderPathCost(names)).toBe(JSON.stringify(names).length - 2);
    }
  });
});

describe("countWithinWireBudget/wireCost", () => {
  it("costs empty returns 0", () => {
    expect(countWithinWireBudget([], 0)).toBe(0);
  });

  it("[10,10,10], base 0, budget 24 -> 2 (12 + 12)", () => {
    expect(countWithinWireBudget([10, 10, 10], 0, 24)).toBe(2);
  });

  // The previous case gives the same result whether or not 2 is added per item (12+12=24 and 10+10+10=30 both stop at 2); this one tells them apart.
  it("[10,10,10], base 0, budget 30 -> 2 (each item carries an extra 2 for the separator; without it 3 items would be accepted)", () => {
    expect(countWithinWireBudget([10, 10, 10], 0, 30)).toBe(2);
  });

  it("budget 1 -> 1 (at least 1)", () => {
    expect(countWithinWireBudget([10, 10, 10], 0, 1)).toBe(1);
  });

  it("base is counted; budget defaults to 240,000", () => {
    expect(countWithinWireBudget([10, 10], 240_000 - 24)).toBe(2);
    expect(countWithinWireBudget([10, 10], 240_000 - 23)).toBe(1);
  });

  it("wireCost equals the code from before it moved out of search-notes.ts, value for value", () => {
    const before = (v: unknown): number => {
      const j = JSON.stringify(v);
      return j.length + JSON.stringify(j).length;
    };
    for (const v of ["plain", { a: `x${Q}y`, b: "\\" }, [[1, [2, `${Q}\\`]], { c: null }]]) {
      expect(wireCost(v)).toBe(before(v));
    }
  });
});

describe("keyset cursor", () => {
  const T = "2026-10-28T01:02:03.456Z";

  it("encode -> decode round trip", () => {
    expect(decodeKeysetCursor(encodeKeysetCursor("t", [T, ID]), "t", 2)).toEqual([T, ID]);
    expect(decodeKeysetCursor(encodeKeysetCursor("f", ["group", ID, ID]), "f", 3)).toEqual(["group", ID, ID]);
  });

  // A round-trip test is insensitive to the separator (it passes even if encode and decode change together); this case pins the wire format itself.
  it("wire format: a hand-built base64url(`t|<time>|<id>`) decodes into two parts, and encode gives the identical string", () => {
    const raw = Buffer.from(`t|${T}|${ID}`, "utf8").toString("base64url");
    expect(decodeKeysetCursor(raw, "t", 2)).toEqual([T, ID]);
    expect(encodeKeysetCursor("t", [T, ID])).toBe(raw);
  });

  it("tag mismatch -> null", () => {
    expect(decodeKeysetCursor(encodeKeysetCursor("t", [T, ID]), "f", 2)).toBeNull();
  });

  it("wrong number of segments -> null", () => {
    const raw = encodeKeysetCursor("t", [T, ID]);
    expect(decodeKeysetCursor(raw, "t", 3)).toBeNull();
    expect(decodeKeysetCursor(raw, "t", 1)).toBeNull();
  });

  it("contains NUL (after the last segment) -> null", () => {
    const raw = Buffer.from(`t|${T}|${ID}${NUL}`, "utf8").toString("base64url");
    expect(decodeKeysetCursor(raw, "t", 2)).toBeNull();
  });

  it("non-base64url garbage -> null", () => {
    expect(decodeKeysetCursor("!!!not-a-cursor", "t", 2)).toBeNull();
    expect(decodeKeysetCursor("", "t", 2)).toBeNull();
    // Buffer skips characters outside the alphabet: a valid cursor with a `!` inserted would still decode, so it has to be rejected explicitly.
    const raw = encodeKeysetCursor("t", [T, ID]);
    expect(decodeKeysetCursor(`${raw.slice(0, 4)}!${raw.slice(4)}`, "t", 2)).toBeNull();
  });

  it("BAD_CURSOR_MESSAGE has the same text as the original in list_notes", () => {
    expect(BAD_CURSOR_MESSAGE).toBe("The `cursor` value is not one this server issued. Omit it to start over.");
  });
});

describe("parseCursorTimestamp", () => {
  it("the toISOString form issued by this site -> Date; out-of-range year, year 0, lenient formats, overflowing dates, non-dates, trailing NUL -> null", () => {
    const ok = "2026-10-28T01:02:03.456Z";
    expect(parseCursorTimestamp(ok)!.toISOString()).toBe(ok);
    for (const bad of [
      "+275760-09-13T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z",
      "0000-01-01T00:00:00.000Z",
      "2026",
      "2026-10-28T01:02:03Z",
      "2026-02-30T00:00:00.000Z",
      "not-a-date",
      `${ok}${NUL}`,
    ]) {
      expect(parseCursorTimestamp(bad), bad).toBeNull();
    }
  });
});

describe("fixed part of the list budget", () => {
  // Removing the placeholder cursor or PAGE_CUT_RESERVE could push the response slightly over budget (the per-item +2 upper bound absorbs most of it, so a weaker check wouldn't notice): the composition is pinned directly here.
  it("LIST_BASE_COST = empty page + 82-char cursor + reserve; not smaller than the largest empty page cost with pageCutShort", () => {
    const realCursorLen = Buffer.from(`2026-10-28T01:02:03.456Z|${ID}`, "utf8").toString("base64url").length;
    expect(realCursorLen).toBe(82);
    expect(LIST_BASE_COST).toBe(wireCost({ notes: [], nextCursor: "x".repeat(82) }) + PAGE_CUT_RESERVE);
    expect(LIST_BASE_COST).toBeGreaterThanOrEqual(wireCost({ notes: [], nextCursor: "x".repeat(82), pageCutShort: true }));
  });

  it("TRASH_BASE_COST = empty page + 84-char cursor + truncated + retentionDays 3650 + reserve; not smaller than the largest empty page cost with pageCutShort", () => {
    expect(encodeKeysetCursor("t", ["2026-10-28T01:02:03.456Z", ID])).toHaveLength(84);
    const empty = { retentionDays: 3650, items: [], truncated: true, nextCursor: "x".repeat(84) };
    expect(TRASH_BASE_COST).toBe(wireCost(empty) + PAGE_CUT_RESERVE);
    expect(TRASH_BASE_COST).toBeGreaterThanOrEqual(wireCost({ ...empty, pageCutShort: true }));
  });
});

describe("FolderFailure mapping table and English sentences", () => {
  const TOOLS: FolderTool[] = ["create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder"];
  const map = (tool: FolderTool, code: ErrorCode) => folderFailureToToolError(tool, { code }).structuredContent;

  it("literal text verbatim", () => {
    expect(FOLDER_NOT_FOUND_MESSAGE).toBe(
      "No folder with that id that you can use here. For example, it may not exist, may have been deleted, or may be someone else's or in a group whose notes your role can't read; list_folders shows the folders you can see.",
    );
    expect(FOLDER_GROUP_NOT_FOUND_MESSAGE).toBe("No group with that id among your groups where your role can read notes.");
    expect(FOLDER_MANAGE_FORBIDDEN_MESSAGE).toBe(
      "Your role in that group can't change its folders — creating, renaming, moving and deleting them needs a role that can edit notes — so nothing was changed.",
    );
    expect(FOLDER_NAME_UNSTORABLE_MESSAGE).toBe(
      "That folder name contains a character that can't be stored (a NUL or an unpaired surrogate), so nothing was changed.",
    );
    expect(FOLDER_NAME_CONTROL_MESSAGE).toBe(
      "Folder names can't contain line breaks, tabs, or other control or text-direction characters, so nothing was changed.",
    );
    expect(FOLDER_NAME_LENGTH_MESSAGE).toBe(
      `Folder names must be 1 to ${FOLDER_NAME_MAX} characters once surrounding whitespace is removed, so nothing was changed.`,
    );
    expect(FOLDER_NAME_TAKEN_MESSAGE).toBe(
      "There is already a folder with that name in that place — names that differ only in letter case can count as the same — so nothing was changed.",
    );
    expect(FOLDER_TOO_DEEP_MESSAGE).toBe(
      `That would put a folder more than ${FOLDER_DEPTH_MAX} levels deep (a top-level folder is level 1), so nothing was changed.`,
    );
    expect(FOLDER_CYCLE_MESSAGE).toBe("A folder can't be moved into itself or into one of its own subfolders, so nothing was changed.");
    expect(FOLDER_LIMIT_MESSAGE).toBe(
      `That space already has the most folders it can hold (${FOLDERS_PER_SPACE_MAX}), so the folder was not created.`,
    );
    expect(FOLDER_BUSY_MESSAGE).toBe("The server was busy, so nothing was changed. Try again in a moment.");
    expect(FOLDER_RATE_LIMITED_MESSAGE).toBe("Too many folder changes right now, so nothing was changed. Try again in a moment.");
    expect(NOTE_FILE_FORBIDDEN_MESSAGE).toBe(
      "Your access to this note doesn't allow filing it, so nothing was changed. Filing a group's notes into folders needs a role in that group that can edit notes.",
    );
    expect(FOLDER_NEEDS_EDIT_MESSAGE).toBe(
      "Your role in that group can create notes but not edit them, so it can't put a note in one of the group's folders. Leave out `folder_id` to put it at the group's top level.",
    );
    expect(NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE).toBe(
      "That folder can't hold this note: a personal folder takes a note without `group_id`, a group's folder needs that group's id as `group_id`, and your folders for notes shared with you don't hold new notes.",
    );
    expect(MOVE_TO_GROUP_FOLDER_CROSS_SPACE_MESSAGE).toBe(
      "That folder isn't one of the folders of the group you're moving the note into. Use one of that group's folders — list_folders with `group_id` shows them — or leave out `folder_id` for the group's top level.",
    );
    expect(NOTE_FOLDER_CROSS_SPACE_MESSAGE).toBe(
      "That folder isn't in this note's space. A note can only be filed among your personal folders if it is yours, its group's folders if it is a group note, or your folders for notes shared with you if someone shared it with you. Moving a personal note into a group is what move_note_to_group does; it needs the notes:move scope.",
    );
    expect(FOLDER_MOVE_CROSS_SPACE_MESSAGE).toBe(
      "A folder can only move within its own space — among your personal folders, within one group, or among your folders for notes shared with you — so nothing was changed. Pass `parent_id: null` to move it to the top level of its space.",
    );
    expect(FOLDER_DELETE_BLOCKED_MESSAGE).toBe(
      "That folder, or one inside it, holds notes your role can't move to the trash, so nothing was deleted.",
    );
    expect(FOLDER_CONTENT_CHANGED_MESSAGE).toBe("The folder's contents changed while it was being deleted, so nothing was deleted. Try again.");
    expect(FOLDER_POSITION_AMBIGUOUS_MESSAGE).toBe("Pass at most one of `parent_id`, `group_id` and `shared: true`, so nothing was created.");
    expect(CREATE_BUSY_MESSAGE).toBe("The server was busy, so no note was created. Try again in a moment.");
  });

  it("the three name causes -> `FOLDER_NAME_UNSTORABLE_MESSAGE`/`FOLDER_NAME_CONTROL_MESSAGE`/`FOLDER_NAME_LENGTH_MESSAGE`", () => {
    expect(folderNameErrorMessage("unstorable")).toBe(FOLDER_NAME_UNSTORABLE_MESSAGE);
    expect(folderNameErrorMessage("control")).toBe(FOLDER_NAME_CONTROL_MESSAGE);
    expect(folderNameErrorMessage("length")).toBe(FOLDER_NAME_LENGTH_MESSAGE);
  });

  it("folder_not_found -> not_found, identical across the five tools", () => {
    const results = TOOLS.map(t => map(t, "folder_not_found"));
    for (const r of results) expect(r).toEqual({ code: "not_found", message: FOLDER_NOT_FOUND_MESSAGE });
  });

  it("row-by-row mapping (codes that apply to every tool)", () => {
    for (const tool of TOOLS) {
      expect(map(tool, "group_not_found")).toEqual({ code: "group_not_found", message: FOLDER_GROUP_NOT_FOUND_MESSAGE });
      expect(map(tool, "folder_delete_blocked")).toEqual({ code: "forbidden", message: FOLDER_DELETE_BLOCKED_MESSAGE });
      expect(map(tool, "folder_name_taken")).toEqual({ code: "conflict", message: FOLDER_NAME_TAKEN_MESSAGE });
      expect(map(tool, "folder_too_deep")).toEqual({ code: "conflict", message: FOLDER_TOO_DEEP_MESSAGE });
      expect(map(tool, "folder_cycle")).toEqual({ code: "conflict", message: FOLDER_CYCLE_MESSAGE });
      expect(map(tool, "folder_limit")).toEqual({ code: "conflict", message: FOLDER_LIMIT_MESSAGE });
      expect(map(tool, "conflict")).toEqual({ code: "conflict", message: FOLDER_CONTENT_CHANGED_MESSAGE });
      expect(map(tool, "not_found")).toEqual({ code: "not_found", message: NOTE_NOT_FOUND_MESSAGE });
      expect(map(tool, "too_many_requests")).toEqual({ code: "too_many_requests", message: FOLDER_RATE_LIMITED_MESSAGE });
      expect(map(tool, "server_busy")).toEqual({ code: "server_busy", message: FOLDER_BUSY_MESSAGE });
    }
  });

  it("forbidden: move_note_to_folder uses `NOTE_FILE_FORBIDDEN_MESSAGE`, the rest use `FOLDER_MANAGE_FORBIDDEN_MESSAGE`", () => {
    expect(map("move_note_to_folder", "forbidden")).toEqual({ code: "forbidden", message: NOTE_FILE_FORBIDDEN_MESSAGE });
    for (const tool of TOOLS.filter(t => t !== "move_note_to_folder")) {
      expect(map(tool, "forbidden")).toEqual({ code: "forbidden", message: FOLDER_MANAGE_FORBIDDEN_MESSAGE });
    }
  });

  it("folder_cross_space: move_folder uses `FOLDER_MOVE_CROSS_SPACE_MESSAGE`, move_note_to_folder uses `NOTE_FOLDER_CROSS_SPACE_MESSAGE`, the other three throw", () => {
    expect(map("move_folder", "folder_cross_space")).toEqual({ code: "invalid_body", message: FOLDER_MOVE_CROSS_SPACE_MESSAGE });
    expect(map("move_note_to_folder", "folder_cross_space")).toEqual({ code: "invalid_body", message: NOTE_FOLDER_CROSS_SPACE_MESSAGE });
    for (const tool of ["create_folder", "rename_folder", "delete_folder"] as const) {
      expect(() => map(tool, "folder_cross_space")).toThrow();
    }
  });

  it("invalid_body (name, already pre-judged by the caller) and unlisted codes -> throw", () => {
    for (const tool of TOOLS) {
      expect(() => map(tool, "invalid_body")).toThrow();
      expect(() => map(tool, "internal")).toThrow();
      expect(() => map(tool, "in_trash")).toThrow();
    }
  });

  it("an error result keeps the mirror equality (isError, content[0].text = JSON.stringify(structuredContent))", () => {
    const r = folderFailureToToolError("delete_folder", { code: "folder_delete_blocked" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent));
  });
});
