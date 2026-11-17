import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { findUserMenuReturnTarget, tourLayout, useTourLayout } from "./tour-find";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("導覽的三種版面", () => {
  it.each([
    ["docked", "wide"],
    ["overlay", "floating"],
    ["phone", "phone"],
  ] as const)("%s → %s", (tier: LayoutTier, layout) => {
    stubLayoutTier(tier);
    expect(tourLayout()).toBe(layout);
  });

  it("沒有 matchMedia 時當寬視窗", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(tourLayout()).toBe("wide");
  });

  it("跨過 640 或 1280 時重畫", () => {
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

describe("導覽結束後要聚焦的使用者選單觸發鈕", () => {
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

  it("寬視窗：側欄的帳號列", () => {
    stubLayoutTier("docked");
    const { account } = mount();
    expect(findUserMenuReturnTarget()).toBe(account);
  });

  it("側欄浮動：開抽屜的側欄鈕（使用者選單在已經關掉的抽屜裡）", () => {
    stubLayoutTier("overlay");
    const { hamburger } = mount();
    expect(findUserMenuReturnTarget()).toBe(hamburger);
  });

  it("手機：清單頂列的頭像；在筆記畫面（清單不可互動）時查不到", () => {
    stubLayoutTier("phone");
    document.body.innerHTML = `<aside><button data-kb-tour-target="userMenu">Ann</button></aside>`;
    const avatar = document.querySelector("aside button");
    expect(findUserMenuReturnTarget()).toBe(avatar);
    document.querySelector("aside")!.setAttribute("inert", "");
    expect(findUserMenuReturnTarget()).toBeNull();
  });

  it("每次呼叫都重查：換殼後拿到的是新掛上的那顆", () => {
    stubLayoutTier("docked");
    mount();
    document.body.innerHTML = `<aside><button data-kb-tour-target="userMenu">Ann</button></aside>`;
    expect(findUserMenuReturnTarget()).toBe(document.querySelector('[data-kb-tour-target="userMenu"]'));
  });
});
