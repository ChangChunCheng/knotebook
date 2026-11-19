import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRef, vid, vlabel, vtarget } from "@/test/version-fixtures";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VersionCurrentDto, VersionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { Toaster, dismissAllToasts } from "@/components/ui/toast";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { useApplyFlow } from "./use-apply-flow";

// useApplyFlow x the controller's `onApplied`: notified only after a successful apply and after mutateAsync resolves;
// an error from the notification itself must not turn success into an error toast (it runs after closeDialog / stopPreview).
const NOTE = "n1";
const V1: VersionDto = { id: vid(1), seq: 1, kind: "manual", name: null, editors: [], baseSeq: null, base: null, createdAt: "2026-10-09T00:00:00.000Z" };
const CURRENT: VersionCurrentDto = { baseSeq: 2, base: baseRef(2), dirty: false, nextSeq: 3, autoEnabled: true };
const APPLY1 = `/api/notes/${NOTE}/versions/1/apply`;

function Harness() {
  const s = useVersions();
  const { applyNow, requestApply } = useApplyFlow(NOTE);
  return (
    <div>
      <button type="button" onClick={() => s.startPreview(vtarget(1))}>h-preview</button>
      <button type="button" onClick={() => s.openDialog({ kind: "apply", version: V1 })}>h-dialog</button>
      <button type="button" onClick={() => void applyNow(V1, true)}>h-apply-now</button>
      <button type="button" onClick={() => void requestApply(V1)}>h-request</button>
      <span data-testid="h-state">{JSON.stringify({ preview: s.preview, dialog: s.dialog?.kind ?? null })}</span>
    </div>
  );
}

function Host({ onApplied }: { onApplied: () => void }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true, onApplied });
  return (
    <VersionsProvider value={value}>
      <Harness />
    </VersionsProvider>
  );
}

function renderFlow(onApplied: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Host onApplied={onApplied} />
      <Toaster />
    </QueryClientProvider>,
  );
}

const hState = () => JSON.parse(screen.getByTestId("h-state").textContent!);

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as Response;
}

describe("useApplyFlow x onApplied", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("409 version_unsaved_changes -> onApplied is not called (the three-choice dialog appears instead)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === APPLY1) {
          return Promise.resolve(jsonResponse(409, { error: { code: "version_unsaved_changes", message: "x" } }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const onApplied = vi.fn();
    renderFlow(onApplied);
    fireEvent.click(screen.getByText("h-apply-now"));
    await waitFor(() => expect(hState().dialog).toBe("apply"));
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("success -> onApplied is called once, and only after the apply response resolves", async () => {
    const order: string[] = [];
    let resolveApply!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === APPLY1) {
          order.push("apply-request");
          return new Promise<Response>((resolve) => {
            resolveApply = resolve;
          });
        }
        if (url.startsWith(`/api/notes/${NOTE}/versions`)) return Promise.resolve(jsonResponse(200, { versions: [V1], current: CURRENT, nextBefore: null }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const onApplied = vi.fn(() => order.push("onApplied"));
    renderFlow(onApplied);
    fireEvent.click(screen.getByText("h-apply-now"));
    await waitFor(() => expect(order).toEqual(["apply-request"]));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(onApplied).not.toHaveBeenCalled();
    await act(async () => {
      order.push("apply-resolved");
      resolveApply(jsonResponse(200, { current: CURRENT }));
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["apply-request", "apply-resolved", "onApplied"]);
    expect(await screen.findByText("Applied agile-beaver (0001aaa)")).toBeInTheDocument();
  });

  it("onApplied throws -> still the success path: dialog closed, preview left, success toast and no error toast", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === APPLY1) return Promise.resolve(jsonResponse(200, { current: CURRENT }));
        if (url.startsWith(`/api/notes/${NOTE}/versions`)) return Promise.resolve(jsonResponse(200, { versions: [V1], current: CURRENT, nextBefore: null }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const onApplied = vi.fn(() => {
      throw new Error("invalidate failed");
    });
    renderFlow(onApplied);
    fireEvent.click(screen.getByText("h-preview"));
    fireEvent.click(screen.getByText("h-dialog"));
    expect(hState()).toEqual({ preview: vtarget(1), dialog: "apply" });
    fireEvent.click(screen.getByText("h-apply-now"));
    expect(await screen.findByText(`Applied ${vlabel(1)}`)).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(hState()).toEqual({ preview: null, dialog: null });
    expect(screen.queryByText(i18n.t("errors.fallback"))).not.toBeInTheDocument();
  });

  it("requestApply double-click: the second call while in flight just returns, so fetchCurrent and apply are each called once; applying again works after it finishes", async () => {
    const calls: string[] = [];
    const pending: Array<(r: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === APPLY1) return new Promise<Response>((resolve) => pending.push(resolve));
        if (url.startsWith(`/api/notes/${NOTE}/versions`)) return Promise.resolve(jsonResponse(200, { versions: [V1], current: CURRENT, nextBefore: null }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderFlow(vi.fn());
    const count = (u: string) => calls.filter((c) => c === u).length;
    fireEvent.click(screen.getByText("h-request"));
    fireEvent.click(screen.getByText("h-request"));
    await waitFor(() => expect(count(APPLY1)).toBe(1));
    // The first apply is still pending: wait a while longer, the second click must not fire another request.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(count(APPLY1)).toBe(1);
    expect(count(`/api/notes/${NOTE}/versions?limit=1`)).toBe(1);
    await act(async () => {
      pending[0](jsonResponse(200, { current: CURRENT }));
    });
    expect(await screen.findByText(`Applied ${vlabel(1)}`)).toBeInTheDocument();
    fireEvent.click(screen.getByText("h-request"));
    await waitFor(() => expect(count(APPLY1)).toBe(2));
    expect(count(`/api/notes/${NOTE}/versions?limit=1`)).toBe(2);
  });
});
