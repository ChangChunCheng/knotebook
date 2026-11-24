import { stat } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelBlocks, DEFAULT_KNOWLEDGE_FIELD_VIEW } from "@knotebook/shared";
import { fingerprintForIds, topLevelFingerprints } from "../../src/notes/editing/fingerprint.js";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { exportNoteForTransfer } from "../../src/transfer/export-note.js";
import { SHAPE_LINK_TARGET, SHAPE_TITLES, TRANSFER_SHAPES, type ShapeBlock } from "./fixtures/transfer-shapes.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
async function docWith(blocks: ShapeBlock[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return doc;
}
const frag = (doc: Y.Doc) => doc.getXmlFragment(YDOC_FRAGMENT);
const paras = (n: number): ShapeBlock[] => Array.from({ length: n }, (_, i) => ({ type: "paragraph", content: `p${i}` }));
const byName = (name: string) => {
  const s = TRANSFER_SHAPES.find(x => x.name === name);
  if (!s) throw new Error(`no shape ${name}`);
  return s;
};

describe("exportNoteForTransfer: 129 shapes", () => {
  it("the fixture is 129 shapes (66 + 35 + 28)", () => {
    expect(TRANSFER_SHAPES).toHaveLength(129);
    expect(TRANSFER_SHAPES.filter(s => s.group === "66")).toHaveLength(66);
    expect(TRANSFER_SHAPES.filter(s => s.group === "35")).toHaveLength(35);
    expect(TRANSFER_SHAPES.filter(s => s.group === "spike")).toHaveLength(28);
  });

  it.each(TRANSFER_SHAPES.map(s => [`[${s.group}] ${s.name}`, s] as const))(
    "%s: segment table and stats match per shape, body = MCP read-out, fingerprints = per id, mounted once",
    async (_label, shape) => {
      const doc = await docWith(shape.blocks);
      const m0 = rt.mounts;
      const ex = await exportNoteForTransfer(rt, doc, SHAPE_TITLES, { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW });
      expect(rt.mounts - m0, "一篇只 mount 一次（含群組匯出）").toBe(1);
      expect(rt.inFlight).toBe(0);
      expect(ex.segments).not.toBeNull();
      expect(ex.segments!.map(s => s.ids.map(id => ex.ids.indexOf(id)))).toEqual(shape.segs);
      expect(ex.stats.groupCalls).toBe(shape.groupCalls);
      expect(ex.stats.groupUsedWhilePerMatched).toBe(shape.groupUsedWhilePerMatched);
      for (const s of ex.segments!) expect(s.fps).toEqual(s.ids.map(id => ex.fps[ex.ids.indexOf(id)]));
      const mcp = await readNoteContentFromDoc(rt, doc, undefined, SHAPE_TITLES, undefined, DEFAULT_KNOWLEDGE_FIELD_VIEW);
      if (typeof mcp === "string" || !("markdown" in mcp)) throw new Error("unexpected read shape");
      expect(ex.body).toBe(mcp.markdown);
      expect(ex.fps).toEqual(ex.ids.map(id => fingerprintForIds(frag(doc), [id])));
      expect(ex.ids).toEqual(topLevelBlocks(frag(doc)).map(c => c.getAttribute("id")));
    },
  );

  it("wikilink target not visible (titles empty): body still = MCP read-out, and differs from when visible", async () => {
    const doc = await docWith(byName("wikilink in para + bullet").blocks);
    const hidden = await exportNoteForTransfer(rt, doc, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW });
    const mcp = await readNoteContentFromDoc(rt, doc, undefined, new Map(), undefined, DEFAULT_KNOWLEDGE_FIELD_VIEW);
    if (typeof mcp === "string" || !("markdown" in mcp)) throw new Error("unexpected read shape");
    expect(hidden.body).toBe(mcp.markdown);
    const shown = await exportNoteForTransfer(rt, doc, SHAPE_TITLES, { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW });
    expect(shown.body).not.toBe(hidden.body);
    expect(shown.body).toContain("Other note");
    expect(SHAPE_TITLES.has(SHAPE_LINK_TARGET)).toBe(true);
  });
});

describe("exportNoteForTransfer: other", () => {
  it("zero-block document: empty body, zero segments, no mount", async () => {
    const doc = new Y.Doc();
    const m0 = rt.mounts;
    const ex = await exportNoteForTransfer(rt, doc, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW });
    expect(rt.mounts - m0).toBe(0);
    expect(ex).toMatchObject({ body: "", lines: [], ids: [], fps: [], types: [], segments: [], lineKinds: [] });
  });

  it("2 000 paragraphs: topLevelFingerprints < 500 ms, result = per id", async () => {
    const doc = await docWith(paras(2000));
    const t0 = performance.now();
    const { ids, fps } = topLevelFingerprints(frag(doc));
    const ms = performance.now() - t0;
    expect(ids).toHaveLength(2000);
    expect(ms).toBeLessThan(500);
    for (const k of [0, 999, 1999]) expect(fps[k]).toBe(fingerprintForIds(frag(doc), [ids[k]!]));
  }, 120_000);

  it("topLevelFingerprints: a top-level block missing its id -> throws (same as outlineOf)", async () => {
    const doc = await docWith(paras(2));
    topLevelBlocks(frag(doc))[1]!.removeAttribute("id");
    expect(() => topLevelFingerprints(frag(doc))).toThrow(/缺 id/);
  });

  it("top-level ids differ before and after mount -> degrade: body is still produced (= MCP read-out), segments null, lineKinds all 0, lease returned (a document with duplicate ids: BlockNote rewrites the duplicate ids on mount)", async () => {
    const doc = await docWith(paras(3));
    const cs = topLevelBlocks(frag(doc));
    cs[1]!.setAttribute("id", cs[0]!.getAttribute("id")!);
    expect(topLevelFingerprints(frag(doc)).ids[0]).toBe(topLevelFingerprints(frag(doc)).ids[1]);
    const m0 = rt.mounts;
    const ex = await exportNoteForTransfer(rt, doc, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW });
    expect(rt.mounts - m0).toBe(1);
    expect(rt.inFlight).toBe(0);
    expect(ex.segments).toBeNull();
    expect(ex.lines).toEqual(["p0", "", "p1", "", "p2"]);
    expect(ex.lineKinds).toEqual([0, 0, 0, 0, 0]);
    const mcp = await readNoteContentFromDoc(rt, doc, undefined, new Map(), undefined, DEFAULT_KNOWLEDGE_FIELD_VIEW);
    if (typeof mcp === "string" || !("markdown" in mcp)) throw new Error("unexpected read shape");
    expect(ex.body).toBe(mcp.markdown);
  });

  it("yield within one note (count): 1 after mount, 1 after the whole-note export, plus 2 for 120 blocks at every 50 = 4 yields; the lease is still held while yielding (inFlight 1); back to zero afterwards", async () => {
    const doc = await docWith(paras(120));
    const seen: number[] = [];
    const ex = await exportNoteForTransfer(rt, doc, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW, yieldEveryBlocks: 50,
      yieldAfterMs: Infinity,
      yieldFn: async () => {
        seen.push(rt.inFlight);
      },
    });
    expect(ex.stats.yields).toBe(4);
    expect(seen).toEqual([1, 1, 1, 1]);
    expect(rt.inFlight).toBe(0);
    expect(ex.segments).toHaveLength(120);
  }, 60_000);

  it("yield within one note (time): yieldAfterMs 0 -> yields on every block (plus 1 after mount and 1 after the whole-note export)", async () => {
    const doc = await docWith(paras(120));
    let n = 0;
    const ex = await exportNoteForTransfer(rt, doc, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW, yieldEveryBlocks: Infinity, yieldAfterMs: 0, yieldFn: async () => void n++ });
    expect(ex.stats.yields).toBeGreaterThanOrEqual(122);
    expect(n).toBe(ex.stats.yields);
  }, 60_000);

  it("the default yield function is setImmediate (really yields the event loop); 60 blocks = after mount + after the whole note + at the 50th = 3 yields", async () => {
    const doc = await docWith(paras(60));
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    const before = ticked;
    const ex = await exportNoteForTransfer(rt, doc, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW, yieldEveryBlocks: 50, yieldAfterMs: Infinity });
    expect(before).toBe(false);
    expect(ex.stats.yields).toBe(3);
    expect(ticked).toBe(true);
  }, 60_000);

  it("forceUnmergeable -> segments null, lineKinds all 0, body as usual", async () => {
    const doc = await docWith(byName("numbered start 5").blocks);
    const normal = await exportNoteForTransfer(rt, doc, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW });
    const forced = await exportNoteForTransfer(rt, doc, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW, forceUnmergeable: true });
    expect(forced.segments).toBeNull();
    expect(forced.lineKinds).toEqual(forced.lines.map(() => 0));
    expect(forced.body).toBe(normal.body);
    expect(normal.lineKinds.some(k => k === 1)).toBe(true);
  });

  it("lineKinds of a numbered segment's lines is 1, others 0 (numbered start 5, 12 items, numbered/para/numbered)", async () => {
    for (const name of ["numbered start 5", "numbered 12 items w/ child on 10"]) {
      const ex = await exportNoteForTransfer(rt, await docWith(byName(name).blocks), new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW });
      expect(ex.lines.length, name).toBeGreaterThan(0);
      expect(ex.lineKinds, name).toEqual(ex.lines.map(() => 1));
    }
    const ex = await exportNoteForTransfer(rt, await docWith(byName("numbered, para, numbered").blocks), new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW });
    const want = new Array<number>(ex.lines.length).fill(0);
    for (const s of ex.segments!) {
      const t = ex.types[ex.ids.indexOf(s.ids[0]!)];
      for (let k = s.start; k < s.start + s.count; k++) want[k] = t === "numberedListItem" ? 1 : 0;
    }
    expect(ex.lineKinds).toEqual(want);
    expect(want).toContain(0);
    expect(want).toContain(1);
  });

  it("k26 (inline colour + table, placeholder digit count) alignment: the table block forms a segment of its own", async () => {
    const shape = TRANSFER_SHAPES.find(s => s.name.startsWith("k26 "))!;
    const ex = await exportNoteForTransfer(rt, await docWith(shape.blocks), new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW });
    expect(ex.segments).not.toBeNull();
    expect(ex.segments!.map(s => s.ids.length)).toEqual(shape.segs.map(s => s.length));
  });

  it("lines/types/ids agree: lines = bodyLines(normalizeBody(body)), types follow the top level", async () => {
    const ex = await exportNoteForTransfer(rt, await docWith(byName("heading->bullet->heading").blocks), new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW });
    expect(ex.types).toEqual(["heading", "bulletListItem", "heading"]);
    expect(ex.lines).toEqual(ex.body.replace(/\n+$/, "").split("\n"));
  });
});

/** Continues in the poll phase (a microtask resolved inside an I/O callback) - in production the step before mount is the DB query in `linkTitlesFor`, same here. */
const fromIoCallback = () => new Promise<void>(r => stat(".", () => r()));
const busy = (ms: number) => {
  const t = performance.now();
  while (performance.now() - t < ms) {
    /* let timers expire / let I/O arrive */
  }
};
/** The first titles lookup = the moment the whole-note export starts (a wikilink without a label -> `titles.get`). */
function probeTitles(onFirstGet: () => void): ReadonlyMap<string, string> {
  let first = true;
  return new (class extends Map<string, string> {
    override get(k: string) {
      if (first) {
        first = false;
        onFirstGet();
      }
      return super.get(k);
    }
  })(SHAPE_TITLES);
}

describe("the default yield really crosses timers + poll (two setImmediate)", () => {
  it("continuing from an I/O callback: during the first yield after mount, a setTimeout(0) that already expired runs first (before the whole-note export)", async () => {
    const doc = await docWith(byName("wikilink in para + bullet").blocks);
    let fired = false;
    let firedBeforeFull: boolean | undefined;
    const titles = probeTitles(() => {
      firedBeforeFull = fired;
    });
    await fromIoCallback();
    setTimeout(() => {
      fired = true;
    }, 0);
    busy(5);
    await exportNoteForTransfer(rt, doc, titles, { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW, yieldEveryBlocks: Infinity, yieldAfterMs: Infinity });
    expect(firedBeforeFull).toBe(true);
  }, 60_000);

  it("continuing from an I/O callback: during the first yield after mount, socket data that has arrived is handled first (before the whole-note export)", async () => {
    const doc = await docWith(byName("wikilink in para + bullet").blocks);
    let peer: Socket | undefined;
    const srv = createServer(s => {
      peer = s;
    });
    await new Promise<void>(r => srv.listen(0, "127.0.0.1", () => r()));
    const cli = connect((srv.address() as { port: number }).port, "127.0.0.1");
    try {
      await new Promise<void>(r => cli.once("connect", () => r()));
      while (peer === undefined) await new Promise(r => setTimeout(r, 1));
      let got = false;
      let gotBeforeFull: boolean | undefined;
      peer.on("data", () => {
        got = true;
      });
      const titles = probeTitles(() => {
        gotBeforeFull = got;
      });
      await fromIoCallback();
      cli.write("x");
      busy(20);
      await exportNoteForTransfer(rt, doc, titles, { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW, yieldEveryBlocks: Infinity, yieldAfterMs: Infinity });
      expect(gotBeforeFull).toBe(true);
    } finally {
      cli.destroy();
      peer?.destroy();
      srv.close();
    }
  }, 60_000);
});
