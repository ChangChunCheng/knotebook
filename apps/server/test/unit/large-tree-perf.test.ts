/**
 * #398: heavy content that is accepted (tens of thousands of inline nodes in one paragraph) must not be quadratic on the main thread.
 * - Y types are not walked with `get(i)` indexing (`note-sections.ts`, `same-canonical.ts`, `decide.ts`).
 * - three quadratic spots in jsdom (`jsdom-perf.ts`): semantics unchanged, and linear.
 * - replacing a large chunk of content inserts first and removes after the editor is closed (`ForkEdits.replace`), with the same result as `replaceBlocks`.
 * Only guards against going quadratic again, not absolute speed: the same shape is measured at N/8 and N, ratio < 24 (linear is about 8-16,
 * quadratic about 64; `expectLinear`); when N is fast it passes outright, and there is a loose absolute cap. Documents built for measurement are reused, not re-parsed.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT, blocksToNoteMarkdown, topLevelBlocks } from "@knotebook/shared";
import { canonicalizeElements } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, forkFrom, withForkEditor } from "../../src/notes/editing/session.js";
import { editOnFork } from "../../src/notes/editing/doc-jobs.js";
import { outlineOf, topLevelSnapshot } from "../../src/notes/editing/fingerprint.js";
import { sameCanonicalOf } from "../../src/transfer/same-canonical.js";
import { isLoneEmptyParagraph } from "../../src/transfer/decide.js";
import { patchJsdomForLargeTrees } from "../../src/notes/editing/jsdom-perf.js";
import { normalizeBody } from "../../src/transfer/normalize.js";
import { expectLinear, timeIt, yieldToLoop } from "../perf-helpers.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const timed = <T,>(f: () => T): [T, number] => {
  const t = performance.now();
  const v = f();
  return [v, performance.now() - t];
};
// Yield to the event loop before every step of building a large document (`yieldToLoop`): the parsing and applying here are large
// synchronous jobs, and chaining them would hold the vitest worker (onTaskUpdate times out after 60 s, as seen in the CI of #400).
const parse = async (md: string) => {
  await yieldToLoop();
  const r = await rt.parser.parse({ owner: "u", markdown: md, candidates: [], siteOrigin: "http://localhost" });
  if ("error" in r) throw new Error(JSON.stringify(r));
  return r.blocks;
};
async function docOfBlocks(blocks: unknown[]): Promise<Y.Doc> {
  await yieldToLoop();
  const doc = new Y.Doc();
  await withForkEditor(rt, doc, Y.encodeStateVector(doc), (ed, edits) => {
    edits.replace(ed.document.map(b => b.id), blocks as never);
  });
  return doc;
}
const docOf = async (md: string): Promise<Y.Doc> => docOfBlocks(await parse(md));

describe("Y type traversal is linear (`get(i)` walks from the start every time)", () => {
  it("paragraphs with `x<br>` x 1,500 and x 12,000 (about 24,000 child nodes): outlineOf/topLevelSnapshot/canonicalize/sameCanonicalOf are linear", async () => {
    const docs = new Map<number, Y.Doc>();
    for (const n of [1_500, 12_000]) docs.set(n, await docOf("x<br>".repeat(n)));
    const steps: Array<[string, (frag: Y.XmlFragment, top: Y.XmlElement[]) => unknown]> = [
      ["outlineOf", frag => outlineOf(frag)],
      ["topLevelSnapshot", frag => topLevelSnapshot(frag)],
      ["canonicalizeElements", (_, top) => canonicalizeElements(top)],
      ["sameCanonicalOf", (_, top) => sameCanonicalOf(top[0]!)],
    ];
    for (const [name, f] of steps) {
      await expectLinear(`#398 ${name}`, n => {
        const frag = docs.get(n)!.getXmlFragment(YDOC_FRAGMENT);
        const top = topLevelBlocks(frag);
        expect(top).toHaveLength(1);
        return timed(() => f(frag, top))[1];
      }, 12_000);
    }
  }, 240_000);
});

describe("isLoneEmptyParagraph's walk over a paragraph's children is linear (it must really walk them all; the shape is tens of thousands of empty XmlText in one paragraph)", () => {
  it("paragraphs with 2,500 and 20,000 empty XmlText: the result is true, and linear (`get(i)` would be quadratic)", async () => {
    const docs = new Map<number, Y.XmlFragment>();
    for (const n of [2_500, 20_000]) {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment(YDOC_FRAGMENT);
      doc.transact(() => {
        const group = new Y.XmlElement("blockGroup");
        const box = new Y.XmlElement("blockContainer");
        const p = new Y.XmlElement("paragraph");
        p.insert(0, Array.from({ length: n }, () => new Y.XmlText()));
        box.insert(0, [p]);
        group.insert(0, [box]);
        frag.insert(0, [group]);
      });
      docs.set(n, frag);
    }
    await expectLinear("#398 isLoneEmptyParagraph", n => {
      const [lone, ms] = timed(() => isLoneEmptyParagraph(docs.get(n)!));
      expect(lone).toBe(true);
      return ms;
    }, 20_000);
  }, 240_000);
});

describe("jsdom patch (live lists recompute immediately, extra index work on insert/remove)", () => {
  it("patch is in effect", () => {
    expect(patchJsdomForLargeTrees()).toBe(true);
  });
  it("live lists stay live: after taking childNodes/children, changes show the right length and content immediately", () => {
    const div = document.createElement("div");
    const nodes = div.childNodes;
    const els = div.children;
    expect(nodes.length).toBe(0);
    div.append("a", document.createElement("b"), "c");
    expect(nodes.length).toBe(3);
    expect(els.length).toBe(1);
    expect(nodes[1]!.nodeName).toBe("B");
    div.firstChild!.remove();
    expect(nodes.length).toBe(2);
    expect([...nodes].map(n => n.nodeName)).toEqual(["B", "#text"]);
    div.insertBefore(document.createElement("i"), div.lastChild);
    expect([...els].map(e => e.tagName)).toEqual(["B", "I"]);
  });
  it("with a Range attached it is updated as before (not the path that skips the index): shifts for inserts/removals before the Range, nothing after", () => {
    const div = document.createElement("div");
    div.append("a", "b", "c");
    const range = document.createRange();
    range.setStart(div, 1);
    range.setEnd(div, 2);
    div.insertBefore(document.createElement("x"), div.lastChild);
    expect([range.startOffset, range.endOffset]).toEqual([1, 2]);
    div.insertBefore(document.createElement("y"), div.firstChild);
    expect([range.startOffset, range.endOffset]).toEqual([2, 3]);
    div.removeChild(div.lastChild!);
    expect([range.startOffset, range.endOffset]).toEqual([2, 3]);
    div.removeChild(div.firstChild!);
    expect([range.startOffset, range.endOffset]).toEqual([1, 2]);
  });
  it("inserting, replacing and removing one by one in the middle of an element with 2,500 and 20,000 children: linear (quadratic when unpatched)", async () => {
    const run = (n: number) => {
      const div = document.createElement("div");
      for (let i = 0; i < n; i++) div.append(document.createElement("span"), "t");
      void div.childNodes.length; // touch the live list first so every mutation below has to keep it updated
      const spans = Array.from(div.querySelectorAll("span"));
      const [, insertMs] = timed(() => {
        for (const s of spans) s.before(document.createTextNode("<"));
      });
      const [, replaceMs] = timed(() => {
        for (const s of spans) s.replaceWith(...Array.from(s.childNodes));
      });
      const [, removeMs] = timed(() => {
        for (let x = div.firstChild; x !== null; ) {
          const next = x.nextSibling?.nextSibling ?? null;
          x.nextSibling?.remove();
          x = next;
        }
      });
      return { insertMs, replaceMs, removeMs };
    };
    for (const k of ["insertMs", "replaceMs", "removeMs"] as const) await expectLinear(`#398 jsdom ${k}`, n => run(n)[k], 20_000);
  }, 120_000);
  it("reading out (blocksToNoteMarkdown) paragraphs with `x<br>` x 750/6,000 and colored text x 375/3,000: linear (quadratic when unpatched)", async () => {
    for (const [label, unit, n] of [["x<br>", "x<br>", 6_000], ["color", '<span style="color:red">x</span> ', 3_000]] as const) {
      const docs = new Map<number, Y.Doc>();
      for (const k of [n / 8, n]) docs.set(k, await docOf(unit.repeat(k)));
      await expectLinear(`#398 read ${label}`, async k => {
        const md = unit.repeat(k);
        const s = await EditorSession.open(rt, docs.get(k)!);
        try {
          const [out, ms] = timed(() => blocksToNoteMarkdown(s.editor, s.editor.document));
          expect(out.length).toBeGreaterThan(md.length / 2);
          return ms;
        } finally {
          s.close();
        }
      }, n);
    }
  }, 240_000);
});

describe("ForkEdits.replace (insert first, remove after close)", () => {
  it("same result as replaceBlocks (document, inserted ids)", async () => {
    for (const [from, to] of [["# A\n\nb\n\nc", "x\n\n- y\n\nz"], ["a\n\nb\n\nc", ""], ["a\n\nb", "**c**"]] as const) {
      // (Replacing with empty, which empties the document, isn't compared: the editor normalizes to a new empty paragraph with a new id, so the ids
      // differ on the two sides anyway; the real path never replaces with empty: parsing to empty is `empty_content`, and an undo that would empty the document adds a paragraph.)
      const a = await docOf(from);
      const b = new Y.Doc();
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      const blocks = to === "" ? [] : await parse(to);
      // Open one session at a time (`runtime.acquire()` isn't reentrant: opening another while holding a lease can deadlock with a rebuild).
      const run = async (doc: Y.Doc, f: (ed: EditorSession["editor"], ids: string[]) => string[]) => {
        const s = await EditorSession.open(rt, doc);
        try {
          const inserted = f(s.editor, s.editor.document.slice(0, 2).map(x => x.id));
          return { inserted, document: s.editor.document };
        } finally {
          s.close();
        }
      };
      const ra = await run(a, (ed, ids) => ed.replaceBlocks(ids, blocks).insertedBlocks.map(x => x.id));
      const rb = await (async () => {
        let inserted: string[] = [];
        await withForkEditor(rt, b, Y.encodeStateVector(b), (ed, edits) => {
          inserted = edits.replace(ed.document.slice(0, 2).map(x => x.id), blocks as never).map(x => x.id);
        });
        const s = await EditorSession.open(rt, b);
        try {
          return { inserted, document: s.editor.document };
        } finally {
          s.close();
        }
      })();
      expect(rb.inserted).toEqual(ra.inserted);
      expect(rb.document).toEqual(ra.document);
    }
  }, 60_000);
  // The replaced paragraph is fixed at `x<br>` x 2,000, and the replacement `**b** _i_` x n is built directly as block JSON (the same as the parse
  // result, see `formatted` below), not through markdown parsing: building both by parsing (the replaced size scales x2n, up to 48,000) makes the inputs
  // alone several seconds of synchronous work each, which on a slow CI holds the vitest worker past 60 s (onTaskUpdate timeout, as in the CI of #400). The quadratic part
  // is the inserted content, which gets its formatting applied block by block in one transaction; the replaced part is a linear delete. Fixing it lets the ratio measure only the quadratic term, and the scale can grow to 48,000.
  it("a paragraph of `x<br>` x 2,000 replaced with `**b** _i_` x 6,000/48,000: linear (replaceBlocks applies formatting block by block in one transaction, which is quadratic)", async () => {
    // The result of parsing `"**b** _i_ ".repeat(n)`: bold b, space, italic i, space, ... (the last space removed)
    const formatted = (n: number) => [
      {
        type: "paragraph",
        props: { backgroundColor: "default", textColor: "default", textAlignment: "left" },
        content: Array.from({ length: n }, () => [
          { type: "text", text: "b", styles: { bold: true } },
          { type: "text", text: " ", styles: {} },
          { type: "text", text: "i", styles: { italic: true } },
          { type: "text", text: " ", styles: {} },
        ])
          .flat()
          .slice(0, -1),
        children: [],
      },
    ];
    expect(formatted(3)).toEqual((await parse("**b** _i_ ".repeat(3))).map(({ id: _id, ...b }: { id?: string }) => b));
    const inputs = new Map<number, { state: Uint8Array; blocks: unknown[] }>();
    const base = Y.encodeStateAsUpdate(await docOf("x<br>".repeat(2_000)));
    for (const n of [48_000 / 8, 48_000]) inputs.set(n, { state: base, blocks: formatted(n) });
    await expectLinear("#398 ForkEdits.replace", async n => {
      const { state, blocks } = inputs.get(n)!;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      return timeIt(() =>
        withForkEditor(rt, doc, Y.encodeStateVector(doc), (ed, edits) => {
          edits.replace(ed.document.map(b => b.id), blocks as never);
        })
      );
    }, 48_000);
  }, 360_000);

  it("editOnFork replace_section with keepIds on the same shape is linear and keeps the replaced paragraph's id (#551)", async () => {
    const formatted = (n: number) => [
      {
        type: "paragraph",
        content: Array.from({ length: n }, () => [
          { type: "text", text: "b", styles: { bold: true } },
          { type: "text", text: " ", styles: {} },
          { type: "text", text: "i", styles: { italic: true } },
          { type: "text", text: " ", styles: {} },
        ])
          .flat()
          .slice(0, -1),
      },
    ];
    const state = Y.encodeStateAsUpdate(await docOf("x<br>".repeat(2_000)));
    const before = new Y.Doc();
    Y.applyUpdate(before, state);
    const oldTop = topLevelBlocks(before.getXmlFragment(YDOC_FRAGMENT)).map(el => String(el.getAttribute("id")));
    expect(oldTop).toHaveLength(1);
    const section = outlineOf(before.getXmlFragment(YDOC_FRAGMENT)).outline.find(o => o.blockIds.includes(oldTop[0]!))!;
    await expectLinear("#551 editOnFork keepIds", async n => {
      const { fork, sv } = forkFrom(state);
      const blocks = formatted(n);
      const [r, ms] = await (async () => {
        const t = performance.now();
        const v = await editOnFork(rt, fork, sv, { op: "replace_section", isEmptyDoc: false, section, keepIds: true }, blocks as never);
        return [v, performance.now() - t] as const;
      })();
      expect(r.afterIds).toEqual(oldTop);
      expect(topLevelBlocks(fork.getXmlFragment(YDOC_FRAGMENT)).map(el => String(el.getAttribute("id")))).toEqual(oldTop);
      return ms;
    }, 48_000);
  }, 360_000);
});

describe("string handling on the main thread is linear", () => {
  it("normalizeBody: newline x 3,125/250,000 followed by a character is linear (the old trailing-newline regex was quadratic), result unchanged", async () => {
    await expectLinear("normalizeBody", n => {
      const s = "a" + "\n".repeat(n) + "b\n\n\n";
      const [out, ms] = timed(() => normalizeBody(s));
      expect(out).toBe("a" + "\n".repeat(n) + "b");
      return ms;
    }, 250_000);
    expect(normalizeBody("\ufeff\r\n \n\tx\r\ny\n\n")).toBe("\tx\ny");
  });
  it("read out: 1,250/100,000 newlines followed by a character inside a code block are linear (the old trailing-whitespace and trailing-newline regexes were quadratic)", async () => {
    // The "long run of spaces inside bold" shape can't measure our fix: on the same input BlockNote's own HTML -> markdown also has a quadratic
    // `/^(.*?)(\s*)$/` that dominates it. Only the newlines in a code block are measured here.
    // A colored run in front makes the read-out take the per-segment assembly path (`serializeNodes`), which is where trailing newlines are stripped.
    const mdOf = (n: number) => '<span style="color:red">c</span>\n\n```\nw' + "\n".repeat(n) + "x\n```";
    const docs = new Map<number, Y.Doc>();
    for (const n of [12_500, 100_000]) docs.set(n, await docOf(mdOf(n)));
    await expectLinear("#398 read code-block newlines", async n => {
      const s = await EditorSession.open(rt, docs.get(n)!);
      try {
        const [out, ms] = timed(() => blocksToNoteMarkdown(s.editor, s.editor.document));
        expect(out.length).toBeGreaterThan(n); // precondition: the newlines really made it into the document and were read out
        return ms;
      } finally {
        s.close();
      }
    }, 100_000);
  }, 240_000);
});
