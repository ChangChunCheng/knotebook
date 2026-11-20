/**
 * Pure behaviour of `createDocUpdateDebouncer` (#138).
 *
 * A remote update's origin is the provider itself (`readSyncMessage(..., provider.document, provider)` in
 * `@hocuspocus/provider`: the fourth argument is `Y.applyUpdate`'s `transactionOrigin`); a local edit's origin is
 * y-prosemirror's `ySyncPluginKey`. Both must notify: the server persists `notes.last_edited_*` for both, so
 * listening to remote updates only would leave the header's "last edited" stale after one's own typing until a reload.
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createDocUpdateDebouncer } from "./useCollab";

describe("createDocUpdateDebouncer", () => {
  it("an update from any origin -> one call after delayMs (bursts coalesce); no calls after dispose", () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const remoteOrigin = {};
    const cb = vi.fn();
    const dispose = createDocUpdateDebouncer(doc, cb, 3_000);
    const text = doc.getText("t");

    for (const ch of ["a", "b", "c"]) doc.transact(() => text.insert(0, ch), remoteOrigin);
    vi.advanceTimersByTime(2_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);

    doc.transact(() => text.insert(0, "d"), { local: true });
    vi.advanceTimersByTime(3_000);
    expect(cb).toHaveBeenCalledTimes(2);

    doc.transact(() => text.insert(0, "e"), { local: true });
    vi.advanceTimersByTime(1_000);
    // A burst mixing local and remote updates is one call: the timer restarts from the last update.
    doc.transact(() => text.insert(0, "f"), remoteOrigin);
    vi.advanceTimersByTime(2_999);
    expect(cb).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(3);

    doc.transact(() => text.insert(0, "g"), remoteOrigin);
    dispose();
    vi.advanceTimersByTime(3_000);
    expect(cb).toHaveBeenCalledTimes(3);

    doc.destroy();
    vi.useRealTimers();
  });
});
