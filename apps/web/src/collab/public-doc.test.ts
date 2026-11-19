import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EMPTY_YDOC_UPDATE_B64, YDOC_FRAGMENT } from "@knotebook/shared";
import { decodePublicYdoc } from "./public-doc";

/** Computes base64 independently with btoa, not through decodePublicYdoc's own decode path (so both ends can't share one wrong implementation). */
function independentBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("decodePublicYdoc (#72: public endpoint ydoc payload -> Y.Doc)", () => {
  it("anti-tautology: EMPTY_YDOC_UPDATE_B64 must equal the empty-document encoding Y computes independently (when both ends import the same constant a wrong constant would stay green; this computes it live with Y)", () => {
    expect(independentBase64(Y.encodeStateAsUpdate(new Y.Doc()))).toBe(EMPTY_YDOC_UPDATE_B64);
  });

  it("empty document payload (AAA=) -> decodes to an empty fragment, no throw (the server returns this for notes whose editor was never opened)", () => {
    const doc = decodePublicYdoc(EMPTY_YDOC_UPDATE_B64);
    expect(doc.getXmlFragment(YDOC_FRAGMENT).length).toBe(0);
  });

  it("document with content round trip: after encode -> base64 -> decode the fragment content is the same", () => {
    const source = new Y.Doc();
    const fragment = source.getXmlFragment(YDOC_FRAGMENT);
    source.transact(() => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText("公開分享的內容")]);
      fragment.insert(0, [paragraph]);
    });

    const decoded = decodePublicYdoc(independentBase64(Y.encodeStateAsUpdate(source)));
    expect(decoded.getXmlFragment(YDOC_FRAGMENT).toString()).toBe(fragment.toString());
    expect(decoded.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("公開分享的內容");
  });

  it("malformed base64 -> throws (the caller's error boundary takes over; it must not silently return an empty document, which would render data corruption as an empty note)", () => {
    expect(() => decodePublicYdoc("not base64 !!!")).toThrow();
  });
});
