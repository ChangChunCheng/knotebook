import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ProviderIconDto } from "@knotebook/shared";
import { ProviderIcon } from "./ProviderIcon";


const URL_V1 = "/api/auth/providers/11111111-1111-4111-8111-111111111111/icon?v=1";
const URL_V2 = "/api/auth/providers/11111111-1111-4111-8111-111111111111/icon?v=2";

describe("ProviderIcon", () => {
  it("three builtin names each render their SVG: data-provider-icon, aria-hidden, focusable=false, 16px, no text content", () => {
    for (const name of ["gitlab", "google", "generic"] as const) {
      const { container, unmount } = render(<ProviderIcon icon={{ type: "builtin", name }} />);
      const svg = container.querySelector("svg");
      expect(svg, name).toHaveAttribute("data-provider-icon", name);
      expect(svg, name).toHaveAttribute("aria-hidden", "true");
      expect(svg, name).toHaveAttribute("focusable", "false");
      expect(svg, name).toHaveClass("h-4", "w-4", "shrink-0");
      expect(container.textContent, name).toBe("");
      expect(container.querySelector("title, text, desc"), name).toBeNull();
      unmount();
    }
  });

  it("the three builtin icons are different shapes; GitLab has all three colors, Google has the official gradient colors, the generic icon uses currentColor", () => {
    const html = (name: "gitlab" | "google" | "generic") => render(<ProviderIcon icon={{ type: "builtin", name }} />).container.innerHTML;
    const [gitlab, google, generic] = [html("gitlab"), html("google"), html("generic")];
    expect(new Set([gitlab, google, generic]).size).toBe(3);
    for (const c of ["#E24329", "#FC6D26", "#FCA326"]) expect(gitlab, c).toContain(c);
    for (const c of ["#3186FF", "#FF4641", "#FF5B8B"]) expect(google, c).toContain(c);
    expect(generic).toContain('stroke="currentColor"');
    expect(generic).not.toMatch(/fill="#/);
  });

  it("Google icon has no button frame or backplate (the official package's square and the #747775 outline are removed)", () => {
    const { container } = render(<ProviderIcon icon={{ type: "builtin", name: "google" }} />);
    expect(container.querySelector("rect")).toBeNull();
    expect(container.innerHTML).not.toContain("#747775");
    expect(container.innerHTML).not.toMatch(/fill="white"/);
    expect(container.querySelector("svg")).toHaveAttribute("viewBox", "10 10 20 20");
  });

  it("two Google icons on one page: ids don't repeat, and each url(#...) points to an id inside its own svg", () => {
    const { container } = render(
      <div>
        <ProviderIcon icon={{ type: "builtin", name: "google" }} />
        <ProviderIcon icon={{ type: "builtin", name: "google" }} />
      </div>,
    );
    const svgs = Array.from(container.querySelectorAll("svg"));
    expect(svgs).toHaveLength(2);
    const ids = svgs.map((svg) => Array.from(svg.querySelectorAll("[id]")).map((e) => e.id));
    expect(ids[0]!.length).toBeGreaterThanOrEqual(9);
    expect(new Set([...ids[0]!, ...ids[1]!]).size).toBe(ids[0]!.length + ids[1]!.length);
    svgs.forEach((svg, i) => {
      const refs = Array.from(svg.innerHTML.matchAll(/url\(#([^)]+)\)/g)).map((m) => m[1]!);
      expect(refs.length).toBeGreaterThanOrEqual(9);
      for (const r of refs) expect(ids[i], r).toContain(r);
    });
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

  it("placing it in a button doesn't change the accessible name (same for all four shapes)", () => {
    const icons: ProviderIconDto[] = [{ type: "builtin", name: "gitlab" }, { type: "builtin", name: "google" }, { type: "builtin", name: "generic" }, { type: "upload", url: URL_V1 }];
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
