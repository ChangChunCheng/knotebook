import { readFileSync } from "node:fs";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissAllToasts, dismissToast, toast, useToasts } from "./toast";

// Regression: the id generator in apps/web/src/components/ui/toast.tsx used crypto.randomUUID(), which does not exist in a non-secure context
// (plain-http LAN, a legitimate topology), so every toast() call threw TypeError. vi.stubGlobal fakes a crypto
// without randomUUID and checks that toast() no longer depends on it.

afterEach(() => {
  dismissAllToasts();
  vi.unstubAllGlobals();
});

describe("toast()", () => {
  it("does not throw when crypto.randomUUID is unavailable (non-secure context)", () => {
    vi.stubGlobal("crypto", {});

    let id = "";
    expect(() => {
      id = toast({ title: "a" });
    }).not.toThrow();
    expect(id).toBeTruthy();
  });

  it("produces distinct ids across successive calls", () => {
    const id1 = toast({ title: "a" });
    const id2 = toast({ title: "b" });
    expect(id1).not.toBe(id2);
  });

  it("dismissToast removes the matching item by id", () => {
    const { result } = renderHook(() => useToasts());

    let id1 = "";
    let id2 = "";
    act(() => {
      id1 = toast({ title: "a" });
      id2 = toast({ title: "b" });
    });
    expect(result.current.map((t) => t.id)).toEqual([id1, id2]);

    act(() => {
      dismissToast(id1);
    });
    expect(result.current.map((t) => t.id)).toEqual([id2]);
  });

  it("#115: the viewport carries pointer-events-none and the toast item carries pointer-events-auto (a pair)", () => {
    // Source scan (this file is .ts, and rendering the Radix viewport needs the whole provider set): an empty viewport is a fixed hit area at the bottom right,
    // and without `pointer-events-none` it would block the lower edge of the bottom-right history bubble; but that class is safe only when the item
    // carries `pointer-events-auto` itself. The two come as a pair: removing either half must turn it red.
    //
    // Strip `//` comments before scanning (same convention as the theme.* guards): toast.tsx's explanatory comments contain these two literals,
    // and without stripping the guard would be guarding its own comments. Anchoring is also tightened to the start of a quoted class literal,
    // not arbitrary text inside the cn(...) block.
    const raw = readFileSync(`${process.cwd()}/src/components/ui/toast.tsx`, "utf8");
    const source = raw.replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    const viewport = /ToastPrimitive\.Viewport[\s\S]*?className=\{cn\(([\s\S]*?)\)\}/.exec(source);
    expect(viewport, "找不到 Viewport 的 className").not.toBeNull();
    expect(viewport![1]).toMatch(/"pointer-events-none [^"]*fixed bottom-0 right-0/);

    const root = /ToastPrimitive\.Root\s[\s\S]*?className=\{cn\(([\s\S]*?)\)\}/.exec(source);
    expect(root, "找不到 ToastRoot 的 className").not.toBeNull();
    expect(root![1]).toMatch(/"pointer-events-auto /);
  });
});
