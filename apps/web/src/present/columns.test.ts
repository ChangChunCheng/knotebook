import { afterEach, describe, expect, it } from "vitest";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { IMG, P, row, type PartialBlockLike } from "@/test/columns-fixtures";
import { markStackedColumnRows, restackSlideBody } from "./columns";
import { createExportEditor, renderDeck } from "./render";

const TEXT_ROW = '<div data-kb-columns="" style="display:flex;gap:16px"><div data-kb-column="" style="flex:1"><p>A</p></div><div data-kb-column="" style="flex:1"><p>B</p></div></div>';
const IMAGE_ROW =
  '<div data-kb-columns="" style="display:flex;gap:16px">' +
  '<div data-kb-column="" style="flex:1"><figure><img src="/a.png" alt="a"></figure></div>' +
  '<div data-kb-column="" style="flex:1"><figure><img src="/b.png" alt="b"></figure></div></div>';

function body(html: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "kn-slide-body";
  el.innerHTML = html;
  return el;
}

const stacked = (root: ParentNode) => root.querySelector("[data-kb-columns]")!.hasAttribute("data-stacked");

describe("present/columns: markStackedColumnRows", () => {
  it("two text columns, width 423 -> data-stacked; re-marking at 424 removes it", () => {
    const root = body(TEXT_ROW);
    markStackedColumnRows(root, 423);
    expect(stacked(root)).toBe(true);
    markStackedColumnRows(root, 424);
    expect(stacked(root)).toBe(false);
  });

  it("two columns that only hold <figure><img>, width 300 -> not stacked (image columns are 96px)", () => {
    const root = body(IMAGE_ROW);
    markStackedColumnRows(root, 300);
    expect(stacked(root)).toBe(false);
  });

  it("width 0 (unmeasurable) -> untouched: unmarked stays unmarked, marked stays marked", () => {
    const root = body(TEXT_ROW);
    markStackedColumnRows(root, 0);
    expect(stacked(root)).toBe(false);
    markStackedColumnRows(root, 423);
    markStackedColumnRows(root, 0);
    expect(stacked(root)).toBe(true);
  });
});

describe("present/columns: real exported slide HTML", () => {
  const exported = (blocks: PartialBlockLike[]) => {
    const editor = createExportEditor();
    const doc = blocksToYDoc(editor, blocks as never, YDOC_FRAGMENT);
    const [cover] = renderDeck({ editor, doc, title: "T", titlePlaceholder: "U", ctx: { resolveMedia: (url) => url, wikilinks: { kind: "public" } } });
    const root = document.createElement("div");
    root.append(cover.slides[0].content!.fragment);
    return root;
  };

  it("image columns (image block exported as figure/img) at width 300 don't stack; a text row of the same width does", () => {
    const images = exported([row([[IMG("i1")], [IMG("i2")]], "row")]);
    markStackedColumnRows(images, 300);
    expect(images.querySelectorAll("[data-kb-column] img")).toHaveLength(2);
    expect(stacked(images)).toBe(false);
    const texts = exported([row([[P("a", "a")], [P("b", "b")]], "row")]);
    markStackedColumnRows(texts, 300);
    expect(stacked(texts)).toBe(true);
  });
});

describe("present/columns: restackSlideBody", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("body not attached to the document (isConnected false) -> untouched even when clientWidth is 300", () => {
    const root = body(TEXT_ROW);
    Object.defineProperty(root, "clientWidth", { value: 300, configurable: true });
    restackSlideBody(root);
    expect(stacked(root)).toBe(false);
    document.body.append(root);
    restackSlideBody(root);
    expect(stacked(root)).toBe(true);
  });
});
