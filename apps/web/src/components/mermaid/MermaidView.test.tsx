import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { stubLayoutTier } from "@/test/layout-tier";
import { MediaZoomContext, type MediaZoomApi } from "@/components/media-zoom/context";

/**
 * Unit tests for `MermaidView`. `lib/mermaid` is mocked wholesale (mermaid itself does not run in jsdom).
 * What is verified here is the two-state switch, errors not being swallowed, viewer not editable and async races, not whether the diagram is drawn correctly.
 */

const renderMermaidMock = vi.hoisted(() => vi.fn());
const cachedMermaidMock = vi.hoisted(() => vi.fn());
const preloadMermaidMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/mermaid", () => ({
  renderMermaid: renderMermaidMock,
  cachedMermaid: cachedMermaidMock,
  preloadMermaid: preloadMermaidMock,
  nextMermaidId: () => "mermaid-test",
}));

const i18n = (await import("@/i18n")).default;
const { MERMAID_ROOT_MARGIN, MermaidView } = await import("./MermaidView");

const MOCK_SVG = "<svg data-testid='diagram' viewBox='0 0 300 200'></svg>";

beforeEach(async () => {
  await i18n.changeLanguage("en"); // assertions use English literals (repo convention, same as ConnectionBadge.test.tsx)
  renderMermaidMock.mockReset();
  renderMermaidMock.mockResolvedValue({ ok: true, svg: MOCK_SVG });
  cachedMermaidMock.mockReset();
  cachedMermaidMock.mockReturnValue(null);
  preloadMermaidMock.mockReset();
});

/** Manually triggered fake IntersectionObserver (jsdom lacks this API). */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();
  readonly takeRecords = () => [];
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  fire(isIntersecting: boolean): void {
    act(() => {
      this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    });
  }
}

/** The current (last created) observer. */
function observer(): FakeIntersectionObserver {
  const last = FakeIntersectionObserver.instances.at(-1);
  if (last === undefined) throw new Error("沒有建立 IntersectionObserver");
  return last;
}

/** Lets the effects and promises queued as microtasks/macrotasks all finish. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("MermaidView - render state", () => {
  it("draws the svg mermaid returns", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
  });

  it("the outermost element carries the feature-tour target attribute (the tour highlights the flow chart in a note)", async () => {
    const { container } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(container.firstElementChild).toHaveAttribute("data-kb-tour-target", "flowchart");
  });

  it("empty source shows a hint, not an error", async () => {
    renderMermaidMock.mockResolvedValue({ ok: false, message: "" });
    render(<MermaidView code="" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Click to add diagram source")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a syntax error shows both the error message and the source (otherwise the user cannot edit it back)", async () => {
    renderMermaidMock.mockResolvedValue({ ok: false, message: "Parse error on line 2" });
    render(<MermaidView code="not a diagram" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Parse error on line 2"));
    expect(screen.getByText("not a diagram")).toBeInTheDocument();
  });

  it("re-renders when the theme changes", async () => {
    const { rerender } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(1));
    rerender(<MermaidView code="graph TD; A-->B;" editable theme="dark" onChange={vi.fn()} />);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenLastCalledWith("graph TD; A-->B;", "dark", expect.anything()));
  });

  it("renderMermaid rejecting unexpectedly (not a cancellation): turns into the error state, not stuck on the placeholder forever", async () => {
    renderMermaidMock.mockRejectedValue(new Error("unexpected boom"));
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unexpected boom"));
    expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();
    expect(screen.getByText("graph TD; A-->B;")).toBeInTheDocument();
  });

  it("async race: an old render result must not overwrite a new one", async () => {
    // code changes from A to B but A's render resolves later - the view must stay on B.
    let resolveSlow!: (v: unknown) => void;
    renderMermaidMock.mockImplementationOnce(() => new Promise((r) => (resolveSlow = r)));
    renderMermaidMock.mockResolvedValueOnce({ ok: true, svg: "<svg data-testid='new'></svg>" });

    const { rerender } = render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    rerender(<MermaidView code="B" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("new")).toBeInTheDocument());

    // Do not use `waitFor(new)`: it passes on the first check and returns immediately, asserting before the old result's setState has flushed,
    // so removing the guard turns red only about half the time. Resolve inside act, then let microtasks/macrotasks finish before asserting.
    await act(async () => {
      resolveSlow({ ok: true, svg: "<svg data-testid='stale'></svg>" });
    });
    await settle();
    expect(screen.getByTestId("new")).toBeInTheDocument();
    expect(screen.queryByTestId("stale")).not.toBeInTheDocument();
  });
});

describe("MermaidView - loading placeholder (#344 D)", () => {
  it("before it is drawn a placeholder of fixed minimum height shows \"rendering\", not a blank area", async () => {
    renderMermaidMock.mockImplementation(() => new Promise(() => {})); // never finishes drawing
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    const placeholder = screen.getByText("Rendering diagram…");
    expect(placeholder.className.split(/\s+/)).toContain("min-h-40");
    expect(placeholder).toHaveAttribute("aria-busy", "true");
  });

  it("once drawn the placeholder disappears", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();
  });

  it("changing code while a diagram exists: the old diagram stays until the new one is ready (no fallback to the placeholder)", async () => {
    const { rerender } = render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());

    let resolveNext!: (v: unknown) => void;
    renderMermaidMock.mockImplementationOnce(() => new Promise((r) => (resolveNext = r)));
    rerender(<MermaidView code="B" editable theme="light" onChange={vi.fn()} />);
    await settle();
    expect(screen.getByTestId("diagram")).toBeInTheDocument();
    expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();

    resolveNext({ ok: true, svg: "<svg data-testid='next'></svg>" });
    await waitFor(() => expect(screen.getByTestId("next")).toBeInTheDocument());
  });

  it("empty source shows the hint directly, without flashing the placeholder or calling renderMermaid", () => {
    render(<MermaidView code="" editable theme="light" onChange={vi.fn()} />);
    expect(screen.getByText("Click to add diagram source")).toBeInTheDocument();
    expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();
    expect(renderMermaidMock).not.toHaveBeenCalled();
  });
});

describe("MermaidView - cache (#344 B)", () => {
  it("cache hit at mount: the diagram is there immediately (no placeholder flash, no new render request)", async () => {
    cachedMermaidMock.mockReturnValue("<svg data-testid='cached'></svg>");
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(screen.getByTestId("cached")).toBeInTheDocument(); // synchronous, no waitFor needed
    expect(cachedMermaidMock).toHaveBeenCalledWith("graph TD; A-->B;", "light");
    await settle();
    expect(renderMermaidMock).not.toHaveBeenCalled();
  });
});

describe("MermaidView - warm-up (#344 E)", () => {
  it("warms the mermaid chunk as soon as it mounts", () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(preloadMermaidMock).toHaveBeenCalled();
  });

  it("an empty block does not warm (a freshly created empty block is the normal case and should not pull in a whole bundle of dependencies)", () => {
    render(<MermaidView code="  " editable theme="light" onChange={vi.fn()} />);
    expect(preloadMermaidMock).not.toHaveBeenCalled();
  });
});

describe("MermaidView - drawing only diagrams near the viewport (#344 C)", () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(`observes the outer element, rootMargin is ${MERMAID_ROOT_MARGIN}`, () => {
    const { container } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(observer().observe).toHaveBeenCalledWith(container.firstElementChild);
    expect(observer().options?.rootMargin).toBe(MERMAID_ROOT_MARGIN);
  });

  it("root is the nearest scrollable ancestor (the note page scrolls an inner container; with the viewport as root rootMargin has no effect)", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const inner = document.createElement("div");
    scroller.append(inner);
    document.body.append(scroller);
    try {
      render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />, { container: inner });
      expect(observer().options?.root).toBe(scroller);
    } finally {
      scroller.remove();
    }
  });

  it("root is looked up again when crossing 640: from 640 the body container scrolls, on phones that layer does not scroll (the document does) so it becomes the viewport; going back switches to the container again", () => {
    const tier = stubLayoutTier("overlay");
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const inner = document.createElement("div");
    scroller.append(inner);
    document.body.append(scroller);
    try {
      render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />, { container: inner });
      expect(observer().options?.root).toBe(scroller);
      const first = observer();
      scroller.style.overflowY = "visible";
      act(() => tier.setLayoutTier("phone"));
      expect(first.disconnect).toHaveBeenCalled();
      expect(observer()).not.toBe(first);
      expect(observer().options?.root).toBeNull();
      scroller.style.overflowY = "auto";
      act(() => tier.setLayoutTier("overlay"));
      expect(observer().options?.root).toBe(scroller);
    } finally {
      scroller.remove();
    }
  });

  it("with no scrollable ancestor the root is the viewport (null)", () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(observer().options?.root).toBeNull();
  });

  it("far from the viewport it makes no render request (shows the placeholder); it requests once it comes near", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    observer().fire(false);
    await settle();
    expect(renderMermaidMock).not.toHaveBeenCalled();
    expect(screen.getByText("Rendering diagram…")).toBeInTheDocument();
    // warm-up does not wait for the viewport
    expect(preloadMermaidMock).toHaveBeenCalled();

    observer().fire(true);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(renderMermaidMock).toHaveBeenCalledTimes(1);
  });

  it("the placeholder pulses only near the viewport: distant ones run no animation (invisible, yet each frame would recompute styles)", async () => {
    renderMermaidMock.mockImplementation(() => new Promise(() => {})); // keeps queuing after coming near
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    observer().fire(false);
    expect(screen.getByText("Rendering diagram…")).not.toHaveClass("motion-safe:animate-pulse");
    observer().fire(true);
    expect(screen.getByText("Rendering diagram…")).toHaveClass("motion-safe:animate-pulse");
    observer().fire(false);
    expect(screen.getByText("Rendering diagram…")).not.toHaveClass("motion-safe:animate-pulse");
  });

  it("request cancelled before it rejects (AbortError): no change to the view and no error state", async () => {
    let rejectIt!: (e: unknown) => void;
    renderMermaidMock.mockImplementation(() => new Promise((_, reject) => (rejectIt = reject)));
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(1));
    observer().fire(false);
    rejectIt(new DOMException("aborted", "AbortError"));
    await settle();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Rendering diagram…")).toBeInTheDocument();
  });

  it("leaving the viewport before the request starts: that request is cancelled (signal aborted)", async () => {
    renderMermaidMock.mockImplementation(() => new Promise(() => {}));
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(1));
    const { signal } = renderMermaidMock.mock.calls[0]![2] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);

    observer().fire(false);
    expect(signal.aborted).toBe(true);
  });

  it("unmount cancels a request still queued", async () => {
    renderMermaidMock.mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(1));
    const { signal } = renderMermaidMock.mock.calls[0]![2] as { signal: AbortSignal };
    unmount();
    expect(signal.aborted).toBe(true);
    expect(observer().disconnect).toHaveBeenCalled();
  });

  it("once drawn, scrolling out and in does not redraw; if the source changed while out it redraws as usual", async () => {
    const { rerender } = render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    observer().fire(false);
    observer().fire(true);
    observer().fire(false);
    await settle();
    expect(renderMermaidMock).toHaveBeenCalledTimes(1);

    rerender(<MermaidView code="B" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(2));
    expect(renderMermaidMock).toHaveBeenLastCalledWith("B", "light", expect.anything());
  });

  it("only the theme changed while scrolled out: the old diagram stays and is redrawn with the new theme once near", async () => {
    const { rerender } = render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    observer().fire(false);

    rerender(<MermaidView code="A" editable theme="dark" onChange={vi.fn()} />);
    await settle();
    expect(renderMermaidMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("diagram")).toBeInTheDocument(); // the old-theme diagram is still there, no fallback to the placeholder

    observer().fire(true);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(2));
    expect(renderMermaidMock).toHaveBeenLastCalledWith("A", "dark", expect.anything());
  });

  it("a theme change while near redraws immediately as usual", async () => {
    const { rerender } = render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    rerender(<MermaidView code="A" editable theme="dark" onChange={vi.fn()} />);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenLastCalledWith("A", "dark", expect.anything()));
  });

  it("inside the editor the root search starts outside the editor: a column (overflow-x:auto => computed overflowY is also auto) is not a scroll root", () => {
    // In a real browser the computed overflowY of `.bn-block-column{overflow-x:auto}` is "auto" (CSS rule: when one axis is non-visible the other computes to auto);
    // jsdom does not do this conversion, so both axes are written as auto to simulate it.
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const editor = document.createElement("div");
    editor.className = "bn-editor";
    const column = document.createElement("div");
    column.className = "bn-block-column";
    column.style.overflowX = "auto";
    column.style.overflowY = "auto";
    const inner = document.createElement("div");
    column.append(inner);
    editor.append(column);
    scroller.append(editor);
    document.body.append(scroller);
    try {
      render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />, { container: inner });
      expect(observer().options?.root).toBe(scroller);
    } finally {
      scroller.remove();
    }
  });

  it("environments without IntersectionObserver (jsdom, old browsers) fall back to drawing as soon as mounted", async () => {
    vi.unstubAllGlobals();
    expect(typeof IntersectionObserver).toBe("undefined");
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
  });
});

/** Clicks into the edit state and returns the textarea. */
function openEditor(): HTMLTextAreaElement {
  fireEvent.click(screen.getByRole("button", { name: "Edit diagram source" }));
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("MermaidView - edit state", () => {
  it("a click switches to source editing", () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(openEditor()).toHaveValue("graph TD; A-->B;");
  });

  it("blur hands the new source out and returns to the diagram", async () => {
    const onChange = vi.fn();
    render(<MermaidView code="A" editable theme="light" onChange={onChange} />);
    const box = openEditor();
    fireEvent.change(box, { target: { value: "graph TD; X-->Y;" } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledWith("graph TD; X-->Y;");
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  });

  it("Esc also commits and returns to the diagram", async () => {
    const onChange = vi.fn();
    render(<MermaidView code="A" editable theme="light" onChange={onChange} />);
    const box = openEditor();
    fireEvent.change(box, { target: { value: "B" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onChange).toHaveBeenCalledWith("B");
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  });

  it("unchanged source does not call onChange (avoids a pointless Yjs update on a collaborative document)", () => {
    const onChange = vi.fn();
    render(<MermaidView code="A" editable theme="light" onChange={onChange} />);
    fireEvent.blur(openEditor());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Enter does not leave the edit state (a diagram's source is multi-line anyway)", () => {
    render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    const box = openEditor();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});

describe("MermaidView - viewer", () => {
  it("editable=false has no edit entry", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable={false} theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Edit diagram source" })).not.toBeInTheDocument();
  });

  it("editable=false still shows the source on a syntax error (otherwise a viewer would see only one error line)", async () => {
    renderMermaidMock.mockResolvedValue({ ok: false, message: "Parse error" });
    render(<MermaidView code="broken" editable={false} theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("broken")).toBeInTheDocument());
  });
});

describe("MermaidView - toolbar", () => {
  it("the diagram state offers an \"Edit\" button", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("pressing \"Edit\" enters the source state", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox")).toHaveValue("graph TD; A-->B;");
  });

  it("the source state can always be left (regression guard for a dead-end bug), and the screen tells the user how to get out", async () => {
    // The old design swapped the block for BlockNote's codeBlock and there was no way back - the first thing a user hit in hands-on use.
    // The way out need not be a button, but it must exist and be stated.
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByText("Press Esc or click elsewhere to finish")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
  });

  it("no second button while editing (the way out is Esc / clicking elsewhere, not a toggle button)", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("the toolbar button is not nested inside the click-the-diagram area (a nested button is invalid and a click would trigger both)", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    const toolbarButton = screen.getByRole("button", { name: "Edit" });
    const clickArea = screen.getByRole("button", { name: "Edit diagram source" });
    expect(clickArea.contains(toolbarButton)).toBe(false);
  });

  it("viewer sees the source with the same button (read-only), labelled \"show source\"", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable={false} theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
  });
});

// jsdom has no layout or tab order, so the style-bearing parts are guarded structurally by class strings
// (same technique as theme.scrollbar-guard.test.ts / theme.block-selection-guard.test.ts).

/** Positioning utility tokens in the element's class (order-insensitive, unaffected by comments). */
function positionalTokens(el: HTMLElement): string[] {
  return el.className
    .split(/\s+/)
    .filter((t) => /^-?(?:absolute|relative|fixed|sticky|inset|top|right|bottom|left)(?:-|$)/.test(t.replace(/^.*:/, "")));
}

describe("MermaidView - style-bearing parts", () => {
  it("the control group hides with opacity, not hidden (hidden removes it from the Tab order so keyboard users cannot reach it)", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());

    const group = screen.getByRole("button", { name: "Edit" }).parentElement as HTMLElement;
    expect(group.className).toContain("opacity-0");
    expect(group.className).toContain("group-hover:opacity-100");
    // Also shown when focus is inside the box (Tab onto the "click the diagram to edit" button) - same meaning as codeBlock showing when the caret is in the code.
    expect(group.className).toContain("group-focus-within:opacity-100");
    expect(group.className.split(/\s+/)).not.toContain("hidden");
  });

  it("the control group overlays the top-right inside the box: a direct child of the relative outer element carrying block-control-group; the buttons carry no positioning and there is no h-7 reserved row", async () => {
    const { container } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());

    const root = container.firstElementChild as HTMLElement;
    const button = screen.getByRole("button", { name: "Edit" });
    const group = button.parentElement as HTMLElement;
    expect(group.className).toContain("block-control-group");
    expect(group.parentElement, "組要直接掛在外層底下").toBe(root);
    expect(button.className).toContain("block-control");
    expect(positionalTokens(button)).toEqual([]);
    expect(root.className.split(/\s+/), "外層要 relative，控制組才疊得在方塊內").toContain("relative");
    expect(root.querySelector('[class*="h-7"]'), "不得再有 h-7 的保留列").toBeNull();
  });

  it("while editing: no control buttons, and the hint sits below the textarea (not over the source)", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const textarea = screen.getByRole("textbox");
    const hint = screen.getByText("Press Esc or click elsewhere to finish");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(textarea.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING, "提示要在 textarea 之後").toBeTruthy();
    expect(hint.className, "提示不得疊上去（absolute）").not.toMatch(/\babsolute\b/);
  });

  it("the outer element carries w-full (bn-block-content is a flex container; without a declared width the whole block would shrink-wrap to about 140px)", () => {
    const { container } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(container.firstElementChild!.className).toContain("w-full");
  });
});


describe("MermaidView - zoom view", () => {
  const open = vi.fn();
  const api: MediaZoomApi = { open, isOpen: false };

  beforeEach(() => open.mockReset());

  function renderZoom(editable: boolean, code = "graph TD; A-->B;") {
    return render(
      <MediaZoomContext.Provider value={api}>
        <MermaidView code={code} editable={editable} theme="light" onChange={vi.fn()} />
      </MediaZoomContext.Provider>,
    );
  }
  const drawn = () => waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
  /** The clickable region wrapping the diagram when read-only. */
  const area = () => screen.getByTestId("diagram").parentElement!.parentElement as HTMLElement;

  it("no Provider: no zoom button; when read-only the diagram container has no role or tabindex", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable={false} theme="light" onChange={vi.fn()} />);
    await drawn();
    expect(screen.queryByRole("button", { name: "Zoom in", hidden: true })).toBeNull();
    expect(area()).not.toHaveAttribute("role");
    expect(area()).not.toHaveAttribute("tabindex");
  });

  it("with a Provider: the group is a direct child of the outer element, in order \"Edit\" then \"Zoom in\", both carrying block-control and no positioning utility", async () => {
    const { container } = renderZoom(true);
    await drawn();
    const edit = screen.getByRole("button", { name: "Edit" });
    const zoomBtn = screen.getByRole("button", { name: "Zoom in" });
    const group = edit.parentElement as HTMLElement;
    expect(group.className).toContain("block-control-group");
    expect(group.parentElement).toBe(container.firstElementChild);
    expect(zoomBtn.parentElement).toBe(group);
    expect(edit.compareDocumentPosition(zoomBtn) & Node.DOCUMENT_POSITION_FOLLOWING, "放大鈕在編輯鈕之後（最右角）").toBeTruthy();
    for (const b of [edit, zoomBtn]) {
      expect(b.className).toContain("block-control");
      expect(positionalTokens(b)).toEqual([]);
    }
  });

  it("the group's show/hide: opacity-0, shown on hover/focus-within, a faint always-on form on touch, and no hidden", async () => {
    renderZoom(true);
    await drawn();
    const group = screen.getByRole("button", { name: "Edit" }).parentElement as HTMLElement;
    for (const token of ["opacity-0", "group-hover:opacity-100", "group-focus-within:opacity-100", "[@media(hover:none)]:opacity-60", "[@media(hover:none)]:group-focus-within:opacity-100"]) {
      expect(group.className.split(/\s+/)).toContain(token);
    }
    expect(group.className.split(/\s+/)).not.toContain("hidden");
  });

  it("clicking \"Zoom in\": open once with the same svg and viewBox size, origin.button is that button; does not enter editing", async () => {
    renderZoom(true);
    await drawn();
    const zoomBtn = screen.getByRole("button", { name: "Zoom in" });
    fireEvent.click(zoomBtn);
    expect(open).toHaveBeenCalledTimes(1);
    const [source, origin] = open.mock.calls[0]!;
    expect(source).toEqual({ kind: "svg", svg: MOCK_SVG, naturalWidth: 300, naturalHeight: 200 });
    expect(origin.button).toBe(zoomBtn);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("placeholder showing: no \"Zoom in\"", () => {
    renderMermaidMock.mockReturnValue(new Promise(() => {}));
    renderZoom(true);
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
  });

  it("syntax error: no \"Zoom in\"", async () => {
    renderMermaidMock.mockResolvedValue({ ok: false, message: "bad syntax" });
    renderZoom(true);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
  });

  it("empty source: no \"Zoom in\"", () => {
    renderZoom(true, "");
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
  });

  it("while editing: no \"Zoom in\"", async () => {
    renderZoom(true);
    await drawn();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
  });

  it("editable: clicking the diagram enters editing, no zoom", async () => {
    renderZoom(true);
    await drawn();
    fireEvent.click(screen.getByRole("button", { name: "Edit diagram source" }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it("read-only: the diagram container is a focusable button \"Zoom in on diagram\"; click, Enter and Space each open once, origin is { button: null, media: container }", async () => {
    renderZoom(false);
    await drawn();
    const el = area();
    expect(el).toHaveAttribute("role", "button");
    expect(el).toHaveAttribute("tabindex", "0");
    expect(el).toHaveAccessibleName("Zoom in on diagram");
    expect(el.className).toContain("cursor-zoom-in");

    fireEvent.click(el);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![1]).toEqual({ button: null, media: el });
    expect(open.mock.calls[0]![0]).toEqual({ kind: "svg", svg: MOCK_SVG, naturalWidth: 300, naturalHeight: 200 });

    fireEvent.keyDown(el, { key: "Enter" });
    expect(open).toHaveBeenCalledTimes(2);
    const notPrevented = fireEvent.keyDown(el, { key: " " });
    expect(open).toHaveBeenCalledTimes(3);
    expect(notPrevented, "Space 要 preventDefault 免得捲頁").toBe(false);
  });

  it("read-only: clicking a link inside the diagram does not open zoom (the link works as usual)", async () => {
    renderMermaidMock.mockResolvedValue({
      ok: true,
      svg: "<svg data-testid='diagram' viewBox='0 0 300 200'><a href='#x' data-testid='lnk'><text>x</text></a></svg>",
    });
    renderZoom(false);
    await drawn();
    fireEvent.click(screen.getByTestId("lnk"));
    expect(open).not.toHaveBeenCalled();
  });

  it("read-only: releasing after drag-selecting text inside the diagram does not open zoom", async () => {
    renderZoom(false);
    await drawn();
    const sel = { isCollapsed: false } as Selection;
    const spy = vi.spyOn(window, "getSelection").mockReturnValue(sel);
    fireEvent.click(area());
    expect(open).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("svg without viewBox/width/height: falls back to the getBoundingClientRect size", async () => {
    renderMermaidMock.mockResolvedValue({ ok: true, svg: "<svg data-testid='diagram'></svg>" });
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 120, height: 80 } as DOMRect);
    renderZoom(true);
    await drawn();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    spy.mockRestore();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatchObject({ kind: "svg", naturalWidth: 120, naturalHeight: 80 });
  });

  it("a measured size of 0: does not open zoom", async () => {
    renderMermaidMock.mockResolvedValue({ ok: true, svg: "<svg data-testid='diagram'></svg>" });
    renderZoom(true); // all getBoundingClientRect values in jsdom are 0
    await drawn();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(open).not.toHaveBeenCalled();
  });

  it("when read-only the zoom button carries [@media(hover:none)]:hidden (touch zooms by tapping the diagram) and the show-source button is not hidden; when editable the zoom button does not carry it", async () => {
    const ro = renderZoom(false);
    await drawn();
    const zoomBtn = screen.getByTitle("Zoom in");
    expect(zoomBtn.className).toContain("[@media(hover:none)]:hidden");
    // keyboard and screen readers use the diagram container; this button is left to the mouse.
    expect(zoomBtn).toHaveAttribute("tabindex", "-1");
    expect(zoomBtn).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "Show source" }).className).not.toContain("hidden");
    // A mouse click on this unfocusable button: origin.button is null, and after closing focus returns to the diagram container (the media is inside the container)
    fireEvent.click(zoomBtn);
    expect(open).toHaveBeenCalledTimes(1);
    const origin = open.mock.calls[0]![1] as { button: HTMLElement | null; media: Element };
    expect(origin.button).toBeNull();
    expect(area().contains(origin.media)).toBe(true);
    ro.unmount();
    renderZoom(true);
    await drawn();
    expect(screen.getByRole("button", { name: "Zoom in" }).className).not.toContain("hidden");
  });
});
