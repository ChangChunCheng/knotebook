import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FolderRowButton } from "./FolderRowButton";
import { GroupRowButton } from "./GroupRowButton";

describe("phone text size of folder rows and group rows", () => {
  it("name is 13px on desktop, 15px on phones", () => {
    render(
      <>
        <FolderRowButton name="Docs" open={false} onToggle={() => {}} />
        <GroupRowButton name="Team" open={false} onToggle={() => {}} />
      </>,
    );
    for (const name of ["Docs", "Team"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("text-[13px]", "max-sm:text-[15px]");
    }
  });
});
