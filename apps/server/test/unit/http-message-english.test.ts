/**
 * #372 guard: the `message` of HTTP responses (`sendError`, `TxAbort`, the `error_description` of `sendOauthError`, inline route
 * `reply.send({ error: { message } })`, zod `.refine` messages, `*_MESSAGE` constants, ...) is always English.
 *
 * It scans in reverse: every .ts file under `src/` is tokenized (comments stripped, string/template/regex literals recognized), and every string literal
 * containing CJK must match one of the exclusion rules below, otherwise the test fails. So any new response shape (a new helper, a new constant name)
 * is scanned too, and only positions explicitly listed as "never reaching an HTTP response" pass. Exclusion rules (kept narrow; before adding one, confirm the sentence really never returns over HTTP):
 *
 *   R1 log: the **innermost** call around the literal is pino: callee `log.<level>(`, `log?.<level>(`, `logger.<level>(` (including chains such as
 *      `request.log.warn(` and `deps.log?.warn(`), level one of trace/debug/info/warn/error/fatal. Plus the injected `warn(` in `notes/version-fingerprint.ts`
 *      (the parameter is named warn, the same pino method). Only the innermost call counts: a nested `sendError(..., "...")` inside log arguments still fails.
 *   R2 exceptions that only reach the log: the innermost call around the literal is `new Error(`/`new RangeError(`/`new TypeError(`, `new AiKeyDecryptError(`,
 *      `new OidcUnavailableError(`, `new SecretDecryptError(` or `redactDbError(`, **and** the exception is not a direct argument of another call
 *      (only `throw ...` and `return ...` pass; `sendError(..., redactDbError(..., "...").message)` fails).
 *      `TxAbort` is **not** in this list: its message is the HTTP response.
 *   R3 named constants for logs: top-level `const <NAME>_LOG = "..."` (a name ending in `_LOG` means log-only). A top-level `const` extends to `;` or the next
 *      top-level declaration keyword (function/export/class/async/let/var/import/interface/type), so a missing semicolon doesn't extend it.
 *   R4 startup config: all of `config.ts` (env parsing and startup warnings, before listen, never through a route).
 *   R5 individually named exceptions (file + top-level constant name, or file + literal): data names and the bilingual explanation page of `/oauth/authorize`, see `NAMED`.
 *
 * Limits: this is a literal scan: strings assembled by code (concatenating non-CJK pieces and then transcoding) or flowing into a response from outside src (the shared package)
 * are not caught; behaviour is covered by each route's integration test comparing the message verbatim. The preconditions of the rules are conventions that the guard itself doesn't verify:
 *   - R2 assumes **the exception's message is never returned verbatim to the client**: an uncaught exception goes to the global errorHandler, which answers status >= 500 with "Internal server error.";
 *     the three named exceptions are caught by routes and answered with a fixed English sentence. But the errorHandler in `app.ts` sends `error.message` as-is for status < 500
 *     (for Fastify's built-in 4xx), so a `new Error("...")` with `statusCode = 400` thrown would leak that sentence into the response and the guard wouldn't catch it
 *     (no such code in src today).
 *   - R3 assumes `*_LOG` constants are only passed to log; using one as the message of `sendError` is not distinguishable by the guard.
 *   - regex vs division is judged roughly from the previous token; rare forms such as `if (x) /re/` can be tokenized wrongly.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
/** CJK punctuation, CJK unified ideographs (including extension A), compatibility ideographs, full-width forms; also the same ranges written as `\uXXXX` escapes (escape sequences in the literal source). */
const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]|\\u(?:3[0-9a-fA-F]{3}|[4-9][0-9a-fA-F]{3}|[fF][9aA][0-9a-fA-F]{2}|[fF]{2}[0-9a-eA-E][0-9a-fA-F])/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

interface CjkLiteral {
  line: number;
  text: string;
  /** From outside to inside, the callee in front of each unclosed `(` (`new X` recorded as `new X`); `[`/`{` record null. */
  callees: (string | null)[];
  /** The NAME when the literal sits (at any depth) in the initializer of a top-level `const NAME = ...;`. */
  topConst: string | null;
}

/** Keywords that, at depth 0, mean the previous top-level `const` declaration has ended. */
const STATEMENT_START = new Set(["function", "export", "class", "async", "let", "var", "import", "interface", "type"]);

/** Whether the previous meaningful character can be followed by a regex literal (otherwise `/` is a division). */
function regexAllowedAfter(prev: string, word: string): boolean {
  if (prev === "") return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(prev)) return true;
  return ["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new"].includes(word);
}

function scanCjkLiterals(src: string): CjkLiteral[] {
  const out: CjkLiteral[] = [];
  const stack: (string | null)[] = [];
  let i = 0;
  let line = 1;
  let prev = ""; // previous meaningful character (not whitespace, not a comment)
  let prevWord = ""; // previous identifier
  let topConst: string | null = null;

  const calleeBefore = (pos: number): string | null => {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(src[j]!)) j--;
    let k = j;
    while (k >= 0 && /[\w$.?]/.test(src[k]!)) k--;
    const name = src.slice(k + 1, j + 1);
    if (name === "" || !/[\w$]/.test(name)) return null;
    let m = k;
    while (m >= 0 && /\s/.test(src[m]!)) m--;
    const isNew = m >= 2 && src.slice(m - 2, m + 1) === "new" && (m < 3 || !/[\w$]/.test(src[m - 3]!));
    return isNew ? `new ${name}` : name;
  };

  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (src.startsWith("//", i)) {
      const j = src.indexOf("\n", i);
      i = j < 0 ? src.length : j;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? src.length : j + 2;
      line += (src.slice(i, end).match(/\n/g) ?? []).length;
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const startLine = line;
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        const d = src[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") line++;
        if (c === "`" && src.startsWith("${", j)) {
          depth++;
          j += 2;
          continue;
        }
        if (c === "`" && depth > 0 && d === "{") {
          depth++;
          j++;
          continue;
        }
        if (c === "`" && depth > 0 && d === "}") {
          depth--;
          j++;
          continue;
        }
        if (d === c && depth === 0) break;
        j++;
      }
      const text = src.slice(i, j + 1);
      if (CJK.test(text)) out.push({ line: startLine, text, callees: [...stack], topConst });
      i = j + 1;
      prev = c;
      prevWord = "";
      continue;
    }
    if (c === "/" && regexAllowedAfter(prev, prevWord)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        const d = src[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/.test(src[j]!)) j++;
      i = j;
      prev = "/";
      prevWord = "";
      continue;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      if (stack.length === 0 && word === "const") {
        const m = /^const\s+([\w$]+)\s*(?::[^=]+)?=/.exec(src.slice(i));
        topConst = m ? m[1]! : null;
      } else if (stack.length === 0 && STATEMENT_START.has(word)) {
        // When a semicolon is missing, the next top-level declaration must not inherit the previous const's name (otherwise everything after `const X_LOG = "..."` would be treated as R3).
        topConst = null;
      }
      prevWord = word;
      prev = word[word.length - 1]!;
      i = j;
      continue;
    }
    if (c === "(") stack.push(calleeBefore(i));
    else if (c === "[" || c === "{") stack.push(null);
    else if (c === ")" || c === "]" || c === "}") stack.pop();
    else if (c === ";" && stack.length === 0) topConst = null;
    prev = c;
    prevWord = "";
    i++;
  }
  return out;
}

const LOG_CALLEE = /(^|\.)(log|logger)\??\.(trace|debug|info|warn|error|fatal)$/;
const EXCEPTION_CALLEE = new Set([
  "new Error",
  "new RangeError",
  "new TypeError",
  "new AiKeyDecryptError",
  "new OidcUnavailableError",
  "new SecretDecryptError",
  "redactDbError",
]);
/** File-specific callees for R1: injected pino methods. */
const FILE_LOG_CALLEES: Record<string, string[]> = { "notes/version-fingerprint.ts": ["warn"] };
/** R4: whole files excluded. */
const EXCLUDED_FILES = new Set(["config.ts"]);
/** R5: named one by one. `const` is the top-level constant name; `literal` is the literal source text (with quotes). */
const NAMED: { file: string; const?: string; literal?: string; why: string }[] = [
  { file: "notes/link-conversion.ts", const: "LINK_CONVERSION_VERSION_NAME", why: "資料：一次性連結轉換前自動存的版本名稱" },
  { file: "folders/names.ts", literal: '"群組"', why: "資料：刪群組轉移時新資料夾的預設名稱（依瀏覽器語言）" },
  { file: "routes/oauth.ts", const: "UNKNOWN_CLIENT_MESSAGE", why: "/oauth/authorize 給人看的純文字頁，刻意中英雙語（不是 message 欄位）" },
  { file: "routes/oauth.ts", const: "T1_MESSAGE", why: "同上" },
  { file: "routes/oauth.ts", const: "RATE_LIMITED_MESSAGE", why: "同上" },
];

function excludedBy(file: string, lit: CjkLiteral): string | null {
  if (EXCLUDED_FILES.has(file)) return "R4";
  // R1/R2 only look at the **innermost** non-null callee: the literal in `log.warn({ sent: sendError(..., "...") })` belongs to sendError, not log.
  let at = lit.callees.length - 1;
  while (at >= 0 && lit.callees[at] === null) at--;
  const inner = at >= 0 ? lit.callees[at]! : null;
  if (inner !== null && (LOG_CALLEE.test(inner) || (FILE_LOG_CALLEES[file] ?? []).includes(inner))) return "R1";
  // R2 also requires the exception itself not to be a direct argument of a call: the value of `sendError(..., redactDbError(..., "...").message)` flows into the response.
  if (inner !== null && EXCEPTION_CALLEE.has(inner) && (at === 0 || lit.callees[at - 1] === null)) return "R2";
  if (lit.topConst !== null && lit.topConst.endsWith("_LOG")) return "R3";
  if (NAMED.some(n => n.file === file && ((n.const !== undefined && n.const === lit.topConst) || (n.literal !== undefined && n.literal === lit.text)))) return "R5";
  return null;
}

function offenders(files: { file: string; src: string }[]): string[] {
  return files.flatMap(({ file, src }) =>
    scanCjkLiterals(src)
      .filter(lit => excludedBy(file, lit) === null)
      .map(lit => `${file}:${lit.line} ${lit.text.slice(0, 80)}`)
  );
}

const ALL = walk(SRC).map(p => ({ file: rel(p), src: readFileSync(p, "utf8") }));

describe("#372: HTTP response messages are always English", () => {
  it("src/ has no non-excluded string literal containing CJK", () => {
    expect(offenders(ALL)).toEqual([]);
  });

  it("not vacuous: the excluded Chinese literals are really found (every rule has a hit)", () => {
    const hit = new Set<string>();
    for (const { file, src } of ALL) for (const lit of scanCjkLiterals(src)) hit.add(excludedBy(file, lit) ?? "none");
    for (const r of ["R1", "R2", "R3", "R4", "R5"]) expect(hit.has(r), r).toBe(true);
  });

  it("every named R5 entry still finds its literal (stale exceptions must be deleted)", () => {
    for (const n of NAMED) {
      const f = ALL.find(x => x.file === n.file);
      expect(f, n.file).toBeDefined();
      const lits = scanCjkLiterals(f!.src);
      expect(lits.some(l => (n.const !== undefined && l.topConst === n.const) || (n.literal !== undefined && l.text === n.literal)), JSON.stringify(n)).toBe(true);
    }
  });

  it.each([
    ["sendError", 'sendError(reply, 404, "not_found", "找不到");'],
    ["TxAbort", 'throw new TxAbort(409, "conflict", "衝突");'],
    ["sendOauthError", 'return sendOauthError(reply, 400, "invalid_request", "格式錯");'],
    ["inline reply.send", 'return reply.code(409).send({ error: { code: "stale", message: "過期" }, current });'],
    ["zod refine", 'const s = z.string().refine(v => v.length > 0, "不得為空");'],
    ["template", "const M = `最多 ${N} 層`;"],
    ["*_MESSAGE constant", 'export const X_MESSAGE = "訊息";'],
    ["sendError on the same line as a log call", 'request.log.warn({}, "ok"); return sendError(reply, 400, "invalid_body", "錯");'],
    ["sendError nested in log arguments", 'request.log.warn({ sent: sendError(reply, 400, "invalid_body", "錯") });'],
    ["message of redactDbError flowing into sendError", 'return sendError(reply, 500, "internal", redactDbError(request.log, err, "建立").message);'],
    ["message of new Error flowing into sendError", 'return sendError(reply, 400, "invalid_body", new Error("錯").message);'],
    ["_LOG constant missing a semicolon, sendError in the next top-level function", 'const AUDIT_LOG = "ok"\nexport function f(reply) { return sendError(reply, 400, "invalid_body", "錯"); }'],
    ["_LOG constant missing a semicolon, the next top-level async/let", 'const AUDIT_LOG = "ok"\nlet m = "錯"'],
    ["Chinese written as unicode escapes", 'sendError(reply, 404, "not_found", "\\u627e\\u4e0d\\u5230");'],
    ["compatibility ideograph", 'sendError(reply, 404, "not_found", "豈");'],
  ])("shape %s with Chinese -> caught", (_name, snippet) => {
    expect(offenders([{ file: "routes/x.ts", src: snippet }])).toHaveLength(1);
  });

  it("an R5 named constant missing a semicolon: a later top-level function's Chinese sendError still fails (only the constant itself passes)", () => {
    const src = 'const T1_MESSAGE =\n  "雙語說明"\nfunction f(reply) { return sendError(reply, 400, "invalid_body", "錯"); }';
    expect(offenders([{ file: "routes/oauth.ts", src }])).toEqual(['routes/oauth.ts:3 "錯"']);
  });

  it.each([
    ["pino log", 'request.log.warn({ err }, "記錄");'],
    ["pino log multi-line", 'deps.log?.error(\n  { noteId },\n  "多行記錄"\n);'],
    ["new Error", 'throw new Error(`不變量被打破：${x}`);'],
    ["redactDbError", 'throw redactDbError(request.log, err, "建立");'],
    ["_LOG constant", 'const AUDIT_LOG = "稽核";'],
    ["comment", '// 中文註解\n/* 區塊 註解 */ sendError(reply, 400, "invalid_body", "Invalid request body.");'],
    ["a quote inside a regex literal doesn't swallow what follows", 'const re = /["\']/; log.info("記錄");'],
  ])("excluded: %s passes", (_name, snippet) => {
    expect(offenders([{ file: "routes/x.ts", src: snippet }])).toEqual([]);
  });
});
