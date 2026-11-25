import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { formatBytes } from "@knotebook/shared";
import i18n from "@/i18n";
import { ContentUsageGroup } from "./ContentUsageGroup";

describe("ContentUsageGroup", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("shows note content and history with formatBytes values, plus the limit disclaimer", () => {
    render(<ContentUsageGroup content={{ noteBytes: 3 * 1048576, historyBytes: 5120 }} pending={false} />);
    expect(screen.getByRole("heading", { level: 2, name: "Notes and history" })).toBeInTheDocument();
    expect(screen.getByText("Space taken by note content and version history. It doesn't count toward the storage limit.")).toBeInTheDocument();
    const note = screen.getByTestId("content-usage-note");
    expect(within(note).getByText("Note content")).toBeInTheDocument();
    expect(within(note).getByText("3 MB")).toBeInTheDocument();
    const history = screen.getByTestId("content-usage-history");
    expect(within(history).getByText("Version history and backups")).toBeInTheDocument();
    expect(within(history).getByText("5 KB")).toBeInTheDocument();
  });

  it("zero renders as formatBytes(0), not blank", () => {
    render(<ContentUsageGroup content={{ noteBytes: 0, historyBytes: 0 }} pending={false} />);
    expect(within(screen.getByTestId("content-usage-note")).getByText(formatBytes(0))).toBeInTheDocument();
    expect(within(screen.getByTestId("content-usage-history")).getByText(formatBytes(0))).toBeInTheDocument();
  });

  it("no rows while loading or when the usage query failed", () => {
    const { rerender } = render(<ContentUsageGroup content={undefined} pending />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByTestId("content-usage-note")).toBeNull();
    rerender(<ContentUsageGroup content={undefined} pending={false} />);
    expect(screen.queryByTestId("content-usage-note")).toBeNull();
  });

  it("zh-TW copy", async () => {
    await i18n.changeLanguage("zh-TW");
    render(<ContentUsageGroup content={{ noteBytes: 1, historyBytes: 2 }} pending={false} />);
    expect(screen.getByRole("heading", { level: 2, name: "筆記與歷史" })).toBeInTheDocument();
    expect(within(screen.getByTestId("content-usage-note")).getByText("筆記內容")).toBeInTheDocument();
    expect(within(screen.getByTestId("content-usage-history")).getByText("版本歷史與備份")).toBeInTheDocument();
  });
});
