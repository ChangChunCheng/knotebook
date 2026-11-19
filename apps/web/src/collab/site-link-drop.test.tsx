import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import * as Y from "yjs";
import type { SiteLinkCandidate } from "@knotebook/shared";
import type { EditorRef } from "@/components/wikilink/menu";
import { attachTestElementRenderer } from "@/test/element-renderer";
import { collabUndoManager } from "./undo";
import { runFallbackConversion, type FallbackRequest, type SiteLinkEnv, type SiteLinkEnvRef } from "./site-link-convert";

// #352: a real editor mounted with `buildNoteEditorOptions` (product code as is) and real DOM `drop` events. toast is replaced by a spy (as in `components/NoteEditor.test.ts`): media blocking calls it.
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
const { buildNoteEditorOptions } = await import("@/components/NoteEditor");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;
type Options = ReturnType<typeof buildNoteEditorOptions>;
type View = AnyEditor["_tiptapEditor"]["view"];
type PmNode = View["state"]["doc"];

const ORIGIN = window.location.origin;
const A_ID = "11111111-1111-4111-8111-111111111111";
const NOTES: SiteLinkCandidate[] = [{ id: A_ID, title: "Alpha", slug: "alpha", groupId: null, ownerHandle: "alice" }];
const URL_A = `${ORIGIN}/n/alice/alpha`;
/** Sidebar <a> shape (text D, so the converted wikilink has label "D"). */
const A_FORM = { "text/html": `<a href="${URL_A}">D</a>`, "text/plain": URL_A, "text/uri-list": URL_A };
/** Same as A_FORM but the text equals the cached title, so the converted wikilink has label "". */
const A_ALPHA = { ...A_FORM, "text/html": `<a href="${URL_A}">Alpha</a>` };
/** Media blocking (data-URL image): the inner handler returns true and PM sends no drop tr. */
const MEDIA = { "text/html": `<img src="data:image/png;base64,AAAA">`, "text/plain": "x" };
const L = (text: string) => ({ type: "link", href: URL_A, content: text });

type Env = SiteLinkEnv & { list: SiteLinkCandidate[]; calls: FallbackRequest[][] };
function mkEnv(list: SiteLinkCandidate[] = NOTES): Env {
  const calls: FallbackRequest[][] = [];
  const env: Env = { origin: ORIGIN, list, notes: () => env.list, schedule: (r) => void calls.push(r), calls };
  return env;
}

const mounted: Array<{ editor: AnyEditor; container: HTMLElement; doc: Y.Doc }> = [];
function mount(env: SiteLinkEnv | null, wrap?: (opts: Options) => void): { editor: AnyEditor; envRef: SiteLinkEnvRef } {
  const doc = new Y.Doc();
  const envRef: SiteLinkEnvRef = { current: env };
  const editorRef: EditorRef = { current: null };
  const opts = buildNoteEditorOptions({
    doc,
    provider: { awareness: null } as never,
    user: { id: "u1", name: "Ann" },
    language: "en",
    translate: (k) => k,
    editorRef,
    noteId: "n",
    siteLinks: envRef,
  });
  wrap?.(opts);
  const editor = BlockNoteEditor.create(opts) as unknown as AnyEditor;
  editorRef.current = editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  attachTestElementRenderer(editor);
  mounted.push({ editor, container, doc });
  return { editor, envRef };
}

const view = (editor: AnyEditor): View => editor._tiptapEditor.view;

function dropOn(
  editor: AnyEditor,
  pos: number,
  data: Record<string, string>,
  o: { files?: File[]; coords?: [number, number]; ctrlKey?: boolean; dragging?: View["dragging"] } = {},
): void {
  const v = view(editor);
  v.posAtCoords = () => ({ pos, inside: -1 });
  const files = o.files ?? [];
  const items = files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f }));
  const dataTransfer = {
    types: [...Object.keys(data), ...(files.length ? ["Files"] : [])],
    items,
    files,
    getData: (t: string) => data[t] ?? "",
    dropEffect: "none",
    effectAllowed: "all",
  };
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: o.coords?.[0] ?? 0 });
  Object.defineProperty(event, "clientY", { value: o.coords?.[1] ?? 0 });
  Object.defineProperty(event, "ctrlKey", { value: !!o.ctrlKey });
  if (o.dragging) v.dragging = o.dragging;
  v.dom.dispatchEvent(event);
}

/** Flush microtasks after every drop, before the next step. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function boundaryAfter(editor: AnyEditor, i: number): number {
  const group = view(editor).state.doc.firstChild!;
  let pos = 1;
  for (let k = 0; k <= i; k++) pos += group.child(k).nodeSize;
  return pos;
}

const pm = (editor: AnyEditor): string => view(editor).state.doc.toString();
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const links = (editor: AnyEditor, text: string): number => count(pm(editor), new RegExp(`link\\("${text}"\\)`, "g"));
const wikis = (editor: AnyEditor): number => count(pm(editor), /wikilink/g);
type Inline = { type: string; props?: Record<string, unknown>; href?: string; text?: string };
const inline = (editor: AnyEditor, i: number): Inline[] => editor.document[i]!.content as Inline[];
const wikiProps = (editor: AnyEditor, i: number) => inline(editor, i).filter((n) => n.type === "wikilink").map((n) => n.props);
function textPos(editor: AnyEditor, text: string): number {
  let at = -1;
  view(editor).state.doc.descendants((n: PmNode, p: number) => {
    if (at === -1 && n.isText && n.text === text) at = p;
    return at === -1;
  });
  return at;
}

const DL1_PROPS = { targetNoteId: A_ID, snapshotTitle: "Alpha", label: "", anchorBlockId: "" };

afterEach(() => {
  toastMock.mockReset();
  vi.restoreAllMocks();
  for (const m of mounted.splice(0)) {
    m.editor.unmount();
    m.container.remove();
    m.doc.destroy();
  }
});

describe("#352 drop hook", () => {
  it("sidebar <a> shape (html + plain + uri-list) hit -> exactly one wikilink (empty label), no ordinary link, no fallback queued", async () => {
    const env = mkEnv();
    const { editor } = mount(env);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    dropOn(editor, 5, A_ALPHA);
    await flush();
    expect(wikiProps(editor, 0)).toEqual([DL1_PROPS]);
    expect(pm(editor)).not.toContain("link(");
    expect(env.calls).toHaveLength(0);
  });

  it("an extra application/x-knotebook-note type -> same result as the sidebar <a> shape (the decision doesn't read it)", async () => {
    const env = mkEnv();
    const { editor } = mount(env);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    dropOn(editor, 5, { ...A_ALPHA, "application/x-knotebook-note": A_ID });
    await flush();
    expect(wikiProps(editor, 0)).toEqual([DL1_PROPS]);
    expect(pm(editor)).not.toContain("link(");
    expect(env.calls).toHaveLength(0);
  });

  it("only a text/plain URL (the paste rule appends a link mark) hit -> one wikilink, empty label", async () => {
    const env = mkEnv();
    const { editor } = mount(env);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    dropOn(editor, 5, { "text/plain": URL_A });
    await flush();
    expect(wikiProps(editor, 0).map((p) => p?.label)).toEqual([""]);
    expect(wikiProps(editor, 0).map((p) => p?.targetNoteId)).toEqual([A_ID]);
  });

  for (const [name, data] of [
    ["sidebar <a> shape", A_FORM],
    ["plain-URL shape", { "text/plain": URL_A }],
  ] as const) {
    it(`cache miss (${name}) -> stays an ordinary link; fallback queued once`, async () => {
      const env = mkEnv([]);
      const { editor } = mount(env);
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
      dropOn(editor, 5, data);
      await flush();
      expect(wikis(editor)).toBe(0);
      expect(pm(editor)).toContain("link(");
      expect(env.calls).toHaveLength(1);
      expect(env.calls[0]![0]!.href).toBe(URL_A);
    });
  }

  for (const href of ["https://example.com/n/alice/alpha", `${ORIGIN}/p/abc`, `${ORIGIN}/n/alice/alpha?present`]) {
    it(`not a convertible on-site link (${href.replace(ORIGIN, "<origin>")}) -> not converted, no fallback queued`, async () => {
      const env = mkEnv();
      const { editor } = mount(env);
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
      dropOn(editor, 5, { "text/html": `<a href="${href}">D</a>`, "text/plain": href, "text/uri-list": href });
      await flush();
      expect(links(editor, "D")).toBe(1);
      expect(wikis(editor)).toBe(0);
      expect(env.calls).toHaveLength(0);
    });
  }

  /** `[p "src " L("S")], [p "dst"]`: selects S, sets `view.dragging` and drops at the end of dst. */
  async function internalDrag(ctrlKey: boolean): Promise<AnyEditor> {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: ["src ", L("S")] },
      { type: "paragraph", content: "dst" },
    ]);
    const v = view(editor);
    const s = textPos(editor, "S");
    const dstEnd = textPos(editor, "dst") + 3;
    editor._tiptapEditor.commands.setTextSelection({ from: s, to: s + 1 });
    dropOn(editor, dstEnd, { "text/html": "<b>ignored</b>", "text/plain": "x" }, { ctrlKey, dragging: { slice: v.state.doc.slice(s, s + 1), move: true } });
    await flush();
    return editor;
  }

  it("internal move (dragging.move) of an existing ordinary on-site link -> stays an ordinary link", async () => {
    const editor = await internalDrag(false);
    expect(inline(editor, 1).map((n) => n.type)).toEqual(["text", "link"]);
    expect(inline(editor, 0).some((n) => n.type === "link")).toBe(false);
    expect(links(editor, "S")).toBe(1);
    expect(wikis(editor)).toBe(0);
  });

  it("internal copy drag (ctrlKey; jsdom's navigator.platform isn't Mac) -> the source stays and the copy is still an ordinary link", async () => {
    const editor = await internalDrag(true);
    expect(inline(editor, 0).map((n) => n.type)).toEqual(["text", "link"]);
    expect(inline(editor, 1).map((n) => n.type)).toEqual(["text", "link"]);
    expect(links(editor, "S")).toBe(2);
    expect(wikis(editor)).toBe(0);
  });

  it("caret in another paragraph; dropping `-<a>Alpha</a>` after the X of `X-[Alpha](url)end` -> the newly dropped one is converted, the existing one isn't", async () => {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "other" },
      { type: "paragraph", content: ["X-", L("Alpha"), "end"] },
    ]);
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    dropOn(editor, boundaryAfter(editor, 0) + 2 + 1, { "text/html": `-<a href="${URL_A}">Alpha</a>`, "text/plain": "x" });
    await flush();
    expect(inline(editor, 1).map((n) => n.type)).toEqual(["text", "wikilink", "text", "link", "text"]);
  });

  // The range ends mustn't cover one position too many: drop right before/after the existing link H. H uses `/notes/<id>`: a cache hit (it would be converted if covered) but its href differs from the dropped one, so PM doesn't merge the two into one link.
  for (const side of ["前", "後"] as const) {
    it(`dropping next to an existing ordinary on-site link H (${side === "前" ? "before" : "after"} side) -> only the newly dropped D is converted, H isn't`, async () => {
      const { editor } = mount(mkEnv());
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: ["AAA ", { type: "link", href: `/notes/${A_ID}`, content: "H" }, " tail"] }]);
      const h = textPos(editor, "H");
      dropOn(editor, side === "前" ? h : h + 1, { "text/html": `<a href="${URL_A}">D</a>`, "text/plain": "x" });
      await flush();
      expect(links(editor, "H")).toBe(1);
      expect(links(editor, "D")).toBe(0);
      expect(wikis(editor)).toBe(1);
    });
  }

  it("read-only, or envRef.current is null -> not converted, no throw", async () => {
    const a = mount(mkEnv());
    a.editor.replaceBlocks(a.editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    a.editor.isEditable = false;
    expect(() => dropOn(a.editor, 5, A_FORM)).not.toThrow();
    await flush();
    expect(wikis(a.editor)).toBe(0);

    const b = mount(mkEnv());
    b.editor.replaceBlocks(b.editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    b.envRef.current = null;
    expect(() => dropOn(b.editor, 5, A_FORM)).not.toThrow();
    await flush();
    expect(wikis(b.editor)).toBe(0);
  });

  it("the conversion throws (env.notes throws) -> console.warn, stays an ordinary link, no uncaught error", async () => {
    const env = mkEnv();
    env.notes = () => {
      throw new Error("boom");
    };
    const { editor } = mount(env);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dropOn(editor, 5, A_FORM);
    await flush();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toBe("[site-link] drop conversion failed");
    expect(links(editor, "D")).toBe(1);
  });

  it("dropping two paragraphs after AAA in `AAA [L] BBB` -> the existing L isn't converted; on-site links in the dropped content are", async () => {
    const a = mount(mkEnv());
    a.editor.replaceBlocks(a.editor.document, [{ type: "paragraph", content: ["AAA ", L("L"), " BBB"] }]);
    dropOn(a.editor, 3 + 3, { "text/html": "<p>new</p><p>two</p>", "text/plain": "x" });
    await flush();
    expect(links(a.editor, "L")).toBe(1);
    expect(wikis(a.editor)).toBe(0);

    const b = mount(mkEnv());
    b.editor.replaceBlocks(b.editor.document, [{ type: "paragraph", content: ["AAA ", L("L"), " BBB"] }]);
    dropOn(b.editor, 3 + 3, { "text/html": `<p>new</p><p>two <a href="${URL_A}">D</a></p>`, "text/plain": "x" });
    await flush();
    expect(links(b.editor, "L")).toBe(1);
    expect(links(b.editor, "D")).toBe(0);
    expect(wikis(b.editor)).toBe(1);
  });

  it("coordinates (1,1) (in jsdom SideMenu's synthetic drop) -> the hook runs once, same result as the sidebar <a> shape", async () => {
    const env = mkEnv();
    let calls = 0;
    const { editor } = mount(env, (opts) => {
      const events = opts._tiptapOptions.editorProps.handleDOMEvents;
      const inner = events.drop;
      events.drop = (v, e) => {
        calls++;
        return inner(v, e);
      };
    });
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
    dropOn(editor, 5, A_ALPHA, { coords: [1, 1] });
    await flush();
    expect(calls).toBe(1);
    expect(wikiProps(editor, 0)).toEqual([DL1_PROPS]);
    expect(pm(editor)).not.toContain("link(");
  });

  for (const [name, html] of [
    ["starts with img", `<img src="https://example.com/x.png"><p>two <a href="${URL_A}">D</a></p>`],
    ["starts with hr", `<hr><p>two <a href="${URL_A}">D</a></p>`],
  ] as const) {
    it(`dropping content that ${name} at a block boundary; the next paragraph starts with the existing NEXT -> NEXT isn't converted, D is`, async () => {
      const { editor } = mount(mkEnv());
      editor.replaceBlocks(editor.document, [
        { type: "paragraph", content: "AAA" },
        { type: "paragraph", content: [L("NEXT"), " BBB"] },
      ]);
      dropOn(editor, boundaryAfter(editor, 0), { "text/html": html, "text/plain": "x" });
      await flush();
      expect(links(editor, "NEXT")).toBe(1);
      expect(links(editor, "D")).toBe(0);
      expect(wikis(editor)).toBe(1);
    });
  }

  it("dropping the sidebar <a> shape at document end (size-1) -> D is converted, the existing H isn't", async () => {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: [L("H")] },
      { type: "paragraph", content: "" },
    ]);
    dropOn(editor, view(editor).state.doc.content.size - 1, A_FORM);
    await flush();
    expect(links(editor, "D")).toBe(0);
    expect(wikis(editor)).toBe(1);
    expect(links(editor, "H")).toBe(1);
  });

  const NO_DROP_TR = {
    "media blocking": (editor: AnyEditor) => dropOn(editor, 5, MEDIA),
    Files: (editor: AnyEditor) => dropOn(editor, 5, {}, { files: [new File(["x"], "a.png", { type: "image/png" })] }),
    "uri-list only": (editor: AnyEditor) => dropOn(editor, 5, { "text/uri-list": URL_A }),
  } as const;

  for (const [name, second] of Object.entries(NO_DROP_TR)) {
    it(`after a miss drop, another drop with no drop tr (${name}) -> D and H stay ordinary links, fallback count unchanged`, async () => {
      const env = mkEnv([]);
      const { editor } = mount(env);
      editor.replaceBlocks(editor.document, [
        { type: "paragraph", content: "xxxxxxxxxxxx" },
        { type: "paragraph", content: ["AAA ", L("H")] },
      ]);
      dropOn(editor, 5, A_FORM);
      await flush();
      expect(links(editor, "D")).toBe(1);
      expect(env.calls).toHaveLength(1);
      second(editor);
      await flush();
      expect(links(editor, "D")).toBe(1);
      expect(links(editor, "H")).toBe(1);
      expect(env.calls).toHaveLength(1);
    });

    it(`after a miss drop the cache loads, then another drop with no drop tr (${name}) -> the earlier D is still an ordinary link`, async () => {
      const env = mkEnv([]);
      const { editor } = mount(env);
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "xxxxxxxxxxxx" }]);
      dropOn(editor, 5, A_FORM);
      await flush();
      expect(env.calls).toHaveLength(1);
      env.list = NOTES;
      second(editor);
      await flush();
      expect(links(editor, "D")).toBe(1);
      expect(wikis(editor)).toBe(0);
    });
  }

  const cells = Array.from({ length: 8 }, (_, i) => `<td>c${i}</td>`).join("");
  const WIDE = `<table><tr><td>a</td></tr><tr>${cells}<td>z <a href="${URL_A}">D</a></td></tr></table>`;
  for (const where of ["段中", "區塊邊界"] as const) {
    it(`wide table (fixTables pads cells and pushes the link back), dropped ${where === "段中" ? "mid-paragraph" : "at a block boundary"} -> D is converted, the existing H and NEXT aren't`, async () => {
      const { editor } = mount(mkEnv());
      editor.replaceBlocks(editor.document, [
        { type: "paragraph", content: ["AAA ", L("H")] },
        { type: "paragraph", content: [L("NEXT"), " BBB"] },
      ]);
      dropOn(editor, where === "段中" ? 5 : boundaryAfter(editor, 0), { "text/html": WIDE, "text/plain": "x" });
      await flush();
      expect(links(editor, "D")).toBe(0);
      expect(wikis(editor)).toBe(1);
      expect(links(editor, "H")).toBe(1);
      expect(links(editor, "NEXT")).toBe(1);
    });
  }

  /** Media-blocked drop: the hook is armed (record set to null), the inner handler returns true and PM sends no drop tr; the test then sends its own tr synchronously. */
  function armWithoutDropTr(editor: AnyEditor): void {
    dropOn(editor, 5, MEDIA);
  }

  it("the last StepMap of the drop tr has more than one range (setNodeMarkup) -> records null, not converted", async () => {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: ["AAA ", L("H")] }]);
    const v = view(editor);
    armWithoutDropTr(editor);
    let paraPos = -1;
    v.state.doc.descendants((n: PmNode, p: number) => {
      if (paraPos === -1 && n.type.name === "paragraph") paraPos = p;
      return paraPos === -1;
    });
    v.dispatch(v.state.tr.setNodeMarkup(paraPos, undefined, v.state.doc.nodeAt(paraPos)!.attrs).setMeta("uiEvent", "drop"));
    await flush();
    expect(links(editor, "H")).toBe(1);
    expect(wikis(editor)).toBe(0);
  });

  it("the record maps to an empty range (insert next to H then delete) -> not converted (the adjacent existing link isn't collected)", async () => {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: ["AAA ", L("H"), " tail"] }]);
    const v = view(editor);
    const hEnd = textPos(editor, "H") + 1;
    armWithoutDropTr(editor);
    v.dispatch(v.state.tr.insertText("Q", hEnd).setMeta("uiEvent", "drop"));
    v.dispatch(v.state.tr.delete(hEnd, hEnd + 1));
    await flush();
    expect(links(editor, "H")).toBe(1);
    expect(wikis(editor)).toBe(0);
  });
});

/**
 * Undo measurement (collab configuration, no fake timers, `stopCapturing()` only before the drop). The measured results are the assertions; the two fallback rows mirror `site-link-convert.test.tsx` but are triggered by a drop.
 */
const MEASURED_DROP = { undoRemovesWholeDrop: true, fallbackAfterPauseRevertsToLink: true, fallbackImmediateRemovesAll: true } as const;

describe("#352 undo measurements (collab)", () => {
  it(`synchronous hit: one undo removes the whole drop =${String(MEASURED_DROP.undoRemovesWholeDrop)}`, async () => {
    const { editor } = mount(mkEnv());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "abc" }]);
    const manager = collabUndoManager(editor)!;
    const before = pm(editor);
    manager.stopCapturing();
    dropOn(editor, textPos(editor, "abc") + 3, A_FORM);
    await flush();
    expect(wikis(editor)).toBe(1);
    manager.undo();
    expect(pm(editor) === before).toBe(MEASURED_DROP.undoRemovesWholeDrop);
  });

  async function missThenFallback(pauseBeforeFallback: boolean): Promise<{ editor: AnyEditor; env: Env; before: string; manager: NonNullable<ReturnType<typeof collabUndoManager>> }> {
    const env = mkEnv([]);
    const { editor } = mount(env);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "abc" }]);
    const manager = collabUndoManager(editor)!;
    const before = pm(editor);
    manager.stopCapturing();
    dropOn(editor, textPos(editor, "abc") + 3, A_FORM);
    await flush();
    if (pauseBeforeFallback) manager.stopCapturing();
    await runFallbackConversion(editor, env.calls[0]!, ORIGIN, async () => ({ id: A_ID, title: "Alpha" }));
    expect(wikis(editor)).toBe(1);
    return { editor, env, before, manager };
  }

  it(`fallback lands after a pause: one undo only reverts to an ordinary link =${String(MEASURED_DROP.fallbackAfterPauseRevertsToLink)}; it isn't converted again afterwards`, async () => {
    const { editor, env, manager } = await missThenFallback(true);
    manager.undo();
    expect(links(editor, "D") === 1 && wikis(editor) === 0).toBe(MEASURED_DROP.fallbackAfterPauseRevertsToLink);
    await flush();
    expect(env.calls).toHaveLength(1);
    expect(wikis(editor)).toBe(0);
  });

  it(`fallback lands right after (same window): one undo undoes the drop too =${String(MEASURED_DROP.fallbackImmediateRemovesAll)}`, async () => {
    const { editor, before, manager } = await missThenFallback(false);
    manager.undo();
    expect(pm(editor) === before).toBe(MEASURED_DROP.fallbackImmediateRemovesAll);
  });
});
