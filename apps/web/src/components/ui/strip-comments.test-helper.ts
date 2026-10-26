import ts from "typescript";

/**
 * 來源層守衛共用：剝掉 TS／TSX 原始碼的註解。檔名刻意是 `.test-helper.ts`（不是 `.test.ts`），
 * vitest 預設 include（`*.{test,spec}.*`）不會把它當測試跑。
 *
 * 用語法樹（`ts.createSourceFile`）取註解位置：走每個葉節點（JsxText 除外），收它前後的
 * leading／trailing comment ranges，再收 EOF token 的，去重後從原文刪掉。
 * 註解範圍是 parser 依語法判定的，所以 regex literal 裡的斜線星號、字串（路由 path 的萬用字元、
 * accept 的 image 萬用字元）、樣板字串裡的雙斜線或斜線星號，都不會被誤當成註解；JSX 文字節點裡的雙斜線也不剝。
 * 剝完不保證是可解析的程式碼（只是文字），拿去做 regex 檢查用。
 */
export function stripComments(source: string, fileName = "source.tsx"): string {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map<number, number>(); // pos → end，Map 本身去重

  const collect = (pos: number): void => {
    const found = [...(ts.getLeadingCommentRanges(source, pos) ?? []), ...(ts.getTrailingCommentRanges(source, pos) ?? [])];
    for (const r of found) ranges.set(r.pos, r.end);
  };

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      collect(node.pos);
      return;
    }
    for (const kid of kids) visit(kid);
  };
  visit(sf);
  collect(sf.endOfFileToken.pos);

  let out = "";
  let last = 0;
  for (const [start, end] of [...ranges.entries()].sort((a, b) => a[0] - b[0])) {
    if (start < last) continue;
    out += source.slice(last, start);
    last = end;
  }
  return out + source.slice(last);
}
