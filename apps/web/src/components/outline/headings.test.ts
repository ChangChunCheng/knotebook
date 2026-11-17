import { describe, expect, it } from "vitest";
import {
  extractHeadings,
  headingPlainText,
  sameHeadings,
  type OutlineBlockLike,
  type OutlineHeading,
} from "./headings";

const h = (id: string, level: number, text: string, extra: Partial<OutlineBlockLike> = {}): OutlineBlockLike => ({
  id,
  type: "heading",
  props: { level },
  content: [{ type: "text", text }],
  ...extra,
});

describe("extractHeadings", () => {
  it("keeps only H1-H3 from a mixed document", () => {
    const blocks: OutlineBlockLike[] = [
      h("a", 1, "One"),
      h("b", 2, "Two"),
      h("c", 3, "Three"),
      h("d", 4, "Four"),
      { id: "e", type: "paragraph", content: [{ type: "text", text: "body" }] },
    ];
    expect(extractHeadings(blocks)).toEqual([
      { id: "a", level: 1, text: "One" },
      { id: "b", level: 2, text: "Two" },
      { id: "c", level: 3, text: "Three" },
    ]);
  });

  it("walks columns in order, then continues with the following top-level block", () => {
    const blocks: OutlineBlockLike[] = [
      {
        id: "cl",
        type: "columnList",
        children: [
          { id: "c1", type: "column", children: [h("l", 2, "Left")] },
          { id: "c2", type: "column", children: [h("r", 2, "Right")] },
        ],
      },
      h("z", 1, "After"),
    ];
    expect(extractHeadings(blocks).map((x) => x.text)).toEqual(["Left", "Right", "After"]);
  });

  it("descends into list items and toggle headings, parent before children", () => {
    const blocks: OutlineBlockLike[] = [
      {
        id: "li",
        type: "bulletListItem",
        children: [h("in-list", 2, "In list")],
      },
      h("tog", 1, "Toggle", { props: { level: 1, isToggleable: true }, children: [h("in-toggle", 3, "Inner")] }),
    ];
    expect(extractHeadings(blocks).map((x) => x.id)).toEqual(["in-list", "tog", "in-toggle"]);
  });

  it("ignores headings with a missing or unsupported level", () => {
    const blocks: OutlineBlockLike[] = [
      { id: "x", type: "heading", content: [] },
      { id: "y", type: "heading", props: { level: 7 }, content: [] },
      { id: "z", type: "heading", props: { level: "2" }, content: [] },
    ];
    expect(extractHeadings(blocks)).toEqual([]);
  });
});

describe("headingPlainText", () => {
  it("joins text, link content and wikilink labels", () => {
    expect(
      headingPlainText([
        { type: "text", text: "Install " },
        { type: "link", href: "x", content: [{ type: "text", text: "guide" }] },
        { type: "wikilink", props: { label: "", snapshotTitle: "Setup" } },
      ]),
    ).toBe("Install guideSetup");
  });

  it("prefers the wikilink label over its snapshot title", () => {
    expect(headingPlainText([{ type: "wikilink", props: { label: "Shown", snapshotTitle: "Old" } }])).toBe("Shown");
  });

  it("collapses whitespace and trims", () => {
    expect(headingPlainText([{ type: "text", text: "  a \n b " }])).toBe("a b");
  });

  it("returns an empty string for empty, non-array and table content", () => {
    expect(headingPlainText([])).toBe("");
    expect(headingPlainText({ type: "tableContent" })).toBe("");
    expect(headingPlainText(undefined)).toBe("");
  });
});

describe("sameHeadings", () => {
  const base: OutlineHeading[] = [
    { id: "a", level: 1, text: "A" },
    { id: "b", level: 2, text: "B" },
  ];
  const copy = () => base.map((x) => ({ ...x }));

  it("is true for equal content in different arrays", () => {
    expect(sameHeadings(base, copy())).toBe(true);
  });

  it("is false when length, id, level or text differ", () => {
    expect(sameHeadings(base, base.slice(0, 1))).toBe(false);
    const id = copy();
    id[1]!.id = "q";
    expect(sameHeadings(base, id)).toBe(false);
    const level = copy();
    level[1]!.level = 3;
    expect(sameHeadings(base, level)).toBe(false);
    const text = copy();
    text[0]!.text = "Z";
    expect(sameHeadings(base, text)).toBe(false);
  });
});
