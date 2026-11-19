import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { checkExpectations, fingerprintForIds, fingerprintsOfGroups, topLevelSnapshot } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { docWith, withEditor } from "./fixtures/transfer-sync.js";

/** Pure functions of mergeDiff's multi-expectation branch (take the fragment directly, not through `mergeDiff`). */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const P = (t: string) => ({ type: "paragraph", content: t });
const frag = (d: Y.Doc) => d.getXmlFragment(YDOC_FRAGMENT);
const expectAll = (d: Y.Doc, ids: string[]) => {
  const s = topLevelSnapshot(frag(d));
  return ids.map(id => ({ id, fp: s.fps[s.ids.indexOf(id)]! }));
};

describe("multi-expectation checks", () => {
  it("all expectations match -> pass; fingerprintsOfGroups per group = fingerprintForIds, empty group -> null", async () => {
    const d = await docWith(rt, [P("a"), P("b"), P("c"), P("d")]);
    const ids = topLevelSnapshot(frag(d)).ids;
    expect(checkExpectations(frag(d), expectAll(d, [ids[1]!, ids[2]!]), [ids[0]!])).toBe(true);
    expect(fingerprintsOfGroups(frag(d), [[ids[0]!, ids[1]!], [ids[3]!], []])).toEqual([fingerprintForIds(frag(d), [ids[0]!, ids[1]!]), fingerprintForIds(frag(d), [ids[3]!]), null]);
    expect(fingerprintsOfGroups(frag(d), [[ids[1]!, ids[0]!], ["nope"]])).toEqual([null, null]); // wrong order / not top-level -> null
  });
  it("the second survivor was modified -> mismatch", async () => {
    const d = await docWith(rt, [P("a"), P("b"), P("c")]);
    const ids = topLevelSnapshot(frag(d)).ids;
    const exp = expectAll(d, [ids[0]!, ids[1]!]);
    await withEditor(rt, d, ed => ed.updateBlock(ids[1]!, { content: "B!" }));
    expect(checkExpectations(frag(d), exp, [])).toBe(false);
  });
  it("anchor deleted -> mismatch", async () => {
    const d = await docWith(rt, [P("a"), P("b"), P("c")]);
    const ids = topLevelSnapshot(frag(d)).ids;
    const exp = expectAll(d, [ids[1]!]);
    await withEditor(rt, d, ed => ed.removeBlocks([ids[2]!]));
    expect(checkExpectations(frag(d), exp, [ids[0]!])).toBe(true);
    expect(checkExpectations(frag(d), exp, [ids[2]!])).toBe(false);
  });
  it("survivors reordered -> still passes (compares each fingerprint, not order)", async () => {
    const d = await docWith(rt, [P("a"), P("b"), P("c")]);
    const ids = topLevelSnapshot(frag(d)).ids;
    const exp = expectAll(d, [ids[0]!, ids[1]!, ids[2]!]);
    await withEditor(rt, d, ed => {
      const c = ed.getBlock(ids[2]!)!;
      ed.removeBlocks([ids[2]!]);
      ed.insertBlocks([c], ids[0]!, "before");
    });
    expect(topLevelSnapshot(frag(d)).ids).toEqual([ids[2], ids[0], ids[1]]);
    expect(checkExpectations(frag(d), exp, [])).toBe(true);
  });
});

describe("performance", () => {
  it("2,000 survivors: checkExpectations < 500 ms", async () => {
    const d = await docWith(rt, Array.from({ length: 2000 }, (_, i) => P(`p${i}`)));
    const ids = topLevelSnapshot(frag(d)).ids;
    const exp = expectAll(d, ids);
    const t0 = performance.now();
    expect(checkExpectations(frag(d), exp, [ids[0]!])).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
    const t1 = performance.now();
    expect(fingerprintsOfGroups(frag(d), [ids])[0]).not.toBeNull();
    expect(performance.now() - t1).toBeLessThan(500);
  }, 60_000);
});
