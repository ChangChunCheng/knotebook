/**
 * #93: builds the full-text search queries (builds only, never runs them). Moved here from `mcp/queries.ts` and
 * extended; MCP and REST both use it through `searchNotesForUser` in `notes/search-query.ts`.
 * The two drizzle pitfalls in the `mcp/queries.ts` header apply here too: branch selects are single-use, so the three
 * are built fresh for every query, and a set operation's ORDER BY only takes output column names, so rank is
 * `.as("rank")` first.
 * The query string is never used as a raw LIKE pattern: the body trigram path escapes it with `escapeLike`.
 *
 * Matching: title `position(lower(q) in lower(title)) > 0`; body `EXISTS (… note_search_sections … <bodyMatch>)`, where
 * `bodyMatch` is the trigram-friendly LIKE or `position(lower(q) in lower(body)) > 0` depending on `usesTrigramPath(q)`
 * (the two forms are equivalent). Title and body are ORed into one `extraWhere` for `visibleNoteBranches`, so each of the
 * three branches carries the same correlated subquery. Index rows carry no permissions: **visibility comes only from
 * the three-branch union**. `body_hit` and WHERE each evaluate the same EXISTS (a branch's WHERE can't reference its own
 * output aliases).
 * rank: title equals the query 0, title starts with it 1, title contains it 2, body only 3.
 *
 * The second (matches) statement takes only the ids on the first statement's page whose `body_hit` is true (a list the
 * server built itself) and passes them with `inArray`. **Do not** write `` sql`= ANY(${ids})` ``: drizzle expands a JS
 * array in an sql template into `($1, $2, …)`, and `ANY(($1,$2))` is an error.
 * Up to `SEARCH_MATCHES_PER_NOTE` matches per note, in `ord` order; the window is 40 code points before the hit, the hit
 * and 160 after (a PG character is a code point); the snippet is picked in JS (`notes/search-snippet.ts`).
 */
import { and, asc, desc, inArray, or, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { DbOrTx } from "../db/tx.js";
import { escapeLike } from "../db/like.js";
import { noteSearchSections, notes } from "../db/schema.js";
import { visibleNoteBranches } from "./list-query.js";

/**
 * Picks the body match form. A query with 3+ consecutive letters/digits uses
 * `lower(body) LIKE lower('%' || escapeLike(q) || '%')`, which can use `nss_body_trgm_idx`; anything else uses
 * `position(...)`. Both forms return the same rows (deterministic collation, UTF8), so a wrong guess only costs speed.
 * Measured on a million sections with the real three-branch union and JIT off: a short query yields no trigrams, so LIKE
 * falls back to a seq scan about 50% slower than position(); a 3+ character query with few hits runs 17-20x faster.
 * The rule approximates pg_trgm's "word = run of alphanumerics", but pg_trgm decides what is alphanumeric from the
 * database's `LC_CTYPE`: under `C`, CJK characters yield no trigrams, so a long CJK query takes the LIKE path with a seq
 * scan (results are still correct).
 */
export function usesTrigramPath(q: string): boolean {
  return /[\p{L}\p{N}]{3}/u.test(q);
}

export const SEARCH_MATCHES_PER_NOTE = 3;
export const SNIPPET_LEAD_CP = 40;
export const SNIPPET_TAIL_CP = 160;

/**
 * #93：REST 的 keyset 游標值＝排序三元組 `(rank, updated_at, id)`。`updatedAtKey` 是 pg 自己格式化的**微秒** UTC 文字
 * （`YYYY-MM-DDTHH:MI:SS.ffffffZ`）：`notes.updated_at` 是微秒、JS `Date` 只有毫秒，降到毫秒會漏列（`mcp/queries.ts` 的
 * `list_notes` 用降精度的排序鍵解，這裡不能照抄——那會改掉 MCP 共用的 `ORDER BY`）。比較時以 `::timestamptz` 原樣送回，同一把尺。
 */
export interface SearchPageKey {
  rank: number;
  updatedAtKey: string;
  id: string;
}

export interface NoteSearchQueryOpts {
  userId: string;
  query: string;
  limit: number;
  /** 只要內文有命中的（REST `match=body`）。不帶／false＝標題或內文（MCP）。 */
  bodyOnly?: boolean;
  /** 存在時多輸出 `updated_at_key`；`after` 非 null 時只回排在它之後的列。MCP 不帶。 */
  page?: { after: SearchPageKey | null };
}

export function buildNoteSearchQuery(db: DbOrTx, opts: NoteSearchQueryOpts) {
  const q = opts.query;
  const titleHit = sql`position(lower(${q}) in lower(${notes.title})) > 0`;
  // The pattern is escaped in JS and lower()ed in PG. lower() never creates or changes `\`, `%` or `_`, so this equals
  // escaping after lower(), and the SQL carries no backslash literal (unaffected by standard_conforming_strings).
  // The title match stays on position(): it is ORed with the EXISTS, so it can only be a Filter and no index would help
  // (hence no title trigram index).
  const bodyMatch = usesTrigramPath(q)
    ? sql`lower(${noteSearchSections.body}) like lower(${"%" + escapeLike(q) + "%"})`
    : sql`position(lower(${q}) in lower(${noteSearchSections.body})) > 0`;
  const bodyHit = sql`exists (select 1 from ${noteSearchSections} where ${noteSearchSections.noteId} = ${notes.id} and ${noteSearchSections.sourceKind} = 'note' and ${bodyMatch})`;
  // 未取別名的 rank 運算式：keyset 述詞要在各支 WHERE 裡用（WHERE 不能引用輸出別名）。同一個 sql 片段重複嵌入是安全的。
  const rankExpr = sql<number>`case
    when lower(${notes.title}) = lower(${q}) then 0
    when position(lower(${q}) in lower(${notes.title})) = 1 then 1
    when ${titleHit} then 2
    else 3 end`;
  const rank = sql<number>`${rankExpr}`.as("rank");
  const titleHitCol = sql<boolean>`${titleHit}`.as("title_hit");
  const bodyHitCol = sql<boolean>`${bodyHit}`.as("body_hit");
  const page = opts.page;
  const after = page?.after ?? null;
  // 排序是 rank asc、updated_at desc、id desc；方向不同，不能寫成一個三元列比較。
  // ⚠ 一定要用 drizzle 的 or(…, and(…)) 組：`and(a, b)` 只在整串外加一層括號，裸 `sql\`… or (…)\`` 丟進 and() 會渲染成
  // `比對 and rank > r or (…)`——AND 先結合，rank = r 且排在游標後的列不必符合比對條件。
  const keysetCond =
    after === null
      ? undefined
      : or(
          sql`${rankExpr} > ${after.rank}`,
          and(sql`${rankExpr} = ${after.rank}`, sql`(${notes.updatedAt}, ${notes.id}) < (${after.updatedAtKey}::timestamptz, ${after.id}::uuid)`),
        );
  const updatedAtKey = sql<string>`to_char(${notes.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("updated_at_key");
  // extra 的順序固定（三支同一個物件，union 按位置對欄）。page 不在時 SQL 與加分頁之前逐位元組相同。
  const { owned, shared, grouped } = visibleNoteBranches(db, opts.userId, {
    extraWhere: and(opts.bodyOnly === true ? bodyHit : or(titleHit, bodyHit), keysetCond),
    extra: { rank, titleHit: titleHitCol, bodyHit: bodyHitCol, ...(page !== undefined ? { updatedAtKey } : {}) },
  });
  return unionAll(owned, shared, grouped)
    .orderBy(asc(rank), desc(notes.updatedAt), desc(notes.id))
    .limit(opts.limit + 1);
}

export type NoteSearchRow = Awaited<ReturnType<typeof buildNoteSearchQuery>>[number];

export type SearchMatchRow = {
  note_id: string;
  section_id: string;
  ord: number;
  heading: string;
  p: number;
  win_start: number;
  win: string;
  body_len: number;
} & Record<string, unknown>;

export function buildSearchMatchesQuery(opts: { query: string; ids: string[] }): SQL {
  const q = opts.query;
  return sql`with hits as (
    select ${noteSearchSections.noteId} as note_id, ${noteSearchSections.sectionId} as section_id, ${noteSearchSections.ord} as ord,
           ${noteSearchSections.heading} as heading, ${noteSearchSections.body} as body,
           position(lower(${q}) in lower(${noteSearchSections.body})) as p
    from ${noteSearchSections}
    where ${inArray(noteSearchSections.noteId, opts.ids)} and ${noteSearchSections.sourceKind} = 'note'
  ), ranked as (
    select *, row_number() over (partition by note_id order by ord) as rn from hits where p > 0
  )
  select note_id, section_id, ord, heading, p,
         greatest(p - ${SNIPPET_LEAD_CP}, 1) as win_start,
         substr(body, greatest(p - ${SNIPPET_LEAD_CP}, 1), ${SNIPPET_LEAD_CP} + char_length(${q}) + ${SNIPPET_TAIL_CP}) as win,
         char_length(body) as body_len
  from ranked where rn <= ${SEARCH_MATCHES_PER_NOTE}
  order by note_id, ord`;
}
