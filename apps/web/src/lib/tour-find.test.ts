import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { findUserMenuReturnTarget, tourLayout, useTourLayout } from "./tour-find";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the tour's three layouts", () => {
  it.each([
    ["docked", "wide"],
    ["overlay", "floating"],
    ["phone", "phone"],
  ] as const)("%s -> %s", (tier: LayoutTier, layout) => {
    stubLayoutTier(tier);
    expect(tourLayout()).toBe(layout);
  });

  it("without matchMedia, treated as a wide window", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(tourLayout()).toBe("wide");
  });

  it("redraws when crossing 640 or 1280", () => {
    const tier = stubLayoutTier("docked");
    function Probe() {
      return createElement("p", null, useTourLayout());
    }
    render(createElement(Probe));
    expect(screen.getByText("wide")).toBeInTheDocument();
    act(() => tier.setLayoutTier("overlay"));
    expect(screen.getByText("floating")).toBeInTheDocument();
    act(() => tier.setLayoutTier("phone"));
    expect(screen.getByText("phone")).toBeInTheDocument();
    act(() => tier.setLayoutTier("overlay"));
    expect(screen.getByText("floating")).toBeInTheDocument();
    act(() => tier.setLayoutTier("docked"));
    expect(screen.getByText("wide")).toBeInTheDocument();
  });
});

describe("user menu trigger to focus after the tour ends", () => {
  function mount() {
    document.body.innerHTML = `
      <button data-kb-tour-target="drawerButton">Open sidebar</button>
      <aside><button data-kb-tour-target="userMenu">Ann</button></aside>
    `;
    return {
      account: document.querySelector('[data-kb-tour-target="userMenu"]'),
      hamburger: document.querySelector('[data-kb-tour-target="drawerButton"]'),
    };
  }

  it("wide window: the account row in the sidebar", () => {
    stubLayoutTier("docked");
    const { account } = mount();
    expect(findUserMenuReturnTarget()).toBe(account);
  });

  it("floating sidebar: the sidebar button that opens the drawer (the user menu is inside the closed drawer)", () => {
    stubLayoutTier("overlay");
    const { hamburger } = mount();
    expect(findUserMenuReturnTarget()).toBe(hamburger);
  });

  it("phone: the avatar in the list's top bar; not found on the note screen (the list is not interactive)", () => {
    stubLayoutTier("phone");
    document.body.innerHTML = `<aside><button data-kb-tour-target="userMenu">Ann</button></aside>`;
    const avatar = document.querySelector("aside button");
    expect(findUserMenuReturnTarget()).toBe(avatar);
    document.querySelector("aside")!.setAttribute("inert", "");
    expect(findUserMenuReturnTarget()).toBeNull();
  });

  it("queried on every call: after a shell swap it returns the newly mounted one", () => {
    stubLayoutTier("docked");
    mount();
    document.body.innerHTML = `<aside><button data-kb-tour-target="userMenu">Ann</button></aside>`;
    expect(findUserMenuReturnTarget()).toBe(document.querySelector('[data-kb-tour-target="userMenu"]'));
  });
});
