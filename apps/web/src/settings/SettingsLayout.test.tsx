import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

// SettingsGroup 的 `labelledByTitle`（#181）：開了才以標題命名成 region；預設不是 landmark。

describe("SettingsGroup labelledByTitle", () => {
  it("SL-T1a 帶 labelledByTitle＋title → region 以標題命名，aria-labelledby 指向那個 h2", () => {
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

  it("SL-T1b 同時兩個 → 兩個 region，id 不撞", () => {
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

  it("SL-T1c 不帶 labelledByTitle → 不是 region、沒有 aria-labelledby、h2 沒有 id", () => {
    const { container } = render(<SettingsGroup title="A" description="d" />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(container.querySelector("section")).not.toHaveAttribute("aria-labelledby");
    expect(screen.getByRole("heading", { level: 2, name: "A" })).not.toHaveAttribute("id");
  });

  it("SL-T1d 帶了 labelledByTitle 但沒有 title → 沒有 aria-labelledby、不是 region", () => {
    const { container } = render(
      <SettingsGroup labelledByTitle description="only description">
        <p>body</p>
      </SettingsGroup>,
    );
    expect(screen.queryByRole("region")).toBeNull();
    expect(container.querySelector("section")).not.toHaveAttribute("aria-labelledby");
  });

  it("手機：標題與說明在上、動作鈕疊在下面（不擠窄說明文字）；sm 起並排", () => {
    render(<SettingsGroup title="A" description="desc" action={<button type="button">Add</button>} />);
    const header = screen.getByRole("heading", { level: 2, name: "A" }).parentElement!.parentElement!;
    expect(header).toHaveClass("flex", "justify-between", "max-sm:flex-col", "max-sm:gap-3");
    expect(screen.getByRole("button", { name: "Add" }).parentElement).toHaveClass("shrink-0");
  });

  it("頁首（SettingsPage）手機：標題說明在上、動作鈕疊在下面，仍留 pr-6 給關閉鈕；sm 起並排", () => {
    render(
      <SettingsPage title="Users" description="desc" action={<button type="button">Create</button>}>
        <p>body</p>
      </SettingsPage>,
    );
    const header = screen.getByRole("heading", { level: 1, name: "Users" }).parentElement!.parentElement!;
    expect(header).toHaveClass("flex", "justify-between", "pr-6", "max-sm:flex-col", "max-sm:gap-3");
    expect(screen.getByRole("button", { name: "Create" }).parentElement).toHaveClass("shrink-0");
  });

  it("頁標題手機 18px、與左上角的「‹」同高（48px 列、左側讓出「‹」）；sm 起維持 20px", () => {
    render(
      <SettingsPage title="Users" description="Manage users">
        <p>x</p>
      </SettingsPage>,
    );
    const h1 = screen.getByRole("heading", { level: 1, name: "Users" });
    expect(h1).toHaveClass("text-xl", "font-semibold", "max-sm:text-lg", "max-sm:min-h-12", "max-sm:items-center", "max-sm:pl-10");
  });
});
