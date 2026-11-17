import { beforeEach, describe, expect, it, vi } from "vitest";

const scrollToBlock = vi.fn();
vi.mock("@/hooks/useBlockAnchor", () => ({ scrollToBlock: (...a: unknown[]) => scrollToBlock(...a) }));

import { jumpToHeading, revealCollapsedAncestors } from "./outline-jump";

let clicks: string[];

/** A block shaped like BlockNote's: outer > .bn-block > (content row) + group of child blocks. */
function block(id: string, opts: { toggle?: "true" | "false"; wrapped?: boolean; children?: HTMLElement[] } = {}): HTMLElement {
  const outer = document.createElement("div");
  outer.className = "bn-block-outer";
  outer.dataset.id = id;
  const inner = document.createElement("div");
  inner.className = "bn-block";
  const content = document.createElement("div");
  content.className = "bn-block-content";
  const mid = document.createElement("div");
  if (opts.toggle) {
    const wrap = document.createElement("div");
    wrap.className = "bn-toggle-wrapper";
    wrap.dataset.showChildren = opts.toggle;
    const btn = document.createElement("button");
    btn.className = "bn-toggle-button";
    btn.addEventListener("click", () => {
      clicks.push(id);
      wrap.dataset.showChildren = "true";
    });
    wrap.appendChild(btn);
    mid.appendChild(wrap);
  }
  content.appendChild(mid);
  if (opts.wrapped) {
    const rr = document.createElement("div");
    rr.className = "react-renderer";
    rr.appendChild(content);
    inner.appendChild(rr);
  } else {
    inner.appendChild(content);
  }
  if (opts.children) {
    const group = document.createElement("div");
    group.className = "bn-block-group";
    opts.children.forEach((c) => group.appendChild(c));
    inner.appendChild(group);
  }
  outer.appendChild(inner);
  return outer;
}

function rootOf(...blocks: HTMLElement[]): HTMLElement {
  const root = document.createElement("div");
  blocks.forEach((b) => root.appendChild(b));
  return root;
}

beforeEach(() => {
  clicks = [];
  scrollToBlock.mockReset();
});

describe("revealCollapsedAncestors", () => {
  it("opens nested collapsed toggles outermost first", () => {
    const root = rootOf(block("a", { toggle: "false", children: [block("b", { toggle: "false", children: [block("t")] })] }));
    expect(revealCollapsedAncestors(root, "t")).toBe(2);
    expect(clicks).toEqual(["a", "b"]);
  });

  it("skips open ancestors, leaves the target's own toggle, and finds wrapped rows", () => {
    const root = rootOf(
      block("a", { toggle: "true", children: [block("b", { toggle: "false", wrapped: true, children: [block("t", { toggle: "false" })] })] }),
    );
    expect(revealCollapsedAncestors(root, "t")).toBe(1);
    expect(clicks).toEqual(["b"]);
  });

  it("does nothing when the target is missing", () => {
    const root = rootOf(block("a", { toggle: "false" }));
    expect(revealCollapsedAncestors(root, "zzz")).toBe(0);
    expect(clicks).toEqual([]);
  });
});

describe("jumpToHeading", () => {
  it("scrolls after opening, with exactly (root, id), and returns the cancel", () => {
    const root = rootOf(block("a", { toggle: "false", children: [block("b", { toggle: "false", children: [block("t")] })] }));
    const cancel = vi.fn();
    scrollToBlock.mockImplementation(() => {
      clicks.push("scroll");
      return cancel;
    });
    const result = jumpToHeading(root, "t");
    expect(scrollToBlock).toHaveBeenCalledTimes(1);
    expect(scrollToBlock.mock.calls[0]).toEqual([root, "t"]);
    expect(clicks).toEqual(["a", "b", "scroll"]);
    expect(result).toBe(cancel);
  });
});
