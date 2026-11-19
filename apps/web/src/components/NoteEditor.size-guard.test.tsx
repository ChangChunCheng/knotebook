/**
 * Front-end check of the note size limit with the **real** BlockNote + y-prosemirror (editor built by `buildNoteEditorOptions`, with an UndoManager) and the real check function
 * (`createNoteSizeGuard`, not a stand-in): a paste event goes through BlockNote's own paste flow to `handlePaste`, and what is estimated is the parsed content.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { createNoteSizeGuard, estimateBlocksBytes, estimatePmBytes, noteStateBytes } from "@/lib/note-size-guard";
import { useNoteOverLimit } from "@/hooks/useNoteOverLimit";

vi.mock("@/components/ui/toast", () => ({ toast: vi.fn() }));
const { buildNoteEditorOptions } = await import("./NoteEditor");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test editor; repo convention BlockNoteEditor<any,any,any>
type AnyEditor = BlockNoteEditor<any, any, any>;

/** The size the server stores (fresh doc + applyUpdate + encode: tombstones kept by the local UndoManager are reclaimed). */
function serverSize(doc: Y.Doc): number {
  const c = new Y.Doc();
  Y.applyUpdate(c, Y.encodeStateAsUpdate(doc));
  return Y.encodeStateAsUpdate(c).byteLength;
}

const mounted: Array<{ editor: AnyEditor; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    m.editor.unmount();
    m.el.remove();
  }
  vi.useRealTimers();
});

function setup() {
  const doc = new Y.Doc();
  let limit: number | undefined;
  const notified: number[] = [];
  const guardCalls: number[] = [];
  const realGuard = createNoteSizeGuard(() => doc, () => limit, l => notified.push(l));
  const editorRef = { current: null as AnyEditor | null };
  const options = buildNoteEditorOptions({
    doc,
    provider: { awareness: null } as never,
    user: { id: "u", name: "U" },
    language: "en",
    translate: (k: string) => k,
    editorRef: editorRef as never,
    noteId: "n",
    siteLinks: { current: null },
    sizeGuard: g => {
      guardCalls.push(g);
      return realGuard(g);
    },
  });
  const editor = BlockNoteEditor.create(options) as AnyEditor;
  editorRef.current = editor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  mounted.push({ editor, el });
  return {
    doc,
    editor,
    notified,
    guardCalls,
    setLimit: (l: number | undefined) => (limit = l),
    fill: (n: number, text = (i: number) => `paragraph ${i} with some ordinary text`) =>
      editor.replaceBlocks(editor.document, Array.from({ length: n }, (_, i) => ({ type: "paragraph", content: text(i) })) as never),
  };
}

function paste(editor: AnyEditor, data: Record<string, string>) {
  const ev = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(ev, "clipboardData", { value: { types: Object.keys(data), getData: (t: string) => data[t] ?? "", files: [], items: [] } });
  editor._tiptapEditor.view.dom.dispatchEvent(ev);
}

function drop(editor: AnyEditor, data: Record<string, string>, pos: number) {
  const view = editor._tiptapEditor.view as unknown as { posAtCoords: unknown; dom: HTMLElement };
  view.posAtCoords = () => ({ pos, inside: -1 }); // jsdom has no layout: give the drop position directly
  const ev = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(ev, "dataTransfer", { value: { types: Object.keys(data), getData: (t: string) => data[t] ?? "", files: [], items: [] } });
  Object.defineProperty(ev, "clientX", { value: 1 });
  Object.defineProperty(ev, "clientY", { value: 1 });
  view.dom.dispatchEvent(ev);
  return ev;
}

function placeCursorAtEnd(editor: AnyEditor) {
  const last = editor.document.at(-1)!;
  editor.setTextCursorPosition(last.id, "end");
}

const mdTable = (rows: number) => "| a | b | c | d | e |\n|---|---|---|---|---|\n" + Array.from({ length: rows }, (_, r) => `| ${r} | b | c | d | e |`).join("\n");
const mdList = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i}`).join("\n");
const wordHtml = (n: number) =>
  '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>' +
  "p.MsoNormal{margin:0cm;font-size:11.0pt;font-family:Calibri}".repeat(300) +
  "</style></head><body>" +
  Array.from({ length: n }, (_, i) => `<p class=MsoNormal style="margin:0cm;mso-pagination:none"><span lang=EN-US style="font-size:11.0pt;font-family:Calibri;mso-ascii-theme-font:minor-latin">Short line ${i}<o:p></o:p></span></p>`).join("") +
  "</body></html>";

describe("paste size check (real BlockNote + y-prosemirror)", () => {
  it("every paste source asks the check before inserting (plain text, HTML, markdown, in-site blocknote/html, VS Code); no room -> not inserted, hint shown", async () => {
    const s = setup();
    s.fill(5);
    const src = setup();
    src.fill(20);
    const internal = await src.editor.blocksToFullHTML(src.editor.document);
    const sources: Array<[string, Record<string, string>]> = [
      ["純文字", { "text/plain": "just some plain text pasted here" }],
      ["HTML", { "text/html": "<p>some <strong>html</strong></p><p>second</p>", "text/plain": "x" }],
      ["markdown", { "text/plain": "# Title\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |" }],
      ["站內 blocknote/html", { "blocknote/html": internal, "text/html": internal, "text/plain": "x" }],
      ["VS Code", { "text/plain": "const a = 1;\nconst b = 2;", "vscode-editor-data": JSON.stringify({ version: 1, mode: "typescript" }) }],
    ];
    s.setLimit(serverSize(s.doc)); // no room at all
    for (const [name, data] of sources) {
      placeCursorAtEnd(s.editor);
      const before = Y.encodeStateAsUpdate(s.doc);
      const calls = s.guardCalls.length;
      paste(s.editor, data);
      await Promise.resolve();
      expect(s.guardCalls.length, `${name}：問到檢查`).toBe(calls + 1);
      expect(s.guardCalls.at(-1)!, `${name}：估計的成長 > 0`).toBeGreaterThan(0);
      expect(Y.encodeStateAsUpdate(s.doc), `${name}：沒有插入`).toEqual(before);
    }
    expect(s.notified).toHaveLength(sources.length);
    s.setLimit(undefined);
    placeCursorAtEnd(s.editor);
    paste(s.editor, sources[0]![1]);
    expect(JSON.stringify(s.editor.document)).toContain("just some plain text pasted here");
  });

  it("near the limit: a markdown table (a few KB of text, tens of times that once stored) -> blocked; allowed when there is room", () => {
    const s = setup();
    s.fill(10);
    const md = mdTable(300);
    s.setLimit(serverSize(s.doc) + 30_000); // 30 KB left: more than the table's text (about 8 KB) but far less than what is stored (about 300 KB)
    expect(new TextEncoder().encode(md).byteLength).toBeLessThan(30_000);
    placeCursorAtEnd(s.editor);
    const before = Y.encodeStateAsUpdate(s.doc);
    paste(s.editor, { "text/plain": md });
    expect(Y.encodeStateAsUpdate(s.doc)).toEqual(before);
    expect(s.notified).toHaveLength(1);
    s.setLimit(serverSize(s.doc) + 600_000);
    paste(s.editor, { "text/plain": md });
    const grown = serverSize(s.doc) - before.byteLength;
    expect(grown).toBeGreaterThan(30_000); // it really grew this much: blocking was right
  });

  it("near the limit: a bullet list (800 items) -> blocked", () => {
    const s = setup();
    s.fill(10);
    const md = mdList(800);
    s.setLimit(serverSize(s.doc) + 60_000); // text about 8 KB; about 175 KB once stored
    placeCursorAtEnd(s.editor);
    const before = Y.encodeStateAsUpdate(s.doc);
    paste(s.editor, { "text/plain": md });
    expect(Y.encodeStateAsUpdate(s.doc)).toEqual(before);
    expect(s.notified).toHaveLength(1);
  });

  it("Word-style clipboard HTML is fat with little content -> allowed (the estimate is of the parsed content, not the clipboard bytes)", () => {
    const s = setup();
    s.fill(10);
    const html = wordHtml(20);
    const headroom = 10_000;
    expect(new TextEncoder().encode(html).byteLength).toBeGreaterThan(headroom); // estimating by clipboard bytes would block it
    s.setLimit(serverSize(s.doc) + headroom);
    placeCursorAtEnd(s.editor);
    paste(s.editor, { "text/html": html, "text/plain": "Short line" });
    expect(s.notified).toEqual([]);
    expect(JSON.stringify(s.editor.document)).toContain("Short line 19");
  });

  it("cut and paste near the limit (a move) -> allowed: content deleted locally (tombstones kept by the UndoManager) doesn't count", async () => {
    const s = setup();
    s.fill(200);
    const moved = s.editor.document.slice(50, 100);
    const html = await s.editor.blocksToFullHTML(moved);
    s.setLimit(serverSize(s.doc) + 2_000); // only 2 KB left; the moved part is about 12 KB
    s.editor.removeBlocks(moved.map(b => b.id)); // cut
    expect(Y.encodeStateAsUpdate(s.doc).byteLength, "UndoManager 留住刪掉的內容：原始大小沒變小").toBeGreaterThan(serverSize(s.doc) + 5_000);
    placeCursorAtEnd(s.editor);
    paste(s.editor, { "blocknote/html": html, "text/html": html, "text/plain": "x" });
    expect(s.notified).toEqual([]);
    const text = JSON.stringify(s.editor.document);
    expect(text).toContain("paragraph 50 with");
    expect(text).toContain("paragraph 99 with");
  });

  it("replacing the selection with shorter text -> allowed (the replaced part is subtracted; same when the note is already over the limit)", () => {
    const s = setup();
    s.fill(30, i => (i === 5 ? "x".repeat(3_000) : `paragraph ${i}`));
    s.setLimit(serverSize(s.doc) - 1_000); // already over the limit
    const target = s.editor.document[5]!;
    void target;
    const view = s.editor._tiptapEditor.view;
    let from = -1;
    let to = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text!.startsWith("xxx")) {
        from = pos;
        to = pos + node.text!.length;
        return false;
      }
      return true;
    });
    s.editor._tiptapEditor.commands.setTextSelection({ from, to });
    expect(estimatePmBytes(view.state.selection.content())).toBeGreaterThan(3_000);
    paste(s.editor, { "text/plain": "short" });
    expect(s.guardCalls.at(-1)!).toBeLessThan(0);
    expect(s.notified).toEqual([]);
    expect(JSON.stringify(s.editor.document)).not.toContain("xxxxxxxx");
    expect(JSON.stringify(s.editor.document)).toContain("short");
  });
});

describe("drag-drop and content with attributes (real BlockNote + y-prosemirror)", () => {
  it("dragged in from outside (HTML, plain text): asks the check before inserting; no room -> not inserted, hint shown; room -> inserted as usual", () => {
    const s = setup();
    s.fill(20);
    const end = s.editor._tiptapEditor.view.state.doc.content.size - 3;
    s.setLimit(serverSize(s.doc));
    const before = Y.encodeStateAsUpdate(s.doc);
    const ev = drop(s.editor, { "text/html": "<p>dropped html</p><p>two</p>", "text/plain": "dropped html" }, end);
    expect(s.guardCalls).toHaveLength(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(Y.encodeStateAsUpdate(s.doc)).toEqual(before);
    drop(s.editor, { "text/plain": "dropped plain text" }, end);
    expect(s.guardCalls).toHaveLength(2);
    expect(Y.encodeStateAsUpdate(s.doc)).toEqual(before);
    expect(s.notified).toHaveLength(2);
    s.setLimit(undefined);
    drop(s.editor, { "text/html": "<p>dropped html</p><p>two</p>", "text/plain": "dropped html" }, end);
    expect(JSON.stringify(s.editor.document)).toContain("dropped html");
  });

  it("block with large attributes (mermaid source): the ProseMirror content estimate counts the attribute bytes, about the actual growth (same as the in-site AI blocks estimate)", () => {
    const s = setup();
    const view = s.editor._tiptapEditor.view;
    const estBefore = estimatePmBytes(view.state.doc);
    const sizeBefore = serverSize(s.doc);
    const blocks = Array.from({ length: 10 }, (_, i) => ({ type: "mermaid", props: { code: "graph TD" + Array.from({ length: 200 }, (_, k) => ` A${i}_${k}-->B${k};`).join("") } }));
    s.editor.replaceBlocks(s.editor.document, blocks as never);
    const actual = serverSize(s.doc) - sizeBefore;
    expect(actual).toBeGreaterThan(20_000);
    const est = estimatePmBytes(view.state.doc) - estBefore;
    expect(est / actual).toBeGreaterThan(0.8);
    expect(est / actual).toBeLessThan(1.25);
    expect(estimateBlocksBytes(blocks) / actual).toBeGreaterThan(0.8);
  });

  it("heavily formatted content (every character bold, linked): the estimate is about the actual growth", () => {
    const s = setup();
    s.fill(3);
    placeCursorAtEnd(s.editor);
    const before = serverSize(s.doc);
    const html = Array.from({ length: 100 }, (_, i) => "<p>" + Array.from({ length: 20 }, (_, w) => (w % 4 === 0 ? `<a href="https://example.com/p/${i}/${w}">l${w}</a> ` : `<b>w${w}</b> `)).join("") + "</p>").join("");
    paste(s.editor, { "text/html": html, "text/plain": "x" });
    const actual = serverSize(s.doc) - before;
    const est = s.guardCalls.at(-1)!;
    expect(est / actual).toBeGreaterThan(0.85);
    expect(est / actual).toBeLessThan(1.2);
  });
});

describe("over-limit hint and tombstones (real editor with UndoManager)", () => {
  it("longer than the limit -> hint; delete 95% -> raw size is still large (tombstones), the reclaimed size is what the server has; the hint disappears and pasting is allowed again", async () => {
    const s = setup();
    s.fill(400);
    const limit = serverSize(s.doc) - 5_000;
    s.setLimit(limit);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const hook = renderHook(() => useNoteOverLimit(s.doc, limit, true));
    expect(hook.result.current).toBe(true);
    act(() => s.editor.removeBlocks(s.editor.document.slice(0, 380).map(b => b.id)));
    expect(Y.encodeStateAsUpdate(s.doc).byteLength, "原始大小：墓碑還在").toBeGreaterThan(limit);
    expect(noteStateBytes(s.doc, limit), "回收過的大小").toBe(serverSize(s.doc));
    expect(serverSize(s.doc)).toBeLessThan(limit / 5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(hook.result.current, "提示消失").toBe(false);
    placeCursorAtEnd(s.editor);
    paste(s.editor, { "text/plain": mdList(50) });
    expect(s.notified).toEqual([]);
    expect(JSON.stringify(s.editor.document)).toContain("item 49");
  });
});
