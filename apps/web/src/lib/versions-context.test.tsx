import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vid, vtarget } from "@/test/version-fixtures";
import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { VersionDto } from "@knotebook/shared";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { KIND_FILTER_STORAGE_KEY, VersionsProvider, isOverlayOpen, useVersions, useVersionsController } from "./versions-context";

/** Controllable layout tier (`test/layout-tier.ts`): `set(true)` is phone (< 640), `set(false)` is docked (>= 1280); `tier()` picks any tier. */
function installMatchMedia(initialPhone: boolean) {
  const handle = stubLayoutTier(initialPhone ? "phone" : "docked");
  return {
    set(phone: boolean) {
      act(() => handle.setLayoutTier(phone ? "phone" : "docked"));
    },
    tier(next: LayoutTier) {
      act(() => handle.setLayoutTier(next));
    },
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

const V: VersionDto = { id: vid(1), seq: 1, kind: "manual", name: null, editors: [], baseSeq: null, base: null, createdAt: "2026-10-09T00:00:00.000Z" };

describe("versions-context", () => {
  let mm: ReturnType<typeof installMatchMedia>;
  beforeEach(() => {
    mm = installMatchMedia(false);
    window.localStorage.clear();
  });
  afterEach(() => mm.restore());

  it("without a provider -> no-op defaults: enabled=false, no action throws", () => {
    const { result } = renderHook(() => useVersions());
    expect(result.current.enabled).toBe(false);
    expect(result.current.panelOpen).toBe(false);
    expect(() => {
      result.current.open();
      result.current.openSave();
      result.current.startPreview({ seq: 1, id: "x", name: null });
    }).not.toThrow();
    expect(result.current.preview).toBeNull();
  });

  it("open() on the fixed and floating tiers -> mode=panel, panelOpen=true; phone -> mode=sheet, panelOpen=false", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.open());
    expect(result.current.mode).toBe("panel");
    expect(result.current.panelOpen).toBe(true);
    act(() => result.current.close());
    mm.tier("overlay");
    act(() => result.current.open());
    expect(result.current.mode).toBe("panel");
    expect(result.current.panelOpen).toBe(true);
    act(() => result.current.close());
    mm.set(true);
    act(() => result.current.open());
    expect(result.current.mode).toBe("sheet");
    expect(result.current.panelOpen).toBe(false);
  });

  it("panel open across 1280 (floating <-> fixed): mode stays panel, preview kept", () => {
    mm.tier("overlay");
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => {
      result.current.open();
      result.current.startPreview(vtarget(2));
    });
    mm.tier("docked");
    expect(result.current.mode).toBe("panel");
    expect(result.current.preview).toEqual(vtarget(2));
    mm.tier("overlay");
    expect(result.current.mode).toBe("panel");
    expect(result.current.preview).toEqual(vtarget(2));
  });

  it("panel open across 640 (floating -> phone): closes entirely, the preview leaves with it", () => {
    mm.tier("overlay");
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => {
      result.current.open();
      result.current.startPreview(vtarget(2));
    });
    mm.tier("phone");
    expect(result.current.mode).toBeNull();
    expect(result.current.preview).toBeNull();
  });

  it("enabled=false -> open / openSave / startPreview have no effect", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: false }));
    act(() => {
      result.current.open();
      result.current.openSave();
      result.current.startPreview({ seq: 1, id: "x", name: null });
    });
    expect(result.current.mode).toBeNull();
    expect(result.current.dialog).toBeNull();
    expect(result.current.preview).toBeNull();
  });

  it("previewSeq is derived from preview; stopPreview -> null", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => {
      result.current.open();
      result.current.startPreview(vtarget(3));
    });
    expect(result.current.previewSeq).toBe(3);
    act(() => result.current.stopPreview());
    expect(result.current.previewSeq).toBeNull();
    expect(result.current.mode).toBe("panel");
  });

  it("close() closes the panel = also leaves the preview, and the right side resets current", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => {
      result.current.open();
      result.current.startPreview(vtarget(3));
      result.current.setCompareRight(vtarget(1));
    });
    expect(result.current.preview).toEqual(vtarget(3));
    act(() => result.current.close());
    expect(result.current.mode).toBeNull();
    expect(result.current.preview).toBeNull();
    expect(result.current.previewSeq).toBeNull();
    expect(result.current.compareRight).toBe("current");
  });

  it("openSave(then) -> dialog={kind:'save', then}; closeDialog clears it", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.openSave(V));
    expect(result.current.dialog).toEqual({ kind: "save", then: V });
    act(() => result.current.closeDialog());
    expect(result.current.dialog).toBeNull();
  });

  it("open across a breakpoint (wide -> narrow) -> closes entirely, the preview leaves with it", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => {
      result.current.open();
      result.current.startPreview(vtarget(2));
    });
    mm.set(true);
    expect(result.current.mode).toBeNull();
    expect(result.current.preview).toBeNull();
  });

  it("narrow -> wide also closes the whole page", () => {
    mm.set(true);
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.open());
    expect(result.current.mode).toBe("sheet");
    mm.set(false);
    expect(result.current.mode).toBeNull();
  });

  it("switching notes (noteId changes) -> the panel (mode) is kept; preview / dialog / compare right / side-by-side / only-changes reset to defaults (#258)", () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useVersionsController({ noteId: id, enabled: true }), { initialProps: { id: "n1" } });
    act(() => {
      result.current.open();
      result.current.startPreview(vtarget(2));
      result.current.setCompareRight(vtarget(1));
      result.current.setSplitMode("split");
      result.current.setOnlyChanges(true);
      result.current.openSave();
    });
    expect(result.current.panelOpen).toBe(true);
    rerender({ id: "n2" });
    expect(result.current.noteId).toBe("n2");
    expect(result.current.mode).toBe("panel");
    expect(result.current.panelOpen).toBe(true);
    expect(result.current.preview).toBeNull();
    expect(result.current.previewSeq).toBeNull();
    expect(result.current.dialog).toBeNull();
    expect(result.current.compareRight).toBe("current");
    expect(result.current.splitMode).toBe("auto");
    expect(result.current.onlyChanges).toBe(false);
  });

  it("switching notes: the narrow-window full page (sheet) still closes (only the wide panel is kept)", () => {
    mm.set(true);
    const { result, rerender } = renderHook(({ id }: { id: string }) => useVersionsController({ noteId: id, enabled: true }), { initialProps: { id: "n1" } });
    act(() => {
      result.current.open();
      result.current.startPreview(vtarget(2));
    });
    expect(result.current.mode).toBe("sheet");
    rerender({ id: "n2" });
    expect(result.current.mode).toBeNull();
    expect(result.current.preview).toBeNull();
    expect(result.current.enabled).toBe(true);
    expect(result.current.panelOpen).toBe(false);
  });

  it("switching notes through a transition (noteId goes null then a new id): the full page closes in the first step of the transition and does not reappear; the wide panel stays", () => {
    type P = { id: string | null; enabled: boolean };
    const init: P = { id: "n1", enabled: true };
    mm.set(true);
    const sheet = renderHook(({ id, enabled }: P) => useVersionsController({ noteId: id, enabled }), { initialProps: init });
    act(() => sheet.result.current.open());
    expect(sheet.result.current.mode).toBe("sheet");
    sheet.rerender({ id: null, enabled: false });
    expect(sheet.result.current.mode).toBeNull();
    sheet.rerender({ id: "n2", enabled: true });
    expect(sheet.result.current.mode).toBeNull();
    sheet.unmount();
    mm.set(false);
    const panel = renderHook(({ id, enabled }: P) => useVersionsController({ noteId: id, enabled }), { initialProps: init });
    act(() => panel.result.current.open());
    expect(panel.result.current.mode).toBe("panel");
    panel.rerender({ id: null, enabled: false });
    panel.rerender({ id: "n2", enabled: true });
    expect(panel.result.current.mode).toBe("panel");
    expect(panel.result.current.panelOpen).toBe(true);
  });

  it("switching notes through a transition (during NotePage's needsResolve noteId is null and enabled is false) -> the panel is kept and shown once the new note is editable", () => {
    const { result, rerender } = renderHook(({ id, enabled }: { id: string | null; enabled: boolean }) => useVersionsController({ noteId: id, enabled }), {
      initialProps: { id: "n1" as string | null, enabled: true },
    });
    act(() => {
      result.current.open();
      result.current.startPreview(vtarget(2));
    });
    rerender({ id: null, enabled: false });
    // Still disabled outwardly during the transition (the panel is not rendered), but the preview is cleared and mode is remembered.
    expect(result.current.enabled).toBe(false);
    expect(result.current.panelOpen).toBe(false);
    expect(result.current.preview).toBeNull();
    rerender({ id: "n2", enabled: true });
    expect(result.current.panelOpen).toBe(true);
    expect(result.current.noteId).toBe("n2");
    expect(result.current.preview).toBeNull();
  });

  it("switching to a non-editable note (noteId non-null, enabled false) -> the panel closes, and does not reappear when enabled flips back to true", () => {
    const { result, rerender } = renderHook(({ id, enabled }: { id: string | null; enabled: boolean }) => useVersionsController({ noteId: id, enabled }), {
      initialProps: { id: "n1" as string | null, enabled: true },
    });
    act(() => result.current.open());
    rerender({ id: null, enabled: false });
    rerender({ id: "n2", enabled: false });
    expect(result.current.mode).toBeNull();
    rerender({ id: "n2", enabled: true });
    expect(result.current.panelOpen).toBe(false);
    expect(result.current.mode).toBeNull();
  });

  it("switching in one step to a non-editable note (no null transition) -> the panel closes", () => {
    const { result, rerender } = renderHook(({ id, enabled }: { id: string; enabled: boolean }) => useVersionsController({ noteId: id, enabled }), {
      initialProps: { id: "n1", enabled: true },
    });
    act(() => result.current.open());
    rerender({ id: "n2", enabled: false });
    expect(result.current.mode).toBeNull();
    rerender({ id: "n2", enabled: true });
    expect(result.current.panelOpen).toBe(false);
  });

  it("list filter: default all; setKindFilter writes localStorage; not reset on note switch; read from localStorage on the next mount", () => {
    const { result, rerender, unmount } = renderHook(({ id }: { id: string }) => useVersionsController({ noteId: id, enabled: true }), { initialProps: { id: "n1" } });
    expect(result.current.kindFilter).toBe("all");
    act(() => result.current.setKindFilter("manual"));
    expect(result.current.kindFilter).toBe("manual");
    expect(window.localStorage.getItem(KIND_FILTER_STORAGE_KEY)).toBe("manual");
    rerender({ id: "n2" });
    expect(result.current.kindFilter).toBe("manual");
    unmount();
    const again = renderHook(() => useVersionsController({ noteId: "n9", enabled: true }));
    expect(again.result.current.kindFilter).toBe("manual");
    act(() => again.result.current.setKindFilter("all"));
    expect(window.localStorage.getItem(KIND_FILTER_STORAGE_KEY)).toBe("all");
  });

  it("list filter: an invalid localStorage value -> all; read/write throwing -> all and setKindFilter still takes effect this time; the no-op without a provider is all", () => {
    window.localStorage.setItem(KIND_FILTER_STORAGE_KEY, "auto");
    expect(renderHook(() => useVersionsController({ noteId: "n1", enabled: true })).result.current.kindFilter).toBe("all");
    window.localStorage.setItem(KIND_FILTER_STORAGE_KEY, "{broken");
    expect(renderHook(() => useVersionsController({ noteId: "n1", enabled: true })).result.current.kindFilter).toBe("all");
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
      expect(result.current.kindFilter).toBe("all");
      act(() => result.current.setKindFilter("manual"));
      expect(result.current.kindFilter).toBe("manual");
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
    expect(renderHook(() => useVersions()).result.current.kindFilter).toBe("all");
  });

  it("enabled flipping to false (downgrade / terminal) -> panel, preview and dialog are all cleared; flipping back to true does not bring them back", () => {
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useVersionsController({ noteId: "n1", enabled }), {
      initialProps: { enabled: true },
    });
    act(() => {
      result.current.open();
      result.current.startPreview(vtarget(2));
      result.current.openSave();
    });
    expect(result.current.mode).toBe("panel");
    expect(result.current.preview).toEqual(vtarget(2));
    expect(result.current.dialog).toEqual({ kind: "save" });
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(result.current.mode).toBeNull();
    expect(result.current.panelOpen).toBe(false);
    expect(result.current.preview).toBeNull();
    expect(result.current.dialog).toBeNull();
  });

  it("switching notes -> splitMode / compareRight / onlyChanges reset to defaults", () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useVersionsController({ noteId: id, enabled: true }), { initialProps: { id: "n1" } });
    act(() => {
      result.current.setSplitMode("split");
      result.current.setCompareRight(vtarget(1));
      result.current.setOnlyChanges(true);
    });
    expect(result.current.splitMode).toBe("split");
    expect(result.current.compareRight).toEqual(vtarget(1));
    expect(result.current.onlyChanges).toBe(true);
    rerender({ id: "n2" });
    expect(result.current.splitMode).toBe("auto");
    expect(result.current.compareRight).toBe("current");
    expect(result.current.onlyChanges).toBe(false);
  });

  it("right defaults to current; the no-op without a provider is also current", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    expect(result.current.compareRight).toBe("current");
    const { result: noop } = renderHook(() => useVersions());
    expect(noop.current.compareRight).toBe("current");
  });

  it("startPreview changes only the left; a right-side version already chosen is kept instead of jumping back to current", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.startPreview(vtarget(3)));
    act(() => result.current.setCompareRight(vtarget(1)));
    act(() => result.current.startPreview(vtarget(2)));
    expect(result.current.preview).toEqual(vtarget(2));
    expect(result.current.compareRight).toEqual(vtarget(1));
  });

  it("stopPreview -> right resets to current", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.startPreview(vtarget(3)));
    act(() => result.current.setCompareRight(vtarget(1)));
    act(() => result.current.stopPreview());
    expect(result.current.compareRight).toBe("current");
  });

  it("enabled flipping to false -> right resets to current (does not reappear when flipped back to true)", () => {
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useVersionsController({ noteId: "n1", enabled }), { initialProps: { enabled: true } });
    act(() => result.current.startPreview(vtarget(3)));
    act(() => result.current.setCompareRight(vtarget(1)));
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(result.current.compareRight).toBe("current");
  });

  it("setCompareRight has no effect when enabled=false (still current after flipping back to true)", () => {
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useVersionsController({ noteId: "n1", enabled }), { initialProps: { enabled: false } });
    act(() => result.current.setCompareRight(vtarget(1)));
    rerender({ enabled: true });
    expect(result.current.compareRight).toBe("current");
  });

  it("across a breakpoint (the preview leaves with it) -> right resets to current", () => {
    const { result } = renderHook(() => useVersionsController({ noteId: "n1", enabled: true }));
    act(() => result.current.startPreview(vtarget(3)));
    act(() => result.current.setCompareRight(vtarget(1)));
    mm.set(true);
    expect(result.current.preview).toBeNull();
    expect(result.current.compareRight).toBe("current");
  });

  it("VersionsProvider hands value to its descendants", () => {
    function Probe() {
      return <span data-testid="probe">{String(useVersions().enabled)}</span>;
    }
    function Host({ children }: { children: ReactNode }) {
      const value = useVersionsController({ noteId: "n1", enabled: true });
      return <VersionsProvider value={value}>{children}</VersionsProvider>;
    }
    render(
      <Host>
        <Probe />
      </Host>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("true");
  });

  it("isOverlayOpen: true only when a dialog (not the sidebar drawer) or a menu is in the DOM", () => {
    expect(isOverlayOpen()).toBe(false);
    const drawer = document.createElement("div");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("data-sidebar-drawer", "");
    document.body.append(drawer);
    expect(isOverlayOpen()).toBe(false);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    expect(isOverlayOpen()).toBe(true);
    drawer.remove();
    menu.remove();
  });
});
