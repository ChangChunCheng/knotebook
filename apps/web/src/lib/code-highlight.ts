import type { CodeBlockOptions } from "@blocknote/core";
import { CODE_BLOCK_BASE_OPTIONS } from "@knotebook/shared";

/**
 * Not the official `@blocknote/code-block` (MPL-2.0 in an MIT repo). One CSS-variables theme
 * because BlockNote's highlight plugin hard-codes `getLoadedThemes()[0]`, so light/dark cannot be
 * switched by loading two themes; the values live in `index.css`.
 */

/**
 * Keys must be shiki bundle language ids: `loadLanguage()` throws for unknown ids (the test loads
 * every key). `text` is first because BlockNote skips highlighting for it.
 */
export { SUPPORTED_LANGUAGES } from "@knotebook/shared";

/**
 * Lazy, so no shiki grammar lands in the entry bundle. JS regex engine, not oniguruma: the CSP has
 * no `'wasm-unsafe-eval'`, so WASM would be blocked and highlighting would silently fail.
 */
export async function createHighlighter() {
  const [{ createHighlighter: create, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki"),
    import("shiki/engine/javascript"),
  ]);
  const theme = createCssVariablesTheme({
    name: "knotebook-code",
    variablePrefix: "--code-",
    fontStyle: true,
  });
  return create({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine() });
}

export const CODE_BLOCK_OPTIONS: CodeBlockOptions = {
  ...CODE_BLOCK_BASE_OPTIONS,
  createHighlighter,
};
