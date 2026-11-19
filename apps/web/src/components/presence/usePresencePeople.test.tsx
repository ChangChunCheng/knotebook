import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { usePresencePeople } from "./usePresencePeople";
import { setRemote, userState } from "./test-awareness";

// #293: subscribes to awareness, merges within one rAF frame, no setState when the signature is unchanged, cursorOf reads the live value.

let frames: FrameRequestCallback[] = [];
const awarenesses: Awareness[] = [];

function newAwareness(): Awareness {
  const a = new Awareness(new Y.Doc());
  awarenesses.push(a);
  return a;
}

function pushFrame() {
  act(() => {
    frames.splice(0).forEach((f) => f(0));
  });
}

let renders = 0;
let latest: ReturnType<typeof usePresencePeople> | null = null;

function Probe({ awareness }: { awareness: Awareness | null }) {
  renders += 1;
  latest = usePresencePeople(awareness, "u-me");
  return null;
}

function keys(): string[] {
  return latest!.people.map((p) => p.key);
}

function changeObservers(a: Awareness): number {
  return a._observers.get("change")?.size ?? 0;
}

beforeEach(() => {
  frames = [];
  renders = 0;
  latest = null;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  awarenesses.splice(0).forEach((a) => a.destroy());
});

describe("usePresencePeople", () => {
  it("the first render already has the existing people; a new person appears after a frame is pushed", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann"));
    const perRender: string[][] = [];
    const { result } = renderHook(() => {
      const r = usePresencePeople(aw, "u-me");
      perRender.push(r.people.map((p) => p.key));
      return r;
    });
    // Present on the first render (lazy initializer), not on a second render after an effect computes it
    expect(perRender[0]).toEqual(["user:u-a"]);
    act(() => {
      setRemote(aw, 11, userState("u-b", "Bob"));
    });
    expect(result.current.people.map((p) => p.key)).toEqual(["user:u-a"]);
    pushFrame();
    expect(result.current.people.map((p) => p.key)).toEqual(["user:u-a", "user:u-b"]);
  });

  it("several changes within one frame render only once (nothing moves before the frame is pushed)", () => {
    const aw = newAwareness();
    render(<Probe awareness={aw} />);
    const before = renders;
    act(() => {
      setRemote(aw, 10, userState("u-a", "Ann"));
      setRemote(aw, 11, userState("u-b", "Bob"));
      setRemote(aw, 12, userState("u-c", "Cat"));
    });
    expect(renders).toBe(before);
    expect(keys()).toEqual([]);
    pushFrame();
    expect(renders).toBe(before + 1);
    expect(keys()).toEqual(["user:u-a", "user:u-b", "user:u-c"]);
  });

  it("only a heartbeat change: no re-render", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann", { beat: 1 }));
    render(<Probe awareness={aw} />);
    const before = renders;
    act(() => {
      setRemote(aw, 10, userState("u-a", "Ann", { beat: 2 }));
    });
    pushFrame();
    expect(renders).toBe(before);
  });

  it("a cursor position change does not re-render, yet cursorOf reads the new value; gaining or losing a cursor re-renders", () => {
    const aw = newAwareness();
    const first = { anchor: { p: 1 }, head: { p: 1 } };
    const second = { anchor: { p: 2 }, head: { p: 2 } };
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: first }));
    render(<Probe awareness={aw} />);
    const before = renders;
    act(() => {
      setRemote(aw, 10, userState("u-a", "Ann", { cursor: second }));
    });
    pushFrame();
    expect(renders).toBe(before);
    expect(latest!.cursorOf("user:u-a")).toBe(second);
    act(() => {
      setRemote(aw, 10, userState("u-a", "Ann", { cursor: null }));
    });
    pushFrame();
    expect(renders).toBe(before + 1);
    expect(latest!.people[0].hasCursor).toBe(false);
  });

  it("switching awareness: old changes no longer matter, people in the new one appear, order restarts", () => {
    const oldAw = newAwareness();
    const { rerender } = render(<Probe awareness={oldAw} />);
    act(() => {
      setRemote(oldAw, 11, userState("u-b", "Bob"));
    });
    pushFrame();
    act(() => {
      setRemote(oldAw, 10, userState("u-a", "Ann"));
    });
    pushFrame();
    expect(keys()).toEqual(["user:u-b", "user:u-a"]);

    const newAw = newAwareness();
    setRemote(newAw, 20, userState("u-a", "Ann"));
    setRemote(newAw, 21, userState("u-b", "Bob"));
    rerender(<Probe awareness={newAw} />);
    expect(keys()).toEqual(["user:u-a", "user:u-b"]);

    act(() => {
      setRemote(oldAw, 12, userState("u-z", "Zed"));
    });
    pushFrame();
    expect(keys()).toEqual(["user:u-a", "user:u-b"]);
  });

  it("unmount: cancels the pending frame and unsubscribes from change", () => {
    const aw = newAwareness();
    const base = changeObservers(aw);
    const { unmount } = render(<Probe awareness={aw} />);
    expect(changeObservers(aw)).toBe(base + 1);
    act(() => {
      setRemote(aw, 10, userState("u-a", "Ann"));
    });
    expect(frames).toHaveLength(1);
    unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(changeObservers(aw)).toBe(base);
  });

  it("awareness null: empty list, cursorOf returns null", () => {
    const { result } = renderHook(() => usePresencePeople(null, "u-me"));
    expect(result.current.people).toEqual([]);
    expect(result.current.cursorOf("user:u-a")).toBeNull();
  });
});
