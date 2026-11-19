import { describe, expect, it } from "vitest";
import DOMPurify from "dompurify";

// The default singleton isn't polluted. Don't import ./sanitize at top level in this file: the baseline must be measured before the import.
describe("DOMPurify default singleton isn't polluted by present/sanitize (mermaid shares it)", () => {
  it("after importing and running our sanitizer once, the default singleton gives byte-identical results for two inputs", async () => {
    const svgInput = '<svg><a href="https://x">t</a></svg>';
    const dataImg = '<img src="data:image/png;base64,AAA">';
    const before = [
      DOMPurify.sanitize(svgInput, { USE_PROFILES: { svg: true } }),
      DOMPurify.sanitize(dataImg),
    ];
    expect(before[1]).toContain('src="data:image/png;base64,AAA"'); // The baseline itself must keep the data: src, otherwise the comparison below can't discriminate

    const { sanitizeSlideFragment } = await import("./sanitize");
    sanitizeSlideFragment(`<p>x</p>${dataImg}<span href="https://e">y</span>`);

    const after = [
      DOMPurify.sanitize(svgInput, { USE_PROFILES: { svg: true } }),
      DOMPurify.sanitize(dataImg),
    ];
    expect(after).toEqual(before);
  });
});
