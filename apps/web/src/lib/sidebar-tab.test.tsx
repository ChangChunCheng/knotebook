import { memo, useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { OVERLAY_QUERY } from "@/lib/layout-tiers";
import { SidebarDrawerContext } from "@/lib/sidebar-drawer";
import { PhoneListContext } from "@/lib/phone-list";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { onSearchMarkClear } from "@/hooks/search-mark";
import { EMPTY_SELECTION } from "./sidebar-selection";
import {
  DEFAULT_SIDEBAR_TAB,
  SIDEBAR_TABS,
  SidebarTabProvider,
  readSidebarTab,
  useSidebarTabActions,
  useSidebarTabState,
  writeSidebarTab,
  type SidebarTab,
  type SidebarTabActions,
} from "./sidebar-tab";

afterEach(() => {
  localStorage.removeItem("sidebar.tab");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: query === OVERLAY_QUERY ? matches : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

function Probe() {
  const { tab } = useSidebarTabState();
  const { showTab } = useSidebarTabActions();
  return (
    <>
      <span data-testid="tab">{tab}</span>
      {SIDEBAR_TABS.map((t) => (
        <button key={t} type="button" onClick={() => showTab(t)}>
          go-{t}
        </button>
      ))}
    </>
  );
}

describe("constants", () => {
  it("tab bar order", () => {
    expect(SIDEBAR_TABS).toEqual(["recent", "favorites", "myNotes", "workspace", "shared", "trash"]);
  });

  it("the default tab is still My Notes (Favorites is second, not the default)", () => {
    expect(DEFAULT_SIDEBAR_TAB).toBe("myNotes");
  });
});

describe("readSidebarTab", () => {
  it("missing key -> default", () => {
    expect(readSidebarTab()).toBe("myNotes");
  });

  it.each(SIDEBAR_TABS)("valid value %s returns itself", (tab) => {
    localStorage.setItem("sidebar.tab", tab);
    expect(readSidebarTab()).toBe(tab);
  });

  it("trash is a valid value", () => {
    localStorage.setItem("sidebar.tab", "trash");
    expect(readSidebarTab()).toBe("trash");
  });

  it.each(["bogus", ""])("invalid value %j -> default", (raw) => {
    localStorage.setItem("sidebar.tab", raw);
    expect(readSidebarTab()).toBe("myNotes");
  });

  it("getItem throwing -> default", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSidebarTab()).toBe("myNotes");
  });
});

describe("writeSidebarTab", () => {
  it("does not throw when setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeSidebarTab("workspace")).not.toThrow();
  });

  it("writes normally", () => {
    writeSidebarTab("workspace");
    expect(localStorage.getItem("sidebar.tab")).toBe("workspace");
  });
});

describe("SidebarTabProvider", () => {
  it("pre-stored shared -> probe shows shared; showTab switches and writes to storage", () => {
    localStorage.setItem("sidebar.tab", "shared");
    render(
      <SidebarTabProvider>
        <Probe />
      </SidebarTabProvider>,
    );
    expect(screen.getByTestId("tab")).toHaveTextContent("shared");
    fireEvent.click(screen.getByRole("button", { name: "go-recent" }));
    expect(screen.getByTestId("tab")).toHaveTextContent("recent");
    expect(localStorage.getItem("sidebar.tab")).toBe("recent");
  });

  it("choosing Favorites -> written to storage; still Favorites after unmount and remount", () => {
    const first = render(
      <SidebarTabProvider>
        <Probe />
      </SidebarTabProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "go-favorites" }));
    expect(screen.getByTestId("tab")).toHaveTextContent("favorites");
    expect(localStorage.getItem("sidebar.tab")).toBe("favorites");
    first.unmount();
    render(
      <SidebarTabProvider>
        <Probe />
      </SidebarTabProvider>,
    );
    expect(screen.getByTestId("tab")).toHaveTextContent("favorites");
  });

  it("showTab still switches when setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    let actions: SidebarTabActions | null = null;
    const Grab = () => {
      actions = useSidebarTabActions();
      return null;
    };
    render(
      <SidebarTabProvider>
        <Grab />
        <Probe />
      </SidebarTabProvider>,
    );
    // Call directly: an exception thrown synchronously bubbles out of act, instead of being swallowed by jsdom as a window error.
    act(() => {
      (actions as SidebarTabActions | null)?.showTab("workspace");
    });
    expect(screen.getByTestId("tab")).toHaveTextContent("workspace");
  });
});

describe("without a provider", () => {
  it("actions are the same object across two renders, showTab does not throw; state is the default", () => {
    const { result, rerender } = renderHook(() => useSidebarTabActions());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(() => result.current.showTab("shared")).not.toThrow();
    expect(renderHook(() => useSidebarTabState()).result.current.tab).toBe("myNotes");
    expect(DEFAULT_SIDEBAR_TAB).toBe("myNotes");
  });
});

describe("actions are stable", () => {
  it("after the provider re-renders and tabs switch, a memo component consuming only actions does not re-render and actions is the same object", () => {
    let renders = 0;
    const seen: SidebarTabActions[] = [];
    const Counter = memo(function Counter() {
      renders += 1;
      seen.push(useSidebarTabActions());
      return null;
    });
    function Harness() {
      const [n, setN] = useState(0);
      const { showTab } = useSidebarTabActions();
      return (
        <>
          <button type="button" onClick={() => setN(n + 1)}>
            rerender
          </button>
          <button type="button" onClick={() => showTab(n % 2 ? "recent" : "shared")}>
            switch
          </button>
        </>
      );
    }
    function Outer() {
      const [n, setN] = useState(0);
      return (
        <SidebarTabProvider>
          <span data-n={n} />
          <button type="button" onClick={() => setN(n + 1)}>
            outer
          </button>
          <Harness />
          <Counter />
        </SidebarTabProvider>
      );
    }
    render(<Outer />);
    const mounted = renders;
    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "outer" }));
      fireEvent.click(screen.getByRole("button", { name: "rerender" }));
      fireEvent.click(screen.getByRole("button", { name: "switch" }));
    }
    expect(renders).toBe(mounted);
    expect(seen.length).toBe(mounted);
    for (const actions of seen) expect(actions).toBe(seen[0]);
  });
});

function withDrawer(spy: (open: boolean) => void, children: ReactNode) {
  return <SidebarDrawerContext.Provider value={{ setOpen: spy }}>{children}</SidebarDrawerContext.Provider>;
}

describe("showTab opens the drawer on a narrow screen", () => {
  it("narrow -> setOpen(true) called once", () => {
    stubMatchMedia(true);
    const spy = vi.fn();
    render(
      withDrawer(
        spy,
        <SidebarTabProvider>
          <Probe />
        </SidebarTabProvider>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "go-workspace" }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(true);
  });

  it("wide -> not called", () => {
    stubMatchMedia(false);
    const spy = vi.fn();
    render(
      withDrawer(
        spy,
        <SidebarTabProvider>
          <Probe />
        </SidebarTabProvider>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "go-workspace" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("when the drawer context object changes: actions stay the same, showTab calls the new setOpen", () => {
    stubMatchMedia(true);
    const spy = vi.fn();
    const spy2 = vi.fn();
    let actions: SidebarTabActions | null = null;
    const Grab = () => {
      const a = useSidebarTabActions();
      if (actions === null) actions = a;
      else expect(a).toBe(actions);
      return null;
    };
    const tree = (s: (open: boolean) => void) =>
      withDrawer(
        s,
        <SidebarTabProvider>
          <Grab />
          <Probe />
        </SidebarTabProvider>,
      );
    const { rerender } = render(tree(spy));
    rerender(tree(spy2));
    act(() => {
      (actions as SidebarTabActions | null)?.showTab("shared" satisfies SidebarTab);
    });
    expect(spy2).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("showTab on phone: back to the list, no drawer", () => {
  function renderWithList(tier: LayoutTier, drawerSpy: (open: boolean) => void, backToList: () => void) {
    stubLayoutTier(tier);
    return render(
      <PhoneListContext.Provider value={{ backToList }}>
        {withDrawer(
          drawerSpy,
          <SidebarTabProvider>
            <Probe />
          </SidebarTabProvider>,
        )}
      </PhoneListContext.Provider>,
    );
  }

  it("phone -> backToList called once, drawer not opened; the tab still switches and is written", () => {
    const drawer = vi.fn();
    const backToList = vi.fn();
    renderWithList("phone", drawer, backToList);
    fireEvent.click(screen.getByRole("button", { name: "go-workspace" }));
    expect(backToList).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();
    expect(screen.getByTestId("tab")).toHaveTextContent("workspace");
    expect(localStorage.getItem("sidebar.tab")).toBe("workspace");
  });

  it("floating tier -> opens the drawer, does not call backToList", () => {
    const drawer = vi.fn();
    const backToList = vi.fn();
    renderWithList("overlay", drawer, backToList);
    fireEvent.click(screen.getByRole("button", { name: "go-workspace" }));
    expect(drawer).toHaveBeenCalledWith(true);
    expect(backToList).not.toHaveBeenCalled();
  });

  it("fixed tier -> neither is called", () => {
    const drawer = vi.fn();
    const backToList = vi.fn();
    renderWithList("docked", drawer, backToList);
    fireEvent.click(screen.getByRole("button", { name: "go-workspace" }));
    expect(drawer).not.toHaveBeenCalled();
    expect(backToList).not.toHaveBeenCalled();
  });
});

function SelectionProbe() {
  const { selection } = useSidebarTabState();
  const { showTab, updateSelection } = useSidebarTabActions();
  return (
    <>
      <span data-testid="active">{String(selection.active)}</span>
      <span data-testid="keys">{[...selection.keys].join(",")}</span>
      <button type="button" onClick={() => updateSelection({ type: "start" })}>
        start
      </button>
      <button type="button" onClick={() => updateSelection({ type: "toggle", key: "note:a" })}>
        toggle-a
      </button>
      <button type="button" onClick={() => showTab("myNotes")}>
        show-myNotes
      </button>
      <button type="button" onClick={() => showTab("recent")}>
        show-recent
      </button>
    </>
  );
}

describe("selection state", () => {
  function startWithA() {
    render(
      <SidebarTabProvider>
        <SelectionProbe />
      </SidebarTabProvider>,
    );
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    fireEvent.click(screen.getByRole("button", { name: "toggle-a" }));
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("keys")).toHaveTextContent("note:a");
  }

  it("selection lives in the provider; clicking the current tab does not end selection", () => {
    startWithA(); // defaults to myNotes
    fireEvent.click(screen.getByRole("button", { name: "show-myNotes" }));
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("keys")).toHaveTextContent("note:a");
  });

  it("switching to another tab ends selection", () => {
    startWithA();
    fireEvent.click(screen.getByRole("button", { name: "show-recent" }));
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    expect(screen.getByTestId("keys")).toBeEmptyDOMElement();
  });

  it("endSelectionIfActive returns true and ends while selecting; calling again returns false", () => {
    let actions: SidebarTabActions | null = null;
    const Grab = () => {
      actions = useSidebarTabActions();
      return null;
    };
    render(
      <SidebarTabProvider>
        <Grab />
        <SelectionProbe />
      </SidebarTabProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    fireEvent.click(screen.getByRole("button", { name: "toggle-a" }));
    let first: boolean | undefined;
    act(() => {
      first = (actions as SidebarTabActions | null)?.endSelectionIfActive();
    });
    expect(first).toBe(true);
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    let second: boolean | undefined;
    act(() => {
      second = (actions as SidebarTabActions | null)?.endSelectionIfActive();
    });
    expect(second).toBe(false);
    expect(screen.getByTestId("active")).toHaveTextContent("false");
  });

  it("after start, three toggles and end, a memo component consuming only actions does not re-render and actions is the same object", () => {
    let renders = 0;
    const seen: SidebarTabActions[] = [];
    const Counter = memo(function Counter() {
      renders += 1;
      seen.push(useSidebarTabActions());
      return null;
    });
    let actions: SidebarTabActions | null = null;
    const Grab = () => {
      actions = useSidebarTabActions();
      return null;
    };
    render(
      <SidebarTabProvider>
        <Grab />
        <SelectionProbe />
        <Counter />
      </SidebarTabProvider>,
    );
    const mounted = renders;
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByRole("button", { name: "toggle-a" }));
    expect(screen.getByTestId("keys")).toHaveTextContent("note:a");
    act(() => {
      (actions as SidebarTabActions | null)?.endSelectionIfActive();
    });
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    expect(renders).toBe(mounted);
    expect(seen.length).toBe(mounted);
    for (const a of seen) expect(a).toBe(seen[0]);
    expect(actions).toBe(seen[0]);
  });

  it("actionsRef points to the same object as useSidebarTabActions() and does not change after re-render", () => {
    let fromHook: SidebarTabActions | null = null;
    let ref: { current: SidebarTabActions | null } | null = null;
    const Grab = () => {
      fromHook = useSidebarTabActions();
      return null;
    };
    function Host() {
      const actionsRef = useRef<SidebarTabActions | null>(null);
      ref = actionsRef;
      const [n, setN] = useState(0);
      return (
        <SidebarTabProvider actionsRef={actionsRef}>
          <button type="button" data-n={n} onClick={() => setN(n + 1)}>
            host-rerender
          </button>
          <Grab />
          <SelectionProbe />
        </SidebarTabProvider>
      );
    }
    render(<Host />);
    const current = () => (ref as { current: SidebarTabActions | null } | null)?.current;
    expect(fromHook).not.toBeNull();
    expect(current()).toBe(fromHook);
    const first = current();
    fireEvent.click(screen.getByRole("button", { name: "host-rerender" }));
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    expect(current()).toBe(first);
    expect(current()).toBe(fromHook);
  });

  it("no provider -> endSelectionIfActive returns false without throwing; selection is EMPTY_SELECTION", () => {
    const actions = renderHook(() => useSidebarTabActions()).result.current;
    expect(actions.endSelectionIfActive()).toBe(false);
    expect(() => actions.updateSelection({ type: "start" })).not.toThrow();
    expect(renderHook(() => useSidebarTabState()).result.current.selection).toBe(EMPTY_SELECTION);
  });

  it("getSelectionSession is null while not selecting; after start it is n, toggle leaves it unchanged, after end null; a new start gives a different n+1", () => {
    let actions: SidebarTabActions | null = null;
    const Grab = () => {
      actions = useSidebarTabActions();
      return null;
    };
    render(
      <SidebarTabProvider>
        <Grab />
        <SelectionProbe />
      </SidebarTabProvider>,
    );
    const session = () => (actions as SidebarTabActions | null)?.getSelectionSession();
    expect(session()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    const n = session();
    expect(typeof n).toBe("number");
    fireEvent.click(screen.getByRole("button", { name: "toggle-a" }));
    expect(session()).toBe(n);
    act(() => {
      (actions as SidebarTabActions | null)?.endSelectionIfActive();
    });
    expect(session()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    expect(session()).toBe((n as number) + 1);
    expect(renderHook(() => useSidebarTabActions()).result.current.getSelectionSession()).toBeNull();
  });
});

describe("persistent search marker: switching to another tab = leaving search -> clear", () => {
  it("showTab to a different tab -> clears once; to the same tab -> does not clear", () => {
    stubMatchMedia(false);
    const cleared = vi.fn();
    const off = onSearchMarkClear(cleared);
    try {
      render(
        <SidebarTabProvider>
          <Probe />
        </SidebarTabProvider>,
      );
      const current = screen.getByTestId("tab").textContent as SidebarTab;
      fireEvent.click(screen.getByText(`go-${current}`));
      expect(cleared).not.toHaveBeenCalled();
      const other = SIDEBAR_TABS.find((t) => t !== current)!;
      fireEvent.click(screen.getByText(`go-${other}`));
      expect(cleared).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});
