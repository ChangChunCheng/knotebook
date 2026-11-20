import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { docClock } from "../../src/collab/store.js";

describe("docClock (sum of per-client seq from Y.decodeStateVector(Y.encodeStateVector(doc)))", () => {
  it("empty doc -> 0", () => {
    expect(docClock(new Y.Doc())).toBe(0);
  });

  it("single client: strictly increases after each edit, by the length of the written op", () => {
    const doc = new Y.Doc();
    expect(docClock(doc)).toBe(0);

    doc.getText("t").insert(0, "a");
    expect(docClock(doc)).toBe(1);

    doc.getText("t").insert(1, "bc");
    expect(docClock(doc)).toBe(3);

    doc.getText("t").insert(3, "defgh");
    expect(docClock(doc)).toBe(8);
  });

  it("multiple clients: after merging an update from another clientID the clock is the sum of both (increases, not replaced)", () => {
    const docA = new Y.Doc();
    docA.getText("t").insert(0, "abc");
    expect(docClock(docA)).toBe(3);

    const docB = new Y.Doc();
    docB.getText("t").insert(0, "de");
    expect(docClock(docB)).toBe(2);

    // Merge docB's update into docA to simulate a remote sync: docA now holds both clients' contributions.
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    expect(docClock(docA)).toBe(5);

    // The reverse merge also works: after docB takes docA's full update both converge on the same sum.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    expect(docClock(docB)).toBe(5);
  });

  it("encodeStateAsUpdate/applyUpdate round trip: clock unchanged", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "hello world");
    const before = docClock(doc);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));

    expect(docClock(restored)).toBe(before);
  });

  it("clock does not decrease after tombstone/GC merging triggered by deletes (stays at the pre-delete sum)", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "hello world");
    const beforeDelete = docClock(doc);
    expect(beforeDelete).toBe(11);

    // Deleting only marks existing items as deleted (possibly splitting one in two); it consumes no new clock.
    doc.getText("t").delete(0, 5);
    expect(docClock(doc)).toBeGreaterThanOrEqual(beforeDelete);

    // After one encodeStateAsUpdate/applyUpdate round trip (gc is on by default, deleted items are compressed into GC structs) the clock
    // still must not drop below the pre-delete sum: GC only affects which content is kept, not the basis for "which clock each client is
    // known up to".
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
    expect(docClock(restored)).toBeGreaterThanOrEqual(beforeDelete);
  });
});
