/**
 * Dates always use the existing absolute format (`formatDate` in `settings/ApiTokensSection.tsx`, i.e. `toLocaleDateString(i18n.language)`): the repo has no relative-time helper (no `Intl.RelativeTimeFormat`).
 * Assertions compare the full formatted string, not a prefix: a prefix check would stay green if the code switched to an unreviewed format.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { LastEditedLabel } from "./LastEditedLabel";
import { OWNER_PERMS } from "@/test/fixtures";

const NOTE: NoteDto = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const AT = "2026-02-03T04:05:06.000Z";
const fmt = (iso: string) => new Date(iso).toLocaleDateString(i18n.language);
const full = (iso: string) => new Date(iso).toLocaleString(i18n.language);

describe("LastEditedLabel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("renders no node when lastEdited is null", () => {
    const { container } = render(<LastEditedLabel note={{ ...NOTE, lastEdited: null }} onOpenEdits={vi.fn()} />);
    expect(screen.queryByTestId("last-edited")).toBeNull();
    // The separator shares the same null condition: it must not be left behind as a lone line.
    expect(container.firstChild).toBeNull();
  });

  it("human: prefix + handle + date, not a button; title is the full string including who (lastEditedAt)", () => {
    render(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "alice", agentLabel: null } }}
        onOpenEdits={vi.fn()}
      />,
    );
    const el = screen.getByTestId("last-edited");
    expect(el.textContent).toBe(`Last edited by alice · ${fmt(AT)}`);
    expect(el.tagName).not.toBe("BUTTON");
    expect(el.getAttribute("title")).toBe(i18n.t("note.lastEditedAt", { who: "alice", when: full(AT) }));
  });

  it("AI: handle (label) + date, is a button, pressing it calls onOpenEdits", () => {
    const open = vi.fn();
    render(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "alice", agentLabel: "claude" } }}
        onOpenEdits={open}
      />,
    );
    const btn = screen.getByRole("button", { name: /alice \(claude\)/ });
    expect(btn.textContent).toBe(`Last edited by alice (claude) · ${fmt(AT)}`);
    // The AI shape is the clickable one, so its tooltip has one more sentence than the human lastEditedAt ("click to see what changed"),
    // explaining what pressing does.
    expect(btn.getAttribute("title")).toBe(i18n.t("note.lastEditedTitle", { who: "alice (claude)", when: full(AT) }));
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledTimes(1);
  });

  // A narrow window must match the ConnectionBadge in the same header: sr-only on phone width or when the header is under 36rem
  // (readable by screen readers, visually hidden), not hidden (display:none removes it from the accessibility tree).
  // Both shapes (human span, AI button) are covered.
  it("narrow window: max-sm:sr-only and @max-[36rem]:sr-only (not hidden), for both shapes", () => {
    const { rerender } = render(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "alice", agentLabel: null } }}
        onOpenEdits={vi.fn()}
      />,
    );
    const humanEl = screen.getByTestId("last-edited");
    expect(humanEl).toHaveClass("max-sm:sr-only", "@max-[36rem]:sr-only");
    expect(humanEl.className).not.toContain("hidden");
    expect(humanEl.className).not.toContain("sm:inline");

    rerender(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "alice", agentLabel: "claude" } }}
        onOpenEdits={vi.fn()}
      />,
    );
    const aiEl = screen.getByTestId("last-edited");
    expect(aiEl).toHaveClass("max-sm:sr-only", "@max-[36rem]:sr-only");
    expect(aiEl.className).not.toContain("hidden");
    expect(aiEl.className).not.toContain("sm:inline");
  });

  // Class assertion, not behaviour: jsdom has no CSS or layout, so only the class strings are pinned.
  it("separator and shrinkability (class assertions; jsdom has no CSS or layout): both shapes", () => {
    const { rerender } = render(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "alice", agentLabel: null } }}
        onOpenEdits={vi.fn()}
      />,
    );
    for (const agentLabel of [null, "claude"]) {
      rerender(
        <LastEditedLabel
          note={{ ...NOTE, lastEdited: { at: AT, byHandle: "alice", agentLabel } }}
          onOpenEdits={vi.fn()}
        />,
      );
      const label = screen.getByTestId("last-edited");
      const sep = label.previousElementSibling;
      expect(sep).not.toBeNull();
      expect(sep).toHaveAttribute("aria-hidden", "true");
      expect(sep).toHaveClass("h-4", "w-px", "bg-border", "max-sm:hidden", "@max-[36rem]:hidden");
      expect(label).toHaveClass("min-w-0", "truncate");
      expect(label).not.toHaveClass("shrink-0");
    }
  });

  it("deleted account (byHandle is an empty string): who becomes 'a deleted account'", () => {
    render(
      <LastEditedLabel
        note={{ ...NOTE, lastEdited: { at: AT, byHandle: "", agentLabel: null } }}
        onOpenEdits={vi.fn()}
      />,
    );
    expect(screen.getByTestId("last-edited").textContent).toBe(`Last edited by a deleted account · ${fmt(AT)}`);
  });
});
