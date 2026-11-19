import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { AGENT_PRESENCE_COLOR, avatarUrl } from "@knotebook/shared";
import { Avatar } from "./Avatar";


const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function root(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

describe("Avatar", () => {
  it("initial: aria-hidden, uppercase first letter, bg-muted/text-foreground, inline size", () => {
    const { container } = render(<Avatar name="ann" avatar={null} size={28} />);
    const el = root(container);
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el).toHaveTextContent(/^A$/);
    expect(el).toHaveClass("bg-muted", "text-foreground");
    expect(el.style.width).toBe("28px");
    expect(el.style.height).toBe("28px");
  });

  it("image: src only via avatarUrl; a load failure falls back to the initial; retries after the version changes", () => {
    const { container, rerender } = render(<Avatar name="ann" avatar={{ id: ID, v: 2 }} size={28} />);
    const img = container.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe(avatarUrl(ID, 2));
    expect(img.getAttribute("alt")).toBe("");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(root(container)).toHaveTextContent(/^A$/);
    rerender(<Avatar name="ann" avatar={{ id: ID, v: 3 }} size={28} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(avatarUrl(ID, 3));
  });

  it("AI: Sparkles icon, no initial", () => {
    const { container } = render(<Avatar name="w" avatar={null} size={28} kind="agent" />);
    const el = root(container);
    expect(el.querySelector('svg[data-icon="sparkles"]')).not.toBeNull();
    expect(el.textContent).toBe("");
  });

  it("AI icon color: light = AGENT_PRESENCE_COLOR, dark uses a brighter purple (class, not inline color)", () => {
    const { container } = render(<Avatar name="w" avatar={null} size={28} kind="agent" />);
    const icon = root(container).querySelector<SVGElement>('svg[data-icon="sparkles"]')!;
    expect(icon).toHaveClass(`text-[${AGENT_PRESENCE_COLOR}]`, "dark:text-[#a78bfa]");
    // An inline color would override the dark: class.
    expect(icon.style.color).toBe("");
  });

  it("frame: two rings (ringColor and card background); offsetColor changes the background; no ringColor -> no boxShadow", () => {
    const { container, rerender } = render(<Avatar name="ann" avatar={null} size={28} ringColor="hsl(10 65% 45%)" />);
    const shadow = root(container).style.boxShadow;
    expect(shadow).toContain("hsl(10 65% 45%)");
    expect(shadow).toContain("var(--color-card)");
    rerender(<Avatar name="ann" avatar={null} size={28} ringColor="hsl(10 65% 45%)" offsetColor="var(--color-popover)" />);
    expect(root(container).style.boxShadow).toContain("var(--color-popover)");
    expect(root(container).style.boxShadow).not.toContain("var(--color-card)");
    rerender(<Avatar name="ann" avatar={null} size={28} />);
    expect(root(container).style.boxShadow).toBe("");
  });

  it("name starting with invisible characters: the initial is the first visible grapheme", () => {
    const { container } = render(<Avatar name={`${String.fromCharCode(0x202e)}ann`} avatar={null} size={28} />);
    expect(root(container).textContent).toBe("A");
  });
});
