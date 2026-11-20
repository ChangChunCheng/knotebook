import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { __resetCollapseForTests, isCollapsed, setCollapsed, useCollapsed, useCollapseVersion, type SidebarSectionKey } from "./collapse";

// The overlay and subscribers are module-level, so state leaks across tests (especially when run out of order).
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  __resetCollapseForTests();
});

function Probe({ id, sectionKey = "group:g1" }: { id: string; sectionKey?: SidebarSectionKey }) {
  const [expanded, toggle] = useCollapsed(sectionKey);
  return (
    <button type="button" data-testid={id} onClick={toggle}>
      {expanded ? "expanded" : "collapsed"}
    </button>
  );
}

function throwQuota(): never {
  throw new DOMException("quota", "QuotaExceededError");
}

describe("collapse store", () => {
  it("nothing stored: isCollapsed is false and useCollapsed reports expanded", () => {
    render(<Probe id="a" />);
    expect(isCollapsed("group:g1")).toBe(false);
    expect(screen.getByTestId("a")).toHaveTextContent("expanded");
  });

  it("toggle writes \"1\"; toggling again removes the key", () => {
    render(<Probe id="a" />);
    fireEvent.click(screen.getByTestId("a"));
    expect(localStorage.getItem("sidebar.collapsed.group:g1")).toBe("1");
    expect(screen.getByTestId("a")).toHaveTextContent("collapsed");
    fireEvent.click(screen.getByTestId("a"));
    expect(localStorage.getItem("sidebar.collapsed.group:g1")).toBeNull();
    expect(screen.getByTestId("a")).toHaveTextContent("expanded");
  });

  it("two components on the same key: toggling the first updates the second within the same act", () => {
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    act(() => {
      screen.getByTestId("a").click();
    });
    expect(screen.getByTestId("a")).toHaveTextContent("collapsed");
    expect(screen.getByTestId("b")).toHaveTextContent("collapsed");
  });

  it("getItem, setItem and removeItem all throw: toggle does not throw, a later read sees collapsed; toggling again expands", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(throwQuota);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(throwQuota);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(throwQuota);
    render(<Probe id="a" />);
    expect(() => fireEvent.click(screen.getByTestId("a"))).not.toThrow();
    expect(isCollapsed("group:g1")).toBe(true);
    expect(screen.getByTestId("a")).toHaveTextContent("collapsed");
    fireEvent.click(screen.getByTestId("a")); // removeItem also throws, so the overlay records expanded
    expect(isCollapsed("group:g1")).toBe(false);
    expect(screen.getByTestId("a")).toHaveTextContent("expanded");
  });

  it("only setItem throws (getItem works, key absent): toggle collapses, toggling again expands", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(throwQuota);
    render(<Probe id="a" />);
    fireEvent.click(screen.getByTestId("a"));
    expect(localStorage.getItem("sidebar.collapsed.group:g1")).toBeNull();
    expect(isCollapsed("group:g1")).toBe(true);
    expect(screen.getByTestId("a")).toHaveTextContent("collapsed");
    fireEvent.click(screen.getByTestId("a"));
    expect(isCollapsed("group:g1")).toBe(false);
    expect(screen.getByTestId("a")).toHaveTextContent("expanded");
  });

  it("setItem failure recorded in the overlay then recovers: next toggle writes to localStorage and drops the overlay key (external changes are readable)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(throwQuota);
    render(<Probe id="a" />);
    fireEvent.click(screen.getByTestId("a")); // overlay: collapsed
    fireEvent.click(screen.getByTestId("a")); // removeItem succeeds: overlay key dropped, expanded
    setItem.mockRestore();
    fireEvent.click(screen.getByTestId("a")); // setItem succeeds: written, overlay key dropped
    expect(localStorage.getItem("sidebar.collapsed.group:g1")).toBe("1");
    expect(isCollapsed("group:g1")).toBe(true);
    localStorage.removeItem("sidebar.collapsed.group:g1");
    expect(isCollapsed("group:g1")).toBe(false);
  });

  it("folder key: setCollapsed(\"folder:a\", true) writes sidebar.collapsed.folder:a=\"1\" and does not affect group:a", () => {
    setCollapsed("folder:a", true);
    expect(localStorage.getItem("sidebar.collapsed.folder:a")).toBe("1");
    expect(isCollapsed("folder:a")).toBe(true);
    expect(isCollapsed("group:a")).toBe(false);
    setCollapsed("group:a", true);
    setCollapsed("folder:a", false);
    expect(localStorage.getItem("sidebar.collapsed.folder:a")).toBeNull();
    expect(isCollapsed("folder:a")).toBe(false);
    expect(isCollapsed("group:a")).toBe(true);
  });

  it("useCollapseVersion: toggling any key re-renders, components on other keys are unaffected", () => {
    let versionRenders = 0;
    let otherRenders = 0;
    function VersionProbe() {
      versionRenders += 1;
      return <span data-testid="version">{useCollapseVersion()}</span>;
    }
    function OtherProbe() {
      otherRenders += 1;
      const [expanded] = useCollapsed("group:g2");
      return <span>{expanded ? "open" : "closed"}</span>;
    }
    render(
      <>
        <Probe id="a" />
        <VersionProbe />
        <OtherProbe />
      </>,
    );
    const versionBefore = versionRenders;
    const otherBefore = otherRenders;
    const shown = Number(screen.getByTestId("version").textContent);
    fireEvent.click(screen.getByTestId("a"));
    expect(versionRenders).toBe(versionBefore + 1);
    expect(Number(screen.getByTestId("version").textContent)).toBeGreaterThan(shown);
    expect(otherRenders).toBe(otherBefore);
  });
});
