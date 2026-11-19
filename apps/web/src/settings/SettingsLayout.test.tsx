import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

// `labelledByTitle` of SettingsGroup (#181): only when enabled is it named as a region by its title; by default it isn't a landmark.

describe("SettingsGroup labelledByTitle", () => {
  it("with labelledByTitle + title -> region named by the title, aria-labelledby points at that h2", () => {
    render(
      <SettingsGroup labelledByTitle title="A">
        <p>body</p>
      </SettingsGroup>,
    );
    const region = screen.getByRole("region", { name: "A" });
    const heading = screen.getByRole("heading", { level: 2, name: "A" });
    const id = region.getAttribute("aria-labelledby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? "")).toBe(heading);
  });

  it("both at once -> two regions, ids don't collide", () => {
    render(
      <>
        <SettingsGroup labelledByTitle title="A" />
        <SettingsGroup labelledByTitle title="B" />
      </>,
    );
    const a = screen.getByRole("region", { name: "A" });
    const b = screen.getByRole("region", { name: "B" });
    expect(screen.getAllByRole("region")).toHaveLength(2);
    expect(a.getAttribute("aria-labelledby")).not.toBe(b.getAttribute("aria-labelledby"));
  });

  it("without labelledByTitle -> not a region, no aria-labelledby, the h2 has no id", () => {
    const { container } = render(<SettingsGroup title="A" description="d" />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(container.querySelector("section")).not.toHaveAttribute("aria-labelledby");
    expect(screen.getByRole("heading", { level: 2, name: "A" })).not.toHaveAttribute("id");
  });

  it("labelledByTitle but no title -> no aria-labelledby, not a region", () => {
    const { container } = render(
      <SettingsGroup labelledByTitle description="only description">
        <p>body</p>
      </SettingsGroup>,
    );
    expect(screen.queryByRole("region")).toBeNull();
    expect(container.querySelector("section")).not.toHaveAttribute("aria-labelledby");
  });

  it("phone: title and description on top, action buttons stacked below (doesn't squeeze the description text); side by side from sm", () => {
    render(<SettingsGroup title="A" description="desc" action={<button type="button">Add</button>} />);
    const header = screen.getByRole("heading", { level: 2, name: "A" }).parentElement!.parentElement!;
    expect(header).toHaveClass("flex", "justify-between", "max-sm:flex-col", "max-sm:gap-3");
    expect(screen.getByRole("button", { name: "Add" }).parentElement).toHaveClass("shrink-0");
  });

  it("page header (SettingsPage) on phone: title and description on top, action buttons stacked below, still leaving pr-6 for the close button; side by side from sm", () => {
    render(
      <SettingsPage title="Users" description="desc" action={<button type="button">Create</button>}>
        <p>body</p>
      </SettingsPage>,
    );
    const header = screen.getByRole("heading", { level: 1, name: "Users" }).parentElement!.parentElement!;
    expect(header).toHaveClass("flex", "justify-between", "pr-6", "max-sm:flex-col", "max-sm:gap-3");
    expect(screen.getByRole("button", { name: "Create" }).parentElement).toHaveClass("shrink-0");
  });

  it("page title on phone is 18px, level with the top-left back chevron (48px row, the left side leaves room for the chevron); stays 20px from sm", () => {
    render(
      <SettingsPage title="Users" description="Manage users">
        <p>x</p>
      </SettingsPage>,
    );
    const h1 = screen.getByRole("heading", { level: 1, name: "Users" });
    expect(h1).toHaveClass("text-xl", "font-semibold", "max-sm:text-lg", "max-sm:min-h-12", "max-sm:items-center", "max-sm:pl-10", "max-sm:-mt-12");
  });
});
