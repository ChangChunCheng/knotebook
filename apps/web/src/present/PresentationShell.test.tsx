import { useEffect, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, type InitialEntry } from "react-router";
import i18n from "@/i18n";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { enterPresentationFullscreen } from "./fullscreen";
import { isPresentingSearch } from "./present-url";
import { PresentationErrorBoundary, PresentationShell, usePresentationShell, type PresentationShellContextValue, type PresentationShellStatus } from "./PresentationShell";

const nav = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-router")>();
  return {
    ...mod,
    useNavigate: () => {
      const real = mod.useNavigate();
      return ((...args: Parameters<typeof real>) => {
        nav.fn(...args);
        return real(...args);
      }) as typeof real;
    },
  };
});

const probe = vi.hoisted(() => ({ ctx: null as PresentationShellContextValue | null, alsoListen: false }));

/** Child-tree stand-in: reads the context; with `alsoListen` it also listens to Esc itself (simulates reveal's keyboard[27] and the shell listener firing in the same tick). */
function Child() {
  const ctx = usePresentationShell();
  useEffect(() => {
    probe.ctx = ctx;
    if (!probe.alsoListen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") ctx.onEsc();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ctx]);
  return <div data-testid="shell-child" />;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}${location.hash}|${JSON.stringify(location.state ?? null)}`}</div>;
}

function Page({ status, errorMessage, title }: { status: PresentationShellStatus; errorMessage?: string; title: string }) {
  const location = useLocation();
  if (!isPresentingSearch(location.search)) return <div>note page</div>;
  return (
    <PresentationShell title={title} status={status} errorMessage={errorMessage}>
      <Child />
    </PresentationShell>
  );
}

function renderShell(
  entries: InitialEntry[],
  { status = "ready", errorMessage, title = "My Note" }: { status?: PresentationShellStatus; errorMessage?: string; title?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <LocationProbe />
      <Routes>
        <Route path="/n/:handle/:slug" element={<Page status={status} errorMessage={errorMessage} title={title} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const loc = () => screen.getByTestId("loc").textContent;
const pressEsc = () => fireEvent.keyDown(document, { key: "Escape" });

describe("PresentationShell", () => {
  let fake: FakeFullscreen | null = null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    nav.fn.mockClear();
    probe.ctx = null;
    probe.alsoListen = false;
    window.history.replaceState(null, "", "/n/tester/my-note?present");
  });

  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    vi.useRealTimers();
  });

  it("Esc before ready with no flag -> replaces away the present flag and hash", async () => {
    renderShell(["/n/tester/my-note?present#/x"]);
    pressEsc();
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note|null"));
    expect(nav.fn).toHaveBeenCalledTimes(1);
    expect(nav.fn).toHaveBeenCalledWith({ pathname: "/n/tester/my-note", search: "", hash: "" }, { replace: true });
  });

  it("with the entered flag -> navigate(-1), back to the entry before presenting", async () => {
    renderShell(["/n/tester/my-note", { pathname: "/n/tester/my-note", search: "?present", state: { knotebookPresentPushed: true } }]);
    pressEsc();
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note|null"));
    expect(nav.fn).toHaveBeenCalledWith(-1);
  });

  it("the shell listener and reveal's keyboard[27] both fire in the same tick -> navigate exactly once (leaving is idempotent)", async () => {
    probe.alsoListen = true;
    renderShell(["/n/tester/my-note?present"]);
    await waitFor(() => expect(probe.ctx).not.toBeNull());
    pressEsc();
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note|null"));
    expect(nav.fn).toHaveBeenCalledTimes(1);
  });

  it("after onRevealReady(true) the shell no longer listens to Esc; leaving goes through onEsc (reveal's keyboard[27]), exactly once", async () => {
    renderShell(["/n/tester/my-note?present"]);
    await waitFor(() => expect(probe.ctx).not.toBeNull());
    act(() => probe.ctx!.onRevealReady(true));
    pressEsc();
    expect(nav.fn).not.toHaveBeenCalled();
    act(() => probe.ctx!.onEsc());
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note|null"));
    expect(nav.fn).toHaveBeenCalledTimes(1);
  });

  it("close button clicked twice -> navigate exactly once", async () => {
    renderShell(["/n/tester/my-note?present"]);
    const close = screen.getByRole("button", { name: "Exit presentation" });
    fireEvent.click(close);
    fireEvent.click(close);
    await waitFor(() => expect(loc()).toBe("/n/tester/my-note|null"));
    expect(nav.fn).toHaveBeenCalledTimes(1);
  });

  it("while presenting, the document behind doesn't scroll (html overflow hidden); after leaving on the same page, original overflow and scroll position are restored", () => {
    const root = document.documentElement;
    root.style.overflow = "clip";
    let y = 640;
    vi.stubGlobal("scrollY", y);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(((_x: number, top: number) => {
      y = top;
    }) as typeof window.scrollTo);
    try {
      const view = renderShell(["/n/tester/my-note?present"]);
      expect(root.style.overflow).toBe("hidden");
      // The position moved during presentation (e.g. the browser scrolled itself): scroll back on leaving
      vi.stubGlobal("scrollY", 0);
      view.unmount();
      expect(root.style.overflow).toBe("clip");
      expect(scrollTo).toHaveBeenCalledWith(0, 640);
      expect(y).toBe(640);
    } finally {
      root.style.removeProperty("overflow");
      scrollTo.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("when leaving after the route changed (note deleted, link dead, back to a list): only releases the lock and doesn't scroll; that page owns the position", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.stubGlobal("scrollY", 640);
    try {
      const view = renderShell(["/n/tester/my-note?present"]);
      vi.stubGlobal("scrollY", 0);
      window.history.replaceState(null, "", "/");
      view.unmount();
      expect(document.documentElement.style.overflow).toBe("");
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      scrollTo.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("the lock is released before the next screen's layout effect (which restores the list position and mustn't be overwritten)", () => {
    let seen: string | null = null;
    function Next() {
      useLayoutEffect(() => {
        seen = document.documentElement.style.overflow;
      }, []);
      return <div>list</div>;
    }
    function Swap({ presenting }: { presenting: boolean }) {
      return presenting ? (
        <PresentationShell title="My Note" status="ready">
          <Child />
        </PresentationShell>
      ) : (
        <Next />
      );
    }
    const tree = (presenting: boolean) => (
      <MemoryRouter initialEntries={["/n/tester/my-note?present"]}>
        <Swap presenting={presenting} />
      </MemoryRouter>
    );
    const view = render(tree(true));
    expect(document.documentElement.style.overflow).toBe("hidden");
    view.rerender(tree(false));
    expect(seen).toBe("");
  });

  it("content area and toolbar both avoid the notch and home indicator (class assertions, jsdom has no env)", () => {
    renderShell(["/n/tester/my-note?present"]);
    const content = screen.getByTestId("shell-child").parentElement!;
    const toolbar = screen.getByRole("button", { name: "Exit presentation" }).parentElement!;
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(content.className).toContain(`env(safe-area-inset-${side})`);
    }
    expect(toolbar.className).toContain("env(safe-area-inset-top)");
    expect(toolbar.className).toContain("env(safe-area-inset-right)");
  });

  it("Esc in fullscreen doesn't leave; ignored for 300 ms after exiting; leaves after that", async () => {
    fake = installFakeFullscreen();
    renderShell(["/n/tester/my-note?present"]);
    enterPresentationFullscreen();
    await fake.grantEventFirst();
    pressEsc();
    expect(nav.fn).not.toHaveBeenCalled();
    await fake.userExit(); // The browser consumes the first Esc to exit fullscreen
    fake.advance(299);
    pressEsc();
    expect(nav.fn).not.toHaveBeenCalled();
    fake.advance(2);
    pressEsc();
    await waitFor(() => expect(nav.fn).toHaveBeenCalledTimes(1));
  });

  it("close button in fullscreen: exits the fullscreen we requested and leaves (exitFullscreen before navigate)", async () => {
    fake = installFakeFullscreen();
    renderShell(["/n/tester/my-note?present"]);
    enterPresentationFullscreen();
    await fake.grantEventFirst();
    fireEvent.click(screen.getByRole("button", { name: "Exit presentation" }));
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(nav.fn).toHaveBeenCalledTimes(1);
    expect(fake.exitFullscreen.mock.invocationCallOrder[0]).toBeLessThan(nav.fn.mock.invocationCallOrder[0]);
  });

  it("onFatal -> shows t(messageKey), subtree unmounted; then one Esc -> navigate exactly once", async () => {
    renderShell(["/n/tester/my-note?present"]);
    await waitFor(() => expect(probe.ctx).not.toBeNull());
    act(() => probe.ctx!.onFatal("present.configRefused"));
    expect(screen.getByRole("alert")).toHaveTextContent("Presentation settings were unexpected, so playback stopped");
    expect(screen.queryByTestId("shell-child")).toBeNull();
    pressEsc();
    await waitFor(() => expect(nav.fn).toHaveBeenCalledTimes(1));
  });

  it("status=loading -> app.loading, no subtree, close button present; status=error -> errorMessage, close button present", () => {
    const { unmount } = renderShell(["/n/tester/my-note?present"], { status: "loading" });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByTestId("shell-child")).toBeNull();
    expect(screen.getByRole("button", { name: "Exit presentation" })).toBeInTheDocument();
    unmount();
    renderShell(["/n/tester/my-note?present"], { status: "error", errorMessage: "Boom" });
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
    expect(screen.getByRole("button", { name: "Exit presentation" })).toBeInTheDocument();
  });

  it("after mount focus is on the dialog root; accessible name = present.dialogLabel (an empty title uses note.titlePlaceholder)", () => {
    const { unmount } = renderShell(["/n/tester/my-note?present"]);
    const dialog = screen.getByRole("dialog", { name: "My Note — presentation" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(dialog);
    unmount();
    renderShell(["/n/tester/my-note?present"], { title: "  " });
    expect(screen.getByRole("dialog", { name: "Untitled — presentation" })).toBeInTheDocument();
  });

  it("normalization: ?present&hash=true#/x -> ?present#/x, state kept as is", async () => {
    renderShell([{ pathname: "/n/tester/my-note", search: "?present&hash=true", hash: "#/x", state: { knotebookPresentPushed: true } }]);
    await waitFor(() => expect(loc()).toBe('/n/tester/my-note?present#/x|{"knotebookPresentPushed":true}'));
    expect(nav.fn).toHaveBeenCalledWith(
      { pathname: "/n/tester/my-note", search: "?present", hash: "#/x" },
      { replace: true, state: { knotebookPresentPushed: true } },
    );
  });

  it("fullscreen button: not rendered when fullscreenEnabled is false", () => {
    fake = installFakeFullscreen({ enabled: false });
    renderShell(["/n/tester/my-note?present"]);
    expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
  });

  it("fullscreen button: mousedown doesn't steal focus, after a click focus returns to the root; icon and label follow the fullscreen state", async () => {
    fake = installFakeFullscreen();
    renderShell(["/n/tester/my-note?present"]);
    const button = screen.getByRole("button", { name: "Full screen" });
    expect(fireEvent.mouseDown(button)).toBe(false); // defaultPrevented
    button.focus(); // Keyboard path: Tab to the button then Enter (jsdom's click doesn't move focus, so focus manually first to be able to observe focus returning to the root)
    fireEvent.click(button);
    expect(fake.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    await act(async () => fake!.grantEventFirst());
    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("toggleFullscreen: fullscreenEnabled false -> no request (F does nothing)", async () => {
    fake = installFakeFullscreen({ enabled: false });
    renderShell(["/n/tester/my-note?present"]);
    await waitFor(() => expect(probe.ctx).not.toBeNull());
    act(() => probe.ctx!.toggleFullscreen());
    expect(fake.requestFullscreen).not.toHaveBeenCalled();
  });

  it("unmount call site: unmounting while the URL still contains present doesn't exit fullscreen; without it, it does", async () => {
    fake = installFakeFullscreen();
    const first = renderShell(["/n/tester/my-note?present"]);
    enterPresentationFullscreen();
    await fake.grantEventFirst();
    first.unmount(); // window.location is still ?present (set in beforeEach)
    expect(fake.exitFullscreen).not.toHaveBeenCalled();
    renderShell(["/n/tester/my-note?present"]).unmount();
    expect(fake.exitFullscreen).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/n/tester/my-note");
    renderShell(["/n/tester/my-note?present"]).unmount();
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("toolbar fades after 2 s idle, mouse movement brings it back", () => {
    vi.useFakeTimers();
    renderShell(["/n/tester/my-note?present"]);
    const toolbar = screen.getByRole("button", { name: "Exit presentation" }).parentElement!;
    // Compare via classList (className always contains hover:opacity-100 / focus-within:opacity-100, so toContain would be an empty assertion)
    expect(toolbar.classList.contains("opacity-100")).toBe(true);
    act(() => vi.advanceTimersByTime(2000));
    expect(toolbar.classList.contains("opacity-0")).toBe(true);
    fireEvent.mouseMove(screen.getByRole("dialog"));
    expect(toolbar.classList.contains("opacity-100")).toBe(true);
    expect(toolbar.classList.contains("opacity-0")).toBe(false);
  });
});

describe("PresentationErrorBoundary (error boundary for presentations on public pages)", () => {
  function Boom(): never {
    throw new Error("failed to fetch dynamically imported module: /assets/PresentationOverlay-x.js");
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    // React prints errors caught by the boundary to console.error; swallow them as PublicNoteShell.test.tsx does so the test output stays clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children unchanged when healthy", () => {
    render(
      <PresentationErrorBoundary reload={vi.fn()}>
        <p>deck-content</p>
      </PresentationErrorBoundary>,
    );
    expect(screen.getByText("deck-content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("child throw -> role=alert plus the public.loadError text; clicking retry -> the injected reload exactly once", () => {
    const reload = vi.fn();
    render(
      <PresentationErrorBoundary reload={reload}>
        <Boom />
      </PresentationErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load this page — check your connection and try again.");
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("offline: retry button disabled plus the offline note, clicking doesn't call reload (an offline reload only lands on the browser error page)", () => {
    const reload = vi.fn();
    // Same technique as ErrorBoundary.test.tsx / PublicNoteShell.test.tsx: defineProperty shadows with an own instance property,
    // restoreAllMocks can't undo it, so delete it here (falls back to the prototype getter).
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    try {
      render(
        <PresentationErrorBoundary reload={reload}>
          <Boom />
        </PresentationErrorBoundary>,
      );
      const retry = screen.getByRole("button", { name: "Try again" });
      expect(retry).toBeDisabled();
      expect(
        screen.getByText("You appear to be offline — this button will re-enable when the connection returns."),
      ).toBeInTheDocument();
      fireEvent.click(retry);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      delete (window.navigator as unknown as Record<string, unknown>).onLine;
    }
  });
});
