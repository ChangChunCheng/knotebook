import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "./schema";
import { resolveTrailingMarkdownLink } from "./markdown-link";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
let editor: BlockNoteEditor<any, any, any>;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  editor = BlockNoteEditor.create({ schema: noteSchema }) as BlockNoteEditor<any, any, any>;
});

/** The "must fire" cases, compared verbatim, not just "has a link".
 *
 * Case `# <heading text> [a](...)`: `text` comes from `$from.parent`, a shape that **ordinary typing can't reach** (once `# ` is followed by a space the heading input rule eats it and turns it into a heading block, so in a real editor the textBefore is `<heading text> [a](...)` without the `# ` prefix). ⚠ But it's **not unreachable**: `resolveTrailingMarkdownLink` is a pure function and doesn't care how the string arrived; a roundabout path such as typing `x# <heading text> [a](https://x.com`, deleting the leading `x`, then typing `)` stops the heading rule from eating `# ` first and feeds this shape of `textBefore` to the rule. Behaviour is correct (last case in the table below), so it's listed rather than claimed unreachable. */
describe("resolveTrailingMarkdownLink must fire", () => {
  it.each([
    ["[a](https://x.com)", "a", "https://x.com", 18],
    ["[水星](https://zh.wikipedia.org/wiki/水星_(行星))", "水星", "https://zh.wikipedia.org/wiki/水星_(行星)", 43],
    ["[a [b] c](https://x.com)", "a [b] c", "https://x.com", 24],
    ["前面有字 [a](https://x.com)", "a", "https://x.com", 18],
    ["[a](https://x.com) 然後 [b](https://y.com)", "b", "https://y.com", 18],
    ["[寄信](mailto:me@example.com)", "寄信", "mailto:me@example.com", 27],
    ["[區域](/n/my-note)", "區域", "/n/my-note", 16],
    ["# 標題裡的 [a](https://x.com)", "a", "https://x.com", 18],
  ])("%s", (input, text, href, matchedLength) => {
    expect(resolveTrailingMarkdownLink(editor, input)).toEqual({ text, href, matchedLength });
  });
});

/** The "must not fire" cases. The first three threw TypeError before the null guard was added (an image has no content field, a paragraph with empty display text has an empty content array, a table's content is an object): they show that writing the criterion as a positive condition is warranted, not formalism. */
describe("resolveTrailingMarkdownLink must not fire", () => {
  it.each([
    ["![a](https://x.com/i.png)"], // image block, no content field
    ["[](https://x.com)"], // paragraph, content is an empty array
    ["<table><tr><td>[a](https://x.com)"], // table, content is an object
    ["\\[a](https://x.com)"], // backslash escape: blocked by construction, not by a blacklist
    ["![a](https://x.com/i.png) 後面還有 ![b](https://y.com/j.png)"],
    ["[水星](https://zh.wikipedia.org/wiki/水星_(行星)"], // one closing parenthesis missing
    ['[a](https://x.com "標題")'],
    ["[a](<https://x.com>)"],
    ["[a](  https://x.com  )"],
    ["[*a*](https://x.com)"],
    ["[壞](javascript:alert(1))"],
    ["[文字]()"],
    ["前面有字但沒有連結)"],
  ])("%s", (input) => {
    expect(resolveTrailingMarkdownLink(editor, input)).toBeNull();
  });
});

/**
 * Doesn't apply inside code blocks / inline code: this holds naturally today because we use `addInputRules()` rather than a hand-written `editorProps.handleTextInput` (tiptap's `inputRulesPlugin` skips code itself, and all four entry points go through it). What's guarded here is a **structural** fact: this file uses `addInputRules` and contains no mounted form of `handleTextInput`.
 *
 * ⚠ The criterion can't be "the string `handleTextInput` must not appear": the handler's comment contains it verbatim (explaining why the offset differs by entry point), so that would turn red on the file's own product. Instead `/handleTextInput\s*[:(]/` is used: it matches only the mounted form (object property `handleTextInput:` or call `handleTextInput(`), not prose references wrapped in backticks.
 */
describe("structural guard: this file uses addInputRules, not a hand-written handleTextInput", () => {
  // `import.meta.url` isn't guaranteed to be a file: scheme under vitest's transform environment (it throws "The URL must be of scheme file"), so the path is built from `process.cwd()`, the same existing convention `paste.subset.test.ts` uses to read node_modules source.
  const source = readFileSync(`${process.cwd()}/src/collab/markdown-link.ts`, "utf8");

  it("contains an addInputRules() registration", () => {
    expect(source).toMatch(/addInputRules\s*\(\s*\)\s*\{/);
  });

  it("contains no mounted form of handleTextInput (prose references are fine, the mounted form isn't)", () => {
    expect(source).not.toMatch(/handleTextInput\s*[:(]/);
  });
});
