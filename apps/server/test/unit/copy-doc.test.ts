/**
 * #175: Y.Doc handling for copies (`notes/copy-doc.ts`, pure Yjs, no DB). Integration coverage is in `test/groups-v2-copy.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { cloneForCopy, rewriteUploadUrls } from "../../src/notes/copy-doc.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
function docWith(urls: string[]): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  group.insert(0, urls.map((u, i) => {
    const c = new Y.XmlElement("blockContainer"); c.setAttribute("id", `b${i}`);
    const img = new Y.XmlElement("image"); img.setAttribute("url", u);
    c.insert(0, [img]); return c;
  }));
  return doc;
}

describe("cloneForCopy/rewriteUploadUrls (#175)", () => {
  it("clone has identical XML but is a different Y.Doc (different clientID)", () => {
    const src = docWith([`/api/uploads/${U1}`, "https://example.com/a.png"]);
    const { doc } = cloneForCopy(src);
    expect(doc.getXmlFragment(YDOC_FRAGMENT).toString()).toBe(src.getXmlFragment(YDOC_FRAGMENT).toString());
    expect(doc.clientID).not.toBe(src.clientID);
  });
  it("collects only nodes whose url is exactly /api/uploads/<uuid>; nested ones too; nodes with the same id group together; uppercase uuids are normalized to lowercase keys", () => {
    const src = docWith([`/api/uploads/${U1}`, `/api/uploads/${U1}`, `/api/uploads/${U2.toUpperCase()}`,
      "https://example.com/a.png", `https://host/api/uploads/${U1}`, `/api/uploads/${U1}?x=1`, "/api/uploads/not-a-uuid"]);
    const { uploadNodes } = cloneForCopy(src);
    expect([...uploadNodes.keys()].sort()).toEqual([U1, U2]);
    expect(uploadNodes.get(U1)).toHaveLength(2);
  });
  it("rewrite: all nodes with the same id get the same new id; nodes absent from the mapping are untouched; the source doc is unaffected", () => {
    const src = docWith([`/api/uploads/${U1}`, `/api/uploads/${U1}`, `/api/uploads/${U2}`]);
    const before = src.getXmlFragment(YDOC_FRAGMENT).toString();
    const copy = cloneForCopy(src);
    const N1 = "33333333-3333-4333-8333-333333333333";
    rewriteUploadUrls(copy, new Map([[U1, N1]]));
    const xml = copy.doc.getXmlFragment(YDOC_FRAGMENT).toString();
    expect(xml.split(`/api/uploads/${N1}`).length - 1).toBe(2);
    expect(xml).toContain(`/api/uploads/${U2}`);
    expect(src.getXmlFragment(YDOC_FRAGMENT).toString()).toBe(before);
  });
  it("empty document: clone is empty, no attachments", () => {
    const { doc, uploadNodes } = cloneForCopy(new Y.Doc());
    expect(doc.getXmlFragment(YDOC_FRAGMENT).length).toBe(0);
    expect(uploadNodes.size).toBe(0);
  });
  it("source guard: `notes/tx/copy.ts` (comments stripped) does not write updatedAt/updated_at, so a copy's updated_at comes only from the DB default (the MCP list_notes sort documentation relies on this)", () => {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/notes/tx/copy.ts");
    const src = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toContain("copyNoteInTx"); // reads the right file (comment stripping did not strip everything)
    expect(src).not.toMatch(/updatedAt|updated_at/);
  });
});
