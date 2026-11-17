import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineHeading } from "./headings";
import { OutlineSheet } from "./OutlineSheet";

const headings: OutlineHeading[] = [
  { id: "h-intro", level: 1, text: "Intro" },
  { id: "h-install", level: 2, text: "Install" },
  { id: "h-usage", level: 2, text: "Usage" },
  { id: "h-api", level: 1, text: "API" },
  { id: "h-faq", level: 2, text: "FAQ" },
];

let rafs: FrameRequestCallback[] = [];
// Radix reports the close-autofocus event from a zero-delay timer after the content unmounts.
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
const runRaf = () =>
  act(() => {
    const run = rafs;
    rafs = [];
    run.forEach((cb) => cb(0));
  });
const flushRaf = async () => {
  await settle();
  runRaf();
};

beforeEach(() => {
  rafs = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafs.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

function setup(over: Partial<React.ComponentProps<typeof OutlineSheet>> = {}) {
  const calls: string[] = [];
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    headings,
    activeId: "h-install",
    onJump: vi.fn((id: string) => void calls.push(`jump:${id}`)),
    restoreFocus: vi.fn(() => void calls.push("restore")),
    ...over,
  };
  const view = render(<OutlineSheet {...props} />);
  return { props, calls, view };
}

describe("OutlineSheet", () => {
  it("shows the title and every heading, with the current section marked and focused", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Heading outline" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-outline-item]")).toHaveLength(5);
    const current = document.querySelector('[aria-current="location"]');
    expect(current).toHaveTextContent("Install");
    expect(document.activeElement).toBe(current);
  });

  it("closes when a heading is tapped, without jumping yet", () => {
    const { props } = setup();
    fireEvent.click(screen.getByText("Usage"));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onJump).not.toHaveBeenCalled();
  });

  it("restores focus first, then jumps once on the next frame after closing", async () => {
    const { props, calls, view } = setup();
    fireEvent.click(screen.getByText("Usage"));
    view.rerender(<OutlineSheet {...props} open={false} />);
    await settle();
    expect(calls).toEqual(["restore"]);
    expect(props.onJump).not.toHaveBeenCalled();
    runRaf();
    expect(calls).toEqual(["restore", "jump:h-usage"]);
    expect(props.onJump).toHaveBeenCalledTimes(1);
    await flushRaf();
    expect(props.onJump).toHaveBeenCalledTimes(1);
  });

  it("does not jump on Escape", async () => {
    const { props, view } = setup();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    view.rerender(<OutlineSheet {...props} open={false} />);
    await flushRaf();
    expect(props.onJump).not.toHaveBeenCalled();
    expect(props.restoreFocus).not.toHaveBeenCalled();
  });

  it("jumps without a custom restoreFocus and leaves focus return to Radix", async () => {
    const { props, view } = setup({ restoreFocus: undefined });
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    fireEvent.click(screen.getByText("Usage"));
    view.rerender(<OutlineSheet {...props} restoreFocus={undefined} open={false} />);
    await flushRaf();
    expect(props.onJump).toHaveBeenCalledWith("h-usage");
    opener.remove();
  });

  it("does not jump on a later close after an earlier pick", async () => {
    const { props, view } = setup();
    fireEvent.click(screen.getByText("Usage"));
    view.rerender(<OutlineSheet {...props} open={false} />);
    await flushRaf();
    view.rerender(<OutlineSheet {...props} open />);
    view.rerender(<OutlineSheet {...props} open={false} />);
    await flushRaf();
    expect(props.onJump).toHaveBeenCalledTimes(1);
  });
});
