import { afterEach, describe, expect, it } from "vitest";
import { COLUMN_TYPE } from "@knotebook/shared";
import { IMG, P, mountEditor, row, withChildren, type PartialBlockLike } from "@/test/columns-fixtures";
import { columnKindOf, shouldStack, type PMNodeLike } from "./layout";

describe("shouldStack: sum of column minimum widths + gutters > available width -> stack", () => {
  it("two text columns: 200+24+200 = 424", () => {
    expect(shouldStack(["text", "text"], 423)).toBe(true);
    expect(shouldStack(["text", "text"], 424)).toBe(false);
  });
  it("two image columns: 96+24+96 = 216", () => {
    expect(shouldStack(["image", "image"], 216)).toBe(false);
    expect(shouldStack(["image", "image"], 215)).toBe(true);
  });
  it("four text columns: 4x200+3x24 = 872", () => {
    expect(shouldStack(["text", "text", "text", "text"], 872)).toBe(false);
    expect(shouldStack(["text", "text", "text", "text"], 871)).toBe(true);
  });
  it("available width 0 or negative (not laid out, hidden) -> not stacked", () => {
    expect(shouldStack(["text", "text"], 0)).toBe(false);
    expect(shouldStack(["text", "text"], -5)).toBe(false);
  });
});

describe("columnKindOf", () => {
  let destroy: (() => void) | undefined;
  afterEach(() => destroy?.());

  function columnsOf(cols: PartialBlockLike[][]): PMNodeLike[] {
    const mounted = mountEditor([P("x", "x0"), row(cols, "r"), P("z", "z9")]);
    destroy = mounted.destroy;
    const out: PMNodeLike[] = [];
    mounted.editor.prosemirrorView!.state.doc.descendants((node) => {
      if (node.type.name === COLUMN_TYPE) out.push(node as unknown as PMNodeLike);
    });
    return out;
  }

  it("all images -> image; image + paragraph -> text; a single empty paragraph -> text", () => {
    const [allImages, mixed, empty] = columnsOf([[IMG("i1"), IMG("i2")], [IMG("i3"), P("t", "t1")], [P("", "e1")]]);
    expect(columnKindOf(allImages)).toBe("image");
    expect(columnKindOf(mixed)).toBe("text");
    expect(columnKindOf(empty)).toBe("text");
  });

  it("paragraph first, image after -> text (not just the first block)", () => {
    const [col] = columnsOf([[P("t", "t1"), IMG("i1")], [P("b", "b1")]]);
    expect(columnKindOf(col)).toBe("text");
  });

  it("text indented under an image -> text (the column isn't image-only)", () => {
    const [col] = columnsOf([[withChildren(IMG("i1"), [P("k", "k1")])], [P("b", "b1")]]);
    expect(columnKindOf(col)).toBe("text");
  });

  it("image with showPreview:false (drawn as a file row, exported as <a> in slides) -> text", () => {
    const noPreview = { ...IMG("i1"), props: { ...IMG("i1").props, showPreview: false } } as PartialBlockLike;
    const [col, preview] = columnsOf([[noPreview], [IMG("i2")]]);
    expect(columnKindOf(col)).toBe("text");
    expect(columnKindOf(preview)).toBe("image");
  });
});
