import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import type { ZoomSource } from "./context";
import { LightboxFallback } from "./LightboxFallback";

const SOURCE: ZoomSource = { kind: "image", src: "/uploads/bob.png", alt: "bob.png", caption: "", naturalWidth: 400, naturalHeight: 200 };

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

describe("LightboxFallback", () => {
  it("a dialog, a grey block in the original aspect ratio and a close button appear as soon as it renders, with focus on the close button", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
    const { container } = render(<LightboxFallback source={SOURCE} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "bob.png" })).toBeInTheDocument();
    // Mounted under body (portal), not in the render container; the ratio matches the "fit to window" computation (jsdom window 1024x768: 400x200 is not enlarged).
    expect(container.querySelector("[data-zoom-fallback]")).toBeNull();
    const skeleton = document.body.querySelector<HTMLElement>("[data-zoom-skeleton]")!;
    expect(skeleton.style.aspectRatio).toBe("400 / 200");
    expect(skeleton.style.width).toBe("400px");
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("without an original size it falls back to a neutral square", () => {
    render(<LightboxFallback source={{ ...SOURCE, naturalWidth: 0, naturalHeight: 0 }} onClose={() => {}} />);
    expect(document.body.querySelector<HTMLElement>("[data-zoom-skeleton]")!.style.aspectRatio).toBe("");
  });

  it("Esc, the close button and a background click all close it", () => {
    const onClose = vi.fn();
    render(<LightboxFallback source={SOURCE} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("Tab does not leave the close button", () => {
    render(<LightboxFallback source={SOURCE} onClose={() => {}} />);
    const close = screen.getByRole("button", { name: "Close" });
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
  });
});
