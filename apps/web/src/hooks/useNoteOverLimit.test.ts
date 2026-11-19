import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";

const measured = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/note-size-guard", async importOriginal => {
  const m = await importOriginal<typeof import("@/lib/note-size-guard")>();
  return {
    ...m,
    noteStateBytes: (doc: Y.Doc, above?: number) => {
      measured.calls++;
      return m.noteStateBytes(doc, above);
    },
  };
});
const { useNoteOverLimit, NOTE_OVER_LIMIT_CHECK_MS } = await import("./useNoteOverLimit");

afterEach(() => vi.useRealTimers());

describe("useNoteOverLimit (over-limit notice)", () => {
  it("already over the limit: additions-only changes are not re-measured (measuring a compacted copy is expensive); only changes with deletions re-measure, and the notice clears once back under the limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "x".repeat(5_000));
    const limit = Y.encodeStateAsUpdate(doc).byteLength - 100;
    const hook = renderHook(() => useNoteOverLimit(doc, limit, true));
    expect(hook.result.current).toBe(true);
    measured.calls = 0;
    act(() => doc.getText("t").insert(5_000, " typing"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTE_OVER_LIMIT_CHECK_MS + 100);
    });
    expect(measured.calls, "只新增：沒有重量").toBe(0);
    expect(hook.result.current).toBe(true);
    act(() => doc.getText("t").delete(0, 4_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTE_OVER_LIMIT_CHECK_MS + 100);
    });
    expect(measured.calls).toBe(1);
    expect(hook.result.current).toBe(false);
  });

  it("still under the limit: additions are still throttled and re-measured (may go over as a result)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "x".repeat(100));
    const limit = Y.encodeStateAsUpdate(doc).byteLength + 500;
    const hook = renderHook(() => useNoteOverLimit(doc, limit, true));
    expect(hook.result.current).toBe(false);
    act(() => doc.getText("t").insert(100, "y".repeat(1_000)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTE_OVER_LIMIT_CHECK_MS + 100);
    });
    expect(hook.result.current).toBe(true);
  });
});
