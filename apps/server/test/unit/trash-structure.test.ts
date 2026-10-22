/**
 * #181 垃圾桶結構守衛（spec §6.2-10、A2-14）。逐行掃 `src/` 下所有 `.ts`（不含測試），`trim()` 後以 `//`、`*`、`/*` 開頭的
 * 註解行跳過，每行以 `matchAll` 計數。
 *
 * 守衛一：直接查 `notes` 表的位置（不分大小寫：`.from(notes)`、`(inner|left|right|full)?join(notes`、`.update(notes)`、
 * `.delete(notes)`、SQL 字面 `from notes`／`join notes`／`update notes`、`${notes}`），以「檔案 → 各處置的處數」登記，
 * 逐檔命中數與表上總和不同就紅；新檔沒登記、登記了但沒命中也紅。
 * 守衛二（AG6）：寫 `deleted_at` 的字面（`deletedAt:`、`deletedBy:`、`deleted_at\s*=`、`set deleted_at`）只准出現在
 * schema、`trashNotesInTx`／`restoreNotesInTx` 所在檔、垃圾桶清單查詢（含 DTO 映射）三檔，各登記處數。
 *
 * 選處數不選行內標記：行內標記要訂「命中前後幾行內要有標記」的視窗規則，查詢跨行、標記被格式化工具移位都會誤判；
 * 處數表是純計數，沒有視窗、沒有放置規則，任何處數變動都會讓這張表出現在 diff 裡，審查者一定看得到。
 * 代價：表只記處數，不記哪一處屬於哪一類。
 *
 * ⚠ 不宣稱（誠實）：
 *   - 同一檔裡「刪一處、加一處」處數不變時抓不到。
 *   - 逐處分類是否正確——靠審查與 spec §6.2-12 的測試，不靠守衛。
 *   - 以 note id 直接查子表、不碰 `notes` 的讀取（`uploads`、`note_states`、`note_versions`、`note_links`、`note_shares`、
 *     `note_search_*` 等）——由附錄 B 清單與 A2-5／A2-16 的測試負責。
 *   - SQL 引號識別字 `"notes"` 與 import 別名（`import { notes as n }`）不在比對式內（目前零命中）。
 *   - 守衛二抓不到物件簡寫 `.set({ deletedAt })`（沒有冒號）；兩條守衛都不做括號解析。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

/** 逐檔命中數（只列 > 0 的檔）。 */
function hits(re: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of walk(SRC)) {
    let n = 0;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      n += [...line.matchAll(re)].length;
    }
    if (n > 0) out[rel(p)] = n;
  }
  return out;
}

const NOTES_QUERY = new RegExp(
  [
    String.raw`\.from\(notes\)`,
    String.raw`\b(?:inner|left|right|full)?join\(notes\b`,
    String.raw`\.update\(notes\)`,
    String.raw`\.delete\(notes\)`,
    String.raw`\bfrom\s+notes\b`,
    String.raw`\bjoin\s+notes\b`,
    String.raw`\bupdate\s+notes\b`,
    String.raw`\$\{notes\}`,
  ].join("|"),
  "gi",
);
const DELETED_AT_WRITE = /deletedAt:|deletedBy:|deleted_at\s*=|set\s+deleted_at/gi;

type Disposition = { excludes?: number; trashOnly?: number; includes?: number; write?: number; why?: string };

// `excludes`＝帶 `deleted_at IS NULL`，或結果必經 §6.2 第 1／3 點閘口；`trashOnly`＝只看垃圾桶；`includes`＝刻意不分狀態（附理由）；`write`＝`UPDATE`／`DELETE`／寫入用 CTE，本句帶 `deleted_at IS NULL` 或受同交易先前帶條件的 `FOR UPDATE` 保護。
const REGISTRY: Record<string, Disposition> = {
  "collab/server.ts": { includes: 1, why: "落款寫進垃圾桶筆記（§6.4.1）" },
  "collab/store.ts": { includes: 1, why: "載入時 links_clock 鉗制，與存活無關" },
  // excludes：scanRound（scanDue）。
  "collab/versions.ts": { excludes: 1, includes: 7, why: "版本狀態隨落盤與套用版本後的基底寫回寫入；readVersionMeta 不改（M-G）；sweep 照常" },
  "groups/queries.ts": { includes: 1, why: "群組全部筆記（踢線、刪群組 P0，§6.5）" },
  // 轉移的鎖、配額 innerJoin、轉移 UPDATE、全刪的鎖。
  "groups/tx/delete-group.ts": { includes: 4, why: "轉移／全刪含垃圾桶（§6.5）" },
  "mcp/tools/read-note-outline.ts": { excludes: 1 },
  "notes/editing/candidates.ts": { excludes: 3 },
  "notes/editing/read.ts": { excludes: 1 },
  "notes/editing/write-service.ts": { includes: 1, why: "帶 content 建立失敗清掉剛建的列" },
  // excludes：存活 meta；includes：backfill 群組分支。
  "notes/link-conversion.ts": { excludes: 1, includes: 1, why: "目標在垃圾桶照記（§6.2-4；總管裁定 M10）" },
  "notes/links.ts": { excludes: 3 },
  "notes/list-query.ts": { excludes: 3 },
  // GET :ref／by-path 重讀／搬移後／還原後都在閘口後；routes/notes.ts POST 帶 content 的建立後重讀不經閘口，
  // 讀的是本請求剛建的列，無洩漏。
  "notes/note-dto.ts": { excludes: 1 },
  "notes/public-links.ts": { excludes: 1 },
  "notes/rename-note.ts": { excludes: 2, write: 1 },
  // excludes：accessQuery、noteIsLive；trashOnly：trashedAccessQuery；includes：loadNoteAudience。
  "notes/service.ts": { excludes: 2, trashOnly: 1, includes: 1, why: "移入前抓名單（§6.2-4）" },
  "notes/site-link-resolver.ts": { excludes: 2 },
  // excludes：legacy ref（之後接授權）；includes：slug 探測。
  "notes/slug.ts": { excludes: 1, includes: 1, why: "slug 仍佔用（§6.1）" },
  "notes/tx/copy.ts": { excludes: 1 },
  "notes/tx/delete-notes.ts": { includes: 2, why: "集合由呼叫端決定（永久刪除只傳垃圾桶 id、全刪傳全部）" },
  "notes/tx/move.ts": { excludes: 1, write: 1 },
  "notes/tx/patch-slug.ts": { write: 2 },
  "notes/tx/search-index.ts": { includes: 1, why: "索引照寫（§6.4）" },
  "notes/tx/shares.ts": { excludes: 1 },
  // trashOnly：照路徑重建寫 folder_id（資料夾 T7）、還原 UPDATE、到期查詢；includes：lockNotes；write：移入 UPDATE。
  "notes/tx/trash.ts": { trashOnly: 3, includes: 1, write: 1, why: "先鎖再判（狀態在鎖後逐篇判）" },
  // excludes：切版鎖讀；includes：notBaseVersionSql、reset 兩句；write：cutVersionInTx 內三句 UPDATE。
  "notes/tx/versions.ts": { excludes: 1, includes: 3, write: 3, why: "版本清除照常、轉移 reset 不分狀態" },
  "notes/tx/write-links.ts": { includes: 4, why: "目標在垃圾桶照記（§6.2-4）、CAS 不加條件" },
  "routes/admin-storage.ts": { includes: 2, why: "容量照算（D-W4）" },
  // excludes：withCurrentBase（授權後讀）；includes：DELETE 版本的基底子查詢。
  "routes/note-versions.ts": { excludes: 1, includes: 1, why: "刪版本：授權後子表單句寫入不加條件（§6.2-11 M-I）" },
  // excludes：ownershipChanged、selectNotesWhere、GET public-link；includes：格 4 pre-read；write：公開連結五支。
  // GET public-link 與格 4 pre-read 同是「授權後、本句不帶條件」：前者是純讀，TOCTOU 下等同「先讀後移入」，歸 excludes；
  // 後者由 spec §6.2-11 指定登記為 includes。
  "routes/notes.ts": { excludes: 3, includes: 1, write: 5, why: "格 4 pre-read 不加條件，後面的 CTE 會擋（spec §6.2-11）" },
  "routes/public.ts": { excludes: 2 },
  "storage/tx/quota.ts": { includes: 1, why: "容量照算（D-W4）" },
  "storage/usage.ts": { includes: 4, why: "容量照算（D-W4）" },
  "trash/list.ts": { trashOnly: 2 },
  // 還原的預讀空間（資料夾 T7，spec 2026-10-22 §5.8-1）。
  "trash/service.ts": { trashOnly: 1 },
  "uploads/tx/insert-upload.ts": { excludes: 1 },
};

/** 守衛二：只准這三檔，值＝處數。 */
const DELETED_AT_WRITERS: Record<string, number> = {
  "db/schema.ts": 2, // 欄位定義 deleted_at、deleted_by
  "notes/tx/trash.ts": 5, // 鎖讀選欄、移入 set 兩欄、還原 set 兩欄
  "trash/list.ts": 3, // 清單選欄、DTO 映射兩欄
};

const total = (d: Disposition) => (d.excludes ?? 0) + (d.trashOnly ?? 0) + (d.includes ?? 0) + (d.write ?? 0);

describe("垃圾桶結構守衛（#181 §6.2-10）", () => {
  const actual = hits(NOTES_QUERY);

  it("守衛一 ① 直查 notes 的檔集合＝登記表的鍵", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(REGISTRY).sort());
  });

  it("守衛一 ② 每檔處數＝登記表四項總和", () => {
    for (const [f, d] of Object.entries(REGISTRY)) expect.soft(actual[f] ?? 0, f).toBe(total(d));
  });

  it("守衛一 ③ 有 includes 的條目一定附理由", () => {
    const missing = Object.entries(REGISTRY).filter(([, d]) => (d.includes ?? 0) > 0 && !d.why?.trim()).map(([f]) => f);
    expect(missing).toEqual([]);
  });

  it("守衛二（AG6）寫 deleted_at 的字面只在三檔、處數凍結", () => {
    expect(hits(DELETED_AT_WRITE)).toEqual(DELETED_AT_WRITERS);
  });
});
