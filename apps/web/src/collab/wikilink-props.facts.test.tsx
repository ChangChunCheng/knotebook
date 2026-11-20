import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { YDOC_FRAGMENT, canonicalizeElements, topLevelBlocks } from "@knotebook/shared";
import "@/i18n";
import { noteSchema } from "./schema";

// Facts about BlockNote / y-prosemirror: the expected values are the observed behaviour, so when they change,
// update the expectation, not the product code.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; any per repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the same alias also types PM nodes (prosemirror-model is not a dependency of apps/web) and prop callbacks; keep any
type AnyView = any;

const TARGET = "22222222-2222-4222-8222-222222222222";

function mountInView(editor: AnyEditor) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BlockNoteView editor={editor} editable />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function legacyDoc(): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  const c1 = new Y.XmlElement("blockContainer");
  c1.setAttribute("id", "p1");
  const p1 = new Y.XmlElement("paragraph");
  // Write the paragraph's default props up front (notes written by the editor already have them): otherwise `move` would also
  // backfill paragraph defaults, changing p1's normalization, and MEASURED_CANONICAL.move could not tell whether the wikilink backfill caused it.
  p1.setAttribute("backgroundColor", "default");
  p1.setAttribute("textAlignment", "left");
  p1.setAttribute("textColor", "default");
  const before = new Y.XmlText();
  const wl = new Y.XmlElement("wikilink");
  wl.setAttribute("targetNoteId", TARGET);
  wl.setAttribute("snapshotTitle", "Legacy Title");
  const after = new Y.XmlText();
  p1.insert(0, [before, wl, after]);
  c1.insert(0, [p1]);
  const c2 = new Y.XmlElement("blockContainer");
  c2.setAttribute("id", "p2");
  const p2 = new Y.XmlElement("paragraph");
  const t2 = new Y.XmlText();
  p2.insert(0, [t2]);
  c2.insert(0, [p2]);
  group.insert(0, [c1, c2]);
  before.insert(0, "before ");
  after.insert(0, " after");
  t2.insert(0, "second");
  return doc;
}

function wikilinkElements(doc: Y.Doc): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  for (const node of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker((n) => n instanceof Y.XmlElement && n.nodeName === "wikilink")) {
    out.push(node as Y.XmlElement);
  }
  return out;
}

function anyBackfilled(doc: Y.Doc): boolean {
  return wikilinkElements(doc).some((el) => "label" in el.getAttributes() || "anchorBlockId" in el.getAttributes());
}

function collabEditor(doc: Y.Doc): AnyEditor {
  return BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: { provider: { awareness: undefined }, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { id: "u1", name: "U", color: "#123456" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema generic triple (same as markdown-link.rule.test.tsx)
    } as any),
  ) as AnyEditor;
}

function caretInBefore(editor: AnyEditor): void {
  const view: AnyView = editor._tiptapEditor.view;
  let target = -1;
  view.state.doc.descendants((node: AnyView, pos: number) => {
    if (target === -1 && node.isText && String(node.text).startsWith("before")) target = pos + 2;
    return target === -1;
  });
  editor._tiptapEditor.commands.setTextSelection(target);
}

function pressEnter(editor: AnyEditor): void {
  const view: AnyView = editor._tiptapEditor.view;
  view.someProp("handleKeyDown", (f: (v: AnyView, e: KeyboardEvent) => boolean) => f(view, new KeyboardEvent("keydown", { key: "Enter" })));
}

type Op = "open" | "type" | "split" | "move" | "paste";
/** Whether the old wikilink's Y attributes get the default props backfilled (children whose `mappedIdentity` holds are skipped; only a rebuilt node is backfilled). */
const MEASURED: Record<Op, boolean> = { open: false, type: false, split: true, move: true, paste: true };
/**
 * Whether p1's normalization (the input of the MCP paragraph fingerprint) changes because of the backfill. Only open / move are
 * recorded (neither changes p1's text). Kept apart from MEASURED: if `canonicalizeElements` omits attributes equal to the default,
 * a backfill would not change it, so the two can disagree.
 */
const MEASURED_CANONICAL: Record<"open" | "move", boolean> = { open: false, move: true };

function p1WikilinkAttrKeys(doc: Y.Doc): string[][] {
  const out: string[][] = [];
  for (const c of topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT)).filter((x) => x.getAttribute("id") === "p1")) {
    for (const node of c.createTreeWalker((n) => n instanceof Y.XmlElement && n.nodeName === "wikilink")) {
      out.push(Object.keys((node as Y.XmlElement).getAttributes()).sort());
    }
  }
  return out;
}

async function measure(op: Op): Promise<{
  backfilled: boolean;
  p1CanonicalChanged: boolean;
  legacyProps: Record<string, unknown> | null;
  p1Text: string;
  p1OriginalAttrKeys: string[][];
}> {
  const doc = legacyDoc();
  const canonicalP1 = () => canonicalizeElements(topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT)).filter((c) => c.getAttribute("id") === "p1"));
  const before = canonicalP1();
  const editor = collabEditor(doc);
  const view = mountInView(editor);
  try {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    if (op === "type") {
      caretInBefore(editor);
      editor._tiptapEditor.commands.insertContent("x");
    } else if (op === "split") {
      caretInBefore(editor);
      pressEnter(editor);
    } else if (op === "move") {
      editor.setTextCursorPosition("p1");
      editor.moveBlocksDown();
    } else if (op === "paste") {
      editor.setTextCursorPosition("p2", "end");
      editor.pasteHTML(editor.blocksToFullHTML([editor.getBlock("p1")!]));
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // When the editor reads the old Y.Doc, the old wikilink's new props read as the default "".
    const legacyProps =
      (editor.getBlock("p1")?.content as Array<{ type: string; props?: Record<string, unknown> }> | undefined)?.find((n) => n.type === "wikilink")?.props ?? null;
    const p1Text = ((editor.getBlock("p1")?.content ?? []) as Array<{ type: string; text?: string }>).map((n) => (n.type === "text" ? n.text : "")).join("");
    return { backfilled: anyBackfilled(doc), p1CanonicalChanged: canonicalP1() !== before, legacyProps, p1Text, p1OriginalAttrKeys: p1WikilinkAttrKeys(doc) };
  } finally {
    view.unmount();
    doc.destroy();
  }
}

describe("#269 facts: round trip of the new props in a real editor (BlockNoteView mounted)", () => {
  afterEach(() => document.body.replaceChildren());

  it("blocks serialization (blocksToFullHTML = the internal serializer, not the blocknote/html clipboard one) -> tryParseHTMLToBlocks keeps label and anchorBlockId", () => {
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [{ type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: TARGET, snapshotTitle: "S", label: "L", anchorBlockId: "b1" } }] }],
    }) as AnyEditor;
    const view = mountInView(editor);
    try {
      const html = editor.blocksToFullHTML(editor.document);
      const parsed = editor.tryParseHTMLToBlocks(html);
      const node = (parsed[0]!.content as Array<{ type: string; props: Record<string, string> }>)[0]!;
      expect(node).toMatchObject({ type: "wikilink", props: { targetNoteId: TARGET, label: "L", anchorBlockId: "b1" } });
    } finally {
      view.unmount();
    }
  });

  it("in-site copy/paste: blocknote/html = innerHTML of view.serializeForClipboard carries two data-* attributes, and a wikilink pasted through pasteHTML(html, true) (raw) keeps label and anchorBlockId", () => {
    // BlockNote 0.52.1 copyExtension: `blocknote/html` = `view.serializeForClipboard(selection.content()).dom.innerHTML`;
    // on paste, `blocknote/html` always goes through `editor.pasteHTML(html, true)` (PM raw paste, not re-parsed into blocks).
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [
        { type: "paragraph", content: ["a ", { type: "wikilink", props: { targetNoteId: TARGET, snapshotTitle: "S", label: "L", anchorBlockId: "b1" } }, " b"] },
        { type: "paragraph", content: "second" },
      ],
    }) as AnyEditor;
    const mountedView = mountInView(editor);
    try {
      const view: AnyView = editor._tiptapEditor.view;
      let range: { from: number; to: number } | null = null;
      view.state.doc.descendants((node: AnyView, pos: number) => {
        if (range === null && node.type.name === "paragraph") range = { from: pos + 1, to: pos + 1 + node.content.size };
        return range === null;
      });
      editor._tiptapEditor.commands.setTextSelection(range!);
      const html: string = view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
      expect(html).toContain('data-label="L"');
      expect(html).toContain('data-anchor-block-id="b1"');

      editor.setTextCursorPosition(editor.document[1]!.id, "end");
      editor.pasteHTML(html, true);
      const pasted = (editor.document[1]!.content as Array<{ type: string; props?: Record<string, string> }>).find((n) => n.type === "wikilink");
      expect(pasted?.props).toEqual({ targetNoteId: TARGET, snapshotTitle: "S", label: "L", anchorBlockId: "b1" });
    } finally {
      mountedView.unmount();
    }
  });
});

describe("#269 facts: when a newer tab backfills default props onto an old wikilink", () => {
  afterEach(() => document.body.replaceChildren());

  for (const op of ["open", "type", "split", "move", "paste"] as const) {
    it(`${op}: Y attribute backfill is ${String(MEASURED[op])}`, async () => {
      const r = await measure(op);
      // Precondition: type's "not backfilled" only means something if the text was really typed.
      if (op === "type") expect(r.p1Text).toContain("bexfore");
      expect(r.backfilled).toBe(MEASURED[op]);
      // For paste, backfilled = true because the pasted copy carries all attributes; the source p1 is not backfilled (copying does not touch the source).
      if (op === "paste") expect(r.p1OriginalAttrKeys).toEqual([["snapshotTitle", "targetNoteId"]]);
      // open / move do not change p1's text, so whether p1's normalization (the input of the MCP paragraph fingerprint) changed depends only on the attribute backfill.
      if (op === "open" || op === "move") expect(r.p1CanonicalChanged).toBe(MEASURED_CANONICAL[op]);
      if (op === "open") expect(r.legacyProps).toMatchObject({ targetNoteId: TARGET, snapshotTitle: "Legacy Title", label: "", anchorBlockId: "" });
    });
  }
});
