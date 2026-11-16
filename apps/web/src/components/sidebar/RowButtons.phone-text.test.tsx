import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FolderRowButton } from "./FolderRowButton";
import { GroupRowButton } from "./GroupRowButton";

describe("資料夾列與群組列的手機字級", () => {
  it("名稱桌機 13px、手機 15px", () => {
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
