import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Migration chain guard (pure file checks, no DB, so it lives in unit). When several parallel PRs each run `drizzle-kit generate`, a later-merged PR
// that keeps the old files generated on its own branch breaks silently: an older journal `when` makes the migrator skip it; a forked snapshot chain
// makes the next generate compute the wrong diff.

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const ZERO_ID = "00000000-0000-0000-0000-000000000000";

type JournalEntry = { idx: number; when: number; tag: string };
type Snapshot = { id: string; prevId: string };
type Reserved = { idx: number; tag: string; when: number };

/**
 * Numbers deliberately skipped across branches: none are reserved at present (0035 of feat/trash and 0034_folders of feat/folders have merged); the mechanism stays for the next cross-branch skip.
 * Only numbers registered here may be skipped; the `when` values on both sides of a skipped number must bracket the registered `when` (so the journal stays monotonic after merging); once a registered number appears in the journal (= merged) the check goes red and asks to delete the entry.
 * The drizzle migrator looks only at `when`, not idx (drizzle-orm@0.44.7 migrator.js and pg-core/dialect.js).
 */
const RESERVED: ReadonlyArray<Reserved> = [];

const pad = (idx: number) => String(idx).padStart(4, "0");

/** Returns all violation messages (an empty array = passes); a pure function, mutation checks and negative cases feed it modified copies. */
function checkMigrationChain(
  input: {
    entries: JournalEntry[];
    sqlFiles: string[]; // file names in drizzle/*.sql
    snapshotFiles: string[]; // file names in drizzle/meta/*_snapshot.json
    snapshots: Record<string, Snapshot>; // file name -> content
  },
  reserved: ReadonlyArray<Reserved> = RESERVED,
): string[] {
  const errors: string[] = [];
  const { entries, sqlFiles, snapshotFiles, snapshots } = input;

  // 0. reserved numbers: already in the journal -> merged, the exception must be deleted; not yet there -> the `when` values on both sides must bracket the registered `when`
  const present = new Set(entries.map(e => e.idx));
  for (const r of reserved) {
    if (present.has(r.idx)) {
      const tag = entries.find(e => e.idx === r.idx)!.tag;
      errors.push(`保留號 ${pad(r.idx)} 已在 journal（tag ${tag}），合流完成請刪掉 RESERVED 的這一筆`);
    }
    const before = entries.filter(e => e.idx < r.idx).at(-1);
    const after = entries.find(e => e.idx > r.idx);
    if ((before && !(before.when < r.when)) || (after && !(r.when < after.when)))
      errors.push(`when 夾不住保留號 ${pad(r.idx)}：${before?.tag}(${before?.when}) < ${r.when} < ${after?.tag}(${after?.when}) 不成立`);
  }

  // 1. idx is consecutive from 0 (only unseen reserved numbers may be skipped); every entry has a .sql and a snapshot, and no file is left unlisted in the journal
  const skip = new Set(reserved.map(r => r.idx).filter(idx => !present.has(idx)));
  let want = 0;
  entries.forEach((e, i) => {
    while (skip.has(want)) want++;
    if (e.idx !== want) errors.push(`idx 不連號：第 ${i} 筆的 idx 是 ${e.idx}（應為 ${want}）`);
    want++;
  });
  // the tag prefix must equal the zero-padded idx (catches a half renumbering that changed only idx or only the file name)
  for (const e of entries) {
    const prefix = `${String(e.idx).padStart(4, "0")}_`;
    if (!e.tag.startsWith(prefix)) errors.push(`tag ${e.tag} 不是以 ${prefix} 開頭（idx ${e.idx}）`);
  }
  const wantSql = new Set(entries.map(e => `${e.tag}.sql`));
  const wantSnap = new Set(entries.map(e => `${String(e.idx).padStart(4, "0")}_snapshot.json`));
  for (const f of wantSql) if (!sqlFiles.includes(f)) errors.push(`journal 有 ${f} 但檔案不存在`);
  for (const f of wantSnap) if (!snapshotFiles.includes(f)) errors.push(`journal 有對應的 ${f} 但檔案不存在`);
  for (const f of sqlFiles) if (!wantSql.has(f)) errors.push(`多餘的 ${f}（journal 沒列）`);
  for (const f of snapshotFiles) if (!wantSnap.has(f)) errors.push(`多餘的 ${f}（journal 沒列）`);

  // 2. `when` strictly increases. The drizzle migrator only applies migrations with `lastDbMigration.created_at < migration.folderMillis`
  //    (drizzle-orm@0.44.7 pg-core/dialect.js), so a migration whose `when` is not greater than the previous one is skipped silently.
  for (let i = 1; i < entries.length; i++) {
    if (!(entries[i]!.when > entries[i - 1]!.when))
      errors.push(`when 未嚴格遞增：${entries[i - 1]!.tag}(${entries[i - 1]!.when}) → ${entries[i]!.tag}(${entries[i]!.when})`);
  }

  // 3. snapshot chain: the 0th prevId is an all-zero UUID, each later prevId equals the previous id
  entries.forEach((e, i) => {
    const name = `${String(e.idx).padStart(4, "0")}_snapshot.json`;
    const cur = snapshots[name];
    if (!cur) return; // a missing file was already reported in 1.
    const expected = i === 0 ? ZERO_ID : snapshots[`${String(entries[i - 1]!.idx).padStart(4, "0")}_snapshot.json`]?.id;
    if (cur.prevId !== expected) errors.push(`${name} 的 prevId(${cur.prevId}) 不等於 ${i === 0 ? "全零 UUID" : "前一支的 id"}(${expected})`);
  });

  return errors;
}

function loadReal() {
  const meta = path.join(drizzleDir, "meta");
  const journal = JSON.parse(readFileSync(path.join(meta, "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  const sqlFiles = readdirSync(drizzleDir).filter(f => f.endsWith(".sql"));
  const snapshotFiles = readdirSync(meta).filter(f => f.endsWith("_snapshot.json"));
  const snapshots = Object.fromEntries(
    snapshotFiles.map(f => [f, JSON.parse(readFileSync(path.join(meta, f), "utf8")) as Snapshot]),
  );
  return { entries: journal.entries, sqlFiles, snapshotFiles, snapshots };
}

describe("migration chain guard", () => {
  it("the real drizzle/ directory passes all checks", () => {
    const real = loadReal();
    expect(real.entries.length).toBeGreaterThan(0);
    expect(checkMigrationChain(real)).toEqual([]);
  });

  // Inject violations into a deep copy of the real data to prove each of the three kinds of check goes red (the real files are untouched).
  const mutated = (mutate: (c: ReturnType<typeof loadReal>) => void) => {
    const c = structuredClone(loadReal());
    mutate(c);
    return checkMigrationChain(c);
  };

  // The reserved-number mechanism is tested with a small synthetic journal (0000 -> 0001 -> [0002 reserved] -> 0003), always passing reserved explicitly and
  // not depending on the real directory or the current RESERVED value: after merging, deleting the RESERVED entry keeps everything green, and a permanent skip (feat/trash landing in main first) is tested too.
  describe("reserved numbers (synthetic fixture: 0002 reserved)", () => {
    const R2: Reserved = { idx: 2, tag: "0002_c", when: 3000 };
    const fixture = () => {
      const entries: JournalEntry[] = [
        { idx: 0, tag: "0000_a", when: 1000 },
        { idx: 1, tag: "0001_b", when: 2000 },
        { idx: 3, tag: "0003_d", when: 4000 },
      ];
      const ids = ["a0000000-0000-4000-8000-000000000000", "b0000000-0000-4000-8000-000000000000", "d0000000-0000-4000-8000-000000000000"];
      const snapshots: Record<string, Snapshot> = {
        "0000_snapshot.json": { id: ids[0]!, prevId: ZERO_ID },
        "0001_snapshot.json": { id: ids[1]!, prevId: ids[0]! },
        "0003_snapshot.json": { id: ids[2]!, prevId: ids[1]! },
      };
      return {
        entries,
        sqlFiles: entries.map(e => `${e.tag}.sql`),
        snapshotFiles: Object.keys(snapshots),
        snapshots,
      };
    };
    const check = (mutate: (c: ReturnType<typeof fixture>) => void, reserved: ReadonlyArray<Reserved> = [R2]) => {
      const c = fixture();
      mutate(c);
      return checkMigrationChain(c, reserved);
    };

    it("skipping a registered number with `when` bracketing on both sides -> passes", () => {
      expect(check(() => {})).toEqual([]);
    });

    it("reserved is an empty array -> idx not consecutive (proves the exception really takes effect)", () => {
      expect(check(() => {}, [])).toEqual([expect.stringContaining("idx 不連號")]);
    });

    it("skipping an unregistered number -> idx not consecutive", () => {
      expect(
        check(c => {
          c.entries[2] = { idx: 4, tag: "0004_d", when: 4000 };
          c.sqlFiles[2] = "0004_d.sql";
          c.snapshotFiles[2] = "0004_snapshot.json";
          c.snapshots["0004_snapshot.json"] = c.snapshots["0003_snapshot.json"]!;
          delete c.snapshots["0003_snapshot.json"];
        }),
      ).toEqual([expect.stringContaining("idx 不連號")]);
    });

    it("a reserved number already in the journal (= merged) -> only reports 'delete this RESERVED entry'", () => {
      const errors = check(c => {
        c.entries.splice(2, 0, { idx: 2, tag: "0002_c", when: 3000 });
        c.sqlFiles.push("0002_c.sql");
        c.snapshotFiles.push("0002_snapshot.json");
        c.snapshots["0002_snapshot.json"] = { id: "c0000000-0000-4000-8000-000000000000", prevId: c.snapshots["0001_snapshot.json"]!.id };
        c.snapshots["0003_snapshot.json"]!.prevId = "c0000000-0000-4000-8000-000000000000";
      });
      expect(errors).toEqual([expect.stringContaining("保留號 0002 已在 journal")]);
    });

    it("the next entry's when equals the registered when -> not bracketed (equal doesn't bracket either)", () => {
      expect(check(c => { c.entries[2]!.when = 3000; })).toEqual([expect.stringContaining("when 夾不住保留號 0002")]);
    });

    it("the registered when equals the previous entry's when -> not bracketed (the previous side is checked too)", () => {
      expect(check(() => {}, [{ ...R2, when: 2000 }])).toEqual([expect.stringContaining("when 夾不住保留號 0002")]);
    });
  });

  it("a missing idx, a missing .sql, a missing snapshot and an extra file are all caught", () => {
    expect(mutated(c => { c.entries[3]!.idx = 7; })).toEqual(expect.arrayContaining([expect.stringContaining("idx 不連號")]));
    expect(mutated(c => { c.sqlFiles.pop(); })).toEqual(expect.arrayContaining([expect.stringContaining("檔案不存在")]));
    expect(mutated(c => { c.snapshotFiles.pop(); })).toEqual(expect.arrayContaining([expect.stringContaining("檔案不存在")]));
    expect(mutated(c => { c.sqlFiles.push("9999_x.sql"); })).toEqual(expect.arrayContaining([expect.stringContaining("多餘的")]));
    expect(mutated(c => { c.snapshotFiles.push("9999_snapshot.json"); })).toEqual(expect.arrayContaining([expect.stringContaining("多餘的")]));
  });

  it("a tag prefix that doesn't match idx (half renumbering) is caught", () => {
    expect(mutated(c => { c.entries[15]!.tag = "0014_b"; })).toEqual(expect.arrayContaining([expect.stringContaining("不是以 0015_ 開頭")]));
  });

  it("an equal or backwards when is caught", () => {
    expect(mutated(c => { c.entries[5]!.when = c.entries[4]!.when; })).toEqual(expect.arrayContaining([expect.stringContaining("when 未嚴格遞增")]));
    expect(mutated(c => { c.entries[5]!.when = c.entries[4]!.when - 1; })).toEqual(expect.arrayContaining([expect.stringContaining("when 未嚴格遞增")]));
  });

  it("a forked snapshot chain and a 0th prevId that is not all zeros are caught", () => {
    expect(mutated(c => { c.snapshots["0007_snapshot.json"]!.prevId = "11111111-1111-1111-1111-111111111111"; })).toEqual(
      expect.arrayContaining([expect.stringContaining("0007_snapshot.json 的 prevId")]),
    );
    expect(mutated(c => { c.snapshots["0000_snapshot.json"]!.prevId = "11111111-1111-1111-1111-111111111111"; })).toEqual(
      expect.arrayContaining([expect.stringContaining("全零 UUID")]),
    );
  });
});
