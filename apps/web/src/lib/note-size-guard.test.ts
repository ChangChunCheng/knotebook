import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  PER_ELEMENT_BYTES,
  PER_INLINE_NODE_BYTES,
  PER_MARK_BYTES,
  createNoteSizeGuard,
  createNoteSizePasteHandlers,
  estimateBlocksBytes,
  estimatePmBytes,
  exceedsNoteLimit,
  formatNoteLimit,
  noteStateBytes,
  utf8Bytes,
} from "./note-size-guard";

function docOf(text: string): Y.Doc {
  const d = new Y.Doc();
  d.getText("t").insert(0, text);
  return d;
}
const text = (s: string, marks: Array<{ attrs?: Record<string, unknown> }> = []) => ({ isText: true, text: s, marks });
const el = (children: unknown[], isInline = false, type = "paragraph", attrs: Record<string, unknown> = {}) => ({
  isText: false,
  isInline,
  type: { name: type },
  attrs,
  marks: [],
  content: { forEach: (f: (c: never) => void) => children.forEach(c => f(c as never)) },
});
const slice = (nodes: unknown[]) => ({ content: { forEach: (f: (c: never) => void) => nodes.forEach(c => f(c as never)) } });

describe("front-end note size limit check (lib/note-size-guard)", () => {
  it("estimatePmBytes: UTF-8 of text + PER_ELEMENT_BYTES per element node + PER_INLINE_NODE_BYTES per inline node + mark overhead", () => {
    const block = el([el([text("中文ab"), el([], true), text("x", [{ attrs: {} }])])]);
    expect(estimatePmBytes(slice([block]))).toBe(2 * PER_ELEMENT_BYTES + 8 + PER_INLINE_NODE_BYTES + 1 + PER_MARK_BYTES);
    const link = el([el([text("go", [{ attrs: { href: "https://e.com" } }])])]);
    expect(estimatePmBytes(slice([link]))).toBe(2 * PER_ELEMENT_BYTES + 2 + PER_MARK_BYTES + utf8Bytes("href") + utf8Bytes("https://e.com"));
    // Each link attribute with a value counts as key + string value; null ones do not count.
    const link2 = el([el([text("go", [{ attrs: { href: "https://e.com", target: "_blank", class: null } }])])]);
    expect(estimatePmBytes(slice([link2]))).toBe(2 * PER_ELEMENT_BYTES + 2 + PER_MARK_BYTES + utf8Bytes("hrefhttps://e.comtarget_blank"));
  });

  it("estimatePmBytes: string attributes on nodes (mermaid source, URLs; id excluded) count; blockGroup is cheap, a to-do list item costs a bit more", () => {
    const code = "graph TD; " + "A-->B; ".repeat(100);
    const mermaid = el([el([], false, "mermaid", { code, id: "x".repeat(36), textColor: "default" })], false, "blockContainer");
    expect(estimatePmBytes(slice([mermaid]))).toBe(2 * PER_ELEMENT_BYTES + utf8Bytes(code));
    const nested = el([el([text("a")], false, "bulletListItem"), el([el([el([text("b")], false, "bulletListItem")], false, "blockContainer")], false, "blockGroup")], false, "blockContainer");
    expect(estimatePmBytes(slice([nested]))).toBe(4 * PER_ELEMENT_BYTES + 20 + 2);
    const task = el([el([text("t")], false, "checkListItem")], false, "blockContainer");
    expect(estimatePmBytes(slice([task]))).toBe(PER_ELEMENT_BYTES + 130 + 1);
  });

  it("estimateBlocksBytes (in-site AI): each block is two element nodes, a child block adds a blockGroup, a table has one per row and two per cell; a line break counts as an inline node, a code block does not", () => {
    expect(estimateBlocksBytes([{ type: "paragraph", content: [{ type: "text", text: "ab", styles: {} }] }])).toBe(2 * PER_ELEMENT_BYTES + 2);
    expect(estimateBlocksBytes([{ type: "paragraph", content: [{ type: "text", text: "a\nb", styles: { bold: true } }] }])).toBe(2 * PER_ELEMENT_BYTES + 2 + PER_INLINE_NODE_BYTES + PER_MARK_BYTES);
    expect(estimateBlocksBytes([{ type: "codeBlock", content: [{ type: "text", text: "a\nb", styles: {} }] }])).toBe(2 * PER_ELEMENT_BYTES + 3);
    expect(estimateBlocksBytes([{ type: "paragraph", content: [], children: [{ type: "paragraph", content: [] }] }])).toBe(4 * PER_ELEMENT_BYTES + 20);
    expect(estimateBlocksBytes([{ type: "checkListItem", content: [] }])).toBe(PER_ELEMENT_BYTES + 130);
    expect(estimateBlocksBytes([{ type: "mermaid", props: { code: "graph TD; A-->B; B-->C;" } }])).toBe(2 * PER_ELEMENT_BYTES + utf8Bytes("graph TD; A-->B; B-->C;"));
    const table = { type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "x", styles: {} }], { content: [{ type: "text", text: "yy", styles: {} }] }] }] } };
    expect(estimateBlocksBytes([table])).toBe(2 * PER_ELEMENT_BYTES + PER_ELEMENT_BYTES + 2 * 2 * 95 + 3); // each cell and the paragraph inside it cost 95
  });

  it("noteStateBytes: uses the raw size if it does not exceed the threshold; only above it measures the compacted copy (content deleted locally but still retained does not count)", () => {
    const d = new Y.Doc({ gc: false }); // simulates the UndoManager retaining deleted content
    d.getText("t").insert(0, "x".repeat(5_000));
    d.getText("t").delete(0, 4_900);
    const raw = Y.encodeStateAsUpdate(d).byteLength;
    expect(raw).toBeGreaterThan(5_000);
    expect(noteStateBytes(d)).toBe(raw);
    expect(noteStateBytes(d, raw)).toBe(raw); // not above the threshold
    const gced = noteStateBytes(d, raw - 1);
    expect(gced).toBeLessThan(300);
  });

  it("exceedsNoteLimit: blocks only if compacted size + growth > limit; exactly equal does not block; no growth (<= 0) or an unknown limit does not block", () => {
    const d = docOf("x".repeat(100));
    const size = Y.encodeStateAsUpdate(d).byteLength;
    expect(exceedsNoteLimit(d, 10, size + 10)).toBe(false);
    expect(exceedsNoteLimit(d, 11, size + 10)).toBe(true);
    expect(exceedsNoteLimit(d, -50, size - 100)).toBe(false); // shrinking: allowed even if already over the limit
    expect(exceedsNoteLimit(d, 1_000_000, undefined)).toBe(false);
    expect(exceedsNoteLimit(d, 5_001, 5_000), "光是這次就超過：不必量").toBe(true);
    const t = new Y.Doc({ gc: false });
    t.getText("t").insert(0, "y".repeat(5_000));
    t.getText("t").delete(0, 4_900);
    // Tombstones: the raw size would block, the compacted size would not -> allowed.
    expect(exceedsNoteLimit(t, 1_000, 2_000)).toBe(false);
  });

  it("formatNoteLimit: MB / KB, at most one decimal", () => {
    expect(formatNoteLimit(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatNoteLimit(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatNoteLimit(20 * 1024)).toBe("20 KB");
    expect(formatNoteLimit(20_000)).toBe("19.5 KB");
  });

  it("createNoteSizeGuard: over -> notifies (with the limit) and returns true; not over or unknown limit -> false and no notification; reads the document and limit on each call", () => {
    let doc = docOf("x".repeat(100));
    let limit: number | undefined = Y.encodeStateAsUpdate(doc).byteLength + 50;
    const notify = vi.fn();
    const guard = createNoteSizeGuard(() => doc, () => limit, notify);
    expect(guard(50)).toBe(false);
    expect(guard(51)).toBe(true);
    expect(notify).toHaveBeenCalledWith(limit);
    notify.mockClear();
    limit = undefined;
    expect(guard(1_000_000)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    doc = docOf("");
    limit = Y.encodeStateAsUpdate(doc).byteLength + 10;
    expect(guard(10)).toBe(false);
  });

  it("createNoteSizePasteHandlers: paste estimates the slice minus the replaced selection; drop estimates the slice, and an in-site move (moved) is not asked", () => {
    const guard = vi.fn(() => false);
    const h = createNoteSizePasteHandlers(guard);
    const incoming = slice([el([el([text("x".repeat(100))])])]);
    const selected = slice([el([el([text("y".repeat(30))])])]);
    const emptySel = { state: { selection: { empty: true, content: () => selected } } };
    const withSel = { state: { selection: { empty: false, content: () => selected } } };
    h.handlePaste(emptySel, {} as ClipboardEvent, incoming);
    expect(guard).toHaveBeenLastCalledWith(estimatePmBytes(incoming));
    h.handlePaste(withSel, {} as ClipboardEvent, incoming);
    expect(guard).toHaveBeenLastCalledWith(estimatePmBytes(incoming) - estimatePmBytes(selected));
    guard.mockClear();
    expect(h.handleDrop(withSel, {} as DragEvent, incoming, true)).toBe(false);
    expect(guard).not.toHaveBeenCalled();
    guard.mockReturnValue(true);
    expect(h.handleDrop(withSel, {} as DragEvent, incoming, false)).toBe(true);
    expect(guard).toHaveBeenLastCalledWith(estimatePmBytes(incoming));
  });
});
