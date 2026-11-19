import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { setNoteWidth } from "@/components/note-width";
import { NoteWidthToggle } from "./NoteWidthToggle";

const ID = "11111111-1111-4111-8111-111111111111";

function widthButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Width/ });
}

function iconOf(button: HTMLElement): string | null {
  return button.querySelector("svg")!.getAttribute("data-icon");
}

describe("NoteWidthToggle (header width button, #297)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
  });

  it.each([
    ["standard", "Width: Standard — click for Wide"],
    ["wide", "Width: Wide — click for Full width"],
    ["full", "Width: Full width — click for Standard"],
  ] as const)("current value %s -> button name and title are the same text (%s), icon follows", (width, name) => {
    setNoteWidth(ID, width);
    render(<NoteWidthToggle noteId={ID} />);
    const button = screen.getByRole("button", { name });
    expect(button).toHaveAttribute("title", name);
    expect(iconOf(button)).toBe(`note-width-${width}`);
  });

  it("width button uses the theme color: className has text-brand / hover:text-brand (same as the share button)", () => {
    render(<NoteWidthToggle noteId={ID} />);
    expect(widthButton()).toHaveClass("text-brand", "hover:text-brand");
  });

  it("three presses cycle standard -> wide -> full -> standard; for standard localStorage has no key", () => {
    render(<NoteWidthToggle noteId={ID} />);
    const key = `note.width.${ID}`;
    expect(localStorage.getItem(key)).toBeNull();

    fireEvent.click(widthButton());
    expect(localStorage.getItem(key)).toBe("wide");
    expect(widthButton()).toHaveAccessibleName("Width: Wide — click for Full width");
    expect(iconOf(widthButton())).toBe("note-width-wide");

    fireEvent.click(widthButton());
    expect(localStorage.getItem(key)).toBe("full");
    expect(widthButton()).toHaveAccessibleName("Width: Full width — click for Standard");
    expect(iconOf(widthButton())).toBe("note-width-full");

    fireEvent.click(widthButton());
    expect(localStorage.getItem(key)).toBeNull();
    expect(widthButton()).toHaveAccessibleName("Width: Standard — click for Wide");
    expect(iconOf(widthButton())).toBe("note-width-standard");
  });

  it("not a menu: no aria-haspopup, aria-expanded, and no role=menu after pressing", () => {
    render(<NoteWidthToggle noteId={ID} />);
    expect(widthButton()).not.toHaveAttribute("aria-haspopup");
    expect(widthButton()).not.toHaveAttribute("aria-expanded");
    fireEvent.pointerDown(widthButton(), { button: 0 });
    fireEvent.click(widthButton());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("button carries a container-query display class", () => {
    render(<NoteWidthToggle noteId={ID} />);
    expect(widthButton()).toHaveClass("hidden", "@min-[43.5rem]:inline-flex", "shrink-0");
  });

  it("zh-TW: button name and title are the Chinese label", async () => {
    await i18n.changeLanguage("zh-TW");
    render(<NoteWidthToggle noteId={ID} />);
    const button = screen.getByRole("button", { name: "寬度：標準（按一下改為寬）" });
    expect(button).toHaveAttribute("title", "寬度：標準（按一下改為寬）");
  });

  it("external change (same-tab setNoteWidth, another tab's storage event) -> the mounted button follows immediately", () => {
    render(<NoteWidthToggle noteId={ID} />);
    act(() => setNoteWidth(ID, "full"));
    expect(widthButton()).toHaveAccessibleName("Width: Full width — click for Standard");
    expect(iconOf(widthButton())).toBe("note-width-full");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: `note.width.${ID}`, newValue: "wide" }));
    });
    expect(widthButton()).toHaveAccessibleName("Width: Wide — click for Full width");
    expect(iconOf(widthButton())).toBe("note-width-wide");
  });
});
