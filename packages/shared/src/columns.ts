// Clean-room MIT code (don't import or consult @blocknote/xl-multi-column). Node names match core's
// columnList/column so core's UniqueID, fixColumnList, keyboard and SideMenu handling apply.
// Only renderHTML/toExternalHTML closures touch document (at mount/export); importing doesn't touch the DOM.
// External columns must be in a valid external row, or PM wraps a lone one into a row with an empty column.
// The site-form column rule is unrestricted: copy-paste inside a column rebuilds through it. Not `context: "columnList/"`: that makes such a paste throw.
// Changing a node name, group, content or prop changes the note schema: bump NOTE_SCHEMA_VERSION.
import { createBlockSpecFromTiptapNode } from "@blocknote/core";
import { Node } from "@tiptap/core";

export const COLUMN_LIST_TYPE = "columnList";
export const COLUMN_TYPE = "column";
export const COLUMN_LIST_GROUP = "childContainer bnBlock blockGroupChild";
export const COLUMN_LIST_CONTENT = "column column+";
export const COLUMN_GROUP = "bnBlock childContainer";
export const COLUMN_CONTENT = "blockContainer+";
export const COLUMNS_MIN = 2;
export const COLUMNS_MAX = 4;
export const COLUMN_WIDTH_MIN = 0.1;
export const COLUMN_WIDTH_MAX = 10;
export const COLUMN_WIDTH_DEFAULT = 1;
export const COLUMN_BLOCK_TYPES: ReadonlySet<string> = new Set([COLUMN_LIST_TYPE, COLUMN_TYPE]);
export const COLUMNS_STYLE = "display:flex;gap:16px";
export const COLUMNS_OPEN_TAG = `<div data-kb-columns style="${COLUMNS_STYLE}">`;

export function clampColumnWidth(n: number): number {
  if (!Number.isFinite(n)) return COLUMN_WIDTH_DEFAULT;
  return Math.round(Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, n)) * 100) / 100;
}

export function formatColumnWidth(n: number): string {
  return String(clampColumnWidth(n));
}

export function columnOpenTag(width: number): string {
  return `<div data-kb-column style="flex:${formatColumnWidth(width)}">`;
}

const FLEX_RE = /(?:^|;)\s*flex\s*:\s*([0-9]+(?:\.[0-9]+)?)/i;
export function parseColumnFlex(style: string | null): number {
  const m = FLEX_RE.exec(style ?? "");
  return m ? clampColumnWidth(Number(m[1])) : COLUMN_WIDTH_DEFAULT;
}

// Walk siblings: on the server, jsdom's `children` costs O(children) per access.
const countChildren = (el: Element, selector: string) => {
  let n = 0;
  for (let c = el.firstElementChild; c !== null; c = c.nextElementSibling) if (c.matches(selector)) n++;
  return n;
};
const hasEnoughColumns = (el: HTMLElement) =>
  countChildren(el, "div[data-node-type=column],div[data-kb-column]") >= COLUMNS_MIN ? {} : false;
const inExternalRow = (el: HTMLElement) => {
  const parent = el.parentElement;
  return parent && parent.matches("div[data-kb-columns]") && countChildren(parent, "div[data-kb-column]") >= COLUMNS_MIN ? {} : false;
};

function container(className: string, nodeType: string, attrs: Record<string, unknown>, style?: string): HTMLDivElement {
  const dom = document.createElement("div");
  dom.className = className;
  dom.setAttribute("data-node-type", nodeType);
  if (style !== undefined) dom.setAttribute("style", style);
  for (const [k, v] of Object.entries(attrs)) if (v != null) dom.setAttribute(k, String(v));
  return dom;
}

export const ColumnListNode = Node.create({
  name: COLUMN_LIST_TYPE,
  group: COLUMN_LIST_GROUP,
  content: COLUMN_LIST_CONTENT,
  priority: 40,
  parseHTML() {
    return [
      { tag: "div[data-node-type=columnList]", getAttrs: hasEnoughColumns },
      { tag: "div[data-kb-columns]", getAttrs: hasEnoughColumns },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    const dom = container("bn-block-column-list", COLUMN_LIST_TYPE, HTMLAttributes);
    return { dom, contentDOM: dom };
  },
});

export const ColumnNode = Node.create({
  name: COLUMN_TYPE,
  group: COLUMN_GROUP,
  content: COLUMN_CONTENT,
  priority: 40,
  addAttributes() {
    return {
      // Width is written into style by the node's renderHTML (flex:N 1 0), not as an attribute.
      width: { default: COLUMN_WIDTH_DEFAULT, parseHTML: (el: HTMLElement) => parseColumnFlex(el.getAttribute("style")), renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-node-type=column]" }, { tag: "div[data-kb-column]", getAttrs: inExternalRow }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const dom = container("bn-block-column", COLUMN_TYPE, HTMLAttributes, `flex:${formatColumnWidth(node.attrs.width as number)} 1 0`);
    return { dom, contentDOM: dom };
  },
});

// Own toExternalHTML, not defaultBlockToHTML: emit only attributes that read back canonically (no class/data-id/data-node-type).
const listSpec = createBlockSpecFromTiptapNode({ node: ColumnListNode, type: COLUMN_LIST_TYPE, content: "none" }, {});
export const columnListBlockSpec: typeof listSpec = {
  ...listSpec,
  implementation: {
    ...listSpec.implementation,
    toExternalHTML: () => {
      const dom = document.createElement("div");
      dom.setAttribute("data-kb-columns", "");
      dom.setAttribute("style", COLUMNS_STYLE);
      return { dom, contentDOM: dom };
    },
  },
};

const colSpec = createBlockSpecFromTiptapNode(
  { node: ColumnNode, type: COLUMN_TYPE, content: "none" },
  { width: { default: COLUMN_WIDTH_DEFAULT } },
);
export const columnBlockSpec: typeof colSpec = {
  ...colSpec,
  implementation: {
    ...colSpec.implementation,
    toExternalHTML: (block: { props: { width: number } }) => {
      const dom = document.createElement("div");
      dom.setAttribute("data-kb-column", "");
      dom.setAttribute("style", `flex:${formatColumnWidth(block.props.width)}`);
      return { dom, contentDOM: dom };
    },
  },
};
