import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { AiActionDto } from "@knotebook/shared";
import { OVERLAY_QUERY } from "@/lib/layout-tiers";
import {
  fetchTourAiActions,
  focusReturnTarget,
  fullTourStops,
  measureCardBands,
  measureTargets,
  planStops,
  RETURN_FOCUS_TIMEOUT_MS,
  samePath,
  TARGET_TIMEOUT_MS,
  TourEngine,
  tourProgress,
  waitForDrawerClosed,
  waitForStopTarget,
  type TourStopEntry,
} from "./engine";
import { LIST_STICKY_TOP_VAR, STICKY_TOP_VAR } from "@/lib/page-scroll";
import { stubLayoutTier } from "@/test/layout-tier";
import { buildSequence } from "./sequence";
import { FULL_TOUR, STOPS, type StopContext, type StopDef, type StopId, type TourScreen } from "./stops";

const CTX: StopContext = { searchQuery: "", aiActions: [], sampleNoteId: "n1", liveStops: false };
const AI_ACTION: AiActionDto = { id: "rewrite", name: "Rewrite", applyMode: "preview", kind: "quick" };

/** A target element with a size; when `visible=false` its width and height are 0 (not appeared yet). */
function targetEl(visible = true): HTMLElement & { show: () => void } {
  let shown = visible;
  const el = Object.assign(document.createElement("button"), {
    show: () => {
      shown = true;
    },
  });
  el.getBoundingClientRect = () => (shown ? new DOMRect(10, 20, 30, 40) : new DOMRect(0, 0, 0, 0));
  document.body.append(el);
  return el;
}

interface FakeStop {
  entry: TourStopEntry;
  prepare: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  el: ReturnType<typeof targetEl> | null;
}

/** Fake stops: for `present=false` the target stays at size 0 (never ready); for `missing=true` the element cannot be found at all. */
function fakeStop(
  name: string,
  opts: { present?: boolean; missing?: boolean; precondition?: (ctx: StopContext) => boolean; skipOnPhone?: boolean; phoneScreen?: "list" } = {},
): FakeStop {
  const el = opts.missing ? null : targetEl(opts.present ?? true);
  const prepare = vi.fn();
  const leave = vi.fn();
  const stop: StopDef = {
    id: name as StopId,
    titleKey: `t.${name}`,
    bodyKey: `b.${name}`,
    target: () => (el === null ? [] : [el]),
    prepare,
    leave,
    precondition: opts.precondition,
    skipOnPhone: opts.skipOnPhone,
    phoneScreen: opts.phoneScreen,
  };
  return { entry: { stop }, prepare, leave, el };
}

function engineOf(stops: FakeStop[], ctx: StopContext = CTX): TourEngine {
  return new TourEngine(
    stops.map((s) => s.entry),
    ctx,
  );
}

const ids = (engine: TourEngine) => engine.getSnapshot().entry?.stop.id;

async function frames(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function stubViewport(narrow: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === OVERLAY_QUERY ? narrow : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("stop filtering and total count", () => {
  it("stops whose precondition fails are dropped at start and the total counts only the rest; preconditions read the context given at start", () => {
    const seen: StopContext[] = [];
    const a = fakeStop("a");
    const b = fakeStop("b", { precondition: (ctx) => (seen.push(ctx), ctx.searchQuery === "") });
    const c = fakeStop("c", { precondition: () => true });
    const ctx: StopContext = { searchQuery: "x", aiActions: [], sampleNoteId: "n1", liveStops: false };
    const planned = planStops([a, b, c].map((s) => s.entry), ctx);
    expect(planned.map((e) => e.stop.id)).toEqual(["a", "c"]);
    expect(seen).toEqual([ctx]);
    expect(new TourEngine(planned, ctx).getSnapshot().total).toBe(2);
  });

  it("full tour: the stop table follows the order of buildSequence", () => {
    const expected = buildSequence(FULL_TOUR);
    expect(fullTourStops().map((e) => e.stop)).toEqual(expected.map((e) => STOPS[e.id]));
  });

  it("site without AI actions: the full tour omits the AI stop; with them it sits between the [[ stop and the / stop", () => {
    const ids = (aiActions: StopContext["aiActions"]) => planStops(fullTourStops(), { ...CTX, aiActions }).map((e) => e.stop.id);
    expect(ids([])).not.toContain("ai");
    const withAi = ids([{ id: "rewrite", name: "Rewrite", applyMode: "preview", kind: "quick" }]);
    expect(withAi.slice(withAi.indexOf("wikilink"), withAi.indexOf("slash") + 1)).toEqual(["wikilink", "ai", "slash"]);
  });

  it("search box has text: the full tour omits the tab list, folder and search stops", () => {
    const planned = planStops(fullTourStops(), { ...CTX, searchQuery: "ab" });
    expect(planned.map((e) => e.stop.id)).toEqual(["newNote", "header", "versions", "knowledge", "tags", "wikilink", "slash", "userMenu"]);
  });
});

describe("stop order and stop changes", () => {
  it("begin enters the first stop: runs prepare first and counts as entered only once the target exists; before that no stop is on screen", async () => {
    const a = fakeStop("a", { present: false });
    const engine = engineOf([a, fakeStop("b")]);
    void engine.begin();
    expect(engine.getSnapshot()).toMatchObject({ phase: "running", entry: null, pending: true, index: -1 });
    expect(a.prepare).toHaveBeenCalledTimes(1);
    a.el!.show();
    await frames();
    expect(engine.getSnapshot()).toMatchObject({ phase: "running", index: 0, total: 2, pending: false });
    expect(ids(engine)).toBe("a");
  });

  it("next and back; the first stop cannot go back further and the last cannot go forward", async () => {
    const engine = engineOf([fakeStop("a"), fakeStop("b"), fakeStop("c")]);
    await engine.begin();
    engine.back();
    await frames();
    expect(ids(engine)).toBe("a");
    engine.next();
    await frames();
    expect(ids(engine)).toBe("b");
    engine.next();
    await frames();
    expect(ids(engine)).toBe("c");
    engine.next();
    await frames();
    expect(ids(engine)).toBe("c");
    engine.back();
    await frames();
    expect(ids(engine)).toBe("b");
  });

  it("pressing next during a stop change (still waiting for the target) does nothing", async () => {
    const b = fakeStop("b", { present: false });
    const c = fakeStop("c");
    const engine = engineOf([fakeStop("a"), b, c]);
    await engine.begin();
    engine.next();
    expect(engine.getSnapshot().pending).toBe(true);
    engine.next();
    engine.back();
    b.el!.show();
    await frames();
    expect(ids(engine)).toBe("b");
    expect(c.prepare).not.toHaveBeenCalled();
  });

  it("a narrow window does not run prepare but still enters the stop", async () => {
    stubViewport(true);
    const a = fakeStop("a");
    const engine = engineOf([a, fakeStop("b")]);
    await engine.begin();
    expect(ids(engine)).toBe("a");
    expect(a.prepare).not.toHaveBeenCalled();
  });

  it("a prepare error is only logged to the console; the engine still waits for the target and enters the stop", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = fakeStop("a");
    a.prepare.mockImplementation(() => {
      throw new Error("boom");
    });
    const engine = engineOf([a, fakeStop("b")]);
    await engine.begin();
    expect(ids(engine)).toBe("a");
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("stops are skipped when the target never appears", () => {
  it(`target not appearing within ${TARGET_TIMEOUT_MS} ms (size stays 0) -> skips to the next stop; 1 ms short it is still waiting`, async () => {
    const b = fakeStop("b", { present: false });
    const engine = engineOf([fakeStop("a"), b, fakeStop("c")]);
    await engine.begin();
    engine.next();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS - 1);
    expect(engine.getSnapshot()).toMatchObject({ index: 0, pending: true });
    await vi.advanceTimersByTimeAsync(1);
    await frames();
    expect(engine.getSnapshot()).toMatchObject({ index: 2, pending: false });
    expect(ids(engine)).toBe("c");
  });

  it("a missing element is skipped the same way", async () => {
    const engine = engineOf([fakeStop("a"), fakeStop("b", { missing: true }), fakeStop("c")]);
    await engine.begin();
    engine.next();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(ids(engine)).toBe("c");
  });

  it("enters the stop if the target appears while waiting (rechecked every frame, not just once)", async () => {
    const b = fakeStop("b", { present: false });
    const engine = engineOf([fakeStop("a"), b, fakeStop("c")]);
    await engine.begin();
    engine.next();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS - 500);
    b.el!.show();
    await frames();
    expect(ids(engine)).toBe("b");
  });

  it("the first stop is skipped too when its target never appears", async () => {
    const engine = engineOf([fakeStop("a", { present: false }), fakeStop("b")]);
    void engine.begin();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(ids(engine)).toBe("b");
    expect(engine.getSnapshot().index).toBe(1);
  });

  it("the last stop is not skipped (it carries the finish choices): it is entered anyway with the card centered", async () => {
    const last = fakeStop("z", { present: false });
    const engine = engineOf([fakeStop("a"), last]);
    await engine.begin();
    engine.next();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(engine.getSnapshot()).toMatchObject({ index: 1, pending: false });
    expect(last.leave).not.toHaveBeenCalled();
  });
});

describe("going back skips stops too", () => {
  it("previous stop's target never appears -> goes one stop further back", async () => {
    const b = fakeStop("b");
    const engine = engineOf([fakeStop("a"), b, fakeStop("c")]);
    await engine.begin();
    engine.next();
    await frames();
    engine.next();
    await frames();
    expect(ids(engine)).toBe("c");
    b.el!.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    engine.back();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(ids(engine)).toBe("a");
    expect(engine.getSnapshot().index).toBe(0);
  });

  it("no earlier stop is available -> returns to the original stop (does not stay stuck mid-change)", async () => {
    const a = fakeStop("a");
    const engine = engineOf([a, fakeStop("b"), fakeStop("c")]);
    await engine.begin();
    engine.next();
    await frames();
    a.el!.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    engine.back();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(engine.getSnapshot()).toMatchObject({ index: 1, pending: false });
  });
});

describe("stops the phone lacks", () => {
  it("phone: skipped immediately (no waiting for the target, no prepare, leave still runs once), in both directions", async () => {
    stubLayoutTier("phone");
    const a = fakeStop("a");
    const b = fakeStop("b", { skipOnPhone: true });
    const c = fakeStop("c");
    const engine = engineOf([a, b, c]);
    await engine.begin();
    engine.next();
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(engine)).toBe("c");
    expect(engine.getSnapshot().pending).toBe(false);
    expect(b.prepare).not.toHaveBeenCalled();
    expect(b.leave).toHaveBeenCalledTimes(1);
    engine.back();
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(engine)).toBe("a");
    expect(b.leave).toHaveBeenCalledTimes(2);
  });

  it("waitForStopTarget: a stop the phone lacks returns false at once even if the target exists; other layouts find it as usual", async () => {
    const b = fakeStop("b", { skipOnPhone: true });
    const tier = stubLayoutTier("phone");
    const signal = new AbortController().signal;
    let settled: boolean | null = null;
    void waitForStopTarget(b.entry, CTX, signal).then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    tier.setLayoutTier("overlay");
    await expect(waitForStopTarget(b.entry, CTX, signal)).resolves.toBe(true);
  });

  it("floating sidebar and wide window: stops are entered as usual", async () => {
    for (const tier of ["overlay", "docked"] as const) {
      stubLayoutTier(tier);
      const b = fakeStop("b", { skipOnPhone: true });
      const engine = engineOf([fakeStop("a"), b, fakeStop("c")]);
      await engine.begin();
      engine.next();
      await frames();
      expect(ids(engine), tier).toBe("b");
      engine.end("close");
    }
  });
});

describe("screen change (StopContext.showScreen)", () => {
  /** Records the call order of screen change and prepare. `gate` holds the screen change until the caller releases it. */
  function recorder() {
    const calls: string[] = [];
    let release: () => void = () => {};
    let gate: Promise<void> | null = null;
    const showScreen = vi.fn(async (screen: TourScreen) => {
      calls.push(`screen:${screen}`);
      if (gate !== null) await gate;
    });
    return {
      calls,
      showScreen,
      hold: () => {
        gate = new Promise<void>((r) => (release = r));
      },
      release: () => {
        gate = null;
        release();
      },
    };
  }

  function track(stop: FakeStop, calls: string[]): FakeStop {
    stop.prepare.mockImplementation(() => calls.push(`prepare:${stop.entry.stop.id}`));
    return stop;
  }

  it("phone: each stop first switches to its screen (list stops to the list, the rest to the sample note) and then runs prepare; the same when going back", async () => {
    stubLayoutTier("phone");
    const r = recorder();
    const engine = new TourEngine(
      [track(fakeStop("a", { phoneScreen: "list" }), r.calls), track(fakeStop("b"), r.calls), track(fakeStop("c", { phoneScreen: "list" }), r.calls)].map((s) => s.entry),
      { ...CTX, showScreen: r.showScreen },
    );
    await engine.begin();
    engine.next();
    await frames();
    engine.next();
    await frames();
    engine.back();
    await frames();
    expect(ids(engine)).toBe("b");
    expect(r.calls).toEqual(["screen:list", "prepare:a", "screen:note", "prepare:b", "screen:list", "prepare:c", "screen:note", "prepare:b"]);
  });

  it("other layouts stay on the sample note; a stop the phone lacks does not change the screen", async () => {
    for (const tier of ["docked", "overlay"] as const) {
      stubLayoutTier(tier);
      const r = recorder();
      const engine = new TourEngine([fakeStop("a", { phoneScreen: "list" }), fakeStop("b")].map((s) => s.entry), { ...CTX, showScreen: r.showScreen });
      await engine.begin();
      engine.next();
      await frames();
      expect(r.calls, tier).toEqual(["screen:note", "screen:note"]);
      engine.end("close");
    }
    stubLayoutTier("phone");
    const r = recorder();
    const engine = new TourEngine([fakeStop("a"), fakeStop("b", { skipOnPhone: true }), fakeStop("c")].map((s) => s.entry), { ...CTX, showScreen: r.showScreen });
    await engine.begin();
    engine.next();
    await frames();
    expect(ids(engine)).toBe("c");
    expect(r.calls).toEqual(["screen:note", "screen:note"]);
  });

  it("before the screen change completes there is no prepare and no stop entry; finishing meanwhile -> that stop leaves once and prepare never runs", async () => {
    stubLayoutTier("phone");
    const r = recorder();
    const a = fakeStop("a");
    const b = fakeStop("b", { phoneScreen: "list" });
    const engine = new TourEngine([a, b].map((s) => s.entry), { ...CTX, showScreen: r.showScreen });
    await engine.begin();
    r.hold();
    engine.next();
    await frames();
    expect(engine.getSnapshot()).toMatchObject({ pending: true, index: 0 });
    expect(b.prepare).not.toHaveBeenCalled();
    engine.end("close");
    r.release();
    await frames();
    expect(b.prepare).not.toHaveBeenCalled();
    expect(b.leave).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot().phase).toBe("ended");
  });

  it("a screen-change error is only logged to the console; prepare and the target wait proceed", async () => {
    stubLayoutTier("phone");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = fakeStop("a", { phoneScreen: "list" });
    const engine = new TourEngine([a.entry], { ...CTX, showScreen: () => Promise.reject(new Error("boom")) });
    await engine.begin();
    expect(ids(engine)).toBe("a");
    expect(a.prepare).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("the card's 'n / N'", () => {
  const entries = () => [fakeStop("a"), fakeStop("b", { skipOnPhone: true }), fakeStop("c"), fakeStop("d")].map((s) => s.entry);

  it("phones do not count stops they lack; other layouts count all", () => {
    const stops = entries();
    expect(tourProgress(stops, 0, "phone")).toEqual({ step: 1, total: 3 });
    expect(tourProgress(stops, 2, "phone")).toEqual({ step: 2, total: 3 });
    expect(tourProgress(stops, 3, "phone")).toEqual({ step: 3, total: 3 });
    for (const layout of ["wide", "floating"] as const) {
      expect(tourProgress(stops, 2, layout)).toEqual({ step: 3, total: 4 });
      expect(tourProgress(stops, 3, layout)).toEqual({ step: 4, total: 4 });
    }
  });

  it("the stop on screen is always counted (the card may still be on it when switching to a phone mid-tour)", () => {
    expect(tourProgress(entries(), 1, "phone")).toEqual({ step: 2, total: 4 });
  });

  it("full tour with an AI stop: the phone has one fewer stop and the last stop is still N / N", () => {
    const planned = planStops(fullTourStops(), { ...CTX, aiActions: [AI_ACTION] });
    const last = planned.length - 1;
    expect(tourProgress(planned, last, "wide")).toEqual({ step: 12, total: 12 });
    expect(tourProgress(planned, last, "phone")).toEqual({ step: 11, total: 11 });
  });
});

describe("measureCardBands", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty(STICKY_TOP_VAR);
    document.documentElement.style.removeProperty(LIST_STICKY_TOP_VAR);
  });

  const NONE = { top: 0, right: 0, bottom: 0, left: 0 };

  function fab(rect: DOMRect, inert = false): void {
    let slot = document.querySelector("[data-phone-fab-slot]");
    if (slot === null) {
      slot = document.createElement("div");
      slot.setAttribute("data-phone-fab-slot", "");
      document.body.append(slot);
    }
    const holder = document.createElement("div");
    if (inert) holder.setAttribute("inert", "");
    const button = document.createElement("button");
    button.setAttribute("data-phone-fab", "x");
    button.getBoundingClientRect = () => rect;
    holder.append(button);
    slot.append(holder);
  }

  function toolbar(top: number): void {
    const el = document.createElement("div");
    el.setAttribute("data-mobile-edit-toolbar", "");
    el.getBoundingClientRect = () => new DOMRect(0, top, 390, 44);
    document.body.append(el);
  }

  it("phone: keepOut's top is the pinned note header and its bottom avoids the visible round button (invisible or non-interactive ones do not count); with no keyboard blocked is all 0", () => {
    document.documentElement.style.setProperty(STICKY_TOP_VAR, "96px");
    fab(new DOMRect(16, window.innerHeight - 72, 56, 56));
    fab(new DOMRect(300, window.innerHeight - 80, 56, 56));
    fab(new DOMRect(0, 0, 0, 0));
    fab(new DOMRect(100, 10, 56, 56), true);
    expect(measureCardBands("phone")).toEqual({ keepOut: { top: 96, right: 0, bottom: 80, left: 0 }, blocked: NONE });
  });

  it("phone: a raised on-screen keyboard (visual viewport shrinks, innerHeight unchanged) counts toward blocked, not keepOut", () => {
    document.documentElement.style.setProperty(STICKY_TOP_VAR, "96px");
    vi.stubGlobal("visualViewport", { height: window.innerHeight - 300, offsetTop: 0, scale: 1 });
    const bands = measureCardBands("phone");
    expect(bands.blocked.bottom).toBe(300);
    expect(bands.keepOut.bottom).toBe(0);
  });

  it("phone: the editing toolbar above the keyboard also counts toward blocked (the taller one wins); the round button stays in keepOut", () => {
    vi.stubGlobal("visualViewport", { height: window.innerHeight - 300, offsetTop: 0, scale: 1 });
    toolbar(window.innerHeight - 344);
    fab(new DOMRect(16, window.innerHeight - 72, 56, 56));
    const bands = measureCardBands("phone");
    expect(bands.blocked.bottom).toBe(344);
    expect(bands.keepOut.bottom).toBe(72);
  });

  it("phone: when the keyboard pushes the layout up (visual viewport offsetTop > 0), the part pushed off screen counts toward blocked's top; pinch zoom does not", () => {
    vi.stubGlobal("visualViewport", { height: window.innerHeight - 300, offsetTop: 120, scale: 1 });
    expect(measureCardBands("phone").blocked.top).toBe(120);
    vi.stubGlobal("visualViewport", { height: window.innerHeight / 2, offsetTop: 120, scale: 2 });
    expect(measureCardBands("phone").blocked.top).toBe(0);
    vi.stubGlobal("visualViewport", { height: window.innerHeight, offsetTop: 0, scale: 1 });
    expect(measureCardBands("phone").blocked.top).toBe(0);
  });

  it("phone list screen: the top is the pinned top row plus the list header (before the variable is written at least the top row is avoided)", () => {
    const list = document.createElement("aside");
    list.setAttribute("data-phone-list-shown", "");
    const bar = document.createElement("div");
    bar.setAttribute("data-phone-top-bar", "");
    bar.getBoundingClientRect = () => new DOMRect(0, 0, 390, 48);
    list.append(bar);
    document.body.append(list);
    document.documentElement.style.setProperty(STICKY_TOP_VAR, "200px");
    expect(measureCardBands("phone").keepOut.top).toBe(48);
    document.documentElement.style.setProperty(LIST_STICKY_TOP_VAR, "90px");
    expect(measureCardBands("phone").keepOut.top).toBe(90);
  });

  it("other layouts avoid nothing", () => {
    document.documentElement.style.setProperty(STICKY_TOP_VAR, "96px");
    vi.stubGlobal("visualViewport", { height: window.innerHeight - 300, offsetTop: 0, scale: 1 });
    fab(new DOMRect(16, window.innerHeight - 72, 56, 56));
    for (const layout of ["wide", "floating"] as const) expect(measureCardBands(layout)).toEqual({ keepOut: NONE, blocked: NONE });
  });
});

describe("leave runs once per exit", () => {
  it("next, back, finish: the stop being left gets one call each; the stop still on screen is not called", async () => {
    const [a, b, c] = [fakeStop("a"), fakeStop("b"), fakeStop("c")];
    const engine = engineOf([a, b, c]);
    await engine.begin();
    expect(a.leave).not.toHaveBeenCalled();
    engine.next();
    await frames();
    expect([a.leave.mock.calls.length, b.leave.mock.calls.length]).toEqual([1, 0]);
    engine.back();
    await frames();
    expect([a.leave.mock.calls.length, b.leave.mock.calls.length]).toEqual([1, 1]);
    engine.end("close");
    expect([a.leave.mock.calls.length, b.leave.mock.calls.length, c.leave.mock.calls.length]).toEqual([2, 1, 0]);
    expect(a.leave).toHaveBeenCalledWith(CTX);
  });

  it("on leaving, leave is called before preparing the next stop (a live stop's menu must close first)", async () => {
    const order: string[] = [];
    const [a, b] = [fakeStop("a"), fakeStop("b")];
    a.leave.mockImplementation(() => order.push("leave a"));
    b.prepare.mockImplementation(() => order.push("prepare b"));
    const engine = engineOf([a, b]);
    await engine.begin();
    engine.next();
    await frames();
    expect(order).toEqual(["leave a", "prepare b"]);
  });

  it.each(["keep", "delete", "close", "left", "unmount"] as const)("finish (%s): the stop on screen leaves once; finishing again does not repeat", async (reason) => {
    const [a, b] = [fakeStop("a"), fakeStop("b")];
    const engine = engineOf([a, b]);
    await engine.begin();
    engine.end(reason);
    engine.end("close");
    expect(a.leave).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot()).toMatchObject({ phase: "ended", endReason: reason });
  });

  it("a skipped stop (prepare ran but the target never appeared) also gets one call", async () => {
    const [a, b, c] = [fakeStop("a"), fakeStop("b", { present: false }), fakeStop("c")];
    const engine = engineOf([a, b, c]);
    await engine.begin();
    engine.next();
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect(ids(engine)).toBe("c");
    expect([a.leave.mock.calls.length, b.leave.mock.calls.length, c.leave.mock.calls.length]).toEqual([1, 1, 0]);
  });

  it("finishing while waiting for a target: the waiting stop (already prepared) gets one call and no stop is entered afterwards", async () => {
    const [a, b] = [fakeStop("a"), fakeStop("b", { present: false })];
    const engine = engineOf([a, b, fakeStop("c")]);
    await engine.begin();
    engine.next();
    await frames();
    engine.end("close");
    await vi.advanceTimersByTimeAsync(TARGET_TIMEOUT_MS + 50);
    expect([a.leave.mock.calls.length, b.leave.mock.calls.length]).toEqual([1, 1]);
    expect(engine.getSnapshot()).toMatchObject({ phase: "ended", index: 0 });
  });

  it("a leave error is only logged to the console and the stop change proceeds", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const [a, b] = [fakeStop("a"), fakeStop("b")];
    a.leave.mockImplementation(() => {
      throw new Error("boom");
    });
    const engine = engineOf([a, b]);
    await engine.begin();
    engine.next();
    await frames();
    expect(ids(engine)).toBe("b");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("finishing before entering the first stop: the first stop (already prepared) gets one call", async () => {
    const a = fakeStop("a", { present: false });
    const engine = engineOf([a, fakeStop("b")]);
    void engine.begin();
    engine.end("unmount");
    await frames();
    expect(a.leave).toHaveBeenCalledTimes(1);
  });
});

describe("subscription", () => {
  it("notifies once per state change; the snapshot is a new object and the old one is not modified", async () => {
    const engine = engineOf([fakeStop("a"), fakeStop("b")]);
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    const before = engine.getSnapshot();
    await engine.begin();
    expect(listener).toHaveBeenCalled();
    expect(before).toMatchObject({ phase: "idle", index: -1 });
    unsubscribe();
    listener.mockClear();
    engine.next();
    await frames();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("reading AI actions from the server at start", () => {
  it("cache holds an empty array and the server returns non-empty -> the server result is used (refetched however long the query's default staleTime is)", async () => {
    vi.useRealTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(["ai-actions"], []);
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ actions: [AI_ACTION] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchTourAiActions(qc)).resolves.toEqual([AI_ACTION]);
    expect(urls).toEqual(["/api/ai/actions"]);
    expect(qc.getQueryData(["ai-actions"])).toEqual([AI_ACTION]);
  });

  it("read failure -> empty array and no throw; no retry even though queries retry by default", async () => {
    vi.useRealTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "internal", message: "x" } }), { status: 500, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchTourAiActions(qc)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("measureTargets", () => {
  it("returns the union only when all have a size; if one is 0 or missing it returns null", () => {
    const a = document.createElement("div");
    a.getBoundingClientRect = () => new DOMRect(10, 10, 20, 20);
    const b = document.createElement("div");
    b.getBoundingClientRect = () => new DOMRect(50, 5, 10, 10);
    expect(measureTargets([a, b])).toEqual({ left: 10, top: 5, width: 50, height: 25 });
    const flat = document.createElement("div");
    flat.getBoundingClientRect = () => new DOMRect(10, 10, 20, 0);
    expect(measureTargets([a, flat])).toBeNull();
    expect(measureTargets([])).toBeNull();
  });
});

describe("waitForDrawerClosed", () => {
  it("waits while the drawer element is still there and resolves on the frame it disappears", async () => {
    const drawer = document.createElement("div");
    drawer.setAttribute("data-sidebar-drawer", "");
    document.body.append(drawer);
    const done = vi.fn();
    void waitForDrawerClosed(new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).not.toHaveBeenCalled();
    drawer.remove();
    await frames();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("no drawer to begin with -> resolves immediately", async () => {
    const done = vi.fn();
    void waitForDrawerClosed(new AbortController().signal).then(done);
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("samePath", () => {
  it("the browser's pathname is percent-encoded for non-ASCII slugs, so it is decoded before comparing", () => {
    expect(samePath("/n/alice/%E6%AD%A1%E8%BF%8E", "/n/alice/歡迎")).toBe(true);
    expect(samePath("/n/alice/歡迎", "/n/alice/歡迎")).toBe(true);
    expect(samePath("/n/alice/other", "/n/alice/歡迎")).toBe(false);
    expect(samePath("/login", "/n/alice/歡迎")).toBe(false);
  });

  it("a malformed % sequence does not throw and is compared as the raw string", () => {
    expect(samePath("/n/alice/%E6", "/n/alice/%E6")).toBe(true);
    expect(samePath("/n/alice/%E6", "/n/alice/x")).toBe(false);
  });
});

describe("focusReturnTarget", () => {
  function button(label: string): HTMLButtonElement {
    const el = document.createElement("button");
    el.textContent = label;
    document.body.append(el);
    return el;
  }

  it("the lookup function is re-run every frame and the element found (still attached to the DOM) is focused", async () => {
    let found: Element | null = null;
    const lookup = vi.fn(() => found);
    const done = focusReturnTarget(lookup, new AbortController().signal);
    await frames(100);
    const calls = lookup.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    const account = button("Ann");
    found = account;
    await frames();
    await expect(done).resolves.toBe(account);
    expect(document.activeElement).toBe(account);
  });

  it("a found element no longer in the DOM does not count and the lookup continues", async () => {
    const stale = document.createElement("button");
    let found: Element = stale;
    const done = focusReturnTarget(() => found, new AbortController().signal);
    await frames(100);
    const fresh = button("Ann");
    found = fresh;
    await frames();
    await expect(done).resolves.toBe(fresh);
    expect(document.activeElement).toBe(fresh);
  });

  it(`the lookup function keeps returning null -> falls back to the note title box after ${RETURN_FOCUS_TIMEOUT_MS} ms`, async () => {
    const title = document.createElement("input");
    title.setAttribute("data-note-title-input", "");
    document.body.append(title);
    const main = document.createElement("main");
    document.body.append(main);
    const done = vi.fn();
    void focusReturnTarget(() => null, new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(RETURN_FOCUS_TIMEOUT_MS - 50);
    expect(done).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toHaveBeenCalledWith(title);
    expect(document.activeElement).toBe(title);
  });

  it("phone: not found -> falls back to the back-to-list chevron, not the title box (focusing a text box would raise the keyboard)", async () => {
    stubLayoutTier("phone");
    const title = document.createElement("input");
    title.setAttribute("data-note-title-input", "");
    document.body.append(title);
    const back = button("Back to notes");
    back.setAttribute("data-kb-tour-target", "backToList");
    const done = focusReturnTarget(() => null, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(RETURN_FOCUS_TIMEOUT_MS + 50);
    await expect(done).resolves.toBe(back);
    expect(document.activeElement).toBe(back);
  });

  it("phone: no back chevron -> the main content area, still not touching the title box", async () => {
    stubLayoutTier("phone");
    const title = document.createElement("input");
    title.setAttribute("data-note-title-input", "");
    document.body.append(title);
    const main = document.createElement("main");
    document.body.append(main);
    const done = focusReturnTarget(() => null, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(RETURN_FOCUS_TIMEOUT_MS + 50);
    await expect(done).resolves.toBe(main);
  });

  it("no title box -> the main content area (not focusable by default, so tabindex=-1 is added)", async () => {
    const main = document.createElement("main");
    document.body.append(main);
    const done = focusReturnTarget(() => null, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(RETURN_FOCUS_TIMEOUT_MS + 50);
    await expect(done).resolves.toBe(main);
    expect(document.activeElement).toBe(main);
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("a title box inside the inert range (non-interactive background) does not count", async () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("inert", "");
    const title = document.createElement("input");
    title.setAttribute("data-note-title-input", "");
    wrapper.append(title);
    const main = document.createElement("main");
    document.body.append(wrapper, main);
    const done = focusReturnTarget(() => null, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(RETURN_FOCUS_TIMEOUT_MS + 50);
    await expect(done).resolves.toBe(main);
  });

  it("aborted -> nothing is focused", async () => {
    const account = button("Ann");
    const ac = new AbortController();
    ac.abort();
    await expect(focusReturnTarget(() => account, ac.signal)).resolves.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
