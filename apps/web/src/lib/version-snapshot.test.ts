import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { forkLiveBlocks, ydocBytesToBlocks } from "./version-snapshot";

function docWith(blocks: unknown[]): Y.Doc {
  const doc = new Y.Doc();
  const writer = BlockNoteEditor.create({ schema: noteSchema });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote PartialBlock generic triple, repo convention
  blocksToYXmlFragment(writer, blocks as any, doc.getXmlFragment(YDOC_FRAGMENT));
  return doc;
}

const BLOCKS = [
  { id: "h1", type: "heading", props: { level: 2 }, content: "標題" },
  {
    id: "p1",
    type: "paragraph",
    content: [{ type: "text", text: "看 ", styles: {} }, { type: "wikilink", props: { targetNoteId: "note-2", snapshotTitle: "別篇" } }],
  },
];

describe("version-snapshot (reads a snapshot without mounting)", () => {
  it("ydocBytesToBlocks: snapshot bytes -> blocks, with id, type and the wikilink's targetNoteId all kept", () => {
    const bytes = Y.encodeStateAsUpdate(docWith(BLOCKS));
    const blocks = ydocBytesToBlocks(bytes);
    expect(blocks.map((b) => [b.id, b.type])).toEqual([
      ["h1", "heading"],
      ["p1", "paragraph"],
    ]);
    const inline = blocks[1].content as Array<{ type: string; props?: { targetNoteId?: string } }>;
    expect(inline.find((x) => x.type === "wikilink")?.props?.targetNoteId).toBe("note-2");
  });

  it("a truly empty document (the fragment has no node) -> []", () => {
    expect(ydocBytesToBlocks(Y.encodeStateAsUpdate(new Y.Doc()))).toEqual([]);
  });

  it("forkLiveBlocks: reads the live document's content with zero writes to it (no update event, state vector unchanged)", () => {
    const live = docWith(BLOCKS);
    const sv = Y.encodeStateVector(live);
    let updates = 0;
    live.on("update", () => {
      updates += 1;
    });
    const blocks = forkLiveBlocks(live);
    expect(blocks.map((b) => b.id)).toEqual(["h1", "p1"]);
    expect(updates).toBe(0);
    expect(Array.from(Y.encodeStateVector(live))).toEqual(Array.from(sv));
  });

  it("forkLiveBlocks: when the live document has a node the schema does not recognize, reading does not write a deletion back to the live document (what the fork is there for)", () => {
    const live = docWith(BLOCKS);
    const group = live.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement;
    const bogus = new Y.XmlElement("kbNoSuchNode");
    group.insert(group.length, [bogus]);
    const svBefore = Array.from(Y.encodeStateVector(live));
    let updates = 0;
    live.on("update", () => {
      updates += 1;
    });
    const blocks = forkLiveBlocks(live);
    expect(blocks.map((b) => b.id)).toEqual(["h1", "p1"]);
    expect(updates).toBe(0);
    expect(Array.from(Y.encodeStateVector(live))).toEqual(svBefore);
    expect(group.toArray()).toContain(bogus);
  });

  it("forkLiveBlocks reads the current snapshot: an earlier result does not follow later changes of the live document; reading again sees the new state", () => {
    const live = docWith(BLOCKS);
    const before = forkLiveBlocks(live);
    // The top-level child is the whole blockGroup, so delete(0, 1) empties the document.
    live.getXmlFragment(YDOC_FRAGMENT).delete(0, 1);
    expect(before.map((b) => b.id)).toEqual(["h1", "p1"]);
    expect(forkLiveBlocks(live)).toEqual([]);
  });
});
