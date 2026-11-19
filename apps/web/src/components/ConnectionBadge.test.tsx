import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { CollabState } from "@/collab/connection";
import i18n from "@/i18n";
import { ConnectionBadge, OFFLINE_WARN_MS } from "./ConnectionBadge";

function renderBadge(state: CollabState, synced: boolean, canEdit = true) {
  return render(<ConnectionBadge state={state} synced={synced} canEdit={canEdit} />);
}

describe("ConnectionBadge (issue #48: offline visibility)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("OFFLINE_WARN_MS is a few-seconds threshold (CHANGELOG/docs publicly promise 'a few seconds')", () => {
    // The other tests advance timers by OFFLINE_WARN_MS itself, which is self-referential: changing it to 60_000 would stay green.
    // This pins the user-facing "a few seconds" contract as a literal.
    expect(OFFLINE_WARN_MS).toBeGreaterThanOrEqual(1_000);
    expect(OFFLINE_WARN_MS).toBeLessThanOrEqual(5_000);
  });

  it("connected + synced: shows Connected and doesn't escalate over time", () => {
    renderBadge({ phase: "connected", role: "owner" }, true);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS * 2));
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("a brief connecting phase (under the threshold) doesn't flash a warning, only shows Connecting", () => {
    renderBadge({ phase: "connecting" }, false);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS - 100));
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(screen.queryByText(/offline|Not loaded/i)).not.toBeInTheDocument();
  });

  it("connected but not synced (server slow or stuck loading) -> escalates past the threshold too, doesn't stay on connected", () => {
    // The reverse shape of #48: onAuthenticated enters connected but synced needs one more round trip.
    // Looking at phase alone this case would never escalate, leaving the user on "connected" with a blank read-only note.
    renderBadge({ phase: "connected", role: "owner" }, false);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Not loaded — offline")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("never synced + offline past the threshold -> escalates to the not-loaded warning", () => {
    renderBadge({ phase: "connecting" }, false);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Not loaded — offline")).toBeInTheDocument();
    // The warning color signal now lives on the status dot (the phase text itself is uncolored, see the ConnectionBadge.tsx header):
    // assert the dot (the `aria-hidden` node under `role=status`) has `bg-destructive`, not the default grey.
    const dot = screen.getByRole("status").querySelector('[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain("bg-destructive");
  });

  it("previously synced + offline past the threshold -> escalates to editing offline (editable, just not synced back yet)", () => {
    renderBadge({ phase: "reconnecting-once" }, true);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Editing offline — changes not synced yet")).toBeInTheDocument();
  });

  it("returning to connected after escalation -> the warning is withdrawn immediately (no waiting for the threshold)", () => {
    const { rerender } = renderBadge({ phase: "connecting" }, true);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Editing offline — changes not synced yet")).toBeInTheDocument();

    rerender(<ConnectionBadge state={{ phase: "connected", role: "owner" }} synced={true} canEdit={true} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  });

  it("after escalation and return to connected, going offline again restarts the timing from zero (reset guard)", () => {
    const { rerender } = renderBadge({ phase: "connecting" }, true);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Editing offline — changes not synced yet")).toBeInTheDocument();

    rerender(<ConnectionBadge state={{ phase: "connected", role: "owner" }} synced={true} canEdit={true} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();

    // Offline again: before the threshold the warning must not reappear at once (else the timer wasn't restarted).
    rerender(<ConnectionBadge state={{ phase: "reconnecting-once" }} synced={true} canEdit={true} />);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS - 100));
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByText("Editing offline — changes not synced yet")).toBeInTheDocument();
  });

  it("viewer disconnected after syncing -> neutral Offline, not editing offline (a viewer can't edit and has no changes)", () => {
    // Telling a viewer "changes not synced yet" would be false. The offline phases carry no role, so the caller passes canEdit.
    renderBadge({ phase: "reconnecting-once" }, true, false);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.queryByText(/Editing offline/)).not.toBeInTheDocument();
  });

  it("editable role disconnected after syncing -> editing offline (contrast with the viewer case)", () => {
    renderBadge({ phase: "reconnecting-once" }, true, true);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByText("Editing offline — changes not synced yet")).toBeInTheDocument();
  });

  it("terminal state (kicked) isn't offline and schedules no escalation timer: keeps the revoked style", () => {
    renderBadge({ phase: "kicked" }, true);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS * 2));
    expect(screen.getByText("Access revoked")).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  });

  it.each(["owner", "editor"] as const)("#335 connected + synced %s: the whole badge reads only Connected, no role, no read-only", (role) => {
    renderBadge({ phase: "connected", role }, true);
    expect(screen.getByRole("status")).toHaveTextContent(/^Connected$/);
    expect(screen.queryByText(/Owner|Editor|Viewer|Read-only/)).not.toBeInTheDocument();
  });

  it("#335 connected + synced viewer: the whole badge reads only Read-only, not Connected or Viewer, the dot is still green", () => {
    renderBadge({ phase: "connected", role: "viewer" }, true, false);
    expect(screen.getByRole("status")).toHaveTextContent(/^Read-only$/);
    expect(screen.queryByText(/Connected|Viewer/)).not.toBeInTheDocument();
    const dot = screen.getByRole("status").querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(dot.className).not.toContain("bg-destructive");
    expect(dot.style.backgroundColor).toBe("oklch(0.8 0.17 152)");
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS * 2));
    expect(screen.getByRole("status")).toHaveTextContent(/^Read-only$/);
  });

  it("#335 viewer disconnect warning unchanged: offline -> Offline (red dot), no Read-only", () => {
    renderBadge({ phase: "reconnecting-once" }, true, false);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByRole("status")).toHaveTextContent(/^Offline$/);
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });

  it("#335 viewer connected but not synced: shows Read-only directly; past the threshold escalates to not loaded", () => {
    renderBadge({ phase: "connected", role: "viewer" }, false, false);
    expect(screen.getByRole("status")).toHaveTextContent(/^Read-only$/);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    expect(screen.getByRole("status")).toHaveTextContent(/^Not loaded — offline$/);
  });

  it("#335 other texts unchanged: connecting, reconnecting, kicked, deleted, outdated", () => {
    const cases: Array<[CollabState, string]> = [
      [{ phase: "connecting" }, "Connecting…"],
      [{ phase: "reconnecting-once" }, "Reconnecting…"],
      [{ phase: "kicked" }, "Access revoked"],
      [{ phase: "deleted" }, "Note deleted"],
      [{ phase: "outdated" }, "Reload required"],
    ];
    for (const [state, text] of cases) {
      const { unmount } = renderBadge(state, true);
      expect(screen.getByRole("status")).toHaveTextContent(new RegExp(`^${text}$`));
      unmount();
    }
  });

  it("#115: the text span is sr-only on phone width or when the header is under 36rem (only the dot remains, aria-live still announces it); the viewer's Read-only too", () => {
    // sr-only rather than hidden: the container is role=status aria-live=polite, and display:none would stop screen readers on narrow
    // windows from getting revoke/downgrade/offline notices.
    const owner = renderBadge({ phase: "connected", role: "owner" }, true);
    expect(screen.getByText("Connected")).toHaveClass("max-sm:sr-only", "@max-[36rem]:sr-only");
    expect(screen.getByText("Connected").className).not.toContain("hidden");
    owner.unmount();
    renderBadge({ phase: "connected", role: "viewer" }, true, false);
    expect(screen.getByText("Read-only")).toHaveClass("max-sm:sr-only", "@max-[36rem]:sr-only");
    expect(screen.getByText("Read-only").className).not.toContain("hidden");
  });

  it("the long offline text and the normal text are the same span with the same shrink classes; the container is still aria-live", () => {
    renderBadge({ phase: "reconnecting-once" }, true);
    act(() => vi.advanceTimersByTime(OFFLINE_WARN_MS));
    const long = screen.getByText("Editing offline — changes not synced yet");
    expect(long.tagName).toBe("SPAN");
    expect(long).toHaveClass("max-sm:sr-only", "@max-[36rem]:sr-only");
    expect(long.className).not.toContain("hidden");
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toContainElement(long);
  });

  it("#269 outdated: neutral Reload required, no escalation to the offline warning even past the threshold", () => {
    vi.useFakeTimers();
    renderBadge({ phase: "outdated" }, true);
    act(() => {
      vi.advanceTimersByTime(OFFLINE_WARN_MS + 1_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Reload required");
    expect(screen.getByRole("status")).not.toHaveTextContent("Editing offline");
    vi.useRealTimers();
  });
});
