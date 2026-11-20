import * as Y from "yjs";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { blocksToYXmlFragment, withCollaboration } from "@blocknote/core/yjs";
import { COLUMN_LIST_TYPE, COLUMN_TYPE, YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import type { EditorRef } from "@/components/wikilink/menu";
import { findNodeById } from "@/collab/columns/position";
import { createFakeDataTransfer, type FakeDataTransfer } from "./drag-fixtures";

/**
 * Shared utilities for the columns-layout web tests. The formats of `shape` / `cursorOf` / `integrity`
 * are fixed, so expected values can be copied straight from the output of `shape()` and friends.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention)
export type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
export type PartialBlockLike = PartialBlock<any, any, any>;

const inline = (text: string) => (text ? [{ type: "text" as const, text, styles: {} }] : []);
const withId = (id: string | undefined) => (id === undefined ? {} : { id });

export const P = (text: string, id?: string): PartialBlockLike => ({ ...withId(id), type: "paragraph", content: inline(text) });
export const H = (text: string, id: string): PartialBlockLike => ({ id, type: "heading", props: { level: 1 }, content: inline(text) });
export const IMG = (id: string, previewWidth?: number): PartialBlockLike => ({
  id,
  type: "image",
  props: { url: `/api/uploads/x${id}`, name: id, ...(previewWidth ? { previewWidth } : {}) },
});
export const CB = (id: string, text?: string): PartialBlockLike => ({ id, type: "codeBlock", content: inline(text ?? "") });
export const withChildren = (b: PartialBlockLike, children: PartialBlockLike[]): PartialBlockLike => ({ ...b, children });

export const row = (cols: PartialBlockLike[][], id?: string, widths?: number[]): PartialBlockLike => ({
  ...withId(id),
  type: COLUMN_LIST_TYPE,
  children: cols.map((children, i) => ({
    ...withId(id === undefined ? undefined : `${id}c${i}`),
    type: COLUMN_TYPE,
    props: { width: widths?.[i] ?? 1 },
    children,
  })),
});

type BlockLike = { type: string; content?: unknown; children?: BlockLike[] };
function shapeOf(b: BlockLike): string {
  if (b.type === COLUMN_LIST_TYPE) return `ROW[${(b.children ?? []).map(shapeOf).join(" | ")}]`;
  if (b.type === COLUMN_TYPE) return `COL(${(b.children ?? []).map(shapeOf).join(",")})`;
  const text = Array.isArray(b.content) && b.content.length ? ":" + b.content.map((c: { text?: string }) => c.text).join("") : "";
  const kids = b.children && b.children.length ? "{" + b.children.map(shapeOf).join(",") + "}" : "";
  return `${b.type}${text}${kids}`;
}

export function shape(editor: AnyEditor): string {
  return (editor.document as BlockLike[]).map(shapeOf).join("  ");
}

export function cursorOf(editor: AnyEditor): string {
  const $from = editor.prosemirrorView!.state.selection.$from;
  const block = editor.getTextCursorPosition().block as BlockLike;
  const text = Array.isArray(block.content) ? block.content.map((c: { text?: string }) => c.text).join("") : "";
  return `${text || block.type}@${$from.parentOffset}`;
}

export function pressKey(
  editor: AnyEditor,
  key: string,
  mods?: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean; altKey?: boolean },
): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  return !!view.someProp("handleKeyDown", (f) => f(view, event));
}

export function textPos(editor: AnyEditor, word: string, offset: number): number {
  let pos: number | undefined;
  editor.prosemirrorView!.state.doc.descendants((node, p) => {
    if (node.isText && node.text === word) pos = p + offset;
  });
  if (pos === undefined) throw new Error(`textPos: 找不到文字節點「${word}」`);
  return pos;
}

const BN_BLOCK_NODES = new Set(["blockContainer", COLUMN_TYPE, COLUMN_LIST_TYPE]);

export function integrity(editor: AnyEditor): { dupIds: number; nullIds: number; nestedRows: number; valid: boolean } {
  const doc = editor.prosemirrorView!.state.doc;
  const seen = new Set<string>();
  let dupIds = 0;
  let nullIds = 0;
  let nestedRows = 0;
  doc.descendants((node, pos) => {
    if (BN_BLOCK_NODES.has(node.type.name)) {
      const id = node.attrs.id as string | null | undefined;
      if (!id) nullIds += 1;
      else if (seen.has(id)) dupIds += 1;
      else seen.add(id);
    }
    if (node.type.name === COLUMN_LIST_TYPE && doc.resolve(pos).depth > 1) nestedRows += 1;
  });
  let valid = true;
  try {
    doc.check();
  } catch {
    valid = false;
  }
  return { dupIds, nullIds, nestedRows, valid };
}

/**
 * Builds an editor from `noteSchema` and mounts it in a container under `document.body`. When `extensions` is a function it receives `editorRef`,
 * and `editorRef.current` is already set after the editor is built and before mount. `collab: true`: its own Y.Doc, awareness undefined
 * (same as `collab/undo.test.tsx`); the content is written into the fragment before mounting, so the initial content isn't on the undo stack.
 */
export function mountEditor(
  content: PartialBlockLike[],
  opts?: { extensions?: unknown[] | ((editorRef: EditorRef) => unknown[]); collab?: boolean },
): { editor: AnyEditor; container: HTMLElement; editorRef: EditorRef; destroy(): void } {
  const editorRef: EditorRef = { current: null };
  const extensions = typeof opts?.extensions === "function" ? opts.extensions(editorRef) : (opts?.extensions ?? []);
  const tiptap = { _tiptapOptions: { extensions } };
  let doc: Y.Doc | undefined;
  let editor: AnyEditor;
  if (opts?.collab) {
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    const seed = BlockNoteEditor.create({ schema: noteSchema, initialContent: content }) as AnyEditor;
    blocksToYXmlFragment(seed, seed.document, fragment);
    editor = BlockNoteEditor.create(
      withCollaboration({
        schema: noteSchema,
        collaboration: {
          provider: { awareness: undefined },
          fragment,
          user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
        },
        ...tiptap,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the option type of withCollaboration requires the full schema triple
      } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
    ) as any as AnyEditor;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the element type of `_tiptapOptions.extensions` is tiptap's Extension
    editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: content, ...(tiptap as any) }) as AnyEditor;
  }
  editorRef.current = editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return {
    editor,
    container,
    editorRef,
    destroy() {
      editor.unmount();
      container.remove();
      doc?.destroy();
    },
  };
}

export function blockPos(editor: AnyEditor, id: string): number {
  const hit = findNodeById(editor.prosemirrorView!.state.doc as never, id);
  if (!hit) throw new Error(`blockPos: 找不到 block ${id}`);
  return hit.pos;
}

/**
 * Text selection `[anchor, head]`. apps/web can't get prosemirror-state's `TextSelection`: find the base `Selection` from the prototype chain of the current selection
 * and build with `fromJSON({ type: "text" })` (when the current selection is a NodeSelection its constructor isn't TextSelection).
 */
export function textSelection(editor: AnyEditor, anchor: number, head: number = anchor): unknown {
  const view = editor.prosemirrorView!;
  let base = view.state.selection.constructor as unknown as object;
  for (let parent = Object.getPrototypeOf(base); parent && parent !== Function.prototype; parent = Object.getPrototypeOf(base)) base = parent;
  return (base as { fromJSON(doc: unknown, json: unknown): unknown }).fromJSON(view.state.doc, { type: "text", anchor, head });
}

/**
 * The real path of the core drag handle: the handle stand-in is mounted under `editor.domElement.parentElement`, its dragstart calls SideMenu's `blockDragStart`,
 * and bubbles to the root so SideMenu sets `view.dragging`. When `range` gives two block ids, the text selection is first dragged from the former to the latter (core turns it into a multi-selection).
 * `prevent`: the stand-in calls `preventDefault` on dragstart after core. Returns the dispatched event and its `dataTransfer` (reused on drop).
 */
export function startBlockDrag(
  editor: AnyEditor,
  blockId: string,
  opts: { range?: readonly [string, string]; prevent?: boolean } = {},
): { event: Event; dataTransfer: FakeDataTransfer } {
  const view = editor.prosemirrorView!;
  if (opts.range) {
    const [from, to] = opts.range;
    view.dispatch(view.state.tr.setSelection(textSelection(editor, blockPos(editor, from) + 2, blockPos(editor, to) + 2) as never));
  }
  const dataTransfer = createFakeDataTransfer([], { store: true });
  const handle = document.createElement("div");
  editor.domElement!.parentElement!.appendChild(handle);
  handle.addEventListener("dragstart", (e) => {
    (editor.getExtension("sideMenu") as unknown as { blockDragStart(e: Event, block: unknown): void }).blockDragStart(e, editor.getBlock(blockId));
    if (opts.prevent) e.preventDefault();
  });
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  handle.dispatchEvent(event);
  handle.remove();
  return { event, dataTransfer };
}
