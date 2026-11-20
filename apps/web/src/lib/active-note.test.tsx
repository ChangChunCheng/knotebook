import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActiveNoteProvider, useActiveNote } from "./active-note";

function Probe() {
  const { activeNoteId } = useActiveNote();
  return <div data-testid="probe">{activeNoteId ?? "none"}</div>;
}

/** Mirrors NotePage's wiring (set after load + conditional clear on unmount). This pins the context's clear semantics itself; NotePage's actual set behaviour is in NotePage.test. */
function Page({ id }: { id: string }) {
  const { setActiveNoteId, clearActiveNoteId } = useActiveNote();
  useEffect(() => {
    setActiveNoteId(id);
    return () => clearActiveNoteId(id);
  }, [id, setActiveNoteId, clearActiveNoteId]);
  return null;
}

describe("ActiveNoteContext", () => {
  it("page switch: the old page's cleanup runs first (same key, new id) -> the new id takes over; closing the page (full unmount) -> cleared", () => {
    const view = render(
      <ActiveNoteProvider>
        <Probe />
        <Page id="aaa" />
      </ActiveNoteProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("aaa");

    view.rerender(
      <ActiveNoteProvider>
        <Probe />
        <Page id="bbb" />
      </ActiveNoteProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("bbb");

    view.rerender(
      <ActiveNoteProvider>
        <Probe />
      </ActiveNoteProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("none");
  });

  it("conditional clear prevents a page-switch race: an old page unmounting after the new page's set must not turn off the highlight", () => {
    // A then B coexist (B's set runs later -> active=B), then A is removed: at A's cleanup `current` is already B, and an
    // unconditional clear would turn off the just-lit B (the reason clearActiveNoteId exists).
    const view = render(
      <ActiveNoteProvider>
        <Probe />
        <Page key="a" id="aaa" />
        <Page key="b" id="bbb" />
      </ActiveNoteProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("bbb");

    view.rerender(
      <ActiveNoteProvider>
        <Probe />
        <Page key="b" id="bbb" />
      </ActiveNoteProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("bbb");
  });

  it("used outside the provider -> fails loudly (a wiring error must not silently degrade into a highlight that never shows)", () => {
    expect(() => render(<Probe />)).toThrow(/ActiveNoteProvider/);
  });
});
