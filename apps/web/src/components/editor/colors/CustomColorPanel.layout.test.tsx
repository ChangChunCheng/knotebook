import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import i18n from "@/i18n";
import { declaredContentWidth } from "@/test/color-menu-host";
import { CustomColorPanel } from "./CustomColorPanel";

// The lazy picker never finishes loading, so the panel stays on the Suspense fallback
vi.mock("./ColorfulPicker", () => new Promise(() => {}));

describe("CustomColorPanel layout", () => {
  it("while the picker is loading, the fallback is as wide as react-colorful (200px) and fits in the panel", async () => {
    await i18n.changeLanguage("en");
    const { container } = render(
      <CustomColorPanel
        request={{ section: "text", target: { kind: "inline" }, current: "default", byKeyboard: false, returnTo: "x" }}
        onBack={() => {}}
        onApply={() => {}}
      />,
    );
    const panel = container.querySelector(".kb-color-panel")!;
    const fallback = container.querySelector("[data-kb-color-picker-fallback]")!;
    expect(fallback).not.toBeNull();
    expect(declaredContentWidth(fallback)).toBe(200);
    expect(fallback.classList).toContain("h-[200px]");
    expect(declaredContentWidth(panel)).toBeGreaterThanOrEqual(declaredContentWidth(fallback));
  });
});
