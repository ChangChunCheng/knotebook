import ts from "typescript";

/**
 * 來源層守衛共用：剝掉 TS／TSX 原始碼的註解。檔名刻意是 `.test-helper.ts`（不是 `.test.ts`），
 * vitest 預設 include（`*.{test,spec}.*`）不會把它當測試跑。
 *
 * 用 TypeScript scanner 逐 token 重組、丟掉 comment trivia，所以字串裡的 `/*`
 * （例如 `path="/*"`、`accept="image/*"`）不會再被正則誤當成註解開頭。
 * 已知殘餘限制：JSX 文字節點裡的撇號或 `//` 仍由一般 token 規則掃，只可能多剝、不會少剝註解。
 */
export function stripComments(source: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, source);
  const stack: Array<"brace" | "template"> = []; // 追 `${ … }`，讓樣板字串的尾段被當字串掃
  let out = "";
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.TemplateHead) stack.push("template");
    else if (kind === ts.SyntaxKind.OpenBraceToken) stack.push("brace");
    else if (kind === ts.SyntaxKind.CloseBraceToken) {
      if (stack.pop() === "template") {
        kind = scanner.reScanTemplateToken(false);
        if (kind === ts.SyntaxKind.TemplateMiddle) stack.push("template");
      }
    }
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) continue;
    out += scanner.getTokenText();
  }
  return out;
}
