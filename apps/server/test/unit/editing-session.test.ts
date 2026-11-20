import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import { YDOC_FRAGMENT, createHeadlessNoteSchema, topLevelBlocks } from "@knotebook/shared";
import type { CollabContext } from "../../src/collab/server.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, NoteGoneError, forkFrom, withDirectConnection, type DirectCtx, type DirectTarget } from "../../src/notes/editing/session.js";

// rebuildEvery/heapGrowthLimit are deliberately set so they can't trigger: the last case builds another runtime with rebuildEvery:1 and uses its
// own installGlobals() to swap globalThis's window/document; if this module-level rt also rebuilt mid-test it would swap the global window
// away and the small runtime's session would mount on another window (potential flake).
const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1_000_000, heapGrowthLimit: Number.MAX_SAFE_INTEGER });
rt.installGlobals();

async function seeded(): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  s.editor.replaceBlocks(s.editor.document, [
    { type: "paragraph", content: "第一段" },
    { type: "paragraph", content: "第二段" },
    { type: "heading", props: { level: 2 }, content: "標題" },
  ]);
  s.close();
  return doc;
}
const ids = (doc: Y.Doc): Array<string | null> => topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id") ?? null);

describe("EditorSession", () => {
  it("replaceBlocks on a fork -> diff applied back to the original doc: ids outside the segment unchanged, the replaced segment gets a new id, concurrent edits survive on both sides", async () => {
    const source = await seeded();
    const [p1, p2, h1] = ids(source);
    // First pin that the ids really are three distinct strings: otherwise the toBe/not.toBe below would pass vacuously if the ids were all null.
    for (const v of [p1, p2, h1]) expect(typeof v).toBe("string");
    expect(new Set([p1, p2, h1]).size).toBe(3);
    const { fork, sv } = forkFrom(source);
    const s = await EditorSession.open(rt, fork);
    s.editor.replaceBlocks([p2!], [{ type: "paragraph", content: "AI 改寫" }]);
    const diff = s.diffSince(sv);
    s.close();
    const s2 = await EditorSession.open(rt, source);
    s2.editor.insertBlocks([{ type: "paragraph", content: "同時打的" }], h1!, "after");
    s2.close();
    Y.applyUpdate(source, diff);
    const after = ids(source);
    expect(after[0]).toBe(p1);
    expect(after[2]).toBe(h1);
    expect(after[1]).not.toBe(p2);
    expect(source.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("AI 改寫");
    expect(source.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("同時打的");
  });

  it("an un-mounted collaborative editor throws when operating on existing ids", async () => {
    const source = await seeded();
    const { fork } = forkFrom(source);
    const editor = BlockNoteEditor.create(
      withCollaboration({
        schema: createHeadlessNoteSchema(rt.baseUrl),
        collaboration: { fragment: fork.getXmlFragment(YDOC_FRAGMENT), user: { name: "x", color: "#000" } },
      })
    );
    expect(() => editor.replaceBlocks([ids(source)[0]!], [{ type: "paragraph" }])).toThrow(/could not be found|not found/);
  });

  it("mounting a non-empty document without editing -> the diff against the pre-fork state vector is empty (2 bytes)", async () => {
    const source = await seeded();
    const { fork, sv } = forkFrom(source);
    const s = await EditorSession.open(rt, fork);
    const diff = s.diffSince(sv);
    s.close();
    expect(diff.length).toBe(2);
  });

  it("after rebuilding the window, mounting again still produces the correct diff", async () => {
    const small = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1 });
    small.installGlobals();
    const source = await seeded();
    const a = await EditorSession.open(small, forkFrom(source).fork);
    a.close();
    expect(small.rebuilds).toBe(1);
    const { fork, sv } = forkFrom(source);
    const b = await EditorSession.open(small, fork);
    b.editor.insertBlocks([{ type: "paragraph", content: "after rebuild" }], ids(fork)[2]!, "after");
    const diff = b.diffSince(sv);
    b.close();
    Y.applyUpdate(source, diff);
    expect(source.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("after rebuild");
  });
});

// In `withDirectConnection`, the error-priority branch (fn's error wins over disconnect's, see the note in session.ts) is hard to force
// on a real hocuspocus with a failing disconnect; a fake Hocuspocus controls disconnect's success here: pure unit, no docker/pg.
function fakeHocuspocus(disconnect: () => Promise<void>): Hocuspocus<CollabContext> {
  return {
    openDirectConnection: async () => ({
      transact: async (cb: (doc: never) => void) => cb({} as never),
      disconnect,
    }),
  } as unknown as Hocuspocus<CollabContext>;
}

/** Gate closed, note alive: re-verification always lets through (this describe only checks error priority). */
const live = (hocuspocus: Hocuspocus<CollabContext>): DirectTarget => ({ hocuspocus, isDeleting: () => false, noteIsLive: async () => true });

const directCtx = (): DirectCtx => ({ source: "ai-edit", userId: "u1", tokenId: null, agentLabel: null, applied: false });

describe("withDirectConnection error priority", () => {
  it("fn succeeds, disconnect fails -> rejects with disconnect's error (a persist failure must not be swallowed)", async () => {
    const disconnectErr = new Error("disconnect boom");
    const disconnect = vi.fn().mockRejectedValue(disconnectErr);
    const hocuspocus = fakeHocuspocus(disconnect);

    await expect(withDirectConnection(live(hocuspocus), "note-1", directCtx(), () => "ok")).rejects.toBe(disconnectErr);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("fn throws and disconnect also fails -> rejects with fn's error (not disconnect's); disconnect's error is logged once", async () => {
    // Compare by identity (toBe) rather than substring (toThrow(string)): the latter would wrongly pass whenever disconnect's message
    // contains fn's message as a substring. Disconnect's message deliberately shares nothing with fn's, so even a future switch back to
    // string matching can't misjudge.
    const fnErr = new Error("fn boom");
    const disconnect = vi.fn().mockRejectedValue(new Error("disconnect failed"));
    const hocuspocus = fakeHocuspocus(disconnect);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        withDirectConnection(live(hocuspocus), "note-1", directCtx(), () => {
          throw fnErr;
        })
      ).rejects.toBe(fnErr);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fn succeeds and disconnect succeeds -> returns result, disconnect is called exactly once (main path + no duplicate persist)", async () => {
    // The cases above use mockRejectedValue, so disconnect rejects on its first call and a duplicate call after disconnect succeeds isn't
    // reached; this case covers that, and the main path (fn succeeds + disconnect succeeds -> returns result).
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const hocuspocus = fakeHocuspocus(disconnect);

    await expect(withDirectConnection(live(hocuspocus), "note-1", directCtx(), () => "ok")).resolves.toBe("ok");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("fn throws and disconnect succeeds -> rejects with fn's error (not swallowed into a successful undefined), disconnect exactly once, no log", async () => {
    // Covers the fourth cell (fn throws x disconnect succeeds) of the matrix.
    // A degenerate form this catches: moving `if (fnFailed) throw fnError;` into disconnect's catch (rethrow only when disconnect also fails): here
    // disconnect didn't fail, so the degenerate function would simply resolve to undefined.
    const fnErr = new Error("fn boom");
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const hocuspocus = fakeHocuspocus(disconnect);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        withDirectConnection(live(hocuspocus), "note-1", directCtx(), () => {
          throw fnErr;
        })
      ).rejects.toBe(fnErr);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fn throws a falsy value (undefined), disconnect succeeds -> still rejects (not decided by the truthiness of the error value, `if (fnError)`)", async () => {
    // A degenerate form this catches: replacing the separate boolean fnFailed with a truthiness check such as `if (fnError)`: when fn throws a falsy
    // value the check fails, is misjudged as "fn didn't fail" and swallowed, and the function resolves to undefined.
    // Uses `throw undefined`, the most extreme falsy value, and asserts with rejects (not by awaiting and comparing the return value),
    // since "rejects with undefined" and "resolves to undefined" look the same as return values; only rejects/resolves tell them
    // apart.
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const hocuspocus = fakeHocuspocus(disconnect);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        withDirectConnection(live(hocuspocus), "note-1", directCtx(), () => {
          throw undefined;
        })
      ).rejects.toBeUndefined();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

// #181: re-verification of direct-connection writes: gate and liveness are each checked once before and once after opening.
function spiedTarget(isDeleting: () => boolean, noteIsLive: () => Promise<boolean>) {
  const transact = vi.fn(async (cb: (doc: never) => void) => cb({} as never));
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn(async () => ({ transact, disconnect }));
  const target: DirectTarget = {
    hocuspocus: { openDirectConnection: open } as unknown as Hocuspocus<CollabContext>,
    isDeleting: vi.fn(isDeleting),
    noteIsLive: vi.fn(noteIsLive),
  };
  return { target, open, transact, disconnect };
}

describe("withDirectConnection re-verification (DirectTarget)", () => {
  it("gate open -> rejects NoteGoneError, no direct connection opened", async () => {
    const s = spiedTarget(() => true, async () => true);
    await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBeInstanceOf(NoteGoneError);
    expect(s.open).not.toHaveBeenCalled();
  });

  it("note missing or already in the trash (false on the first check) -> rejects NoteGoneError, no direct connection opened", async () => {
    const s = spiedTarget(() => false, async () => false);
    await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBeInstanceOf(NoteGoneError);
    expect(s.open).not.toHaveBeenCalled();
  });

  it("gate opens after the connection is opened -> rejects NoteGoneError, one disconnect, no transact", async () => {
    let n = 0;
    const s = spiedTarget(() => ++n > 1, async () => true);
    await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBeInstanceOf(NoteGoneError);
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(s.transact).not.toHaveBeenCalled();
  });

  it("judged gone after opening and disconnect also fails -> still throws NoteGoneError, disconnect's error is logged once", async () => {
    let n = 0;
    const s = spiedTarget(() => ++n > 1, async () => true);
    s.disconnect.mockRejectedValue(new Error("dc boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBeInstanceOf(NoteGoneError);
      expect(s.disconnect).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("moved to the trash after opening (the second noteIsLive returns false) -> same as the case where the gate opens after opening", async () => {
    let n = 0;
    const s = spiedTarget(() => false, async () => ++n === 1);
    await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBeInstanceOf(NoteGoneError);
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(s.transact).not.toHaveBeenCalled();
  });

  it("the liveness query after opening fails -> the original error surfaces, still one disconnect, no transact", async () => {
    const dbErr = new Error("db down");
    let n = 0;
    const s = spiedTarget(() => false, async () => {
      if (++n > 1) throw dbErr;
      return true;
    });
    await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBe(dbErr);
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(s.transact).not.toHaveBeenCalled();
  });
});
