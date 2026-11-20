import { stat } from "node:fs";
import { describe, expect, it } from "vitest";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { normalizeBody } from "../../src/transfer/normalize.js";
import { yieldToLoop } from "../../src/transfer/yield.js";
import { docWith, forkOf, makeBaseInMemory, planInMemory } from "./fixtures/transfer-sync.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
type Candidates = Array<{ id: string; title: string; slug: string; groupId: string | null; ownerHandle: string }>;
const P = (t: string) => ({ type: "paragraph", content: t });
const NL = (t: string) => ({ type: "numberedListItem", content: t });
const clock = (step: number) => {
  let t = 0;
  return () => (t += step);
};
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(`not ok: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};
const marks = (r: { plan: { decisions: Array<{ kind: string; mark: string }> } }) => r.plan.decisions.map(d => `${d.kind}:${d.mark}`);

describe("one scratch session, zero DB while holding the lease", () => {
  // #398: parsing (including the boundary parse) happens outside the lease (in production inside the parse worker); the scratch session is opened only when writing pre-parsed blocks - so inFlight is 0 (while parsing) or 1 (while writing into scratch) at yields.
  it("mounts differ by 1 (including the boundary parse), inFlight 0 afterwards, no lease held while parsing", async () => {
    const doc = await docWith(rt, [P("A"), P("B"), P("C")]);
    const b = await makeBaseInMemory(rt, doc);
    const live = forkOf(doc);
    const m0 = rt.mounts;
    const inFlightAtYield: number[] = [];
    // a line `X` pasted before `C` (no blank line) -> C's boundary is parsed once in the same scratch session
    const r = ok(
      await planInMemory(rt, b, "A\n\nB2\n\nX\nC", live, {
        now: clock(25),
        yieldFn: async () => {
          inFlightAtYield.push(rt.inFlight);
        },
      }),
    );
    expect(rt.mounts - m0).toBe(1);
    expect(rt.inFlight).toBe(0);
    expect(inFlightAtYield.length).toBeGreaterThan(0);
    expect(inFlightAtYield.some(n => n === 0)).toBe(true);
    expect(inFlightAtYield.every(n => n <= 1)).toBe(true);
    expect(r.plan.boundaryChecks).toBe(1);
    expect(marks(r)).toEqual(["rewrite:applied"]);
  });
});

describe("parse failure -> the whole note is not written", () => {
  it("a rewrite region fails to parse (unsupported_color) -> { ok: false }", async () => {
    const doc = await docWith(rt, [P("A"), P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    expect(await planInMemory(rt, b, 'A\n\nx <span style="color:tomato">orange-ish</span>', forkOf(doc))).toMatchObject({ ok: false, code: "unsupported_color" });
  });
  it("an unterminated `<!--` pasted above an unchanged segment -> empty_content; rewriting a paragraph and adding an unterminated `<!--` on the line before -> empty_content", async () => {
    const doc = await docWith(rt, [P("A"), P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    expect(await planInMemory(rt, b, "A\n\n<!--\nB", forkOf(doc))).toMatchObject({ ok: false, code: "empty_content" });
    expect(await planInMemory(rt, b, "A\n\n<!--\nB2", forkOf(doc))).toMatchObject({ ok: false, code: "empty_content" });
  });
});

describe("file-level unclosed code fence -> the whole note is not written", () => {
  it("an unclosed ``` line added above a 0-line-separated list -> { ok: false, code: unclosed_fence }, one mount only, lease returned", async () => {
    const doc = await docWith(rt, [P("Z"), { type: "bulletListItem", content: "a" }, { type: "bulletListItem", content: "b" }]);
    const b = await makeBaseInMemory(rt, doc);
    expect(await planInMemory(rt, b, "Z\n\n```\n* a\n* b", forkOf(doc))).toMatchObject({ ok: false, code: "unclosed_fence" });
    expect(rt.inFlight).toBe(0);
  });
});

describe("same criterion (planning only happens when current = base)", () => {
  it("no human edit, the agent only changes the spelling (`*` -> `-`) -> same (a non-conflicting region is also judged same first, ids not replaced)", async () => {
    const doc = await docWith(rt, [P("A"), { type: "bulletListItem", content: "item" }, P("C")]);
    const b = await makeBaseInMemory(rt, doc);
    expect(normalizeBody(b.body)).toBe("A\n\n* item\n\nC");
    expect(marks(ok(await planInMemory(rt, b, "A\n\n- item\n\nC", forkOf(doc))))).toEqual(["rewrite:same"]);
  });
  it("contrast: a region with the same content and no human edit -> applied (it would replace ids if it were not same)", async () => {
    const doc = await docWith(rt, [P("A"), P("B"), P("C")]);
    const b = await makeBaseInMemory(rt, doc);
    const r = ok(await planInMemory(rt, b, "A\n\nB2\n\nC", forkOf(doc)));
    expect(marks(r)).toEqual(["rewrite:applied"]);
  });
});

describe("a pre-parsed numbered in the middle of a list is rewritten -> start is stripped", () => {
  it("changing item 2 -> stripStart, the pre-parse has no start; the first list item -> kept", async () => {
    const doc = await docWith(rt, [NL("a"), NL("b"), NL("c")]);
    const b = await makeBaseInMemory(rt, doc);
    const mid = ok(await planInMemory(rt, b, "1. a\n2. b2\n3. c", forkOf(doc)));
    expect(mid.plan.decisions[0]).toMatchObject({ mark: "applied", stripStart: true });
    expect((mid.plan.parsed[0]![0]!.props as Record<string, unknown>).start).toBeUndefined();
    const doc5 = await docWith(rt, [{ type: "numberedListItem", content: "a", props: { start: 5 } }, NL("b")]);
    const b5 = await makeBaseInMemory(rt, doc5);
    const first = ok(await planInMemory(rt, b5, "5. a2\n6. b", forkOf(doc5)));
    expect(first.plan.decisions[0]).toMatchObject({ mark: "applied", stripStart: false });
    expect((first.plan.parsed[0]![0]!.props as Record<string, unknown>).start).toBe(5);
  });
});

describe("yielding", () => {
  it("5 regions -> yields >= 5 (time budget: the clock advances 25 ms per read)", async () => {
    const doc = await docWith(rt, Array.from({ length: 10 }, (_, i) => P(`p${i}`)));
    const b = await makeBaseInMemory(rt, doc);
    const body = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? `p${i} changed` : `p${i}`)).join("\n\n");
    let yields = 0;
    const r = ok(await planInMemory(rt, b, body, forkOf(doc), { now: clock(25), yieldFn: async () => void yields++ }));
    expect(r.plan.regions).toHaveLength(5);
    expect(yields).toBeGreaterThanOrEqual(5);
  });
  it("deterministic: the clock advances 25 ms per read -> 1 after open + 1 after each region's parse + 1 after each region's write into scratch (replaces the wall-clock threshold)", async () => {
    const doc = await docWith(rt, Array.from({ length: 10 }, (_, i) => P(`p${i}`)));
    const b = await makeBaseInMemory(rt, doc);
    const body = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? `p${i} changed` : `p${i}`)).join("\n\n");
    let yields = 0;
    const r = ok(await planInMemory(rt, b, body, forkOf(doc), { now: clock(25), yieldFn: async () => void yields++ }));
    expect(r.plan.regions).toHaveLength(5);
    expect(r.plan.boundaryChecks).toBe(0);
    expect(yields).toBe(1 + 5 + 5);
  });
  it("contrast: the clock does not advance -> only the unconditional yield after open", async () => {
    const doc = await docWith(rt, Array.from({ length: 10 }, (_, i) => P(`p${i}`)));
    const b = await makeBaseInMemory(rt, doc);
    const body = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? `p${i} changed` : `p${i}`)).join("\n\n");
    let yields = 0;
    ok(await planInMemory(rt, b, body, forkOf(doc), { now: clock(0), yieldFn: async () => void yields++ }));
    expect(yields).toBe(1);
  });
  it("entered from an I/O callback (default yieldFn): the timer has already run before the first region's parse (the first read of candidates)", async () => {
    const doc = await docWith(rt, [P("A"), P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    let fired = false;
    let firedAtFirstRead: boolean | undefined;
    const candidates = new Proxy([] as Candidates, {
      get(t, k, r) {
        firedAtFirstRead ??= fired;
        return Reflect.get(t, k, r);
      },
    });
    await new Promise<void>(r => stat(".", () => r()));
    setTimeout(() => {
      fired = true;
    }, 0);
    const t = performance.now();
    while (performance.now() - t < 5) {
      /* busy */
    }
    ok(await planInMemory(rt, b, "A\n\nB2", forkOf(doc), { candidates }));
    expect(firedAtFirstRead).toBe(true);
    void yieldToLoop;
  });
});

describe("#398: the unclosed-fence check also goes through runtime.parser (production = the parse worker), not parsed on the main thread", () => {
  it("a changed line that looks like a fence -> parser.openFenceLine is called once (with the writer); if it says too complex -> the whole note unsupported_block / too_complex", async () => {
    const calls: Array<[string, number]> = [];
    const inline = new EditingRuntime({ baseUrl: "http://localhost/" });
    const spyRt = new EditingRuntime({
      baseUrl: "http://localhost/",
      parser: {
        parse: req => inline.parser.parse(req),
        openFenceLine: async (owner, lines) => {
          calls.push([owner, lines.length]);
          return "too_complex";
        },
        fileBudget: () => inline.parser.fileBudget(),
        timeoutMs: () => inline.parser.timeoutMs(),
        close: async () => {},
      },
    });
    const doc = await docWith(rt, [P("A"), P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    expect(await planInMemory(spyRt, b, "A\n\n```\n\nB", forkOf(doc))).toMatchObject({ ok: false, code: "unsupported_block", detail: "too_complex" });
    expect(calls).toEqual([["test-user", 5]]);
  });
});

describe("#398: a too-complex answer from the boundary-check parse -> the whole file is too complex (it is not treated as \"boundary does not hold\" and parsing continues with the next segment)", () => {
  it("10 paragraphs stuck on one line, every parse answers too_complex -> planSync returns unsupported_block / too_complex, and parsing was done only once", async () => {
    let calls = 0;
    const inline = new EditingRuntime({ baseUrl: "http://localhost/" });
    const spyRt = new EditingRuntime({
      baseUrl: "http://localhost/",
      parser: {
        parse: async () => {
          calls++;
          return { error: "unsupported_block", detail: "too_complex" };
        },
        openFenceLine: async () => null,
        fileBudget: () => inline.parser.fileBudget(),
        timeoutMs: () => inline.parser.timeoutMs(),
        close: async () => {},
      },
    });
    const paras = Array.from({ length: 10 }, (_, k) => `Para ${k}`);
    const doc = await docWith(rt, paras.map(P));
    const b = await makeBaseInMemory(rt, doc);
    expect(await planInMemory(spyRt, b, "X\n" + paras.join("\n"), forkOf(doc))).toMatchObject({ ok: false, code: "unsupported_block", detail: "too_complex" });
    expect(calls).toBe(1);
  });
});
