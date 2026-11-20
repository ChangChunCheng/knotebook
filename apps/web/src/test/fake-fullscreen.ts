import { vi } from "vitest";

/**
 * A browser-shaped fake Fullscreen implementation for component tests, installed on jsdom's real document (jsdom has no Fullscreen API).
 * - requestFullscreen / exitFullscreen return **pending** Promises; the test decides when and in what order they complete;
 * - fullscreenElement is controlled here and changes after the call; fullscreenchange is dispatched from here.
 * - performance.now is replaced by a controllable clock (jumps forward 1,000,000 ms on every install); tests advance it with advance().
 * Always `await fake.uninstall()` when done (afterEach): it rejects pending requests and **dispatches one "exit" at clock 0** -
 *   owned / exitWanted in present/fullscreen.ts go false and lastExitAt goes to 0 (= never exited, msSinceFullscreenExit() returns Infinity).
 *   Without resetting to 0 the module would keep a fake time in the millions, and if the next case **doesn't install** the fake fullscreen, the real clock minus it is negative (< 300) and the exit debounce swallows every Esc.
 */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface Deferred {
  resolve: () => void;
  reject: (err: unknown) => void;
}

export interface FakeFullscreen {
  readonly requestFullscreen: ReturnType<typeof vi.fn>;
  readonly exitFullscreen: ReturnType<typeof vi.fn>;
  /** Spec order: fullscreenchange, then resolve. */
  grantEventFirst(): Promise<void>;
  grantResolveFirst(): Promise<void>;
  deny(): Promise<void>;
  /** Completes the earliest pending exitFullscreen. */
  completeExit(): Promise<void>;
  userExit(): Promise<void>;
  advance(ms: number): void;
  uninstall(): Promise<void>;
}

let clockBase = 1_000_000;

export function installFakeFullscreen({ enabled = true }: { enabled?: boolean } = {}): FakeFullscreen {
  clockBase += 1_000_000;
  let now = clockBase;
  const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
  let element: Element | null = null;
  let request: Deferred | null = null;
  const exits: Deferred[] = [];
  const fire = () => document.dispatchEvent(new Event("fullscreenchange"));

  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => enabled });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  const requestFullscreen = vi.fn(() => new Promise<void>((resolve, reject) => { request = { resolve, reject }; }));
  const exitFullscreen = vi.fn(() => new Promise<void>((resolve, reject) => { exits.push({ resolve, reject }); }));
  Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: requestFullscreen });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });

  return {
    requestFullscreen,
    exitFullscreen,
    async grantEventFirst() {
      element = document.documentElement;
      fire();
      request?.resolve();
      request = null;
      await flushMicrotasks();
    },
    async grantResolveFirst() {
      element = document.documentElement;
      request?.resolve();
      request = null;
      await flushMicrotasks();
      fire();
      await flushMicrotasks();
    },
    async deny() {
      request?.reject(new TypeError("denied"));
      request = null;
      await flushMicrotasks();
    },
    async completeExit() {
      element = null;
      fire();
      exits.shift()?.resolve();
      await flushMicrotasks();
    },
    async userExit() {
      element = null;
      fire();
      await flushMicrotasks();
    },
    advance(ms: number) {
      now += ms;
    },
    async uninstall() {
      request?.reject(new TypeError("uninstalled"));
      request = null;
      await flushMicrotasks();
      element = null;
      now = 0; // makes the module's recorded lastExitAt 0 (see the file header)
      fire();
      while (exits.length > 0) exits.shift()?.resolve();
      await flushMicrotasks();
      delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
      delete (document as unknown as Record<string, unknown>).fullscreenElement;
      delete (document as unknown as Record<string, unknown>).exitFullscreen;
      delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
      nowSpy.mockRestore();
    },
  };
}
