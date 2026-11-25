import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { CommentsProvider, useCommentsController } from "@/lib/comments-context";
import { VersionsProvider, useVersionsController } from "@/lib/versions-context";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { COMMENT_NOTE, createLiveSource, page } from "@/test/comment-fixtures";
import { ThemeProvider } from "@/theme";
import { NoteEditor } from "./NoteEditor";

function json(body: unknown, status = 200): Response {
  return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(json({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
      if (url === `/api/notes/${COMMENT_NOTE}/comments/unread-count`) return Promise.resolve(json({ count: 0 }));
      if (url === `/api/notes/${COMMENT_NOTE}/comments?limit=50`) return Promise.resolve(json(page([1])));
      if (url === `/api/notes/${COMMENT_NOTE}/comments/read` && method === "POST") return Promise.resolve(json(null, 204));
      if (url.startsWith(`/api/knowledge/fields`)) return Promise.resolve(json({ fields: [] }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function Host({ doc, canEdit }: { doc: Y.Doc; canEdit: boolean }) {
  const comments = useCommentsController({ noteId: COMMENT_NOTE, enabled: true, provider: createLiveSource() });
  const versions = useVersionsController({ noteId: COMMENT_NOTE, enabled: canEdit, onOpen: comments.close });
  return (
    <VersionsProvider value={versions}>
      <CommentsProvider value={comments}>
        <button type="button" onClick={() => comments.open()}>host-open-comments</button>
        <NoteEditor doc={doc} provider={{ awareness: null } as never} editable={canEdit} user={{ id: "u-alice", name: "Alice" }} noteId={COMMENT_NOTE} />
      </CommentsProvider>
    </VersionsProvider>
  );
}

async function renderAt(tier: LayoutTier, canEdit = true) {
  stubLayoutTier(tier);
  const doc = new Y.Doc();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Host doc={doc} canEdit={canEdit} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await screen.findByTestId("note-editor");
  return doc;
}

describe("NoteEditor comments panel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens in its own `display: contents` slot in the row container, which also carries the shared width variable; the bubbles go away while it is open", async () => {
    window.localStorage.setItem("versions.panelWidth", "400");
    const doc = await renderAt("docked");
    expect(await screen.findByTestId("comments-bubble")).toBeInTheDocument();
    fireEvent.click(screen.getByText("host-open-comments"));
    const panel = await screen.findByTestId("comments-panel");
    const slot = panel.parentElement!;
    expect(slot).toHaveAttribute("data-comments-panel-slot");
    expect(slot).toHaveClass("contents");
    expect(slot.parentElement!.style.getPropertyValue("--versions-panel-width")).toBe("400px");
    expect(within(panel).getByRole("separator", { name: "Resize comments panel" })).toHaveAttribute("aria-valuenow", "400");
    expect(screen.queryByTestId("corner-stack")).toBeNull();
    expect(document.querySelector("[data-versions-panel-slot]")).toBeNull();
    doc.destroy();
  });

  it("floating tier: Esc inside the panel closes it and focus returns to the comments bubble; Esc in a composer with text keeps it", async () => {
    const doc = await renderAt("overlay");
    fireEvent.click(screen.getByText("host-open-comments"));
    const panel = await screen.findByTestId("comments-panel");
    const box = await within(panel).findByRole("textbox", { name: "Comment" });
    fireEvent.change(box, { target: { value: "draft" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByTestId("comments-panel")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("comments-panel")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("comments-bubble")));
    doc.destroy();
  });

  it("floating tier: pressing on the note doesn't close the comments panel (a passage can be selected while writing)", async () => {
    const doc = await renderAt("overlay");
    fireEvent.click(screen.getByText("host-open-comments"));
    await screen.findByTestId("comments-panel");
    fireEvent.pointerDown(screen.getByTestId("note-editor"));
    expect(screen.getByTestId("comments-panel")).toBeInTheDocument();
    doc.destroy();
  });

  it("a viewer (no version history) still gets the comments bubble", async () => {
    const doc = await renderAt("docked", false);
    const stack = await screen.findByTestId("corner-stack");
    expect(Array.from(stack.children).map((el) => el.getAttribute("data-testid"))).toEqual(["comments-bubble"]);
    doc.destroy();
  });
});
