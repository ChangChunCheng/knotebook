import { describe, expect, it } from "vitest";
import * as shared from "./index.js";
import { unescapeAttributeAngles } from "./serialized-html.js";

// Serialisation differences for `<` / `>` in attribute values (Chromium 151 / Firefox 153 / WebKit 26.5 escape them, jsdom 30 does not): both inputs must end up in the jsdom shape.
describe("unescapeAttributeAngles", () => {
  it("a browser-shaped attribute value is restored to the literal and equals the jsdom shape (golden)", () => {
    const browser = '<figure><img alt="a &quot;b&quot; &amp; &lt;c&gt;" src="/api/uploads/u5?a=1&amp;b=2" width="300"><figcaption>x &amp; "y"</figcaption></figure>';
    const jsdom = '<figure><img alt="a &quot;b&quot; &amp; <c>" src="/api/uploads/u5?a=1&amp;b=2" width="300"><figcaption>x &amp; "y"</figcaption></figure>';
    expect(unescapeAttributeAngles(browser)).toBe(jsdom);
    expect(unescapeAttributeAngles(jsdom)).toBe(jsdom);
  });

  it("&lt; / &gt; in text are untouched, even when they look like an attribute", () => {
    const html = '<p>k="&lt;b&gt;" &lt;i x="&lt;"&gt;</p><td colwidth="120">&lt;a&gt; &amp; "q"</td>';
    expect(unescapeAttributeAngles(html)).toBe(html);
  });

  it("a literal &amp;lt; inside an attribute value is not replaced by mistake; several attributes and several tags are all replaced", () => {
    expect(unescapeAttributeAngles('<img alt="&amp;lt; &lt;" src="/x?q=&gt;"><a href="/y&lt;">t &lt;</a>')).toBe('<img alt="&amp;lt; <" src="/x?q=>"><a href="/y<">t &lt;</a>');
  });

  it("with a raw-text element the input is returned as is (content is not escaped, replacing would create new markup)", () => {
    const html = '<style><a x="&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;"></style>';
    expect(unescapeAttributeAngles(html)).toBe(html);
  });

  it.each(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext", "textarea", "title"])(
    "%s: with this raw-text element the input is returned as is",
    (tag) => {
      const html = `<img alt="&lt;"><${tag}><a x="&lt;"></${tag}>`;
      expect(unescapeAttributeAngles(html)).toBe(html);
    },
  );

  it("with a comment the input is returned as is (comment content is serialised as is)", () => {
    const html = '<img alt="&lt;"><!--<b x="&lt;">-->';
    expect(unescapeAttributeAngles(html)).toBe(html);
  });

  it("not a public export of @knotebook/shared (the precondition only holds for toBlockHTML's input)", () => {
    expect("unescapeAttributeAngles" in shared).toBe(false);
  });
});
