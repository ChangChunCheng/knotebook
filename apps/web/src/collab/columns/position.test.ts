import { afterEach, describe, expect, it } from "vitest";
import { P, mountEditor, row, textPos, withChildren, type AnyEditor } from "@/test/columns-fixtures";
import { columnContextOf, findNodeById, isTopLevelPosition } from "./position";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

// x、[a,q｜b]、y{k}、z
function mount(): AnyEditor {
  const m = mountEditor([
    P("x", "x0"),
    row([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]], "r"),
    withChildren(P("y", "y1"), [P("k", "k1")]),
    P("z", "z9"),
  ]);
  cleanups.push(m.destroy);
  return m.editor;
}

const docOf = (editor: AnyEditor) => editor.prosemirrorView!.state.doc;
const at = (editor: AnyEditor, pos: number) => docOf(editor).resolve(pos);
const posOf = (editor: AnyEditor, id: string, type?: string) => findNodeById(docOf(editor), id, type)!.pos;

describe("PO1 isTopLevelPosition", () => {
  it("頂層段落文字內 → true", () => {
    const editor = mount();
    expect(isTopLevelPosition(at(editor, textPos(editor, "x", 1)))).toBe(true);
  });
  it("欄內段落文字內 → false", () => {
    const editor = mount();
    expect(isTopLevelPosition(at(editor, textPos(editor, "b", 1)))).toBe(false);
  });
  it("頂層段落的子 block 文字內 → false", () => {
    const editor = mount();
    expect(isTopLevelPosition(at(editor, textPos(editor, "k", 1)))).toBe(false);
  });
  it("column 節點內、block 之間 → false", () => {
    const editor = mount();
    const q = findNodeById(docOf(editor), "q1", "blockContainer")!;
    const $pos = at(editor, q.pos);
    expect($pos.parent.type.name).toBe("column");
    expect(isTopLevelPosition($pos)).toBe(false);
  });
  it("欄與欄之間（columnList 內）→ false", () => {
    const editor = mount();
    const $pos = at(editor, posOf(editor, "rc1", "column"));
    expect($pos.parent.type.name).toBe("columnList");
    expect(isTopLevelPosition($pos)).toBe(false);
  });
  it("頂層 block 之間（depth 1）→ true", () => {
    const editor = mount();
    const $pos = at(editor, posOf(editor, "r", "columnList"));
    expect($pos.depth).toBe(1);
    expect(isTopLevelPosition($pos)).toBe(true);
  });
});

describe("PO2 columnContextOf", () => {
  it("第 2 欄第 1 顆文字內 → colIndex 1、blockIndex 0", () => {
    const editor = mount();
    const ctx = columnContextOf(at(editor, textPos(editor, "b", 0)))!;
    expect(ctx).not.toBeNull();
    expect({ colIndex: ctx.colIndex, blockIndex: ctx.blockIndex }).toEqual({ colIndex: 1, blockIndex: 0 });
    expect([ctx.list.attrs.id, ctx.col.attrs.id, ctx.block.attrs.id]).toEqual(["r", "rc1", "b1"]);
    expect(ctx.listPos).toBe(posOf(editor, "r", "columnList"));
    expect(docOf(editor).resolve(textPos(editor, "b", 0)).node(ctx.colDepth).attrs.id).toBe("rc1");
    expect(ctx.listDepth).toBe(ctx.colDepth - 1);
  });
  it("第 1 欄第 2 顆 → colIndex 0、blockIndex 1", () => {
    const editor = mount();
    const ctx = columnContextOf(at(editor, textPos(editor, "q", 1)))!;
    expect({ colIndex: ctx.colIndex, blockIndex: ctx.blockIndex, id: ctx.block.attrs.id }).toEqual({ colIndex: 0, blockIndex: 1, id: "q1" });
  });
  it("欄內 block 的子 block 文字內 → null", () => {
    const m = mountEditor([P("x", "x0"), row([[P("a", "a1")], [withChildren(P("b", "b1"), [P("k", "k1")])]], "r"), P("z", "z9")]);
    cleanups.push(m.destroy);
    expect(columnContextOf(at(m.editor, textPos(m.editor, "k", 0)))).toBeNull();
  });
  it("頂層 → null", () => {
    const editor = mount();
    expect(columnContextOf(at(editor, textPos(editor, "x", 0)))).toBeNull();
  });
});

describe("findNodeById", () => {
  it("依 id 與型別找節點；找不到回 null", () => {
    const editor = mount();
    const doc = docOf(editor);
    const hit = findNodeById(doc, "rc1")!;
    expect(hit.node.type.name).toBe("column");
    expect(doc.nodeAt(hit.pos)!.attrs.id).toBe("rc1");
    expect(findNodeById(doc, "r", "column")).toBeNull();
    expect(findNodeById(doc, "nope")).toBeNull();
  });
});
