// This repo patches @blocknote/core so that `\<` is an escape (patches/@blocknote__core@0.52.1.patch);
// if this fails after upgrading BlockNote, regenerate that patch.
import { markdownToHTML } from "@blocknote/core";
import { describe, expect, it } from "vitest";

describe("markdownToHTML: backslash + < is a literal <", () => {
  const rows: [string, string, string][] = [
    ["\\<b>x\\</b>", "<p>&lt;b&gt;x&lt;/b&gt;</p>", "escaped tags"],
    ["\\<!-- c -->", "<p>&lt;!-- c --&gt;</p>", "escaped comment"],
    ["\\<div>x\\</div>", "<p>&lt;div&gt;x&lt;/div&gt;</p>", "escaped div stays a paragraph"],
    ["`\\<b>`", "<p><code>\\&lt;b&gt;</code></p>", "inline code keeps the backslash"],
    ["```\n\\<b>\n```", "<pre><code>\\&lt;b&gt;</code></pre>", "fence keeps the backslash"],
    ["\\\\<b>x</b>", "<p>\\<b>x</b></p>", "escaped backslash then a real tag"],
    ["<b>x</b>", "<p><b>x</b></p>", "unescaped input unchanged"],
    ["&lt;b&gt;", "<p>&amp;lt;b&amp;gt;</p>", "entities stay literal"],
  ];
  for (const [input, expected, name] of rows) {
    it(name, async () => {
      expect(await markdownToHTML(input)).toBe(expected);
    });
  }
});
