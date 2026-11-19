/**
 * #398: jsdom 30 is quadratic on large child lists. (1) `_modified()` recomputes accessed live `childNodes`/`children` on every mutation, though live lists already recompute lazily on read, so they are hidden from it (the version counter is still bumped). (2) `_insert`/`_remove` compute the child's index only to update live Ranges; when no Range is attached to the parent (or, for removal, the removed subtree), as in our detached DOMs, that call returns -1; with any Range attached the original path runs.
 * If jsdom's internals change nothing is patched and false is returned (`installGlobals` warns); the perf test then goes red.
 */
import { createRequire } from "node:module";

type Ranges = { size: number } | undefined;
interface NodeImpl {
  _childNodesList: unknown;
  _childrenList: unknown;
  _referencedRanges?: Ranges;
}
interface NodeImplProto {
  _modified(this: NodeImpl): void;
  _insert(this: NodeImpl, node: NodeImpl, child: NodeImpl | null, suppress?: boolean): void;
  _remove(this: NodeImpl, node: NodeImpl, suppress?: boolean): void;
}
interface Tree {
  index(child: NodeImpl): number;
  treeIterator(root: NodeImpl): Iterable<NodeImpl>;
}

let applied: boolean | null = null;

const hasRanges = (n: NodeImpl): boolean => (n._referencedRanges?.size ?? 0) > 0;

export function patchJsdomForLargeTrees(): boolean {
  if (applied !== null) return applied;
  try {
    const req = createRequire(import.meta.url);
    const proto = (req("jsdom/lib/jsdom/living/nodes/Node-impl.js") as { implementation?: { prototype: NodeImplProto } }).implementation?.prototype;
    const tree = (req("jsdom/lib/jsdom/living/helpers/internal-constants.js") as { domSymbolTree?: Tree }).domSymbolTree;
    const modified = proto?._modified;
    const insert = proto?._insert;
    const remove = proto?._remove;
    if (proto === undefined || tree === undefined || typeof modified !== "function" || typeof insert !== "function" || typeof remove !== "function" || typeof tree.index !== "function") return (applied = false);
    const realIndex = tree.index;
    const skippingFirstIndexOf = <T>(target: NodeImpl, fn: () => T): T => {
      const before = Object.getOwnPropertyDescriptor(tree, "index");
      let skipped = false;
      tree.index = function (this: Tree, child: NodeImpl) {
        if (!skipped && child === target) {
          skipped = true;
          return -1;
        }
        return realIndex.call(this, child);
      };
      try {
        return fn();
      } finally {
        if (before) Object.defineProperty(tree, "index", before);
        else delete (tree as Partial<Tree>).index;
      }
    };
    proto._modified = function (this: NodeImpl) {
      const nodes = this._childNodesList;
      const elements = this._childrenList;
      this._childNodesList = null;
      this._childrenList = null;
      try {
        modified.call(this);
      } finally {
        this._childNodesList = nodes;
        this._childrenList = elements;
      }
    };
    proto._insert = function (this: NodeImpl, node: NodeImpl, child: NodeImpl | null, suppress?: boolean) {
      if (child === null || child === undefined || hasRanges(this)) return insert.call(this, node, child, suppress);
      return skippingFirstIndexOf(child, () => insert.call(this, node, child, suppress));
    };
    proto._remove = function (this: NodeImpl, node: NodeImpl, suppress?: boolean) {
      if (hasRanges(this)) return remove.call(this, node, suppress);
      for (const d of tree.treeIterator(node)) if (hasRanges(d)) return remove.call(this, node, suppress);
      return skippingFirstIndexOf(node, () => remove.call(this, node, suppress));
    };
    return (applied = true);
  } catch {
    return (applied = false);
  }
}
