/**
 * Cheap pre-check of the block limit (`plainParagraphFloor`/`topLevelBlockFloor`): a full `tryParseHTMLToBlocks` parse of a file with tens of
 * thousands of paragraphs takes seconds of synchronous time before answering 400 `too_many_blocks`. The pre-check is a lower bound: over it is certainly over, an underestimate falls back to the full parse.
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { syntaxCheckRoot } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { BLOCK_PRECHECK_MIN_CHARS, MAX_BLOCKS, parseMarkdownForNote, plainParagraphFloor, topLevelBlockFloor } from "../../src/notes/editing/markdown.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const ORIGIN = "http://localhost";

/** Runs parse in a scratch session; returns the result and how many times `tryParseHTMLToBlocks` was called (try/finally close: lease invariant). */
async function parseCounting(md: string) {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    const spy = vi.spyOn(s.editor, "tryParseHTMLToBlocks");
    const t = performance.now();
    const r = parseMarkdownForNote(s.editor, md, [], ORIGIN);
    const ms = performance.now() - t;
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    return { r, ms, calls };
  } finally {
    s.close();
  }
}
const paras = (n: number, prefix = "p") => Array.from({ length: n }, (_, k) => `${prefix} ${k} lorem ipsum dolor sit amet`).join("\n\n");

describe("plainParagraphFloor (first layer: line by line)", () => {
  it("counts lines that start with a letter after a blank line; continuation lines of the same paragraph, indented lines, and lines starting with list/quote/heading/number markers are not counted", () => {
    expect(plainParagraphFloor("a\n\nb\nc\n\n  d\n\n- e\n\n> f\n\n# g\n\n1. h\n\n中文段落")).toBe(3);
    expect(plainParagraphFloor("")).toBe(0);
    expect(plainParagraphFloor("a\r\n\r\nb")).toBe(2);
  });

  it("any `<` disables the estimate (HTML blocks, comments, and content-swallowing elements can stop letter lines from forming paragraphs)", () => {
    expect(plainParagraphFloor("a\n\nb <\n\nc")).toBe(0);
  });

  it("any ``` or ~~~ in the text disables the estimate (BlockNote is not CommonMark; how a fence opens and closes is left to the second layer)", () => {
    expect(plainParagraphFloor("x\n\n```\n\na\n\nb\n```\n\ny")).toBe(0);
    expect(plainParagraphFloor("~~~~\n\na\n\n~~~\n\nb\n~~~~\n\nc")).toBe(0);
    expect(plainParagraphFloor("``` a`b\n\nc")).toBe(0);
    expect(plainParagraphFloor("a\n\nb ``` inline\n\nc")).toBe(0);
    expect(plainParagraphFloor("a\n\nb\n\nc ~~ d")).toBe(3);
  });
});

describe("topLevelBlockFloor (second layer: top-level DOM)", () => {
  it("counts top-level p/h1-h6/pre with text and li of top-level lists with text, one each; nested or empty ones are not counted", () => {
    const root = syntaxCheckRoot(
      "<p>a</p><h2>b</h2><pre><code>c</code></pre><ul><li>d</li><li>e</li></ul><ol><li></li></ol><p></p><p><img src=x></p>" +
        "<table><tr><td><p>x</p><p>y</p></td></tr></table><div><p>z</p></div>",
    );
    expect(topLevelBlockFloor(root)).toBe(5);
  });
});

describe("parseMarkdownForNote pre-check (27k paragraphs)", () => {
  it("plain markdown with 27k paragraphs -> too_many_blocks, never reaches the full parse (tryParseHTMLToBlocks called 0 times)", async () => {
    const md = paras(27_000);
    expect(Buffer.byteLength(md)).toBeGreaterThan(900_000);
    const { r, calls, ms } = await parseCounting(md);
    expect(r).toEqual({ error: "too_many_blocks" });
    expect(calls).toBe(0);
    console.log(`[27k plain] ${Math.round(ms)} ms`);
  }, 60_000);

  it("plain markdown shorter than the second-layer threshold (MAX_BLOCKS + 1 single-letter paragraphs, about 6 KB) -> stopped by the first layer, no full parse (the second layer ignores files this short)", async () => {
    const md = Array.from({ length: MAX_BLOCKS + 1 }, () => "a").join("\n\n");
    expect(md.length).toBeLessThan(BLOCK_PRECHECK_MIN_CHARS);
    const { r, calls } = await parseCounting(md);
    expect(r).toEqual({ error: "too_many_blocks" });
    expect(calls).toBe(0);
  }, 60_000);

  it("27k paragraphs starting with an HTML tag (the first layer doesn't estimate) -> stopped by the second layer: too_many_blocks, no full parse", async () => {
    const md = "<b>x</b>\n\n" + paras(27_000);
    const { r, calls, ms } = await parseCounting(md);
    expect(r).toEqual({ error: "too_many_blocks" });
    expect(calls).toBe(0);
    console.log(`[27k html-first] ${Math.round(ms)} ms`);
  }, 60_000);

  it("the lower bound has no false positives: exactly MAX_BLOCKS paragraphs (plain markdown and with HTML) parse successfully into exactly MAX_BLOCKS blocks; one more -> too_many_blocks", async () => {
    for (const head of ["", "<b>x</b> "]) {
      const ok = await parseCounting(head + paras(MAX_BLOCKS));
      expect(ok.r, `head=${JSON.stringify(head)}`).not.toHaveProperty("error");
      expect((ok.r as { blocks: unknown[] }).blocks, `head=${JSON.stringify(head)}`).toHaveLength(MAX_BLOCKS);
      const over = await parseCounting(head + paras(MAX_BLOCKS + 1));
      expect(over.r, `head=${JSON.stringify(head)}`).toEqual({ error: "too_many_blocks" });
    }
  }, 60_000);

  // Six shapes: counting fences the CommonMark way would misjudge each of these (BlockNote parses them into 1-3 blocks) as too_many_blocks.
  const FENCE_HEADS: Array<[string, string]> = [
    ["info string containing a backtick (BlockNote still opens the fence)", "``` a`b\n\n"],
    ["NBSP after the closing fence", "```\ncode\n```\u00a0\n\nZed\n\n```\n\n"],
    ["``` at the start of a table row", "a | b\n--|--\n```|x\n```\n\n"],
    ["indented fence in a paragraph continuation line", "Lead\n  ```\n```\n\n"],
    ["indented fence in a blockquote lazy continuation line", "> q\n  ```\n```\n\n"],
    ["fence in a list item closed at column 0", "- item\n  ```\n  code\n```\n\n"],
  ];
  for (const [name, head] of FENCE_HEADS) {
    it(`${name} + ${MAX_BLOCKS + 10} paragraphs -> parses normally (not misjudged by the first layer)`, async () => {
      const md = head + Array.from({ length: MAX_BLOCKS + 10 }, (_, k) => `Para ${k}`).join("\n\n");
      const { r } = await parseCounting(md);
      expect(r, name).not.toHaveProperty("error");
      expect((r as { blocks: unknown[] }).blocks.length, name).toBeLessThanOrEqual(MAX_BLOCKS);
    }, 60_000);
  }

  it("3,000 paragraphs inside a code fence -> one code block, parses normally (the first layer doesn't count what is inside a fence)", async () => {
    const md = "```\n" + paras(3_000) + "\n```";
    expect(md.length).toBeGreaterThan(BLOCK_PRECHECK_MIN_CHARS);
    const { r, calls } = await parseCounting(md);
    expect(calls).toBe(1);
    expect((r as { blocks: Array<{ type: string }> }).blocks.map(b => b.type)).toEqual(["codeBlock"]);
  }, 60_000);
});
