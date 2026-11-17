import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OutlineHeading } from "./headings";
import { OutlineList } from "./OutlineList";

const headings: OutlineHeading[] = [
  { id: "a", level: 1, text: "Alice" },
  { id: "b", level: 2, text: "Bob" },
  { id: "c", level: 3, text: "" },
  { id: "d", level: 1, text: "A very long heading that would wrap past two lines in a narrow panel" },
];

const item = (id: string) => document.querySelector<HTMLButtonElement>(`[data-outline-item="${id}"]`)!;

describe("OutlineList", () => {
  it("lists the headings in order with their text", () => {
    render(<OutlineList headings={headings} activeId="a" onSelect={() => {}} />);
    const ids = [...document.querySelectorAll("[data-outline-item]")].map((e) => (e as HTMLElement).dataset.outlineItem);
    expect(ids).toEqual(["a", "b", "c", "d"]);
    expect(item("a")).toHaveTextContent("Alice");
    expect(item("b")).toHaveTextContent("Bob");
  });

  it("indents by level", () => {
    render(<OutlineList headings={headings} activeId="a" onSelect={() => {}} />);
    expect(item("a")).toHaveClass("pl-2");
    expect(item("b")).toHaveClass("pl-5");
    expect(item("c")).toHaveClass("pl-8");
  });

  it("shows a placeholder for an empty heading", () => {
    render(<OutlineList headings={headings} activeId="a" onSelect={() => {}} />);
    expect(item("c")).toHaveTextContent("(Untitled heading)");
  });

  it("marks only the current section with aria-current=location", () => {
    render(<OutlineList headings={headings} activeId="b" onSelect={() => {}} />);
    const current = document.querySelectorAll('[aria-current="location"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toBe(item("b"));
  });

  it("puts the full text in title", () => {
    render(<OutlineList headings={headings} activeId="a" onSelect={() => {}} />);
    expect(item("d")).toHaveAttribute("title", headings[3]!.text);
  });

  it("moves focus with arrow keys, stops at the ends and moves the tab stop", () => {
    render(<OutlineList headings={headings} activeId="b" onSelect={() => {}} />);
    expect(item("b")).toHaveAttribute("tabindex", "0");
    expect(item("a")).toHaveAttribute("tabindex", "-1");
    item("b").focus();
    fireEvent.keyDown(item("b"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("c"));
    expect(item("c")).toHaveAttribute("tabindex", "0");
    expect(item("b")).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(item("c"), { key: "ArrowDown" });
    fireEvent.keyDown(item("d"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("d"));
    fireEvent.keyDown(item("d"), { key: "ArrowUp" });
    fireEvent.keyDown(item("c"), { key: "ArrowUp" });
    fireEvent.keyDown(item("b"), { key: "ArrowUp" });
    fireEvent.keyDown(item("a"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(item("a"));
  });

  it("returns the tab stop to the current section when it changes while focus is outside", () => {
    const view = render(<OutlineList headings={headings} activeId="b" onSelect={() => {}} />);
    item("b").focus();
    fireEvent.keyDown(item("b"), { key: "ArrowDown" });
    expect(item("c")).toHaveAttribute("tabindex", "0");
    (document.activeElement as HTMLElement).blur();
    view.rerender(<OutlineList headings={headings} activeId="d" onSelect={() => {}} />);
    expect(item("d")).toHaveAttribute("tabindex", "0");
    expect(item("c")).toHaveAttribute("tabindex", "-1");
  });

  it("makes the first entry the tab stop when nothing is current", () => {
    render(<OutlineList headings={headings} activeId={null} onSelect={() => {}} />);
    expect(item("a")).toHaveAttribute("tabindex", "0");
    expect(item("b")).toHaveAttribute("tabindex", "-1");
  });

  it("calls onSelect once with the id on click", () => {
    const onSelect = vi.fn();
    render(<OutlineList headings={headings} activeId="a" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Bob"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("focuses the current section on mount when asked", () => {
    render(<OutlineList headings={headings} activeId="b" onSelect={() => {}} focusActiveOnMount />);
    expect(document.activeElement).toBe(item("b"));
  });

  it("does not take focus on mount by default", () => {
    render(<OutlineList headings={headings} activeId="b" onSelect={() => {}} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("scrolls the current section into view on mount and when it changes", () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    const view = render(<OutlineList headings={headings} activeId="b" onSelect={() => {}} />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.contexts[0]).toBe(item("b"));
    expect(spy).toHaveBeenLastCalledWith({ block: "nearest" });
    view.rerender(<OutlineList headings={headings} activeId="d" onSelect={() => {}} />);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.contexts[1]).toBe(item("d"));
    // @ts-expect-error restore the jsdom default (no implementation)
    delete Element.prototype.scrollIntoView;
  });
});
