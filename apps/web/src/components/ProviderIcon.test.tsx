import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ProviderIconDto } from "@knotebook/shared";
import { ProviderIcon } from "./ProviderIcon";


const URL_V1 = "/api/auth/providers/11111111-1111-4111-8111-111111111111/icon?v=1";
const URL_V2 = "/api/auth/providers/11111111-1111-4111-8111-111111111111/icon?v=2";

describe("ProviderIcon", () => {
  it("builtin generic renders its SVG: data-provider-icon, aria-hidden, focusable=false, 16px, no text content, currentColor, no fixed fills", () => {
    const { container } = render(<ProviderIcon icon={{ type: "builtin", name: "generic" }} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-provider-icon", "generic");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveClass("h-4", "w-4", "shrink-0");
    expect(container.textContent).toBe("");
    expect(container.querySelector("title, text, desc")).toBeNull();
    expect(container.innerHTML).toContain('stroke="currentColor"');
    expect(container.innerHTML).not.toMatch(/fill="#/);
  });

  it("upload -> <img alt='' aria-hidden> src = url, object-contain, not draggable", () => {
    const { container } = render(<ProviderIcon icon={{ type: "upload", url: URL_V1 }} className="mr-1" />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", URL_V1);
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");
    expect(img).toHaveAttribute("data-provider-icon", "upload");
    expect(img).toHaveAttribute("draggable", "false");
    expect(img).toHaveClass("h-4", "w-4", "shrink-0", "object-contain", "mr-1");
  });

  it("upload fails to load -> falls back to the generic icon (no broken image left)", () => {
    const { container } = render(<ProviderIcon icon={{ type: "upload", url: URL_V1 }} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toHaveAttribute("data-provider-icon", "generic");
  });

  it("after a failure the DTO gets a new URL (image changes, ?v= increments) -> <img> shows again; going back to the already failed URL -> still the generic icon", () => {
    const { container, rerender } = render(<ProviderIcon icon={{ type: "upload", url: URL_V1 }} />);
    fireEvent.error(container.querySelector("img")!);
    rerender(<ProviderIcon icon={{ type: "upload", url: URL_V2 }} />);
    expect(container.querySelector("img")).toHaveAttribute("src", URL_V2);
    rerender(<ProviderIcon icon={{ type: "upload", url: URL_V1 }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toHaveAttribute("data-provider-icon", "generic");
  });

  it("null (hidden) and undefined (old fixtures missing the field) both render no node", () => {
    for (const icon of [null, undefined] as Array<ProviderIconDto | undefined>) {
      const { container, unmount } = render(<ProviderIcon icon={icon} />);
      expect(container.firstChild, String(icon)).toBeNull();
      unmount();
    }
  });

  it("placing it in a button doesn't change the accessible name (same for both shapes)", () => {
    const icons: ProviderIconDto[] = [{ type: "builtin", name: "generic" }, { type: "upload", url: URL_V1 }];
    for (const icon of icons) {
      const { unmount } = render(
        <button type="button">
          <ProviderIcon icon={icon} />
          Sign in with X
        </button>,
      );
      expect(screen.getByRole("button", { name: "Sign in with X" })).toBeInTheDocument();
      unmount();
    }
  });
});
