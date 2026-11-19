import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { PublicNoteErrorBoundary, PublicNoteFallback, PublicPageFrame } from "./PublicNoteShell";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PublicNoteFallback (#72: dedicated fallback while the /p/ chunk loads)", () => {
  it("minimal loading card: loading text present, **no** AppShell (the sidebar's New note and search must not be exposed to anonymous visitors)", () => {
    render(<PublicNoteFallback />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("New note")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});

describe("PublicPageFrame (#229: inert prop)", () => {
  it("with inert the root div has the inert attribute; without it, it doesn't", () => {
    const { container, rerender } = render(<PublicPageFrame inert>x</PublicPageFrame>);
    expect(container.firstElementChild).toHaveAttribute("inert");
    rerender(<PublicPageFrame>x</PublicPageFrame>);
    expect(container.firstElementChild).not.toHaveAttribute("inert");
  });
});

describe("PublicNoteErrorBoundary (#72: chunk/render error boundary for /p/)", () => {
  function Boom(): never {
    throw new Error("failed to fetch dynamically imported module: /assets/PublicNotePage-x.js");
  }

  it("renders children unchanged when nothing fails", () => {
    render(
      <PublicNoteErrorBoundary reload={vi.fn()}>
        <p>public-content</p>
      </PublicNoteErrorBoundary>,
    );
    expect(screen.getByText("public-content")).toBeInTheDocument();
  });

  it("child throws -> error card (role=alert + load-failure text + retry button); does **not** auto-reload (public pages have no flag allowance mechanism, manual retry is the only exit)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(
      <PublicNoteErrorBoundary reload={reload}>
        <Boom />
      </PublicNoteErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load this page — check your connection and try again.")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    // The error card must not wrap AppShell either (same as the fallback: anonymous visitors get no sidebar).
    expect(screen.queryByText("New note")).not.toBeInTheDocument();
  });

  it("pressing retry -> one full page reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(
      <PublicNoteErrorBoundary reload={reload}>
        <Boom />
      </PublicNoteErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("offline: retry button disabled + offline explanation shown (an offline reload only lands on the browser error page; same as the existing behaviour of the two ErrorBoundary error screens)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Same technique as ErrorBoundary.test.tsx: defineProperty sets an instance own property that afterEach's restoreAllMocks can't manage,
    // so delete it here (falls back to the prototype getter).
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    try {
      render(
        <PublicNoteErrorBoundary reload={vi.fn()}>
          <Boom />
        </PublicNoteErrorBoundary>,
      );
      expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
      expect(
        screen.getByText("You appear to be offline — this button will re-enable when the connection returns."),
      ).toBeInTheDocument();
    } finally {
      delete (window.navigator as unknown as Record<string, unknown>).onLine;
    }
  });
});


describe("PublicPageFrame (full-bleed frame)", () => {
  it("frame layer fills the window (h-dvh + flex flex-col + overflow-hidden + bg-card), no card vocabulary", async () => {
    // Dynamic import: the named imports at the top of this file don't include PublicPageFrame, to avoid touching the older tests' import lines.
    const { PublicPageFrame } = await import("./PublicNoteShell");
    render(
      <PublicPageFrame>
        <p data-testid="probe">content</p>
      </PublicPageFrame>,
    );
    const probe = screen.getByTestId("probe");
    // Assert only **the frame's own layer** (the probe's direct parent): the page content legitimately carries a border-b divider and rounded badges, so a chain scan would misfire;
    // the card-vocabulary ban applies only to the frame.
    const frame = probe.parentElement!;
    // The height/scroll chain needs all four: flex + flex-col is the precondition of the body's `min-h-0 flex-1 overflow-y-auto`,
    // overflow-hidden is the pivot of "the page itself must not scroll as a whole" (same chain as AppShell), h-dvh fixes the root height.
    // Token comparison, not substring: `flex-col` contains "flex" (and `min-h-dvh` contains "h-dvh"), so a substring check lets degenerate forms through.
    // The background is bg-card (a fifth load-bearing item): BlockNote's editor paints --color-card globally (index.css); with the darker bg-background on the frame,
    // the article-width card-colored strip floats above the page bottom and still looks like a content card. The whole page in the same card color is what makes it "full-bleed in one color".
    const tokens = frame.className.split(/\s+/);
    for (const cls of ["h-dvh", "flex", "flex-col", "overflow-hidden", "bg-card"]) {
      expect(tokens).toContain(cls);
    }
    // Card face withdrawn: no max-w cap, no rounded corners, no border (full-bleed, not a centered card).
    expect(frame.className).not.toMatch(/max-w-|rounded|border/);
    // The full-bleed frame avoids the notch and Home indicator on all four sides.
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(frame.className).toContain(`env(safe-area-inset-${side})`);
    }
    // The frame wraps children directly (no card layer in between).
    expect(frame.parentElement?.className ?? "").toBe(""); // RTL container
  });
});
