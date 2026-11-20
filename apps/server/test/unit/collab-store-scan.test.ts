import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { collectUnsafeUrlFindings } from "../../src/collab/store.js";

/** Builds a block element with the given attributes and attaches it to the collab fragment. */
function insertBlock(doc: Y.Doc, nodeName: string, attrs: Record<string, string>, parent?: Y.XmlElement): Y.XmlElement {
  const element = new Y.XmlElement(nodeName);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  if (parent) parent.insert(parent.length, [element]);
  else doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
  return element;
}

describe("collectUnsafeUrlFindings (issue #44, minimal step: detect only, no rewriting)", () => {
  it("javascript:/data: url attributes -> one finding each (block name and scheme, not the URL itself)", () => {
    const doc = new Y.Doc();
    insertBlock(doc, "image", { url: "javascript:alert(1)" });
    insertBlock(doc, "video", { url: "data:text/html;base64,PHNjcmlwdD4=" });

    const findings = collectUnsafeUrlFindings(doc);
    expect(findings).toHaveLength(2);
    expect(findings).toContainEqual({ block: "image", scheme: "javascript:" });
    expect(findings).toContainEqual({ block: "video", scheme: "data:" });
    // The URL itself (attacker-controlled content) must never appear in a finding.
    expect(JSON.stringify(findings)).not.toContain("alert");
    expect(JSON.stringify(findings)).not.toContain("base64");
  });

  it("nested elements (under blockGroup/blockContainer) are scanned too", () => {
    const doc = new Y.Doc();
    const group = insertBlock(doc, "blockGroup", {});
    const container = insertBlock(doc, "blockContainer", {}, group);
    insertBlock(doc, "file", { url: "javascript:void(0)" }, container);

    expect(collectUnsafeUrlFindings(doc)).toEqual([{ block: "file", scheme: "javascript:" }]);
  });

  it("own-upload relative URLs, external http(s), and empty strings -> no findings (consistent with the isSafeMediaUrl allowlist in @knotebook/shared)", () => {
    const doc = new Y.Doc();
    insertBlock(doc, "image", { url: "/api/uploads/u1" });
    insertBlock(doc, "image", { url: "https://example.com/a.png" });
    insertBlock(doc, "image", { url: "http://example.com/a.png" });
    insertBlock(doc, "file", { url: "" });

    expect(collectUnsafeUrlFindings(doc)).toEqual([]);
  });

  it("ordinary text attributes containing a colon (caption/name) are not flagged: only attributes named url are checked", () => {
    const doc = new Y.Doc();
    insertBlock(doc, "image", { url: "https://example.com/a.png", caption: "note: remember this", name: "time: 12:30" });

    expect(collectUnsafeUrlFindings(doc)).toEqual([]);
  });

  it("empty document -> no findings", () => {
    expect(collectUnsafeUrlFindings(new Y.Doc())).toEqual([]);
  });

  it("non-string url attribute values (a hostile client can write any Yjs value) are scanned too: URL's ToString flattens arrays", () => {
    const doc = new Y.Doc();
    const element = new Y.XmlElement("image");
    element.setAttribute("url", ["javascript:alert(1)"] as unknown as string);
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);

    expect(collectUnsafeUrlFindings(doc)).toEqual([{ block: "image", scheme: "javascript:" }]);
  });

  it("deep nesting (5000 levels) does not blow up: the traversal is iterative, and depth is attacker-controlled", () => {
    const doc = new Y.Doc();
    let parent = new Y.XmlElement("blockContainer");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [parent]);
    for (let i = 0; i < 5_000; i += 1) {
      const child = new Y.XmlElement("blockContainer");
      parent.insert(0, [child]);
      parent = child;
    }
    const leaf = new Y.XmlElement("image");
    leaf.setAttribute("url", "javascript:deep");
    parent.insert(0, [leaf]);

    expect(collectUnsafeUrlFindings(doc)).toEqual([{ block: "image", scheme: "javascript:" }]);
  });

  it("block name (any string a client writes into the Y.Doc) is truncated to 64 chars: the size of a single log line must not be attacker-controlled", () => {
    const doc = new Y.Doc();
    insertBlock(doc, "x".repeat(1_000), { url: "javascript:alert(1)" });

    const findings = collectUnsafeUrlFindings(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.block).toBe("x".repeat(64));
  });

  it("the number of findings is not capped (the cap on the distinct list is on the log side): 11 distinct block names are all listed", () => {
    // The log-side cap (at most 10 distinct names plus a total) lives in onStoreDocument in store.ts; this pure function returns every
    // finding so the log side can report the right blocksTotal. Together with the integration assertion in collab-store.test.ts it
    // pins the documented "at most ten listed".
    const doc = new Y.Doc();
    for (let i = 0; i < 11; i += 1) insertBlock(doc, `custom-block-${i}`, { url: "javascript:x" });

    const findings = collectUnsafeUrlFindings(doc);
    expect(findings).toHaveLength(11);
    expect(new Set(findings.map(f => f.block)).size).toBe(11);
  });

  it("scanning is read-only: for a doc built only via applyUpdate (production shape) the state bytes are identical before and after", () => {
    // In production the server-side doc gets its content only through Y.applyUpdate, so share entries are AbstractType and
    // getXmlFragment's conversion branch runs on such docs (benign today). This pins it: if a yjs upgrade makes it an operation
    // that produces an update, this goes red.
    const source = new Y.Doc();
    const el = new Y.XmlElement("image");
    el.setAttribute("url", "javascript:alert(1)");
    source.getXmlFragment(YDOC_FRAGMENT).insert(0, [el]);
    const update = Y.encodeStateAsUpdate(source);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    const before = Y.encodeStateAsUpdate(doc);
    const beforeSv = Y.encodeStateVector(doc);

    collectUnsafeUrlFindings(doc);

    expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(Buffer.from(before));
    expect(Buffer.from(Y.encodeStateVector(doc))).toEqual(Buffer.from(beforeSv));
  });
});
