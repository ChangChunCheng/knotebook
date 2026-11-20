import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelBlocks } from "@knotebook/shared";

const BLOCKS = new Set(["blockContainer", "columnList", "column"]);

/** Every block id in document order (pre-order, any depth). */
export function allBlockIds(doc: Y.Doc): string[] {
  const out: string[] = [];
  const stack: Array<Y.XmlFragment | Y.XmlElement> = [doc.getXmlFragment(YDOC_FRAGMENT)];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const kids = node.toArray();
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid instanceof Y.XmlElement && (kid.nodeName === "blockGroup" || BLOCKS.has(kid.nodeName))) stack.push(kid);
    }
    if (node instanceof Y.XmlElement && BLOCKS.has(node.nodeName)) {
      const id = node.getAttribute("id");
      if (typeof id === "string") out.push(id);
    }
  }
  return out;
}

export function topIds(doc: Y.Doc): string[] {
  return topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT)).map(el => String(el.getAttribute("id")));
}

export function totalClock(doc: Y.Doc): number {
  let sum = 0;
  for (const c of Y.decodeStateVector(Y.encodeStateVector(doc)).values()) sum += c;
  return sum;
}
