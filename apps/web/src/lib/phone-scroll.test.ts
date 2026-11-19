import { describe, expect, it } from "vitest";
import { createPhoneScrollMemory, enterPhoneScreen, phoneScreenKey, rememberPhoneScroll, type PhoneScreen } from "./phone-scroll";

const LIST: PhoneScreen = { kind: "list" };
const SEARCH: PhoneScreen = { kind: "search" };
const note = (path: string): PhoneScreen => ({ kind: "note", path });

describe("phone-scroll: where the document scrolls when the phone changes screen", () => {
  it("just entered phone width (no previous screen): unchanged", () => {
    const memory = createPhoneScrollMemory();
    expect(enterPhoneScreen(memory, null, LIST, null)).toBeNull();
    expect(enterPhoneScreen(memory, null, note("/n/a/x"), null)).toBeNull();
    expect(enterPhoneScreen(memory, null, SEARCH, null)).toBeNull();
  });

  it("list -> note starts at the top; note -> list returns to where it was left", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, LIST, 640);
    expect(enterPhoneScreen(memory, LIST, note("/n/a/x"), null)).toBe(0);
    rememberPhoneScroll(memory, note("/n/a/x"), 1200);
    expect(enterPhoneScreen(memory, note("/n/a/x"), LIST, null)).toBe(640);
  });

  it("same screen: unchanged (modal path changed on the list, hash changed on the same note)", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, LIST, 300);
    expect(enterPhoneScreen(memory, LIST, LIST, null)).toBeNull();
    expect(enterPhoneScreen(memory, note("/n/a/x"), note("/n/a/x"), null)).toBeNull();
    expect(enterPhoneScreen(memory, SEARCH, SEARCH, null)).toBeNull();
  });

  it("note -> another note: top; same note with a changed URL (convergence): unchanged", () => {
    const memory = createPhoneScrollMemory();
    expect(enterPhoneScreen(memory, note("/n/a/x"), note("/n/a/y"), null)).toBe(0);
    expect(enterPhoneScreen(memory, note("/n/a/x"), note("/n/a/renamed"), "/n/a/x")).toBeNull();
  });

  it("list -> search layer: top; Cancel back to the list: returns to the original position", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, LIST, 480);
    expect(enterPhoneScreen(memory, LIST, SEARCH, null)).toBe(0);
    // Scrolling inside the search layer is not recorded as the list's position.
    rememberPhoneScroll(memory, SEARCH, 900);
    expect(enterPhoneScreen(memory, SEARCH, LIST, null)).toBe(480);
  });

  it("search layer over a note: Cancel (same note) returns to that note's original position; so does clicking the same note (same URL)", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, note("/n/a/x"), 1500);
    expect(enterPhoneScreen(memory, note("/n/a/x"), SEARCH, null)).toBe(0);
    rememberPhoneScroll(memory, SEARCH, 200);
    expect(enterPhoneScreen(memory, SEARCH, note("/n/a/x"), null)).toBe(1500);
  });

  it("search layer over a note, clicking another note: top; later opening the search layer from the list and clicking the original note: top (the old position is not reused)", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, note("/n/a/x"), 1500);
    enterPhoneScreen(memory, note("/n/a/x"), SEARCH, null);
    expect(enterPhoneScreen(memory, SEARCH, note("/n/a/y"), null)).toBe(0);
    rememberPhoneScroll(memory, note("/n/a/y"), 0);
    expect(enterPhoneScreen(memory, note("/n/a/y"), LIST, null)).toBe(0);
    expect(enterPhoneScreen(memory, LIST, SEARCH, null)).toBe(0);
    expect(enterPhoneScreen(memory, SEARCH, note("/n/a/x"), null)).toBe(0);
  });

  it("system back from a search layer over a note to the list: returns to the list's position", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, LIST, 360);
    enterPhoneScreen(memory, LIST, note("/n/a/x"), null);
    rememberPhoneScroll(memory, note("/n/a/x"), 700);
    enterPhoneScreen(memory, note("/n/a/x"), SEARCH, null);
    expect(enterPhoneScreen(memory, SEARCH, LIST, null)).toBe(360);
  });

  it("phoneScreenKey: notes carry the path, others look at the kind only; no screen is an empty string", () => {
    expect(phoneScreenKey(null)).toBe("");
    expect(phoneScreenKey(LIST)).toBe("list");
    expect(phoneScreenKey(SEARCH)).toBe("search");
    expect(phoneScreenKey(note("/n/a/x"))).toBe("note:/n/a/x");
  });
});
