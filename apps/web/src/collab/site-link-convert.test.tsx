import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { Extension } from "@tiptap/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { YDOC_FRAGMENT, type SiteLinkCandidate } from "@knotebook/shared";
import { noteSchema } from "./schema";
import { collabUndoManager } from "./undo";
import { createSiteLinkConvertExtension, runFallbackConversion, type FallbackRequest, type SiteLinkEnv, type SiteLinkEnvRef } from "./site-link-convert";
import { SITE_LINK_CONVERT_META, Y_SYNC_META } from "./site-link-pm";
import { createPmPlugin } from "./pm-plugin";
import { attachTestElementRenderer } from "@/test/element-renderer";
import { P, row, shape } from "@/test/columns-fixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests only touch a few fields of the view (state/dispatch/someProp), any kept as with AnyEditor
type AnyView = any;

const ORIGIN = window.location.origin;
const A_ID = "11111111-1111-4111-8111-111111111111";
const NOTES: SiteLinkCandidate[] = [{ id: A_ID, title: "Alpha", slug: "alpha", groupId: null, ownerHandle: "alice" }];

function env(notes: SiteLinkCandidate[] | undefined = NOTES): SiteLinkEnv & { requests: FallbackRequest[][] } {
  const requests: FallbackRequest[][] = [];
  return { origin: ORIGIN, notes: () => notes, schedule: (r) => void requests.push(r), requests };
}

function mount(e: SiteLinkEnv | null, collab = false, extra: Extension[] = []): { editor: AnyEditor; doc?: Y.Doc; container: HTMLElement } {
  const envRef: SiteLinkEnvRef = { current: e };
  // `extra` goes first: tiptap reverses then sorts by priority, so extensions later in the array have earlier plugins; this plugin therefore runs before `extra`.
  const extensions = [...extra, createSiteLinkConvertExtension({ envRef })];
  let doc: Y.Doc | undefined;
  const editor = (collab
    ? BlockNoteEditor.create(
        withCollaboration({
          schema: noteSchema,
          collaboration: { provider: { awareness: undefined }, fragment: (doc = new Y.Doc()).getXmlFragment(YDOC_FRAGMENT), user: { id: "u", name: "U", color: "#123456" } },
          _tiptapOptions: { extensions },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
        } as any),
      )
    : BlockNoteEditor.create({ schema: noteSchema, _tiptapOptions: { extensions } } as never)) as AnyEditor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  attachTestElementRenderer(editor); // wikilink's toDOM needs it (see the helper's file header)
  return { editor, doc, container };
}

function typeChar(view: AnyView, ch: string): void {
  const { from, to } = view.state.selection;
  const handled = view.someProp("handleTextInput", (f: (v: AnyView, a: number, b: number, c: string) => boolean | void) => f(view, from, to, ch));
  if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
}
const typeString = (view: AnyView, s: string) => [...s].forEach((ch) => typeChar(view, ch));

function inline(editor: AnyEditor): Array<{ type: string; props?: Record<string, string>; href?: string }> {
  return editor.document[0]!.content as Array<{ type: string; props?: Record<string, string>; href?: string }>;
}

describe("#269 AddMarkStep plugin", () => {
  let editor: AnyEditor;
  let container: HTMLElement;
  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("autolink (typing a URL plus a space): replaced by a wikilink within the same dispatch (text equal to the URL -> empty label)", () => {
    ({ editor, container } = mount(env()));
    const view = editor._tiptapEditor.view;
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    typeString(view, `see ${ORIGIN}/n/alice/alpha `);
    const w = inline(editor).find((n) => n.type === "wikilink");
    expect(w?.props).toEqual({ targetNoteId: A_ID, snapshotTitle: `${ORIGIN}/n/alice/alpha`, label: "", anchorBlockId: "" });
    expect(inline(editor).some((n) => n.type === "link")).toBe(false);
  });

  it("createLink (where the link dialog lands): replaced by a wikilink, label rule (text differs from the title -> label = text), the anchor goes into a prop", () => {
    ({ editor, container } = mount(env()));
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.createLink(`/n/alice/alpha#b-h1`, "see this");
    expect(inline(editor).find((n) => n.type === "wikilink")?.props).toEqual({ targetNoteId: A_ID, snapshotTitle: "see this", label: "see this", anchorBlockId: "h1" });
  });

  it("URL pasted over a selection (tiptap Link's handlePaste -> setMark): with the plugin mounted alone it becomes a wikilink with label = the selected text (in the product configuration this path belongs to the paste hook)", () => {
    ({ editor, container } = mount(env()));
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "go Alpha now" }]);
    const view = editor._tiptapEditor.view;
    let from = -1;
    view.state.doc.descendants((n: AnyView, pos: number) => {
      if (from === -1 && n.isText && String(n.text).includes("Alpha")) from = pos + String(n.text).indexOf("Alpha");
      return from === -1;
    });
    editor._tiptapEditor.commands.setTextSelection({ from, to: from + 5 });
    editor.pasteText(`${ORIGIN}/notes/${A_ID}`);
    expect(inline(editor).find((n) => n.type === "wikilink")?.props).toEqual({ targetNoteId: A_ID, snapshotTitle: "Alpha", label: "", anchorBlockId: "" });
  });

  it("inside columns: URL pasted over a selection in the paragraph of column 2 -> replaced by a wikilink, the row still has two columns", () => {
    ({ editor, container } = mount(env()));
    editor.replaceBlocks(editor.document, [row([[P("left")], [P("go Alpha now", "c2p")]], "r1")]);
    const view = editor._tiptapEditor.view;
    let from = -1;
    view.state.doc.descendants((n: AnyView, pos: number) => {
      if (from === -1 && n.isText && String(n.text).includes("Alpha")) from = pos + String(n.text).indexOf("Alpha");
      return from === -1;
    });
    editor._tiptapEditor.commands.setTextSelection({ from, to: from + 5 });
    editor.pasteText(`${ORIGIN}/notes/${A_ID}`);
    const para = editor.getBlock("c2p")!.content as Array<{ type: string; props?: Record<string, string> }>;
    expect(para.find((n) => n.type === "wikilink")?.props).toEqual({ targetNoteId: A_ID, snapshotTitle: "Alpha", label: "", anchorBlockId: "" });
    expect(shape(editor)).toBe("ROW[COL(paragraph:left) | COL(paragraph:go  now)]");
  });

  it("cache miss / not-yet-loaded on-site URL: stays an ordinary link and a fallback is queued (one batch per action); external links aren't queued", () => {
    const e = env([]);
    ({ editor, container } = mount(e));
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.createLink(`/n/bob/secret`, "s");
    editor.createLink("https://example.com/x", "ext");
    expect(inline(editor).filter((n) => n.type === "link").map((n) => n.href)).toEqual(["/n/bob/secret", "https://example.com/x"]);
    return Promise.resolve().then(() => {
      expect(e.requests).toHaveLength(1);
      expect(e.requests[0]!.map((r) => [r.href, r.text])).toEqual([["/n/bob/secret", "s"]]);
    });
  });

  it("a tr with the y-sync$ meta or the knotebook:siteLinkConvert meta: not converted", () => {
    ({ editor, container } = mount(env()));
    const view = editor._tiptapEditor.view;
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "Alpha" }]);
    for (const meta of [Y_SYNC_META, SITE_LINK_CONVERT_META]) {
      let from = -1;
      view.state.doc.descendants((n: AnyView, pos: number) => {
        if (from === -1 && n.isText) from = pos;
        return from === -1;
      });
      const tr = view.state.tr.addMark(from, from + 5, view.state.schema.marks.link.create({ href: "/n/alice/alpha" }));
      tr.setMeta(meta, {});
      view.dispatch(tr);
      expect(inline(editor).some((n) => n.type === "wikilink"), meta).toBe(false);
      view.dispatch(view.state.tr.removeMark(0, view.state.doc.content.size, view.state.schema.marks.link));
    }
  });

  it("another plugin appends a link mark to a remote update / the conversion's own tr (the appended tr reaches this plugin alone): looks at the root tr, not converted", () => {
    // The test plugin appends an addMark when the root tr carries `test:linkify`. Plugin order puts it after this plugin (see mount), so this plugin first sees only the root tr (no AddMarkStep) and the appended tr alone in the next round; looking at the tr's own meta would miss y-sync$/siteLinkConvert on the root.
    const linkify = Extension.create({
      name: "testLinkify",
      addProseMirrorPlugins() {
        return [
          createPmPlugin({
            appendTransaction: (trs, _old, state) => {
              const req = trs.find((t) => t.getMeta("test:linkify") !== undefined)?.getMeta("test:linkify") as { from: number } | undefined;
              return req ? state.tr.addMark(req.from, req.from + 5, state.schema.marks.link.create({ href: "/n/alice/alpha" })) : null;
            },
          }) as never,
        ];
      },
    });
    ({ editor, container } = mount(env(), false, [linkify]));
    const view = editor._tiptapEditor.view;
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "Alpha" }]);
    for (const meta of [Y_SYNC_META, SITE_LINK_CONVERT_META]) {
      let from = -1;
      view.state.doc.descendants((n: AnyView, pos: number) => {
        if (from === -1 && n.isText) from = pos;
        return from === -1;
      });
      view.dispatch(view.state.tr.setMeta(meta, {}).setMeta("test:linkify", { from }));
      expect(inline(editor).map((n) => n.type), meta).toEqual(["link"]);
      view.dispatch(view.state.tr.removeMark(0, view.state.doc.content.size, view.state.schema.marks.link));
    }
  });

  it("typing (ReplaceStep) doesn't trigger: typing inside an existing ordinary on-site link isn't converted", () => {
    ({ editor, container } = mount(env()));
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href: "/n/alice/alpha", content: "Alpha" }] }]);
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(false); // replaceBlocks is a ReplaceStep, not converted
    const view = editor._tiptapEditor.view;
    let pos = -1;
    view.state.doc.descendants((n: AnyView, p: number) => {
      if (pos === -1 && n.isText) pos = p + 2;
      return pos === -1;
    });
    editor._tiptapEditor.commands.setTextSelection(pos);
    typeString(view, "x");
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(false);
  });

  it("deleting inside a link or typing over a selection (a ReplaceStep with from < to) doesn't trigger: the ordinary on-site link left after undoing a conversion isn't converted back by editing", () => {
    ({ editor, container } = mount(env()));
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href: "/n/alice/alpha", content: "Alpha" }] }]);
    const view = editor._tiptapEditor.view;
    let start = -1;
    view.state.doc.descendants((n: AnyView, p: number) => {
      if (start === -1 && n.isText) start = p;
      return start === -1;
    });
    view.dispatch(view.state.tr.delete(start + 2, start + 3)); // "Alpha" -> "Alha"
    expect(inline(editor).map((n) => [n.type, n.href])).toEqual([["link", "/n/alice/alpha"]]);
    editor._tiptapEditor.commands.setTextSelection({ from: start + 1, to: start + 3 });
    typeString(view, "y"); // "Alha" with "lh" selected, typing "y" -> "Aya"
    expect(inline(editor).map((n) => [n.type, n.href])).toEqual([["link", "/n/alice/alpha"]]);
  });

  it("with the plugin mounted alone drops aren't handled (a drop belongs to the drop hook `withSiteLinkDrop`): the paste rule adds a link mark but nothing is converted or queued", () => {
    const e = env();
    ({ editor, container } = mount(e));
    const view = editor._tiptapEditor.view;
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    const at = view.state.selection.from;
    view.dispatch(view.state.tr.insertText(`${ORIGIN}/n/alice/alpha ${ORIGIN}/n/bob/secret`, at).setMeta("uiEvent", "drop"));
    // Tiptap's paste rule also runs for external drops, so both URLs really became links (one hit, one miss) while the plugin converted nothing and queued no fallback: a drop belongs to the drop hook (#352, `site-link-drop.test.tsx`), which isn't mounted here. The whole `[type, href]` row is asserted at once so a wrong conversion shows a wikilink in the failure message instead of being confused with "the paste rule added no link".
    expect(inline(editor).map((n) => [n.type, n.href])).toEqual([
      ["link", `${ORIGIN}/n/alice/alpha`],
      ["text", undefined],
      ["link", `${ORIGIN}/n/bob/secret`],
    ]);
    return Promise.resolve().then(() => expect(e.requests).toEqual([]));
  });

  it("a paste (uiEvent=paste) belongs to the paste hook: with the plugin mounted alone, pasteText of a bare URL on an empty selection - the paste rule adds a link but the plugin neither converts nor queues a fallback", () => {
    const e = env();
    ({ editor, container } = mount(e));
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.pasteText(`${ORIGIN}/n/alice/alpha`);
    expect(inline(editor).map((n) => [n.type, n.href])).toEqual([["link", `${ORIGIN}/n/alice/alpha`]]);
    return Promise.resolve().then(() => expect(e.requests).toEqual([]));
  });

  it("remote update (a link written in from another Y.Doc): not converted", () => {
    const { editor: e1, doc, container: c1 } = mount(env(), true);
    editor = e1;
    container = c1;
    // Before any edit y-prosemirror hasn't written the initial empty document into the Y.Doc (the fragment is empty): write locally once so the remote side has a paragraph to insert into.
    editor.replaceBlocks(editor.document, [{ type: "paragraph" }]);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc!));
    const para = (remote.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    const content = para.get(0) as Y.XmlElement;
    const text = new Y.XmlText();
    content.insert(0, [text]);
    text.insert(0, "Alpha", { link: { href: "/n/alice/alpha" } });
    Y.applyUpdate(doc!, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc!)), "remote");
    expect(inline(editor).some((n) => n.type === "link")).toBe(true);
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(false);
  });

  it("a remote update writes on-site URL + space as plain text: the receiving side's autolink really adds a link (it doesn't skip y-sync$), but the root tr is a remote update -> not converted, no fallback queued", async () => {
    const e = env();
    const { editor: e1, doc, container: c1 } = mount(e, true);
    editor = e1;
    container = c1;
    editor.replaceBlocks(editor.document, [{ type: "paragraph" }]);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc!));
    const content = ((remote.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    const text = new Y.XmlText();
    content.insert(0, [text]);
    text.insert(0, `see ${ORIGIN}/n/alice/alpha `); // no link attribute: any link can only come from the receiver's autolink
    Y.applyUpdate(doc!, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc!)), "remote");
    expect(inline(editor).map((n) => [n.type, n.href])).toEqual([
      ["text", undefined],
      ["link", `${ORIGIN}/n/alice/alpha`],
      ["text", undefined],
    ]);
    await Promise.resolve();
    expect(e.requests).toEqual([]);
  });
});

describe("#269 async fallback", () => {
  afterEach(() => document.body.replaceChildren());

  it("resolved -> one transaction replaces links still in their original block with the same href and text; links whose text changed are dropped; with more than 20 distinct hrefs only the first 20 are asked", async () => {
    const { editor } = mount(null);
    const hrefs = Array.from({ length: 22 }, (_, i) => `/n/bob/n${i}`);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: hrefs.map((h, i) => ({ type: "link" as const, href: h, content: `t${i}` })) }]);
    const blockId = editor.document[0]!.id;
    const requests: FallbackRequest[] = hrefs.map((h, i) => ({ blockIds: [blockId], href: h, text: i === 1 ? "changed" : `t${i}`, parsed: { path: { kind: "n", handle: "bob", slug: `n${i}` }, anchorBlockId: "" } }));
    const resolve = vi.fn(async (p: { path: { kind: string; slug?: string } }) => ({ id: `${"0".repeat(8)}-0000-4000-8000-${String(p.path.slug).padStart(12, "0")}`, title: "T" }));
    const dispatchSpy = vi.spyOn(editor._tiptapEditor.view, "dispatch");
    const n = await runFallbackConversion(editor, requests, ORIGIN, resolve as never);
    expect(resolve).toHaveBeenCalledTimes(20);
    expect(n).toBe(19); // n1's text doesn't match (the request says "changed") so it is dropped; n20 and n21 are over the cap and not asked
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const tr = dispatchSpy.mock.calls[0]![0] as { getMeta(k: string): unknown };
    expect(tr.getMeta(SITE_LINK_CONVERT_META)).toBe(true);
    const types = inline(editor).map((x) => x.type);
    expect(types.filter((t) => t === "wikilink")).toHaveLength(19);
    expect(types.filter((t) => t === "link")).toHaveLength(3);
  });

  it("none resolved -> no dispatch", async () => {
    const { editor } = mount(null);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href: "/n/bob/x", content: "x" }] }]);
    const spy = vi.spyOn(editor._tiptapEditor.view, "dispatch");
    const n = await runFallbackConversion(editor, [{ blockIds: [editor.document[0]!.id], href: "/n/bob/x", text: "x", parsed: { path: { kind: "n", handle: "bob", slug: "x" }, anchorBlockId: "" } }], ORIGIN, async () => null);
    expect(n).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolved but the original link can no longer be found (text changed) -> dropped, no dispatch", async () => {
    const { editor } = mount(null);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href: "/n/bob/x", content: "x2" }] }]);
    const spy = vi.spyOn(editor._tiptapEditor.view, "dispatch");
    const n = await runFallbackConversion(editor, [{ blockIds: [editor.document[0]!.id], href: "/n/bob/x", text: "x", parsed: { path: { kind: "n", handle: "bob", slug: "x" }, anchorBlockId: "" } }], ORIGIN, async () => ({ id: A_ID, title: "Alpha" }));
    expect(n).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("the editor unmounted while waiting for the server (switched notes) -> not applied", async () => {
    const { editor, container } = mount(null);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href: "/n/bob/x", content: "x" }] }]);
    const blockId = editor.document[0]!.id;
    editor.unmount();
    container.remove();
    const n = await runFallbackConversion(editor, [{ blockIds: [blockId], href: "/n/bob/x", text: "x", parsed: { path: { kind: "n", handle: "bob", slug: "x" }, anchorBlockId: "" } }], ORIGIN, async () => ({ id: A_ID, title: "Alpha" }));
    expect(n).toBe(0);
    expect(inline(editor).map((x) => x.type)).toEqual(["link"]);
  });
});

/**
 * Undo measurements (two rows; the measured results are the assertions; collab configuration, no fake timers):
 * - AddMarkStep plugin: the conversion and the link creation are in the **same dispatch** (appendTransaction), so they should share one undo cell: the first undo makes the whole link disappear.
 * - Async fallback: (a) when the fallback lands after a pause (separated by stopCapturing), the first undo only reverts the wikilink to an ordinary link, and it isn't auto-converted again afterwards; (b) when it lands right after (same 500ms window), the first undo undoes the link creation too. MEASURED is a hypothesis derived by reasoning.
 */
const MEASURED = { addMarkSameCell: true, fallbackAfterPauseRevertsToLink: true, fallbackImmediateRemovesAll: true } as const;

describe("#269 undo measurements (plugin, fallback)", () => {
  afterEach(() => document.body.replaceChildren());

  it(`AddMarkStep plugin: the first undo makes the whole link (conversion included) disappear =${String(MEASURED.addMarkSameCell)}`, () => {
    const { editor } = mount(env(), true);
    const manager = collabUndoManager(editor)!;
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    manager.stopCapturing();
    editor.createLink("/n/alice/alpha", "x");
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(true);
    manager.undo();
    expect((editor.document[0]!.content as unknown[]).length === 0).toBe(MEASURED.addMarkSameCell);
  });

  it(`fallback lands after a pause: the first undo only reverts to an ordinary link =${String(MEASURED.fallbackAfterPauseRevertsToLink)}; it isn't auto-converted again afterwards`, async () => {
    const e = env([]);
    const { editor } = mount(e, true);
    const manager = collabUndoManager(editor)!;
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    manager.stopCapturing();
    editor.createLink("/n/bob/secret", "s");
    await Promise.resolve();
    manager.stopCapturing();
    await runFallbackConversion(editor, e.requests[0]!, ORIGIN, async () => ({ id: A_ID, title: "Alpha" }));
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(true);
    manager.undo();
    const afterUndo = inline(editor).map((n) => n.type);
    expect(afterUndo.includes("link") && !afterUndo.includes("wikilink")).toBe(MEASURED.fallbackAfterPauseRevertsToLink);
    await Promise.resolve();
    expect(e.requests).toHaveLength(1); // an undo (y-sync$) doesn't queue the fallback again
    expect(inline(editor).some((n) => n.type === "wikilink")).toBe(false);
  });

  it(`fallback lands right after (same window): the first undo undoes the link creation too =${String(MEASURED.fallbackImmediateRemovesAll)}`, async () => {
    const e = env([]);
    const { editor } = mount(e, true);
    const manager = collabUndoManager(editor)!;
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    manager.stopCapturing();
    editor.createLink("/n/bob/secret", "s");
    await Promise.resolve();
    await runFallbackConversion(editor, e.requests[0]!, ORIGIN, async () => ({ id: A_ID, title: "Alpha" }));
    manager.undo();
    expect((editor.document[0]!.content as unknown[]).length === 0).toBe(MEASURED.fallbackImmediateRemovesAll);
  });
});
