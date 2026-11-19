/**
 * Stacking and image-column marking are node decorations on rows and columns (`data-stacked`, `data-kb-col-kind`), not direct DOM edits: PM's DOMObserver would read those as
 * document changes (jsdom can't show this; e2e covers it). No `style` is emitted: a column's renderHTML writes `flex:N 1 0` and a decoration style would override it.
 * - Attached to the block spec rather than an editor option: every `noteSchema` editor needs it and read-only options forbid `_tiptapOptions`. `withColumnsLayout` returns a new object so the headless
 *   schema (server) doesn't pick the plugin up.
 * - `view()` scans once on creation: a static read-only editor gets no `update()` without transactions.
 * - A column's kind changes with its content while the row width stays the same, so ResizeObserver doesn't fire; on document change recompute with the last measured width (keyed by row id).
 */
import { createExtension, type ExtensionOptions } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import { Decoration, DecorationSet } from "prosemirror-view";
import { createPmPlugin } from "../pm-plugin";
import { attachDragSourceRecorder } from "./drag-source";
import { attachColumnImageResize } from "./image-resize";
import { columnKindOf, shouldStack, type ColumnKind, type PMNodeLike } from "./layout";

export const STACKED_ATTR = "data-stacked";
export const COLUMN_KIND_ATTR = "data-kb-col-kind";

const ROW_SELECTOR = `[data-node-type="${COLUMN_LIST_TYPE}"]`;

interface StateLike {
  doc: PMNodeLike;
}
interface TransactionLike {
  getMeta(key: unknown): unknown;
  setMeta(key: unknown, value: unknown): TransactionLike;
}
interface ViewLike {
  dom: HTMLElement;
  state: StateLike & { tr: TransactionLike };
  dispatch(tr: TransactionLike): void;
}
interface PluginLike {
  getState(state: StateLike): ReadonlySet<string>;
}

function forEachRow(doc: PMNodeLike, f: (row: PMNodeLike, pos: number) => void): void {
  doc.firstChild?.forEach((node, offset) => {
    if (node.type.name === COLUMN_LIST_TYPE) f(node, offset + 1);
  });
}

function kindsOf(row: PMNodeLike): ColumnKind[] {
  const kinds: ColumnKind[] = [];
  row.forEach((col) => {
    if (col.type.name === COLUMN_TYPE) kinds.push(columnKindOf(col));
  });
  return kinds;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function layoutDecorations(doc: PMNodeLike, stacked: ReadonlySet<string>): DecorationSet {
  const decorations: Decoration[] = [];
  forEachRow(doc, (row, pos) => {
    if (stacked.has(row.attrs.id as string)) decorations.push(Decoration.node(pos, pos + row.nodeSize, { [STACKED_ATTR]: "" }));
    row.forEach((col, offset) => {
      const from = pos + 1 + offset;
      if (columnKindOf(col) === "image") decorations.push(Decoration.node(from, from + col.nodeSize, { [COLUMN_KIND_ATTR]: "image" }));
    });
  });
  return DecorationSet.create(doc as unknown as Parameters<typeof DecorationSet.create>[0], decorations);
}

function createStackingPlugin(): never {
  const plugin: PluginLike = createPmPlugin({
    state: {
      init: () => new Set<string>(),
      apply: (tr: TransactionLike, value: ReadonlySet<string>) => (tr.getMeta(plugin) as ReadonlySet<string> | undefined) ?? value,
    },
    props: { decorations: (state: StateLike) => layoutDecorations(state.doc, plugin.getState(state)) },
    view(editorView: ViewLike) {
      if (typeof ResizeObserver === "undefined") return {};
      const observed = new WeakSet<Element>();
      const widths = new Map<string, number>();
      let destroyed = false;

      const compute = (state: StateLike): Set<string> => {
        const next = new Set<string>();
        forEachRow(state.doc, (row) => {
          const id = row.attrs.id as string;
          const width = widths.get(id);
          if (width !== undefined && shouldStack(kindsOf(row), width)) next.add(id);
        });
        return next;
      };
      const commit = () => {
        if (destroyed) return;
        const next = compute(editorView.state);
        if (sameSet(next, plugin.getState(editorView.state))) return;
        editorView.dispatch(editorView.state.tr.setMeta(plugin, next).setMeta("addToHistory", false));
      };

      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          // Row elements replaced / removed by PM may report 0 width once more; recording it would overwrite the width of a new element with the same id. Stop observing; the next scan() re-observes it if reattached.
          if (!entry.target.isConnected) {
            observer.unobserve(entry.target);
            observed.delete(entry.target);
            continue;
          }
          const id = entry.target.getAttribute("data-id");
          if (id) widths.set(id, (entry.target as HTMLElement).clientWidth);
        }
        commit();
      });
      const scan = () => {
        editorView.dom.querySelectorAll(ROW_SELECTOR).forEach((el) => {
          if (observed.has(el)) return;
          observed.add(el);
          observer.observe(el);
        });
      };
      scan();

      return {
        update(view: ViewLike, prevState: StateLike) {
          scan();
          if (prevState.doc === view.state.doc) return;
          if (sameSet(compute(view.state), plugin.getState(view.state))) return;
          // Don't dispatch synchronously inside update; the scheduled commit rechecks that the view isn't destroyed and the set still differs.
          queueMicrotask(commit);
        },
        destroy() {
          destroyed = true;
          observer.disconnect();
        },
      };
    },
  }) as PluginLike;
  return plugin as never;
}

// Function form `createExtension(fn)()`: fn runs per editor, so each gets the editor and its own plugin instance.
export const columnsLayoutExtension = createExtension(({ editor }: ExtensionOptions<undefined>) => ({
  key: "knotebookColumnsLayout",
  prosemirrorPlugins: [createStackingPlugin()],
  mount: ({ dom, signal }: { dom: HTMLElement; signal: AbortSignal }) => {
    attachColumnImageResize(editor, dom, signal);
    attachDragSourceRecorder(editor, dom, signal);
  },
}))();

interface BlockSpecLike {
  extensions?: readonly unknown[];
}

export function withColumnsLayout<S extends BlockSpecLike>(spec: S): S {
  return { ...spec, extensions: [...(spec.extensions ?? []), columnsLayoutExtension] };
}
