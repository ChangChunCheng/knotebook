import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { BrowserRouter, useLocation, useNavigate } from "react-router";
import { canonicalizedFrom, useHistoryLocation, useHistoryLocationKey, withCanonicalizedFrom } from "./real-location";

// #179: NotePage's convergence effect uses `useHistoryLocationKey` to tell whether a navigation is in flight. It reads
// `UNSAFE_NavigationContext.navigator.location`, whose existence the types do not guarantee. The real app uses BrowserRouter,
// so this pins under BrowserRouter that it is readable and is the key of the current history entry: if a react-router upgrade
// changes the navigator's shape this turns red, instead of the guard silently degrading into "cannot tell, replace as usual".

let readKey: (() => string | undefined) | undefined;
let go: ((to: string) => void) | undefined;

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  readKey = useHistoryLocationKey();
  go = (to) => void navigate(to);
  return <div data-testid="rendered-key">{location.key}</div>;
}

describe("useHistoryLocationKey (BrowserRouter)", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    readKey = undefined;
    go = undefined;
  });

  it("returns the key of the current history entry, equal to the rendered location.key; changes after navigation", async () => {
    window.history.replaceState(null, "", "/start");
    render(
      <BrowserRouter>
        <Probe />
      </BrowserRouter>,
    );

    const first = readKey?.();
    expect(typeof first).toBe("string");
    expect(first).toBe(screen.getByTestId("rendered-key").textContent);

    await act(async () => {
      go?.("/next");
    });
    const second = readKey?.();
    expect(typeof second).toBe("string");
    expect(second).not.toBe(first);
    expect(second).toBe(screen.getByTestId("rendered-key").textContent);
  });

  it("useHistoryLocation: pathname, state and action of the same entry (used by NotePage to judge the gap while switching notes)", async () => {
    window.history.replaceState(null, "", "/start");
    let readLocation: ReturnType<typeof useHistoryLocation> | undefined;
    let goWithState: ((to: string, state: unknown, replace?: boolean) => void) | undefined;
    function LocationProbe() {
      const navigate = useNavigate();
      readLocation = useHistoryLocation();
      goWithState = (to, state, replace) => void navigate(to, { state, replace });
      return null;
    }
    render(
      <BrowserRouter>
        <LocationProbe />
      </BrowserRouter>,
    );

    expect(readLocation?.()?.pathname).toBe("/start");
    await act(async () => {
      goWithState?.("/next", withCanonicalizedFrom(null, "/start"));
    });
    expect(readLocation?.()?.pathname).toBe("/next");
    expect(canonicalizedFrom(readLocation?.()?.state)).toBe("/start");
    expect(readLocation?.()?.action).toBe("PUSH");

    await act(async () => {
      goWithState?.("/renamed", withCanonicalizedFrom(null, "/next"), true);
    });
    expect(readLocation?.()?.action).toBe("REPLACE");
  });
});

describe("canonicalizedFrom marker", () => {
  it("keeps the existing state's keys and adds the source pathname; a non-object state starts from an empty object", () => {
    expect(withCanonicalizedFrom({ openEdits: false }, "/notes/x")).toEqual({
      openEdits: false,
      knotebookCanonicalizedFrom: "/notes/x",
    });
    expect(canonicalizedFrom(withCanonicalizedFrom(null, "/n/a/b"))).toBe("/n/a/b");
    expect(canonicalizedFrom(null)).toBeUndefined();
    expect(canonicalizedFrom({ other: 1 })).toBeUndefined();
  });
});
