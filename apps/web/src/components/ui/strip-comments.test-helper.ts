import ts from "typescript";

/**
 * The file name is `.test-helper.ts` on purpose (not `.test.ts`) so vitest's default include doesn't run it as a test.
 * Comment ranges come from the syntax tree (every leaf except JsxText: leading/trailing comment ranges, plus EOF's), so slashes in regex literals, strings (route wildcards, image accept wildcards), template strings and JSX text aren't mistaken for comments. The result isn't guaranteed parseable; for regex checks only.
 */
export function stripComments(source: string, fileName = "source.tsx"): string {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map<number, number>(); // pos → end; the Map dedupes

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
