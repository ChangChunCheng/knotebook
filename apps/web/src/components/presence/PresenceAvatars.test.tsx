import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import i18n from "@/i18n";
import type { CursorScroller } from "@/collab/cursor-scroll";
import { LONG_PRESS_MS } from "@/lib/long-press";
import { PresenceAvatars, type PresenceAvatarsProps } from "./PresenceAvatars";
import { agentState, fakeProvider, removeRemote, setRemote, userState } from "./test-awareness";

// #293: the header avatar row. The host is mounted like NotePage's `<header className="@container ...">`.

let frames: FrameRequestCallback[] = [];
const awarenesses: Awareness[] = [];

function newAwareness(): Awareness {
  const a = new Awareness(new Y.Doc());
  awarenesses.push(a);
  return a;
}

function pushFrame() {
  act(() => {
    frames.splice(0).forEach((f) => f(0));
  });
}

const cur = (tag: string) => ({ anchor: { tag }, head: { tag } });

function Host(props: PresenceAvatarsProps) {
  return (
    <header className="@container flex items-center gap-3">
      <PresenceAvatars {...props} />
    </header>
  );
}

function mount(aw: Awareness, overrides: Partial<PresenceAvatarsProps> = {}) {
  const scroller = vi.fn<(cursor: unknown) => boolean>(() => true);
  const scrollerRef: { current: CursorScroller | null } = { current: scroller };
  const props: PresenceAvatarsProps = { provider: fakeProvider(aw), connected: true, myUserId: "u-me", scrollerRef, ...overrides };
  const r = render(<Host {...props} />);
  return { ...r, scroller, scrollerRef, rerenderWith: (o: Partial<PresenceAvatarsProps>) => r.rerender(<Host {...props} {...o} />) };
}

/** Sorted by key lexicographically on first paint: agent:15, u-a, u-b, u-c, u-d, u-e. */
function six(aw: Awareness) {
  setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
  setRemote(aw, 11, userState("u-b", "Bob"));
  setRemote(aw, 12, userState("u-c", "Cid", { cursor: cur("c") }));
  setRemote(aw, 13, userState("u-d", "Dee"));
  setRemote(aw, 14, userState("u-e", "Eve", { role: "viewer" }));
  setRemote(aw, 15, agentState("w", "claude", { cursor: cur("w") }));
}

function group(): HTMLElement {
  return screen.getByRole("group", { name: "Also viewing this note" });
}

/** Avatar buttons (excluding +N). */
function personButtons(): HTMLElement[] {
  return within(group())
    .getAllByRole("button")
    .filter((b) => !b.hasAttribute("aria-haspopup"));
}

/** Errors thrown inside React/Radix event handlers do not propagate through `fireEvent` (jsdom reports them to the window error event), so `not.toThrow` cannot catch them; they are collected here. */
function collectErrors(): { errors: unknown[]; stop: () => void } {
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    errors.push(e.error);
    e.preventDefault();
  };
  window.addEventListener("error", onError);
  return { errors, stop: () => window.removeEventListener("error", onError) };
}

beforeEach(async () => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  awarenesses.splice(0).forEach((a) => a.destroy());
});

describe("PresenceAvatars", () => {
  it("names and no announcement; only me or not connected: nothing renders", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann"));
    const { container, unmount } = mount(aw);
    const g = group();
    for (let el: HTMLElement | null = g; el && el !== container.parentElement; el = el.parentElement) {
      expect(el).not.toHaveAttribute("aria-live");
      expect(el.getAttribute("role")).not.toBe("status");
      expect(el.getAttribute("role")).not.toBe("log");
    }
    unmount();

    const mine = newAwareness();
    setRemote(mine, 10, userState("u-me", "Me"));
    const onlyMe = mount(mine);
    expect(onlyMe.container.querySelector('[role="group"]')).toBeNull();
    expect(onlyMe.container.querySelector("header")!.childElementCount).toBe(0);
    onlyMe.unmount();

    const off = mount(aw, { connected: false });
    expect(off.container.querySelector('[role="group"]')).toBeNull();
  });

  it("accessible name: four person forms (with/without role, with/without cursor), an empty name falls back to ?", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
    setRemote(aw, 11, userState("u-b", "Ann B"));
    setRemote(aw, 12, userState("u-c", "Old C", { field: false, cursor: cur("c") }));
    setRemote(aw, 13, userState("u-d", "Old D", { field: false }));
    setRemote(aw, 14, userState("u-e", "", { role: "viewer" }));
    mount(aw);
    expect(screen.getByRole("button", { name: "Ann, Editor, go to their cursor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ann B, Editor, no cursor right now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Old C, go to their cursor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Old D, no cursor right now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "?, Viewer, no cursor right now" })).toBeInTheDocument();
  });

  it("accessible name: the two AI forms", () => {
    const aw = newAwareness();
    setRemote(aw, 20, agentState("w", "claude", { cursor: cur("w") }));
    setRemote(aw, 21, agentState("x", "bot"));
    mount(aw);
    expect(screen.getByRole("button", { name: "w (claude), AI agent, go to its cursor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "x (bot), AI agent, no cursor right now" })).toBeInTheDocument();
  });

  it("accessible name: a name of only invisible characters (zero-width space, RLO) also falls back to ?", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", String.fromCharCode(0x200b), { role: "viewer" }));
    setRemote(aw, 11, userState("u-b", String.fromCharCode(0x202e, 0x200e), { role: "viewer", cursor: cur("b") }));
    mount(aw);
    expect(screen.getByRole("button", { name: "?, Viewer, no cursor right now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "?, Viewer, go to their cursor" })).toBeInTheDocument();
  });

  it("accessible name: zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "王小明", { role: "viewer" }));
    render(
      <Host provider={fakeProvider(aw)} connected myUserId="u-me" scrollerRef={{ current: null }} />,
    );
    expect(screen.getByRole("group", { name: "目前也在這篇的人" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "王小明，檢視者，目前沒有游標位置" })).toBeInTheDocument();
  });

  it("tooltip: opens on both focus and hover; the button has no aria-describedby", async () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
    mount(aw);
    const btn = screen.getByRole("button", { name: "Ann, Editor, go to their cursor" });
    act(() => {
      btn.focus();
    });
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Ann · Editor");
    expect(tip).toHaveTextContent("Click to go to their cursor");
    expect(btn).not.toHaveAttribute("aria-describedby");
    expect(btn).toHaveAccessibleDescription("");
    act(() => {
      btn.blur();
    });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    fireEvent.pointerMove(btn, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Ann · Editor");
  });

  it("tooltip: the second line for AI and for no cursor", async () => {
    const aw = newAwareness();
    setRemote(aw, 20, agentState("w", "claude", { cursor: cur("w") }));
    setRemote(aw, 11, userState("u-b", "Bob"));
    mount(aw);
    const ai = screen.getByRole("button", { name: "w (claude), AI agent, go to its cursor" });
    act(() => {
      ai.focus();
    });
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("w (claude) · AI agent");
    expect(tip).toHaveTextContent("Click to go to its cursor");
    const bob = screen.getByRole("button", { name: "Bob, Editor, no cursor right now" });
    act(() => {
      bob.focus();
    });
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Bob · Editor"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("No cursor right now");
  });

  it("click scrolling: reads the live cursor; no cursor means no call; a null scroller does not throw", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a1") }));
    setRemote(aw, 11, userState("u-b", "Bob"));
    const { scroller, scrollerRef } = mount(aw);
    const fresh = cur("a2");
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: fresh })); // no frame pushed: no re-render
    fireEvent.click(screen.getByRole("button", { name: "Ann, Editor, go to their cursor" }));
    expect(scroller).toHaveBeenCalledTimes(1);
    expect(scroller.mock.calls[0]![0]).toBe(fresh);
    fireEvent.click(screen.getByRole("button", { name: "Bob, Editor, no cursor right now" }));
    expect(scroller).toHaveBeenCalledTimes(1);
    scrollerRef.current = null;
    const caught = collectErrors();
    fireEvent.click(screen.getByRole("button", { name: "Ann, Editor, go to their cursor" }));
    caught.stop();
    expect(caught.errors).toEqual([]);
  });

  it("clicking an avatar, pressing Enter on it and pointerdown all do not open the menu", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
    setRemote(aw, 11, userState("u-b", "Bob"));
    const { scroller } = mount(aw);
    const btn = screen.getByRole("button", { name: "Ann, Editor, go to their cursor" });
    fireEvent.click(btn);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(scroller).toHaveBeenCalledTimes(1);
    // The Enter keydown must not be preventDefault-ed (otherwise a native button is not turned into a click)
    expect(fireEvent.keyDown(btn, { key: "Enter" })).toBe(true);
    fireEvent.click(btn);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(scroller).toHaveBeenCalledTimes(2);
    expect(fireEvent.pointerDown(btn, { pointerType: "mouse", button: 0 })).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(group()).not.toHaveAttribute("aria-haspopup");
  });

  it("capacity and +N: 6 people give 4 avatars + wide +2 / narrow +5 / compact +6; stacking structure", () => {
    const aw = newAwareness();
    six(aw);
    mount(aw);
    const btns = personButtons();
    expect(btns).toHaveLength(4);
    // On phones (< 640) only the compact +N remains: every avatar carries max-sm:hidden; the one kept in the narrow form is not hidden at 640 and above
    expect(btns[0]).toHaveClass("max-sm:hidden");
    expect(btns[0]).not.toHaveClass("@max-[43.5rem]:hidden");
    for (const b of btns.slice(1)) expect(b).toHaveClass("max-sm:hidden", "@max-[43.5rem]:hidden");
    expect(screen.getAllByRole("button", { name: /more, show everyone/ })).toHaveLength(3);
    const wide = screen.getByRole("button", { name: "2 more, show everyone" });
    const narrow = screen.getByRole("button", { name: "5 more, show everyone" });
    const compact = screen.getByRole("button", { name: "6 more, show everyone" });
    expect(wide).toHaveClass("max-sm:hidden", "@max-[43.5rem]:hidden");
    for (const cls of ["sm:@min-[43.5rem]:hidden", "sm:hidden"]) expect(wide).not.toHaveClass(cls);
    expect(narrow).toHaveClass("max-sm:hidden", "sm:@min-[43.5rem]:hidden");
    for (const cls of ["@max-[43.5rem]:hidden", "sm:hidden"]) expect(narrow).not.toHaveClass(cls);
    expect(compact).toHaveClass("sm:hidden");
    for (const cls of ["max-sm:hidden", "@max-[43.5rem]:hidden", "sm:@min-[43.5rem]:hidden"]) expect(compact).not.toHaveClass(cls);
    for (const b of [wide, narrow, compact]) {
      expect(b).toHaveAttribute("aria-haspopup", "menu");
      expect(b).toHaveAttribute("aria-expanded", "false");
    }
    // The focused/hovered one rises to the top layer so the focus ring is not covered by the next one
    for (const b of [...btns, wide, narrow, compact]) expect(b).toHaveClass("focus-visible:z-10", "hover:z-10");
    const g = group();
    expect(g).toHaveClass("[&>button+button]:-ms-1.5");
    expect(g.className).not.toContain("space-x");
    const first = g.firstElementChild as HTMLElement;
    expect(first.tagName).toBe("SPAN");
    expect(first).toHaveAttribute("aria-hidden", "true");
    expect(first.tabIndex).toBe(-1);
    fireEvent.click(wide);
    expect(wide).toHaveAttribute("aria-expanded", "true");
  });

  it("#335 avatar size: every header avatar and +N is 24px, the hit area ::before is 32x32 by default and 36x44 on touch devices (x overhang <= the 6px stacking overlap, so it does not cover a neighbour's center); the phone compact +N is 32x28 visually with a 40x44 hit area", () => {
    const aw = newAwareness();
    six(aw);
    mount(aw);
    for (const b of personButtons()) {
      const circle = b.firstElementChild as HTMLElement;
      expect(circle.style.width).toBe("24px");
      expect(circle.style.height).toBe("24px");
      expect(b).toHaveClass("before:-inset-x-1", "before:-inset-y-1", "pointer-coarse:before:-inset-x-1.5", "pointer-coarse:before:-inset-y-2.5");
    }
    for (const name of ["2 more, show everyone", "5 more, show everyone"]) {
      const more = screen.getByRole("button", { name });
      expect(more).toHaveClass("h-6", "w-6");
      expect(more).not.toHaveClass("h-7");
      expect(more).toHaveClass("before:-inset-x-1", "before:-inset-y-1", "pointer-coarse:before:-inset-x-1.5", "pointer-coarse:before:-inset-y-2.5");
    }
    // The compact +N appears only at phone width with no neighbour before it to cover: visually 32x28 (h-7 w-8), ::before expands to 40x44
    const compact = screen.getByRole("button", { name: "6 more, show everyone" });
    expect(compact).toHaveClass("h-7", "w-8", "before:-inset-x-1", "before:-inset-y-2");
    for (const cls of ["h-6", "w-6"]) expect(compact).not.toHaveClass(cls);
    // At phone width a connection dot precedes it, so the negative stacking margin must be cleared; the hit area does not carry the avatar group's enlarging class
    expect(compact).toHaveClass("max-sm:ms-0!");
    expect(compact).not.toHaveClass("before:-inset-y-1");
    expect(compact.className).not.toMatch(/pointer-coarse:|max-sm:before:/);
  });

  it("capacity: 5 people give 5 avatars, narrow +4 and compact +5; 2 people give two avatars not hidden in either wide or narrow form, and only the compact +2", () => {
    const aw = newAwareness();
    for (const [i, id] of ["u-a", "u-b", "u-c", "u-d", "u-e"].entries()) setRemote(aw, 10 + i, userState(id, id));
    const five = mount(aw);
    const btns = personButtons();
    expect(btns).toHaveLength(5);
    expect(btns[0]).toHaveClass("max-sm:hidden");
    expect(btns[0]).not.toHaveClass("@max-[43.5rem]:hidden");
    for (const b of btns.slice(1)) expect(b).toHaveClass("max-sm:hidden", "@max-[43.5rem]:hidden");
    expect(screen.getByRole("button", { name: "4 more, show everyone" })).toHaveClass("sm:@min-[43.5rem]:hidden");
    expect(screen.getByRole("button", { name: "5 more, show everyone" })).toHaveClass("sm:hidden");
    expect(screen.queryAllByRole("button", { name: /more, show everyone/ })).toHaveLength(2);
    five.unmount();

    const two = newAwareness();
    setRemote(two, 10, userState("u-a", "Ann"));
    setRemote(two, 11, userState("u-b", "Bob"));
    mount(two);
    for (const b of personButtons()) {
      expect(b).toHaveClass("max-sm:hidden");
      expect(b).not.toHaveClass("@max-[43.5rem]:hidden");
    }
    const chips = screen.getAllByRole("button", { name: /more, show everyone/ });
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveAccessibleName("2 more, show everyone");
    expect(chips[0]).toHaveClass("sm:hidden");
  });

  it("compact +N: one person gives +1; nobody else renders nothing", () => {
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", "Ann"));
    const one = mount(aw);
    expect(screen.getByRole("button", { name: "1 more, show everyone" })).toHaveClass("sm:hidden");
    one.unmount();

    const none = newAwareness();
    mount(none);
    expect(screen.queryAllByRole("button", { name: /more, show everyone/ })).toHaveLength(0);
  });

  it("compact +N: clicking opens the full list; after Esc, if the avatar that opened it is hidden, focus falls back to the first visible avatar", async () => {
    const aw = newAwareness();
    six(aw);
    mount(aw);
    const compact = screen.getByRole("button", { name: "6 more, show everyone" });
    expect(compact).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(compact);
    expect(compact).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "People on this note (6)" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(6);
    // Simulates >= 640px: the compact +N is display:none, the others are visible.
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) =>
      el === compact ? ({ display: "none" } as CSSStyleDeclaration) : real(el, pseudo),
    );
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const target = personButtons()[0]!;
    await waitFor(() => expect(target).toHaveFocus());
    expect(compact).not.toHaveFocus();
  });

  it("full list: name, 6 rows in the same order, rows with no cursor are aria-disabled, choosing a row scrolls and closes; Esc returns focus to +N", async () => {
    const aw = newAwareness();
    six(aw);
    const { scroller } = mount(aw);
    const more = screen.getByRole("button", { name: "2 more, show everyone" });
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "People on this note (6)" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.getAttribute("data-person-key"))).toEqual([
      "agent:15",
      "user:u-a",
      "user:u-b",
      "user:u-c",
      "user:u-d",
      "user:u-e",
    ]);
    for (const i of [2, 4, 5]) {
      expect(items[i]).toHaveAttribute("aria-disabled", "true");
      expect(items[i]).not.toHaveAttribute("data-disabled");
      expect(items[i]).toHaveTextContent("No cursor");
      // A role must be visible even without a cursor (touch has no tooltip, so the list is where it shows)
      expect(items[i]).toHaveTextContent(i === 5 ? "Viewer" : "Editor");
    }
    for (const i of [0, 1, 3]) expect(items[i]).not.toHaveTextContent("No cursor");
    for (const i of [0, 1, 3]) expect(items[i]).not.toHaveAttribute("aria-disabled");
    expect(items[1]).toHaveTextContent("Editor");
    expect(items[0]).toHaveTextContent("AI agent");
    // A space between the name and the small text on the right keeps the accessible name from running into one word
    expect(items[1]).toHaveAccessibleName("Ann Editor");
    expect(items[5]).toHaveAccessibleName("Eve Viewer No cursor");
    // The row avatar's separator ring uses the menu background
    expect((items[1]!.querySelector('[aria-hidden="true"]') as HTMLElement).style.boxShadow).toContain("var(--color-popover)");
    fireEvent.click(items[3]!);
    expect(scroller).toHaveBeenCalledTimes(1);
    expect(scroller.mock.calls[0]![0]).toEqual(cur("c"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await waitFor(() => expect(more).toHaveFocus());
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByRole("menu", { name: "People on this note (6)" }), { key: "Escape" });
    await waitFor(() => expect(more).toHaveFocus());
  });

  it("rows with no cursor are reachable with the arrow keys; selecting one does not scroll or throw and the menu stays open", async () => {
    const aw = newAwareness();
    six(aw);
    const { scroller } = mount(aw);
    fireEvent.click(screen.getByRole("button", { name: "2 more, show everyone" }));
    const menu = screen.getByRole("menu", { name: "People on this note (6)" });
    const items = within(menu).getAllByRole("menuitem");
    // items[2] is the first row with no cursor (Bob)
    items[1]!.focus();
    fireEvent.keyDown(items[1]!, { key: "ArrowDown" });
    await waitFor(() => expect(items[2]).toHaveFocus());
    expect(items[2]).toHaveAttribute("aria-disabled", "true");
    const caught = collectErrors();
    // The menu still being open is what really guards "selected but nothing happened" (with no cursor the scroller is never called anyway)
    for (const press of [
      () => fireEvent.keyDown(items[2]!, { key: "Enter" }),
      () => fireEvent.keyDown(items[2]!, { key: " " }),
      () => fireEvent.click(items[2]!),
    ]) {
      press();
      expect(screen.getByRole("menu", { name: "People on this note (6)" })).toBeInTheDocument();
    }
    caught.stop();
    expect(caught.errors).toEqual([]);
    fireEvent.click(items[3]!);
    expect(scroller).toHaveBeenCalledTimes(1);
  });

  it("an AI row with no cursor shows both AI agent and No cursor", () => {
    const aw = newAwareness();
    six(aw);
    setRemote(aw, 15, agentState("w", "claude"));
    mount(aw);
    fireEvent.click(screen.getByRole("button", { name: "2 more, show everyone" }));
    const item = within(screen.getByRole("menu")).getAllByRole("menuitem").find((i) => i.dataset.personKey === "agent:15")!;
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("AI agent");
    expect(item).toHaveTextContent("No cursor");
  });

  it("the menu lists everyone (including those already shown as avatars)", () => {
    const aw = newAwareness();
    six(aw);
    mount(aw);
    fireEvent.click(screen.getByRole("button", { name: "2 more, show everyone" }));
    const menu = screen.getByRole("menu", { name: "People on this note (6)" });
    for (const name of ["w (claude)", "Ann", "Bob", "Cid", "Dee", "Eve"]) {
      expect(within(menu).getByText(name)).toBeInTheDocument();
    }
  });

  it("list changes while the menu is open: rows shrink along, +N disappears; after Esc focus falls back to the first avatar", async () => {
    const aw = newAwareness();
    six(aw);
    mount(aw);
    fireEvent.click(screen.getByRole("button", { name: "2 more, show everyone" }));
    removeRemote(aw, 13);
    removeRemote(aw, 14);
    pushFrame();
    const menu = screen.getByRole("menu", { name: "People on this note (4)" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(4);
    expect(document.querySelector('[aria-label="2 more, show everyone"]')).toBeNull();
    const caught = collectErrors();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const first = screen.getByRole("button", { name: "w (claude), AI agent, go to its cursor" });
    await waitFor(() => expect(first).toHaveFocus());
    caught.stop();
    expect(caught.errors).toEqual([]);
  });

  it("disconnect makes them disappear; reconnect brings them back, and a menu that was open does not come back with them", async () => {
    const aw = newAwareness();
    six(aw);
    const { container, rerenderWith } = mount(aw);
    fireEvent.click(screen.getByRole("button", { name: "2 more, show everyone" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    rerenderWith({ connected: false });
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    rerenderWith({ connected: true });
    expect(group()).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a very long name + RLO: the name in the tooltip and the list row is isolated with <bdi> and truncated, the role text is outside the bdi", async () => {
    const RLO = String.fromCharCode(0x202e);
    const name = `Ann${RLO}${"x".repeat(300)}`;
    const aw = newAwareness();
    setRemote(aw, 10, userState("u-a", name, { cursor: cur("a") }));
    mount(aw);
    const btn = screen.getByRole("button", { name: `${name}, Editor, go to their cursor` });
    act(() => {
      btn.focus();
    });
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveClass("max-w-64");
    const tipName = tip.querySelector("bdi")!;
    expect(tipName).not.toBeNull();
    expect(tipName.textContent).toBe(name);
    expect(tipName).toHaveClass("truncate", "min-w-0");
    expect(tipName.parentElement).toHaveClass("flex", "min-w-0");
    expect(tipName.nextElementSibling).toHaveTextContent("· Editor");
    // Long press (the contextmenu path) opens the list
    fireEvent.pointerDown(btn, { pointerType: "touch", clientX: 0, clientY: 0 });
    fireEvent.contextMenu(btn);
    fireEvent.pointerUp(btn, { pointerType: "touch" });
    const row = within(screen.getByRole("menu")).getByRole("menuitem");
    const rowName = row.querySelector("bdi")!;
    expect(rowName).not.toBeNull();
    expect(rowName.textContent).toBe(name);
    expect(rowName).toHaveClass("truncate", "min-w-0");
    expect(rowName.nextElementSibling).toHaveTextContent("Editor");
    expect(rowName.textContent).not.toContain("Editor");
  });

  describe("long press (fake timers)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function two(aw: Awareness) {
      setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
      setRemote(aw, 11, userState("u-b", "Bob"));
    }

    /** Touch long press -> menu opens with focus on that row -> finger released -> the follow-up click does not scroll. */
    function longPress(btn: HTMLElement, key: string, scroller: ReturnType<typeof vi.fn>) {
      fireEvent.pointerDown(btn, { pointerType: "touch", clientX: 0, clientY: 0 });
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(document.activeElement).toBe(screen.getByRole("menu").querySelector(`[data-person-key="${key}"]`));
      fireEvent.pointerUp(btn, { pointerType: "touch" });
      fireEvent.click(btn);
      expect(scroller).not.toHaveBeenCalled();
    }

    function escape() {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      act(() => {
        vi.advanceTimersByTime(0);
      });
    }

    function pressAndEscape() {
      const aw = newAwareness();
      two(aw);
      const { scroller } = mount(aw);
      const ann = screen.getByRole("button", { name: "Ann, Editor, go to their cursor" });
      longPress(ann, "user:u-a", scroller);
      escape();
      expect(ann).toHaveFocus();
      expect(screen.queryByRole("tooltip")).toBeNull();
      return ann;
    }

    it("long press opens the menu with focus on that row and the click does not scroll; Esc returns focus to the avatar and the tooltip is suppressed; a key press lifts the suppression", () => {
      const ann = pressAndEscape();
      fireEvent.keyDown(ann, { key: "Shift" });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });

    it("blur lifts the suppression and leaves no tooltip; focusing again is a new focus", () => {
      const ann = pressAndEscape();
      act(() => {
        ann.blur();
      });
      expect(screen.queryByRole("tooltip")).toBeNull();
      act(() => {
        ann.focus();
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });

    it("pointerdown lifts the suppression and leaves no tooltip; hover opens it again", () => {
      const ann = pressAndEscape();
      fireEvent.pointerDown(ann, { pointerType: "mouse", button: 0 });
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.pointerUp(ann, { pointerType: "mouse" });
      fireEvent.pointerMove(ann, { pointerType: "mouse" });
      // While focused, Radix's onChange(true) has already cleared the provider's delay (a suppressed close does not call onChange(false)),
      // so this hover does not really wait 300 ms; advancing 300 ms is just to not depend on that detail.
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });

    it("long press on a person with no cursor: the aria-disabled row still gets focus; Esc returns focus to that avatar", () => {
      const aw = newAwareness();
      two(aw);
      const { scroller } = mount(aw);
      const bob = screen.getByRole("button", { name: "Bob, Editor, no cursor right now" });
      const caught = collectErrors();
      longPress(bob, "user:u-b", scroller);
      expect(document.activeElement).toHaveAttribute("aria-disabled", "true");
      escape();
      expect(bob).toHaveFocus();
      caught.stop();
      expect(caught.errors).toEqual([]);
    });

    it("the avatar that opened the menu gets hidden (display:none) while it is open: focus falls back to the first visible avatar and that avatar's tooltip is suppressed", () => {
      const aw = newAwareness();
      setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
      setRemote(aw, 11, userState("u-b", "Bob", { cursor: cur("b") }));
      const { scroller } = mount(aw);
      const ann = screen.getByRole("button", { name: "Ann, Editor, go to their cursor" });
      const bob = screen.getByRole("button", { name: "Bob, Editor, go to their cursor" });
      longPress(bob, "user:u-b", scroller);
      bob.style.display = "none"; // simulates `max-sm:hidden` taking effect after a wide/narrow switch
      escape();
      expect(ann).toHaveFocus();
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("the avatar that opened the menu leaves while it is open: focus falls back to the first avatar and that avatar's tooltip is suppressed", () => {
      const aw = newAwareness();
      setRemote(aw, 10, userState("u-a", "Ann", { cursor: cur("a") }));
      setRemote(aw, 11, userState("u-b", "Bob", { cursor: cur("b") }));
      const { scroller } = mount(aw);
      const ann = screen.getByRole("button", { name: "Ann, Editor, go to their cursor" });
      longPress(screen.getByRole("button", { name: "Bob, Editor, go to their cursor" }), "user:u-b", scroller);
      removeRemote(aw, 11);
      pushFrame();
      escape();
      expect(ann).toHaveFocus();
      expect(screen.queryByRole("tooltip")).toBeNull();
    });
  });
});
