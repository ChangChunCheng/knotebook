import { describe, expect, it } from "vitest";
import { COVER_ID, noteToSlides, type Section, type SlideBlock } from "./slides";

// Fixtures carry only the fields noteToSlides reads.
const p = (id: string, text = "t", children: SlideBlock[] = []): SlideBlock => ({
  id, type: "paragraph", props: {}, content: text === "" ? [] : [{ type: "text", text, styles: {} }], children,
});
const blank = (id: string): SlideBlock => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text: "  ", styles: {} }], children: [] });
const h = (id: string, level: number, children: SlideBlock[] = [], extra: Record<string, unknown> = {}): SlideBlock => ({
  id, type: "heading", props: { level, ...extra }, content: [{ type: "text", text: id, styles: {} }], children,
});
const d = (id: string): SlideBlock => ({ id, type: "divider", props: {}, children: [] });

/** `section:[slide(block ids other than the title in that slide), ...]`, sections separated by two spaces - the cover section is always listed. */
function show(sections: Section[]): string {
  return sections
    .map((s) => `${s.id}:[${s.slides
      .map((slide) => {
        const rest = slide.blocks.filter((b) => b.id !== slide.id).map((b) => b.id);
        return rest.length > 0 ? `${slide.id}(${rest.join(",")})` : slide.id;
      })
      .join(", ")}]`)
    .join("  ");
}

describe("noteToSlides: table (the cover section is always kept)", () => {
  it.each<[string, SlideBlock[], string]>([
    ["paragraph a; H2 x; paragraph b; H3 y; H4 z; paragraph c", [p("a"), h("x", 2), p("b"), h("y", 3), h("z", 4), p("c")], "_title:[_title(a)]  x:[x(b), y(z,c)]"],
    ["H1 x; H2 y; H3 z", [h("x", 1), h("y", 2), h("z", 3)], "_title:[_title]  x:[x, y(z)]"],
    ["H3 x; H3 y", [h("x", 3), h("y", 3)], "_title:[_title]  x:[x]  y:[y]"],
    ["H2 s; H1 x (a lower-level heading before the first section title attaches to the cover section)", [h("s", 2), h("x", 1)], "_title:[_title, s]  x:[x]"],
    ["H1 x; divider d; paragraph a; divider e; empty paragraph (section e is entirely empty and skipped)", [h("x", 1), d("d"), p("a"), d("e"), blank("b0")], "_title:[_title]  x:[x]  d:[d(a)]"],
    ["H2 a; divider d; H3 y; paragraph b (d is empty and skipped, the section ID becomes y)", [h("a", 2), d("d"), h("y", 3), p("b")], "_title:[_title]  a:[a]  y:[y(b)]"],
    ["H1 x; H3 z (no H2: the next level is the second highest)", [h("x", 1), h("z", 3)], "_title:[_title]  x:[x, z]"],
    ["toggle H1 x (with child blocks)", [h("x", 1, [p("c1"), p("c2")], { isToggleable: true })], "_title:[_title]  x:[x]"],
    ["no title, no divider", [p("a"), p("b")], "_title:[_title(a,b)]"],
  ])("%s", (_name, blocks, expected) => {
    expect(show(noteToSlides("T", blocks))).toBe(expected);
  });

  it("children of a toggle heading follow the parent block (top level only): the children are in blocks[0].children, not in that slide's blocks", () => {
    const sections = noteToSlides("T", [h("x", 1, [p("c1")], { isToggleable: true })]);
    const slide = sections[1].slides[0];
    expect(slide.blocks.map((b) => b.id)).toEqual(["x"]);
    expect((slide.blocks[0].children ?? []).length).toBe(1);
  });

  it("an ordinary paragraph with children: stays whole on the same slide, children don't open a new slide", () => {
    expect(show(noteToSlides("T", [h("x", 2), p("a", "t", [h("nested", 2)])]))).toBe("_title:[_title]  x:[x(a)]");
  });

  it("dividers only: every divider's section is empty -> only the cover remains", () => {
    expect(show(noteToSlides("T", [d("d1"), d("d2")]))).toBe("_title:[_title]");
  });

  it("content between consecutive dividers: only sections with content remain", () => {
    expect(show(noteToSlides("T", [d("d1"), d("d2"), p("a")]))).toBe("_title:[_title]  d2:[d2(a)]");
  });

  it("empty paragraphs only: the cover keeps them (the cover is never skipped)", () => {
    expect(show(noteToSlides("T", [blank("b1"), p("b2", "")]))).toBe("_title:[_title(b1,b2)]");
  });

  it("an empty title string doesn't affect slide splitting (the render layer fills in the title)", () => {
    expect(show(noteToSlides("", [h("x", 2)]))).toBe("_title:[_title]  x:[x]");
  });

  it("a heading slide is never empty: kept even when it has only a title and an empty body", () => {
    expect(show(noteToSlides("T", [h("x", 2), blank("b")]))).toBe("_title:[_title]  x:[x(b)]");
  });

  it("cover ID is always _title with kind cover; a divider slide has kind divider and the divider itself isn't in blocks", () => {
    const sections = noteToSlides("T", [d("d"), p("a")]);
    expect(sections[0].slides[0]).toMatchObject({ id: COVER_ID, kind: "cover" });
    expect(sections[1].slides[0]).toMatchObject({ id: "d", kind: "divider" });
    expect(sections[1].slides[0].blocks.map((b) => b.id)).toEqual(["a"]);
  });

  it("a title slide has kind heading (the slide that starts with a heading block, neither cover nor divider)", () => {
    const sections = noteToSlides("T", [h("x", 2), p("a"), h("y", 3), p("b")]);
    expect(sections[0].slides[0].kind).toBe("cover");
    expect(sections[1].slides.map((slide) => [slide.id, slide.kind])).toEqual([["x", "heading"], ["y", "heading"]]);
  });

  it("a paragraph with a link / wikilink isn't blank (inline content isn't only text)", () => {
    const withLink: SlideBlock = { id: "l", type: "paragraph", props: {}, content: [{ type: "link", href: "https://x", content: [] }], children: [] };
    expect(show(noteToSlides("T", [d("d"), withLink]))).toBe("_title:[_title]  d:[d(l)]");
  });

  it("a heading inside a row's column doesn't split slides (top level only)", () => {
    const col = (id: string, children: SlideBlock[]): SlideBlock => ({ id, type: "column", props: { width: 1 }, children });
    const row: SlideBlock = { id: "r", type: "columnList", props: {}, children: [col("rc0", [h("in", 1), p("a")]), col("rc1", [p("b")])] };
    expect(show(noteToSlides("T", [h("A", 1), row]))).toBe("_title:[_title]  A:[A(r)]");
  });
});
