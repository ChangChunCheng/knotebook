import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import i18n from "@/i18n";
import { CommentsProvider, useComments, useCommentsController } from "@/lib/comments-context";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { stubLayoutTier } from "@/test/layout-tier";
import { COMMENT_NOTE, createLiveSource, json, stubCommentFetch } from "@/test/comment-fixtures";
import { CornerStack } from "./CornerStack";
import { CORNER_STACK_FOOTPRINT_PX, cornerStackFootprint } from "./corner-stack-geometry";

const UNREAD = `/api/notes/${COMMENT_NOTE}/comments/unread-count`;
const READ = `POST /api/notes/${COMMENT_NOTE}/comments/read`;

function Probe() {
  const v = useVersions();
  const c = useComments();
  return (
    <div>
      <span data-testid="open">{JSON.stringify({ versions: v.panelOpen, comments: c.panelOpen })}</span>
      <button type="button" onClick={() => v.open()}>probe-open-versions</button>
    </div>
  );
}

function Host({ canEdit, children }: { canEdit: boolean; children: ReactNode }) {
  const comments = useCommentsController({ noteId: COMMENT_NOTE, enabled: true, provider: createLiveSource(), onOpen: () => versionsClose() });
  const versions = useVersionsController({ noteId: COMMENT_NOTE, enabled: canEdit, onOpen: comments.close });
  const versionsClose = versions.close;
  return (
    <VersionsProvider value={versions}>
      <CommentsProvider value={comments}>{children}</CommentsProvider>
    </VersionsProvider>
  );
}

function renderStack(canEdit: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Host canEdit={canEdit}>
        <Probe />
        <CornerStack />
      </Host>
    </QueryClientProvider>,
  );
}

const open = () => JSON.parse(screen.getByTestId("open").textContent!) as { versions: boolean; comments: boolean };

describe("CornerStack comments bubble", () => {
  let tier: ReturnType<typeof stubLayoutTier>;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    tier = stubLayoutTier("docked");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("editor: the comments bubble sits above the version history bubble (first child is the bottom one in flex-col-reverse)", async () => {
    stubCommentFetch({ [UNREAD]: json({ count: 0 }) });
    renderStack(true);
    const stack = await screen.findByTestId("corner-stack");
    expect(Array.from(stack.children).map((el) => el.getAttribute("data-testid"))).toEqual(["versions-bubble", "comments-bubble"]);
    expect(stack).toHaveClass("flex-col-reverse");
    expect(screen.getByTestId("comments-bubble")).toHaveAttribute("aria-label", "Comments");
  });

  it("viewer (no version history): only the comments bubble, with this note's unread count; 9+ above nine", async () => {
    stubCommentFetch({ [UNREAD]: json({ count: 3 }) });
    renderStack(false);
    const bubble = await screen.findByTestId("comments-bubble");
    expect(screen.queryByTestId("versions-bubble")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("comments-unread")).toHaveTextContent("3"));
    expect(screen.getByTestId("comments-unread")).toHaveAttribute("aria-hidden", "true");
    expect(bubble).toHaveAttribute("aria-label", "Comments (3)");
  });

  it("an unread count over nine reads 9+", async () => {
    stubCommentFetch({ [UNREAD]: json({ count: 12 }) });
    renderStack(false);
    await waitFor(() => expect(screen.getByTestId("comments-unread")).toHaveTextContent("9+"));
  });

  it("phone: no bubbles at all", () => {
    act(() => tier.setLayoutTier("phone"));
    stubCommentFetch({ [UNREAD]: json({ count: 1 }) });
    renderStack(true);
    expect(screen.queryByTestId("corner-stack")).toBeNull();
  });

  it("clicking opens the comments panel and the stack hides; opening version history closes the comments panel (one right-hand panel at a time)", async () => {
    stubCommentFetch({ [UNREAD]: json({ count: 0 }), [READ]: json(null, 204) });
    renderStack(true);
    fireEvent.click(await screen.findByTestId("comments-bubble"));
    expect(open()).toEqual({ versions: false, comments: true });
    expect(screen.queryByTestId("corner-stack")).toBeNull();
    fireEvent.click(screen.getByText("probe-open-versions"));
    expect(open()).toEqual({ versions: true, comments: false });
  });

  it("geometry: the footprint grows by one bubble and the gap per extra bubble", () => {
    expect(cornerStackFootprint(0)).toBe(0);
    expect(cornerStackFootprint(1)).toBe(CORNER_STACK_FOOTPRINT_PX);
    expect(cornerStackFootprint(2)).toBe(18 + 48 + 12 + 48);
  });
});
