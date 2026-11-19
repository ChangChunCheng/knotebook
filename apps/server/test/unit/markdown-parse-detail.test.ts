import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { syntaxCheckRoot } from "@knotebook/shared";
import { DROPPED_SELECTOR, DROPPED_TAGS, hasDroppedElement, parseMarkdownForNote } from "../../src/notes/editing/markdown.js";

/** The failure causes of `parseMarkdownForNote` (`detail`), and "elements that get dropped are rejected as a whole wherever they are". */
const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
async function parse(md: string) {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    return parseMarkdownForNote(s.editor, md, [], "http://localhost");
  } finally {
    s.close();
  }
}
const DROPPED = { error: "unsupported_block", detail: "dropped_element" };

describe("parse failure causes", () => {
  it("event attribute -> unsupported_block/event_attr; editor-internal HTML -> editor_internal", async () => {
    expect(await parse("<img src=x onerror=alert(1)>")).toEqual({ error: "unsupported_block", detail: "event_attr" });
    expect(await parse('<div data-content-type="paragraph">x</div>')).toEqual({ error: "unsupported_block", detail: "editor_internal" });
  });
  it("<script>/<style>/<iframe>/<object>/<noscript>/<title>/<template>: when they are all there is -> dropped_element (not empty_content)", async () => {
    for (const md of ["<script>alert(1)</script>", "<style>p{}</style>", '<iframe src="https://x"></iframe>', '<object data="x"></object>', "<noscript>hello</noscript>", "<title>hello</title>", "<template>hello</template>"]) expect(await parse(md), md).toEqual(DROPPED);
  });
  it("mixed with other content, inline, or inside a list or column also rejects the whole write (not silently removed together with the text inside)", async () => {
    const cases = [
      "para\n\n<script>alert(1)</script>",
      "<style>p{}</style>\n\npara",
      'text <iframe src="https://x"></iframe> more',
      "- item <script>x</script>",
      "para <noscript>hello</noscript>",
      "para <title>hello</title>",
      "> quote <template>hello</template>",
      '<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\na <object data="x"></object>\n\n</div>\n<div data-kb-column style="flex:1">\n\nb\n\n</div>\n</div>\n',
    ];
    for (const md of cases) expect(await parse(md), md).toEqual(DROPPED);
  });
  it("a <script> inside an HTML comment or in code doesn't count; <embed> parses into a file block and isn't rejected", async () => {
    expect(await parse("<!-- <script>x</script> -->")).toEqual({ error: "empty_content" });
    for (const md of ["para <!-- <script>x</script> -->", "`<script>x</script>`", "```html\n<script>x</script>\n```"]) expect("error" in (await parse(md)), md).toBe(false);
    // an escaped `<` (backslash + `<`) is a literal `<`: `\<script>x` is ordinary paragraph text, not an element
    const escaped = await parse("\\<script>x");
    expect("error" in escaped).toBe(false);
    if (!("error" in escaped)) expect(escaped.blocks.map(b => b.content)).toEqual([[{ type: "text", text: "<script>x", styles: {} }]]);
    const embed = await parse('<embed src="https://example.com/a.pdf">');
    expect("error" in embed).toBe(false);
    if (!("error" in embed)) expect(embed.blocks.map(b => b.type)).toEqual(["file"]);
  });
  it("an unclosed <!-- swallows everything -> empty_content/unclosed_comment (a <script> swallowed inside doesn't count); truly empty -> empty_content with no detail", async () => {
    expect(await parse("<!-- open")).toEqual({ error: "empty_content", detail: "unclosed_comment" });
    expect(await parse("<!-- open <script>x</script>")).toEqual({ error: "empty_content", detail: "unclosed_comment" });
    expect(await parse("   ")).toEqual({ error: "empty_content" });
  });
});

describe("the string pre-screen doesn't change the result", () => {
  // The pre-screen is only a shortcut: every shape is compared with "build the DOM and query DROPPED_SELECTOR", and the two must agree
  const inputs = [
    "<p><script>x</script></p>", "<p><SCRIPT>x</SCRIPT></p>", "<p><ScRiPt src=x></p>", "<p><Title>t</Title></p>", "<TEMPLATE>t</TEMPLATE>", "<p><NoScript>n</NoScript></p>",
    "<p><svg><script>x</script></svg></p>", "<p><svg><style>x</style></svg></p>", "<p><svg><title>x</title></svg></p>", "<p><math><style>x</style></math></p>",
    "<p><code>&lt;script&gt;x&lt;/script&gt;</code></p>", "<pre><code>&lt;style&gt;&lt;/style&gt;</code></pre>", "<p>&amp;lt;script&amp;gt;</p>",
    "<p><script-x>hi</script-x></p>", "<p><scripted>hi</scripted></p>", "<p><x-title>hi</x-title></p>", "<!-- <script>x</script> --><p>a</p>", "<p>text &lt;script</p>",
    "<p>plain</p>", "",
  ];
  it("the pre-screened decision equals querying the DOM, shape by shape; elements in different case, in SVG/MathML are hit; inline code, code blocks, escaped characters, comments and custom elements are not", () => {
    const direct = (html: string) => syntaxCheckRoot(html).querySelector(DROPPED_SELECTOR) !== null;
    for (const html of inputs) expect(hasDroppedElement(html), html).toBe(direct(html));
    expect(inputs.filter(hasDroppedElement)).toEqual(inputs.slice(0, 10));
  });
  it("there is a single list: the selector covers all of DROPPED_TAGS", () => {
    expect(DROPPED_SELECTOR.split(", ")).toEqual([...DROPPED_TAGS]);
    for (const t of DROPPED_TAGS) expect(hasDroppedElement(`<p>a <${t}>b</${t}></p>`), t).toBe(true);
  });
});
