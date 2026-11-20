import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { toast } from "@/components/ui/toast";
import { useTour, type TourApi } from "@/lib/tour-context";
import { TourProvider } from "./TourProvider";

// The tour chunk fails to download the first time and succeeds the second (a retry after a redeploy or a brief network drop). The flow after the chunk loads is in TourProvider.test.tsx.
const chunk = vi.hoisted(() => ({ attempts: 0 }));
vi.mock("./TourLazy", async (importOriginal) => {
  chunk.attempts += 1;
  if (chunk.attempts === 1) throw new TypeError("Failed to fetch dynamically imported module");
  return importOriginal();
});

vi.mock("@/components/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/toast")>();
  return { ...actual, toast: vi.fn(actual.toast) };
});
const toastSpy = vi.mocked(toast);
const toastTitles = () => toastSpy.mock.calls.map(([item]) => item.title);

let posts = 0;
let tour: TourApi | null = null;

function Probe() {
  tour = useTour();
  return null;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  posts = 0;
  toastSpy.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/notes" && (init?.method ?? "GET").toUpperCase() === "POST") posts += 1;
      // Creating the sample note always fails: it is enough to see that the flow really started after the chunk loaded; it need not run to the end.
      return new Response(JSON.stringify({ error: { code: "internal", message: "x" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tour chunk download failure", () => {
  it("one load-failure toast and no sample note; the next start downloads again and proceeds normally once loaded", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/"]}>
          <TourProvider>
            <Probe />
          </TourProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const start = () => act(() => tour!.start({ returnTo: "/", returnFocus: () => null }));

    start();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(toastTitles()).toEqual([i18n.t("app.chunkLoadError")]);
    expect(posts).toBe(0);

    start();
    await waitFor(() => expect(posts).toBe(1));
    expect(chunk.attempts).toBe(2);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));
    // The second toast comes from the flow inside the chunk (sample-note creation failed), not from another load failure.
    expect(toastTitles()).toEqual([i18n.t("app.chunkLoadError"), "Couldn't create the sample note. Try again."]);
  });
});
