import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { StorageUsageDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SettingsStorageUsageSection } from "./SettingsStorageUsageSection";

const USER: UserDto = {
  id: "u1", email: "a@example.com", handle: "a", displayName: "A",
  isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true,
  avatar: null,
};
const MiB = 1048576;

function fakeResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function renderPage(usage: StorageUsageDto) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/storage") return Promise.resolve(fakeResponse(usage));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/auth/config")
        return Promise.resolve(fakeResponse({ providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SettingsStorageUsageSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (kind: string) => screen.getByTestId(`by-kind-${kind}`);
const barWidth = (kind: string) => (screen.getByTestId(`by-kind-bar-${kind}`) as HTMLElement).style.width;

describe("SettingsStorageUsageSection (#247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the five \"by type\" rows are always present in a fixed order (including rows with 0)", async () => {
    renderPage({ usedBytes: 3 * MiB, quotaBytes: null, planName: "Big", byKind: { image: 3 * MiB, audio: 0, video: 0, document: 0, other: 0 }, content: { noteBytes: 0, historyBytes: 0 } });
    expect(await screen.findByRole("heading", { level: 2, name: "By type" })).toBeInTheDocument();
    // The section title renders while loading (the rows wait for /api/storage) - wait for the rows to appear before counting
    await screen.findByTestId("by-kind-image");
    const names = screen.getAllByTestId(/^by-kind-(image|audio|video|document|other)$/).map((el) => el.getAttribute("data-testid"));
    expect(names).toEqual(["by-kind-image", "by-kind-audio", "by-kind-video", "by-kind-document", "by-kind-other"]);
    expect(within(row("image")).getByText("Images")).toBeInTheDocument();
    expect(within(row("image")).getByText("3 MB")).toBeInTheDocument();
    expect(within(row("other")).getByText("0 B")).toBeInTheDocument();
    expect(screen.queryByText("Profile pictures")).not.toBeInTheDocument();
  });

  it("the percentage denominator is the sum of byKind, not usedBytes (when they differ)", async () => {
    renderPage({
      usedBytes: 99 * MiB, quotaBytes: 2048 * MiB, planName: "Basic",
      byKind: { image: 3 * MiB, audio: 0, video: 0, document: 1 * MiB, other: 0 }, content: { noteBytes: 0, historyBytes: 0 },
    });
    await screen.findByTestId("by-kind-image");
    expect(barWidth("image")).toBe("75%");
    expect(barWidth("document")).toBe("25%");
    expect(barWidth("audio")).toBe("0%");
  });

  it("kinds sum to 0 -> all five are 0% (must not be NaN)", async () => {
    renderPage({ usedBytes: 0, quotaBytes: 2048 * MiB, planName: "Basic", byKind: { image: 0, audio: 0, video: 0, document: 0, other: 0 }, content: { noteBytes: 0, historyBytes: 0 } });
    await screen.findByTestId("by-kind-image");
    for (const kind of ["image", "audio", "video", "document", "other"]) expect(barWidth(kind)).toBe("0%");
  });

  it("header, usage section, version history section (including the \"versions don't count toward the quota\" sentence and the auto-save switch)", async () => {
    renderPage({ usedBytes: MiB, quotaBytes: 2048 * MiB, planName: "Basic", byKind: { image: MiB, audio: 0, video: 0, document: 0, other: 0 }, content: { noteBytes: 0, historyBytes: 0 } });
    expect(screen.getByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Usage" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Version history" })).toBeInTheDocument();
    expect(screen.getByText("Versions and note text don't count toward the storage limit. Files and, in a personal space, profile pictures do.")).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Automatic versions" })).toBeInTheDocument();
  });

  it("the notes-and-history group comes right after the usage group and shows both numbers", async () => {
    renderPage({ usedBytes: MiB, quotaBytes: 2048 * MiB, planName: "Basic", byKind: { image: MiB, audio: 0, video: 0, document: 0, other: 0 }, content: { noteBytes: 2 * MiB, historyBytes: 5 * MiB } });
    const usage = screen.getByRole("heading", { level: 2, name: "Usage" });
    const content = await screen.findByRole("heading", { level: 2, name: "Notes and history" });
    expect(usage.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(content.compareDocumentPosition(screen.getByRole("heading", { level: 2, name: "By type" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(within(screen.getByTestId("content-usage-note")).getByText("2 MB")).toBeInTheDocument());
    expect(within(screen.getByTestId("content-usage-history")).getByText("5 MB")).toBeInTheDocument();
    expect(screen.getByTestId("storage-usage")).not.toHaveTextContent("7 MB");
  });
});
