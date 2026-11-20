import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import "@/i18n/tour-strings";
import { AppErrorBoundary } from "@/components/ErrorBoundary";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { useTour, type TourApi } from "@/lib/tour-context";
import { TourProvider } from "./TourProvider";

// The tour component throws while rendering until the test switches it off; the next round renders normally. Checks that the failed round only tears down the tour and does not take down the whole app.
const lazy = vi.hoisted(() => ({ crash: true }));
vi.mock("./TourLazy", () => ({
  TourLazy: () => {
    if (lazy.crash) throw new Error("tour render failed");
    return <div data-testid="tour-ok" />;
  },
}));

let tour: TourApi | null = null;
function Probe() {
  tour = useTour();
  return null;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  lazy.crash = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  dismissAllToasts();
  vi.restoreAllMocks();
});

describe("tour component throws while rendering", () => {
  it("the rest of the app stays up and the fallback screen is not shown; the round ends with one toast and the next start works normally", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/"]}>
          <AppErrorBoundary>
            <TourProvider>
              <Probe />
              <p>app content</p>
            </TourProvider>
          </AppErrorBoundary>
          <Toaster />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const start = () => act(() => tour!.start({ returnTo: "/", returnFocus: () => null }));

    start();
    expect(await screen.findByText("The feature tour ran into a problem and was closed.")).toBeTruthy();
    expect(screen.getByText("app content")).toBeTruthy();
    expect(screen.queryByText(i18n.t("app.crashTitle"))).toBeNull();
    expect(screen.queryByTestId("tour-ok")).toBeNull();

    lazy.crash = false;
    start();
    await waitFor(() => expect(screen.getByTestId("tour-ok")).toBeTruthy());
    expect(screen.getByText("app content")).toBeTruthy();
  });
});
