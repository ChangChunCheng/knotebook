import { normalizeEmail } from "@knotebook/shared";
import { ApiFail } from "@/api/client";

/**
 * 群組成員的批次加入（一次加很多人；純前端、沿用單人的 `PUT /api/groups/:id/members`）。
 * 是**一次性的複製**：從別的群組匯入後，兩邊的名單各自獨立，之後不會同步。
 * 只被 `GroupMembersSection`（lazy 的 GroupSections chunk）與測試 import。
 */

/** 只擋明顯不是 email 的字（server 的 zod `.email()` 才是裁決者：過不了回 400 `invalid_body`，下面一樣歸「格式不對」）。 */
const EMAIL_LIKE_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+$/;

/**
 * 把貼上的一串地址拆開：以逗號、分號、空白、換行分隔；每段去掉包著的 `<…>`／引號（從信件收件人欄貼過來的形狀）。
 * 大小寫不分去重（保留第一次出現的寫法）。看起來不像 email 的片段放進 `invalid`（同樣去重），不送出。
 */
export function parseEmailList(text: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const token = raw.replace(/^[<"']+|[>"']+$/g, "");
    if (token.length === 0) continue;
    const key = normalizeEmail(token);
    if (seen.has(key)) continue;
    seen.add(key);
    (EMAIL_LIKE_RE.test(token) ? emails : invalid).push(token);
  }
  return { emails, invalid };
}

/**
 * 每個地址的結果：
 * - `added`：加入成功；`notFound`：404 `user_not_found`（沒有這個帳號）；`alreadyMember`：409 `already_member`
 *   或送出前就在名單裡；`invalid`：格式不對（client 先擋，或 server 400 `invalid_body`）；
 * - `failed`：讓整批停下的那一個；`notProcessed`：停下之後沒送出的。
 */
export type BulkAddOutcome = "added" | "notFound" | "alreadyMember" | "invalid" | "failed" | "notProcessed";

export interface BulkAddResult {
  email: string;
  outcome: BulkAddOutcome;
}

export interface BulkAddReport {
  /** 依送出順序。 */
  results: BulkAddResult[];
  /** 讓整批停下的錯誤（429、權限被收回、群組不見了、5xx、網路錯誤…）；跑完全部則為 null。 */
  stopped: { cause: unknown } | null;
}

/** 逐項結果才略過、繼續；其餘一律停下（同選取模式批次的原則：不認得的錯誤不硬跑下去）。 */
export function classifyAddError(err: unknown): Exclude<BulkAddOutcome, "added" | "failed" | "notProcessed"> | "stop" {
  if (!(err instanceof ApiFail)) return "stop";
  if (err.status === 404 && err.code === "user_not_found") return "notFound";
  if (err.status === 409 && err.code === "already_member") return "alreadyMember";
  if (err.status === 400 && err.code === "invalid_body") return "invalid";
  return "stop";
}

/** 是不是節流（429）——停下時給「稍後再加其餘的」提示。 */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiFail && err.status === 429;
}

/**
 * 依序（await 完一個才送下一個）。不開批次端點：沿用單人端點的交易、權限與 409 守法；依序才停得住、才回報得出做到哪。
 * `onProgress(processed, total)` 在每項結束（成功、略過）後呼叫。`add` 丟出 classify 為 `stop` 的錯誤時：那一項記 `failed`、
 * 其後全部記 `notProcessed`，回傳 `stopped`。
 */
export async function runBulkAdd(
  emails: readonly string[],
  add: (email: string) => Promise<unknown>,
  onProgress?: (processed: number, total: number) => void,
): Promise<BulkAddReport> {
  const results: BulkAddResult[] = [];
  for (const [index, email] of emails.entries()) {
    try {
      await add(email);
      results.push({ email, outcome: "added" });
    } catch (err) {
      const kind = classifyAddError(err);
      if (kind === "stop") {
        results.push({ email, outcome: "failed" });
        for (const rest of emails.slice(index + 1)) results.push({ email: rest, outcome: "notProcessed" });
        return { results, stopped: { cause: err } };
      }
      results.push({ email, outcome: kind });
    }
    onProgress?.(index + 1, emails.length);
  }
  return { results, stopped: null };
}
