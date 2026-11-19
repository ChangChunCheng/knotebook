// Markdown sent by in-site AI: byte-identical to the server read path for the same blocks. The goldens are shared with the server's `note-markdown-goldens.test.ts`; inputs always go through the note-page schema editor and `ed.document` is serialized.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import { aiMarkdownOf } from "./note-markdown";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyPartial = PartialBlock<any, any, any>;
type GoldenCase = { id: string; roundTrip: string; blocks: AnyPartial[]; markdown: string };
// Under web's vitest `import.meta.url` isn't a file: URL, so compute from the apps/web root (same as columns-css.guard.test.ts).
const goldens = JSON.parse(readFileSync(`${process.cwd()}/../../packages/shared/test-fixtures/note-markdown-goldens.json`, "utf8")) as {
  cases: GoldenCase[];
};

const documentOf = (blocks: AnyPartial[]) => BlockNoteEditor.create({ schema: noteSchema, initialContent: blocks }).document;
const NOTE_ID = "11111111-1111-4111-8111-111111111111";

// Walks the DOM per the HTML fragment serialization algorithm and escapes attributes like a browser (including `<` and `>`), building the string by hand instead of reusing the product regex.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript"]);
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");
function browserInnerHTML(node: Node): string {
  const kids = node instanceof HTMLTemplateElement ? node.content.childNodes : node.childNodes;
  let out = "";
  for (const n of Array.from(kids)) {
    if (n.nodeType === Node.TEXT_NODE) {
      const parent = (node as Element).localName;
      out += RAW_TEXT.has(parent) ? (n as Text).data : escText((n as Text).data);
    } else if (n.nodeType === Node.COMMENT_NODE) {
      out += `<!--${(n as Comment).data}-->`;
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as Element;
      out += `<${el.localName}${Array.from(el.attributes).map((a) => ` ${a.name}="${escAttr(a.value)}"`).join("")}>`;
      if (!VOID.has(el.localName)) out += `${browserInnerHTML(el)}</${el.localName}>`;
    }
  }
  return out;
}

describe("aiMarkdownOf", () => {
  it("goldens are non-empty (the shared file is readable)", () => {
    expect(goldens.cases.length).toBeGreaterThan(20);
  });

  it.each(goldens.cases.map((c) => [c.id, c] as const))("%s: byte-identical to the server read", (_id, c) => {
    const md = aiMarkdownOf(documentOf(c.blocks), () => undefined);
    expect(md, `${c.id} 實際：${JSON.stringify(md)}`).toBe(c.markdown);
  });

  it("wikilink display text is escaped once", () => {
    const blocks = documentOf([
      { type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: NOTE_ID, label: "[Draft]" } }] } as AnyPartial,
    ]);
    const md = aiMarkdownOf(blocks, () => undefined);
    expect(md).toContain(`[\\[Draft\\]](/notes/${NOTE_ID})`);
    expect(md).not.toContain("\\\\\\[");
  });

  it("text color is carried along (incidental behaviour change)", () => {
    const blocks = documentOf([
      { type: "paragraph", content: [{ type: "text", text: "red", styles: { textColor: "red" } }, { type: "text", text: " plain", styles: {} }] },
    ]);
    expect(aiMarkdownOf(blocks, () => undefined)).toContain('<span style="color:red">');
  });

  it("singleton is reusable: calling twice on the same input gives the same result", () => {
    const c = goldens.cases.find((x) => x.id === "G1-cols-spec")!;
    const blocks = documentOf(c.blocks);
    const first = aiMarkdownOf(blocks, () => undefined);
    expect(aiMarkdownOf(blocks, () => undefined)).toBe(first);
    expect(first).toBe(c.markdown);
  });

  it("media URL guard (#43): javascript: URL is sent as about:blank", () => {
    const blocks = documentOf([{ type: "image", props: { url: "javascript:alert(1)", name: "x", previewWidth: 300 } }]);
    const md = aiMarkdownOf(blocks, () => undefined);
    expect(md).not.toContain("javascript:");
    expect(md).toContain("about:blank");
  });

  it("all goldens still match under browser attribute serialization (`<` and `>` written as &lt; and &gt;, as in Chromium/Firefox/WebKit)", () => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
    const original = (el: Element) => desc.get!.call(el) as string;
    Object.defineProperty(Element.prototype, "innerHTML", { ...desc, get(this: Element) { return browserInnerHTML(this); } });
    try {
      const probe = document.createElement("div");
      probe.innerHTML = '<img alt="<c>">';
      expect(probe.innerHTML).toBe('<img alt="&lt;c&gt;">'); // confirms the simulated serialization really applies
      // Simulator fidelity: when attribute values contain no `<` or `>`, output is character-identical to jsdom.
      probe.innerHTML = '<p data-x="a&quot;b&amp;">x &amp; "y"   &lt;z&gt;</p><table><tbody><tr><td colwidth="120,">a</td></tr></tbody></table><img src="/u"><br><pre><code>a\nb</code></pre><!--c--><style>a<b</style>';
      expect(browserInnerHTML(probe)).toBe(original(probe));
      for (const c of goldens.cases) expect(aiMarkdownOf(documentOf(c.blocks), () => undefined), c.id).toBe(c.markdown);
    } finally {
      Object.defineProperty(Element.prototype, "innerHTML", desc);
    }
  });

  it("titleOf: wikilink with an empty label sends the current title", () => {
    const blocks = documentOf([
      { type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: NOTE_ID, snapshotTitle: "Old" } }] } as AnyPartial,
    ]);
    expect(aiMarkdownOf(blocks, (id) => (id === NOTE_ID ? "Now" : undefined))).toBe(`[Now](/notes/${NOTE_ID})\n`);
  });
});
