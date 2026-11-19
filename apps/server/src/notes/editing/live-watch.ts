/**
 * Records which top-level blocks others changed since the state was taken, so a merge proceeds unless a block this write cares about was touched. Starting over on any change made busy notes (from ~0.2 MB of state a worker round trip outlasts keystrokes) lose three times in a row (503). On a touched block the worker rechecks `if_match` on the new state (409 if the target section changed), still at most 3 tries, then 503. Cost is independent of note size.
 */
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";

/** `none`: append/replace_all without `if_match`, create. `any`: whole-note `if_match`, bulk write-back. `blocks`: conflict if a listed container changed or was deleted, or a block was inserted right after one (it would land in the target section); deleted `anchors` conflict; `absent` ids back at top level block the merge (`mergeAtBase` checks it); empty `items` conflict only when the top level can't be read. */
export type MergeGuard = { kind: "none" } | { kind: "any" } | { kind: "blocks"; items: string[]; anchors: string[]; absent?: string[] };

export const itemKey = (id: Y.ID): string => `${id.client}:${id.clock}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs type-tree node; the generic parameter is meaningless here
type AnyType = Y.AbstractType<any>;

/** Containers are ContentType items of length 1 and never split, so their ids are stable across docs. */
export function containerItems(fragment: Y.XmlFragment, blockIds: readonly string[]): string[] {
  if (blockIds.length === 0) return [];
  const want = new Set(blockIds);
  const group = fragment.get(0);
  const out: string[] = [];
  if (!(group instanceof Y.XmlElement)) return out;
  for (const child of group.toArray()) {
    if (child instanceof Y.XmlElement && want.has(child.getAttribute("id") as string) && child._item !== null) out.push(itemKey(child._item.id));
  }
  return out;
}

export class LiveWatch {
  private readonly touched = new Set<string>();
  private readonly deleted = new Set<string>();
  private readonly insertedAfter = new Set<string>();
  private changed = false;
  private unknown = false;
  private readonly handler: (tr: Y.Transaction) => void;
  private stopped = false;

  constructor(readonly doc: Y.Doc) {
    this.handler = tr => this.record(tr);
    doc.on("afterTransaction", this.handler);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.doc.off("afterTransaction", this.handler);
  }

  conflicts(guard: MergeGuard): boolean {
    if (guard.kind === "none") return false;
    if (guard.kind === "any") return this.changed;
    if (this.unknown) return true;
    for (const k of guard.items) if (this.touched.has(k) || this.deleted.has(k) || this.insertedAfter.has(k)) return true;
    for (const k of guard.anchors) if (this.deleted.has(k)) return true;
    return false;
  }

  private record(tr: Y.Transaction): void {
    if (tr.changed.size === 0 && tr.deleteSet.clients.size === 0) return;
    this.changed = true;
    const root = this.doc.getXmlFragment(YDOC_FRAGMENT);
    const first = root.length > 0 ? root.get(0) : null;
    const group = first instanceof Y.XmlElement && first.nodeName === "blockGroup" ? first : null;
    let structural = false;
    const rootRef = root as unknown as AnyType;
    const groupRef = group as unknown as AnyType | null;
    for (const type of tr.changed.keys() as IterableIterator<AnyType>) {
      if (type === rootRef) {
        this.unknown = true;
        continue;
      }
      if (groupRef !== null && type === groupRef) {
        structural = true;
        continue;
      }
      let t: AnyType = type;
      while (t._item !== null && t._item.parent !== groupRef) t = t._item.parent as AnyType;
      if (t._item === null) {
        if (t === rootRef) this.unknown = true;
        continue;
      }
      this.touched.add(itemKey(t._item.id));
    }
    if (structural && group !== null) {
      for (let item = group._start; item !== null; item = item.right) {
        if (Y.isDeleted(tr.deleteSet, item.id)) this.deleted.add(itemKey(item.id));
        else if (!item.deleted && item.id.clock >= (tr.beforeState.get(item.id.client) ?? 0)) {
          let left = item.left;
          while (left !== null && (left.deleted || left.id.clock >= (tr.beforeState.get(left.id.client) ?? 0))) left = left.left;
          if (left !== null) this.insertedAfter.add(itemKey(left.id));
        }
      }
    }
  }
}
