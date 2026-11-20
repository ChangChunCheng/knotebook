/**
 * Note size limit (`notes/note-size.ts`): the rule judged on results (`capBlocks` + the four numbers of `measureTrial`; used by API/MCP/batch write-back/undo/apply version/copy),
 * the seven bypass forms, and configuration. Collab updates from the browser aren't checked on the server (the web editor blocks them itself).
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { loadConfig } from "../../src/config.js";
import {
  DEFAULT_NOTE_MAX_BYTES,
  SIZE_SLACK_BYTES,
  capBlocks,
  collabMaxPayloadBytes,
  growsPastCap,
  liveContentBytes,
  measureTrial,
  noteTooLargeMessage,
  stateSize,
  type SizeMeasure,
} from "../../src/notes/note-size.js";

const MiB = 1024 * 1024;
const frag = (d: Y.Doc) => d.getXmlFragment(YDOC_FRAGMENT);
const para = (d: Y.Doc, i: number) => frag(d).get(i) as Y.XmlElement;
const text = (d: Y.Doc, i: number) => para(d, i).get(0) as Y.XmlText;
const mkPara = (s: string) => {
  const p = new Y.XmlElement("paragraph");
  const t = new Y.XmlText();
  t.insert(0, s);
  p.insert(0, [t]);
  return p;
};
/** A note: one paragraph per string under the body fragment. */
function noteDoc(paras: string[]): Y.Doc {
  const d = new Y.Doc();
  d.transact(() => frag(d).insert(0, paras.map(mkPara)));
  return d;
}
/** A note over the cap: paragraph 0 has 100,000 characters, 39 others have 200 each; the cap = state minus 1,000. */
function overCap() {
  const doc = noteDoc(Array.from({ length: 40 }, (_, i) => (i === 0 ? "y".repeat(100_000) : "x".repeat(200))));
  return { doc, cap: stateSize(doc) - 1_000 };
}
/** A collab client (same as a browser): first syncs the server's copy, then each `edit` returns the update of that transaction (not applied to the server's copy). */
function client(server: Y.Doc) {
  const c = new Y.Doc();
  Y.applyUpdate(c, Y.encodeStateAsUpdate(server));
  const edit = (f: (d: Y.Doc) => void): Uint8Array => {
    let out: Uint8Array | null = null;
    const h = (u: Uint8Array) => (out = u);
    c.on("update", h);
    c.transact(() => f(c));
    c.off("update", h);
    return out ?? new Uint8Array([0, 0]);
  };
  return Object.assign(edit, { doc: c });
}
const measure = (doc: Y.Doc, u: Uint8Array) => measureTrial(Y.encodeStateAsUpdate(doc), u);
function varuint(n: number, out: number[]) {
  while (n > 127) {
    out.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

describe("capBlocks: blocked only when over the cap, larger than before, and (the live content grows, or the state grows by more than SLACK at once)", () => {
  const m = (stateBefore: number, stateAfter: number, liveBefore: number, liveAfter: number): SizeMeasure => ({ stateBefore, stateAfter, liveBefore, liveAfter });
  it.each([
    [m(100, 150, 10, 60), 200, false], // within the cap
    [m(100, 201, 10, 60), 200, true], // grew past the cap, content grew
    [m(300, 250, 50, 60), 200, false], // already over, state got smaller (even if content grew)
    [m(300, 301, 50, 51), 200, true], // already over, one character added
    [m(300, 343, 50, 50), 200, false], // already over, equal-size rewrite (state grows 43 B) -> accepted
    [m(300, 300 + SIZE_SLACK_BYTES, 50, 40), 200, false], // content shrank, state grew exactly SLACK -> accepted
    [m(300, 301 + SIZE_SLACK_BYTES, 50, 40), 200, true], // content shrank, state grew more than SLACK -> blocked (a trick that only grows bookkeeping)
    [m(0, 200, 0, 100), 200, false], // exactly equal to the cap
  ])("%o cap %i -> %s", (mm, cap, expected) => {
    expect(capBlocks(mm, cap)).toBe(expected);
  });
  it("SLACK is 4 KiB; growsPastCap (for copy) = over the cap and larger than before", () => {
    expect(SIZE_SLACK_BYTES).toBe(4096);
    expect(growsPastCap(0, 201, 200)).toBe(true);
    expect(growsPastCap(300, 250, 200)).toBe(false);
  });
  it("the 413 message states the actual rule: deleting and shortening are still accepted, to add content split the note", () => {
    expect(noteTooLargeMessage(5)).toContain("Deleting and shortening are still accepted");
    expect(noteTooLargeMessage(5)).not.toMatch(/always accepted|adds no more than it removes/);
  });
});

describe("liveContentBytes/measureTrial: remaining content is measured with Yjs's encoder", () => {
  it("every kind of content is counted at its size: text, attributes (key + value), formats, embeds, subdocument guid/meta, XmlHook names, BigInt", () => {
    const N = 50_000;
    const cases: Array<[string, (d: Y.Doc) => void]> = [
      ["text", d => text(d, 0).insert(0, "a".repeat(N))],
      ["attr value", d => para(d, 0).setAttribute("v", "A".repeat(N))],
      ["attr key", d => para(d, 0).setAttribute("K".repeat(N), "1")],
      ["format", d => text(d, 0).format(0, 2, { link: { href: "q".repeat(N) } })],
      ["embed", d => text(d, 0).insertEmbed(0, { src: "e".repeat(N) })],
      ["subdoc meta", d => para(d, 0).setAttribute("d", new Y.Doc({ meta: "M".repeat(N) }) as never)],
      ["subdoc guid", d => para(d, 0).setAttribute("d", new Y.Doc({ guid: "G".repeat(N) }) as never)],
      ["xmlhook", d => para(d, 0).insert(1, [new Y.XmlHook("H".repeat(N)) as never])],
      ["bigint", d => para(d, 0).setAttribute("b", Array.from({ length: N / 8 }, (_, i) => BigInt(i) * 1_000_000_000_000n) as never)],
    ];
    for (const [name, f] of cases) {
      const doc = noteDoc(["hello"]);
      const before = liveContentBytes(doc);
      doc.transact(() => f(doc));
      expect(liveContentBytes(doc) - before, name).toBeGreaterThanOrEqual(N * 0.9);
    }
  });
  it("deleted content doesn't count; measureTrial returns the four before/after numbers (applied on a new document)", () => {
    const doc = noteDoc(["hello wonderful world"]);
    const u = client(doc)(d => text(d, 0).delete(6, 10));
    const r = measure(doc, u);
    expect(r.stateBefore).toBe(stateSize(doc));
    expect(r.liveAfter).toBe(r.liveBefore - 10); // splitting into two items doesn't count the length prefix twice
    const applied = new Y.Doc();
    Y.applyUpdate(applied, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(applied, u);
    expect(r.stateAfter).toBe(stateSize(applied));
  });
});

describe("five bypass forms: always blocked on a note over the cap", () => {
  it("duplicated delete ranges (the same range deleted 40 times, claiming 4 MB deleted) + inserting 1 MiB", () => {
    const { doc, cap } = overCap();
    let u = client(doc)(d => text(d, 5).insert(0, "Z".repeat(MiB)));
    expect(u[u.length - 1]).toBe(0); // an empty delete set
    const item = text(doc, 0)._start!;
    const ds: number[] = [];
    varuint(1, ds);
    varuint(item.id.client, ds);
    varuint(40, ds);
    for (let i = 0; i < 40; i++) {
      varuint(item.id.clock, ds);
      varuint(item.length, ds);
    }
    u = new Uint8Array([...u.subarray(0, u.length - 1), ...ds]);
    expect(capBlocks(measure(doc, u), cap)).toBe(true);
  });

  it("set a 1 MiB key in the same transaction and then delete it (the content is ContentDeleted, the key stays in the state): in the body -> blocked by size; in another root -> blocked by root type", () => {
    const { doc, cap } = overCap();
    const K = "K".repeat(MiB);
    const inNote = client(doc)(d => {
      para(d, 3).setAttribute(K, "1");
      para(d, 3).removeAttribute(K);
    });
    const m = measure(doc, inNote);
    expect(m.liveAfter).toBe(m.liveBefore); // content didn't grow: blocked by SLACK
    expect(m.stateAfter - m.stateBefore).toBeGreaterThan(MiB);
    expect(capBlocks(m, cap)).toBe(true);
    const foreign = client(doc)(d => {
      d.getMap("evil").set(K, 1);
      d.getMap("evil").delete(K);
    });
    expect(capBlocks(measure(doc, foreign), cap)).toBe(true);
  });

  it("subdocument meta/guid of 1 MiB (plus deleting 3 characters)", () => {
    for (const opts of [{ meta: "M".repeat(MiB) }, { guid: "G".repeat(MiB) }]) {
      const { doc, cap } = overCap();
      const inNote = client(doc)(d => {
        para(d, 1).setAttribute("d", new Y.Doc(opts) as never);
        text(d, 1).delete(0, 3);
      });
      expect(capBlocks(measure(doc, inNote), cap)).toBe(true);
      const foreign = client(doc)(d => {
        d.getMap("evil").set("d", new Y.Doc(opts));
        text(d, 1).delete(0, 3);
      });
      expect(capBlocks(measure(doc, foreign), cap)).toBe(true);
    }
  });

  it("XmlHook name of 1 MiB (plus deleting 3 characters)", () => {
    const { doc, cap } = overCap();
    const inNote = client(doc)(d => {
      para(d, 1).insert(1, [new Y.XmlHook("H".repeat(MiB)) as never]);
      text(d, 1).delete(0, 3);
    });
    expect(capBlocks(measure(doc, inNote), cap)).toBe(true);
    const foreign = client(doc)(d => {
      d.getXmlFragment("evil").insert(0, [new Y.XmlHook("H".repeat(MiB)) as never]);
      text(d, 1).delete(0, 3);
    });
    expect(capBlocks(measure(doc, foreign), cap)).toBe(true);
  });

  it("BigInt inside ContentAny (a value JSON can't measure)", () => {
    const { doc, cap } = overCap();
    const big = () => Array.from({ length: 100_000 }, (_, i) => BigInt(i) * 1_000_000_000_000n);
    const inNote = client(doc)(d => para(d, 2).setAttribute("b", big() as never));
    expect(capBlocks(measure(doc, inNote), cap)).toBe(true);
    const foreign = client(doc)(d => d.getArray("evil").insert(0, [big()]));
    expect(capBlocks(measure(doc, foreign), cap)).toBe(true);
  });
});

describe("two more: delete 1 character plus a large attribute, a large link format", () => {
  it("delete 1 character + set a 4 MiB attribute -> blocked", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => {
      text(d, 4).delete(0, 1);
      para(d, 4).setAttribute("x", "A".repeat(4 * MiB));
    });
    expect(capBlocks(measure(doc, u), cap)).toBe(true);
  });
  it("apply a 2 MiB link format -> blocked", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => text(d, 4).format(0, 5, { link: { href: "https://e.com/" + "q".repeat(2 * MiB) } }));
    expect(capBlocks(measure(doc, u), cap)).toBe(true);
  });
});

describe("on a note over the cap: ordinary deletions and rewrites are still accepted, adding content is blocked", () => {
  it("select all + type one character -> accepted (applied once as a trial)", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => {
      frag(d).delete(1, frag(d).length - 1);
      text(d, 0).delete(0, text(d, 0).length);
      text(d, 0).insert(0, "a");
    });
    expect(capBlocks(measure(doc, u), cap)).toBe(false);
  });
  it("equal-size rewrite (abc -> xyz) -> accepted", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => {
      text(d, 6).delete(10, 3);
      text(d, 6).insert(10, "xyz");
    });
    const m = measure(doc, u);
    expect(m.stateAfter).toBeGreaterThan(m.stateBefore); // the state grows a little, the content doesn't
    expect(m.liveAfter).toBe(m.liveBefore);
    expect(capBlocks(measure(doc, u), cap)).toBe(false);
  });
  it("delete a large span + type a few characters -> accepted", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => {
      text(d, 0).delete(0, 90_000);
      text(d, 0).insert(0, "hi there");
    });
    expect(capBlocks(measure(doc, u), cap)).toBe(false);
  });
  it("select one character and type a longer one to replace it (the state grows only tens of bytes, but the content grows) -> blocked", () => {
    const { doc, cap } = overCap();
    const u = client(doc)(d => {
      text(d, 6).delete(10, 3);
      text(d, 6).insert(10, "a longer word");
    });
    const m = measure(doc, u);
    expect(m.stateAfter - m.stateBefore).toBeLessThan(SIZE_SLACK_BYTES);
    expect(capBlocks(measure(doc, u), cap)).toBe(true);
  });
});

describe("NOTE_MAX_BYTES setting", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: "a".repeat(64), PUBLIC_URL: "http://localhost:3000" };
  it("default 5 MiB; a positive integer can be set; empty string = unset; 0, negatives, decimals, non-numbers and anything above 1 GiB -> startup fails", () => {
    expect(DEFAULT_NOTE_MAX_BYTES).toBe(5_242_880);
    expect(loadConfig(base).limitEnv.noteMaxBytes, "沒設＝undefined").toBeUndefined();
    expect(loadConfig({ ...base, NOTE_MAX_BYTES: "1048576" }).limitEnv.noteMaxBytes).toBe(1_048_576);
    expect(loadConfig({ ...base, NOTE_MAX_BYTES: "" }).limitEnv.noteMaxBytes, "空字串＝未設").toBeUndefined();
    for (const bad of ["0", "-1", "1.5", "abc", String(1024 ** 3 + 1)]) expect(() => loadConfig({ ...base, NOTE_MAX_BYTES: bad }), bad).toThrow(/NOTE_MAX_BYTES/);
  });
});

describe("collabMaxPayloadBytes (limit of a single collab WebSocket message)", () => {
  it("without env: twice the largest admin page value plus 1 MiB (11 MiB); with env: twice the env value plus 1 MiB; never above ws's default 100 MiB", () => {
    expect(collabMaxPayloadBytes(undefined)).toBe(11_534_336);
    expect(collabMaxPayloadBytes(1_048_576)).toBe(3_145_728);
    expect(collabMaxPayloadBytes(1_073_741_824)).toBe(104_857_600);
  });
});
