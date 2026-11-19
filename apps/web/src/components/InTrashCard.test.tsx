import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SidebarTabProvider, useSidebarTabState } from "@/lib/sidebar-tab";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import * as toastModule from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { InTrashCard } from "./InTrashCard";

// The part wired into NotePage is in pages/NotePage.test.tsx.

afterEach(() => {
  localStorage.clear();
});

const NOTE_ID = "n1";

const RESTORED: NoteDto = {
  id: NOTE_ID,
  title: "Trashed",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "trashed",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  permissions: OWNER_PERMS,
  folderId: null,
};

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

/** Response of `POST /api/trash/restore`; if `hold` is given it waits for it to resolve before replying (to test the in-flight state). */
function stubRestore(reply: { status: number; body: unknown }, hold?: Promise<void>) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/trash/restore" && method === "POST") {
        posts.push(JSON.parse(String(init?.body)));
        const make = () => fakeResponse(reply.body, reply.status);
        return hold ? hold.then(make) : Promise.resolve(make());
      }
      // After restore, none of the keys invalidated by invalidateTrashRelated has a mounted observer, so no request is made; a request would be unexpected.
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return { posts };
}

function TabProbe() {
  const { tab } = useSidebarTabState();
  return <span data-testid="tab-probe">{tab}</span>;
}

function renderCard() {
  const onRestored = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SidebarTabProvider>
        <InTrashCard noteId={NOTE_ID} onRestored={onRestored} />
        <TabProbe />
      </SidebarTabProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return { onRestored };
}

/** Radix Toast Root (`<li>`): the variant class is on it. */
function toastRoot(title: string): HTMLElement {
  return screen.getByText(title, { exact: true }).closest("li") as HTMLElement;
}

const restoreButton = () => screen.getByRole("button", { name: "Restore" });

describe("InTrashCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("title and two buttons", () => {
    stubRestore({ status: 200, body: { restored: [], skipped: [] } });
    renderCard();
    expect(screen.getByRole("heading", { level: 2, name: "This note is in the trash" })).toBeInTheDocument();
    expect(restoreButton()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Go to trash" })).toBeEnabled();
  });

  it("restore success: sends {ids:[n1]}, onRestored once, no toast", async () => {
    const { posts } = stubRestore({ status: 200, body: { restored: [RESTORED], skipped: [] } });
    const toastSpy = vi.spyOn(toastModule, "toast");
    onTestFinished(() => toastSpy.mockRestore());
    const { onRestored } = renderCard();

    fireEvent.click(restoreButton());

    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(posts).toEqual([{ ids: [NOTE_ID] }]);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("while sending, Restore is disabled and recovers when the response returns", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubRestore({ status: 200, body: { restored: [RESTORED], skipped: [] } }, hold);
    const { onRestored } = renderCard();

    fireEvent.click(restoreButton());
    await waitFor(() => expect(restoreButton()).toBeDisabled());
    expect(onRestored).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(restoreButton()).toBeEnabled());
  });

  it("all skipped: result-sentence toast (destructive), onRestored is still called (refetch)", async () => {
    stubRestore({ status: 200, body: { restored: [], skipped: [{ id: NOTE_ID, reason: "not_in_trash" }] } });
    const { onRestored } = renderCard();

    fireEvent.click(restoreButton());

    const title = "Restored 0 notes, 1 no longer in the trash";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });

  it("failure (500): error toast, onRestored not called, button usable again", async () => {
    stubRestore({ status: 500, body: { error: { code: "internal", message: "x" } } });
    const { onRestored } = renderCard();

    fireEvent.click(restoreButton());

    const title = "Something went wrong. Please try again.";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    await waitFor(() => expect(restoreButton()).toBeEnabled());
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("go to trash: via actions' showTab, localStorage and the same provider's state are both trash", async () => {
    stubRestore({ status: 200, body: { restored: [], skipped: [] } });
    renderCard();
    expect(screen.getByTestId("tab-probe")).toHaveTextContent("myNotes");

    fireEvent.click(screen.getByRole("button", { name: "Go to trash" }));

    expect(localStorage.getItem("sidebar.tab")).toBe("trash");
    await waitFor(() => expect(screen.getByTestId("tab-probe")).toHaveTextContent("trash"));
  });
});
