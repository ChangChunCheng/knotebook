import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { avatarUrl, type VersionEditorDto } from "@knotebook/shared";
import { EditorAvatars } from "./EditorAvatars";

const ID_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID_B = "1f8fad5b-d9cb-469f-a165-70867728950e";

const ed = (handle: string, over: Partial<VersionEditorDto> = {}): VersionEditorDto => ({ handle, agentLabel: null, avatar: null, ...over });

function group(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}
function circles(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>("[data-editor-avatar]"));
}

describe("EditorAvatars", () => {
  it("1 person: one avatar, no +N; the whole block is aria-hidden", () => {
    const { container } = render(<EditorAvatars editors={[ed("alice")]} />);
    expect(group(container)).toHaveAttribute("aria-hidden", "true");
    expect(circles(group(container))).toHaveLength(1);
    expect(group(container).textContent).toBe("A");
  });

  it("3 people: three avatars, no +N; same order as the input", () => {
    const { container } = render(<EditorAvatars editors={[ed("alice"), ed("bob"), ed("carol")]} />);
    const els = circles(group(container));
    expect(els.map((e) => e.textContent)).toEqual(["A", "B", "C"]);
    expect(group(container).textContent).toBe("ABC");
  });

  it("5 people: the first three avatars plus +2 (plain text, aria-hidden)", () => {
    const { container } = render(<EditorAvatars editors={["alice", "bob", "carol", "dave", "erin"].map((h) => ed(h))} />);
    const els = circles(group(container));
    expect(els.map((e) => e.textContent)).toEqual(["A", "B", "C"]);
    const more = Array.from(group(container).querySelectorAll("span")).find((s) => s.textContent === "+2");
    expect(more).toBeTruthy();
    expect(more).toHaveAttribute("aria-hidden", "true");
  });

  it("the same handle appearing as both a person and an agent -> drawn once", () => {
    const { container } = render(
      <EditorAvatars editors={[ed("alice", { avatar: { id: ID_A, v: 1 } }), ed("alice", { agentLabel: "claude", avatar: { id: ID_A, v: 1 } }), ed("bob")]} />,
    );
    const els = circles(group(container));
    expect(els).toHaveLength(2);
    expect(group(container).querySelectorAll("img")).toHaveLength(1);
  });

  it("the limit applies after deduplication: 4 entries with 2 sharing a handle -> 3 avatars, no +N", () => {
    const { container } = render(<EditorAvatars editors={[ed("alice"), ed("alice", { agentLabel: "x" }), ed("bob"), ed("carol")]} />);
    expect(circles(group(container))).toHaveLength(3);
    expect(group(container).textContent).not.toContain("+");
  });

  it("two deleted users (empty-string handle) merge into one ? placeholder with no img", () => {
    const { container } = render(<EditorAvatars editors={[ed(""), ed("")]} />);
    const els = circles(group(container));
    expect(els).toHaveLength(1);
    expect(els[0]!.textContent).toBe("?");
    expect(container.querySelector("img")).toBeNull();
  });

  it("an agent editor draws its own avatar picture (img, src via avatarUrl), not the AI icon", () => {
    const { container } = render(<EditorAvatars editors={[ed("alice", { agentLabel: "claude", avatar: { id: ID_B, v: 3 } })]} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(avatarUrl(ID_B, 3));
    expect(container.querySelector("svg")).toBeNull();
  });

  it("missing avatar field (old server) -> first letter, no throw", () => {
    const legacy = { handle: "alice", agentLabel: null } as unknown as VersionEditorDto;
    const { container } = render(<EditorAvatars editors={[legacy]} />);
    expect(container.querySelector("img")).toBeNull();
    expect(group(container).textContent).toBe("A");
  });

  it("no editors -> nothing rendered", () => {
    const { container } = render(<EditorAvatars editors={[]} />);
    expect(container.firstElementChild).toBeNull();
  });
});
