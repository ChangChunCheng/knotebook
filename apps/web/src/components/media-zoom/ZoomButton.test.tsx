import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import i18n from "@/i18n";
import { prefetchMediaLightbox } from "./lightbox-chunk";
import { ZoomButton } from "./ZoomButton";

vi.mock("./lightbox-chunk", () => ({ loadMediaLightbox: vi.fn(), prefetchMediaLightbox: vi.fn() }));

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.mocked(prefetchMediaLightbox).mockClear();
});
afterEach(cleanup);

describe("ZoomButton", () => {
  it("pointerenter and focus both prefetch the zoom view chunk and still call the caller's handlers", () => {
    const onPointerEnter = vi.fn();
    const onFocus = vi.fn();
    render(<ZoomButton onPointerEnter={onPointerEnter} onFocus={onFocus} />);
    const button = screen.getByRole("button", { name: "Zoom in" });
    fireEvent.pointerEnter(button);
    expect(prefetchMediaLightbox).toHaveBeenCalledTimes(1);
    fireEvent.focus(button);
    expect(prefetchMediaLightbox).toHaveBeenCalledTimes(2);
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("carries block-control: hover/press/focus feedback all live on this shared rule", () => {
    render(<ZoomButton />);
    expect(screen.getByRole("button").className).toContain("block-control");
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8");
    expect(css).toMatch(/\.block-control:hover[^{]*\{[^}]*--brand-soft/);
    expect(css).toMatch(/\.block-control:active[^{]*\{[^}]*--brand-soft-strong/);
    expect(css).toMatch(/\.block-control:focus-visible[^{]*\{[^}]*outline/);
  });
});
