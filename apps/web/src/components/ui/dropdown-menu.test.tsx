import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

function renderOpenMenu() {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>plain item</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked>checkbox item</DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>sub trigger</DropdownMenuSubTrigger>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe("選單項在粗指標下撐到 40px 以上", () => {
  it.each([
    ["menuitem", "plain item"],
    ["menuitemcheckbox", "checkbox item"],
    ["menuitem", "sub trigger"],
  ] as const)("%s「%s」：py-1.5 之外多一個 pointer-coarse:py-2.5", (role, name) => {
    renderOpenMenu();
    const item = screen.getByRole(role, { name });
    expect(item).toHaveClass("py-1.5");
    expect(item).toHaveClass("pointer-coarse:py-2.5");
  });
});
