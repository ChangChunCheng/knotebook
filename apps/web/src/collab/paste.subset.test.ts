import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasMarkdownStructure } from "./paste";

/**
 * Invariant: `hasMarkdownStructure` must be a **subset** of BlockNote's `isMarkdown`.
 *
 * `decideMarkdownPaste` uses this threshold only when the clipboard also has HTML, to decide whether to take the paste over from the HTML path. While the subset relation holds, taking over equals "the same decision as BlockNote plus line-ending normalization" and can't pull away content BlockNote would have handled via HTML (a recurring regression: JSDoc ` * ` continuation lines taken as a list, an overlong `#` comment taken as a heading, psql's `-----|-----` taken as a table, shell `1) ` taken as a numbered list).
 *
 * The oracle executes the source installed in `node_modules` directly and is deliberately not copied into this project (BlockNote is MPL-2.0, this project MIT). If that file disappears or changes shape after an upgrade this test goes red, which is the moment to re-confirm the invariant.
 */
function loadBlockNoteIsMarkdown(): (src: string) => boolean {
  const path = `${process.cwd()}/node_modules/@blocknote/core/src/api/parsers/markdown/detectMarkdown.ts`;
  const source = readFileSync(path, "utf8")
    .replace(/^export /gm, "")
    .replace(/\(src: string\): boolean =>/, "(src) =>");

  return new Function(`${source}\nreturn isMarkdown;`)() as (src: string) => boolean;
}

/** Shapes captured from a real clipboard plus ordinary markdown documents; the subset relation must hold across the whole set. */
const CORPUS: Array<[string, string]> = [
  ["JSDoc 註解", "/**\n * Adds two numbers together.\n * @param {number} a - first\n */\nfunction add(a, b) {\n  return a + b;\n}"],
  ["C/Java 授權標頭", "/*\n * Copyright 2026 Someone.\n * Licensed under the Apache License.\n */"],
  ["超長 # 註解＋空行＋設定", "# This file configures the reverse proxy for the production cluster, see docs\n\nserver {\n  listen 80;\n}"],
  ["短 # 註解＋空行＋設定", "# proxy config\n\nserver {\n  listen 80;\n}"],
  ["# 註解緊接指令", "# install deps\nnpm install foo"],
  ["diff 新增側", "+ const a = 1;\n+ const b = 2;"],
  ["diff 兩側", "- old line\n+ new line"],
  ["shell case 分支", 'case "$1" in\n1) echo one ;;\n2) echo two ;;\nesac'],
  ["psql 輸出", "id    | name\n------|-------\n1     | foo"],
  ["ASCII 方框表格", "| a | b |\n|---|---|\n| 1 | 2 |"],
  ["heredoc 內含圍籬", "cat <<'EOF' > README.md\n```bash\nnpm run dev\n```\nEOF"],
  ["YAML 兩個序列項（2 空格縮排）", "services:\n  - name: web\n  - name: db"],
  ["YAML 深縮排序列項", 'ports:\n      - "80:80"\n      - "443:443"'],
  ["CLI --help 輸出", "options:\n  -v, --verbose\n  -q, --quiet"],
  ["# 橫線分隔", "# ------------------------------\n# section\n# ------------------------------"],
  ["SQL 註解橫線", "-- ------------------------\n-- table defs\n-- ------------------------"],
  ["ini 註解", "# database settings\n\n[db]\nhost = localhost"],
  ["Makefile 註解", "# build everything\n\nall:\n\tgo build ./..."],
  ["一般段落", "就是一段普通文字，沒有任何標記。"],
  ["只有行內標記", "這段有 **粗體** 和 `code` 還有 [連結](https://example.com)"],
  ["標題＋空行＋內容", "# 標題\n\n內文一段"],
  ["兩個 - 清單項", "- 一\n- 二"],
  ["兩個編號項", "1. 一\n2. 二"],
  ["成對圍籬", "```bash\nls\n```\n"],
  ["完整文件", "# 全域備忘\n\n## 環境\n\n- 一\n- 二\n\n```bash\nls\n```\n"],
  ["單一清單項", "- 只有一項"],
  ["單獨標題", "# 標題"],
  ["郵件引用", "> 引用一句\n> 第二句"],
  ["水平線", "Part one.\n\n---\n\nPart two."],
];

describe("hasMarkdownStructure is a subset of BlockNote isMarkdown", () => {
  const isMarkdown = loadBlockNoteIsMarkdown();

  it("the oracle itself loads and behaves sensibly (guards against a vacuous green)", () => {
    expect(isMarkdown("# 標題\n\n內文一段")).toBe(true);
    expect(isMarkdown("就是一段普通文字，沒有任何標記。")).toBe(false);
  });

  it.each(CORPUS)("%s: when we judge it markdown, BlockNote must agree", (_name, source) => {
    if (hasMarkdownStructure(source)) {
      expect(isMarkdown(source)).toBe(true);
    }
  });

  /** The subset assertion would stay green even if we always returned false; this makes sure the corpus really hits the true branch. */
  it("several corpus entries do pass our threshold (otherwise the subset assertions above run vacuously)", () => {
    const passing = CORPUS.filter(([, source]) => hasMarkdownStructure(source)).map(([name]) => name);

    expect(passing).toEqual(
      expect.arrayContaining(["標題＋空行＋內容", "兩個 - 清單項", "兩個編號項", "成對圍籬", "完整文件", "ASCII 方框表格"]),
    );
  });

  it("no corpus entry violates the subset relation", () => {
    const violations = CORPUS.filter(([, source]) => hasMarkdownStructure(source) && !isMarkdown(source)).map(([name]) => name);

    expect(violations).toEqual([]);
  });
});
