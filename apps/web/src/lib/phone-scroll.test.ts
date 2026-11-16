import { describe, expect, it } from "vitest";
import { createPhoneScrollMemory, enterPhoneScreen, phoneScreenKey, rememberPhoneScroll, type PhoneScreen } from "./phone-scroll";

const LIST: PhoneScreen = { kind: "list" };
const SEARCH: PhoneScreen = { kind: "search" };
const note = (path: string): PhoneScreen => ({ kind: "note", path });

describe("phone-scroll：手機換畫面時文件捲到哪", () => {
  it("剛進手機寬度（沒有上一個畫面）：不動", () => {
    const memory = createPhoneScrollMemory();
    expect(enterPhoneScreen(memory, null, LIST, null)).toBeNull();
    expect(enterPhoneScreen(memory, null, note("/n/a/x"), null)).toBeNull();
    expect(enterPhoneScreen(memory, null, SEARCH, null)).toBeNull();
  });

  it("清單 → 筆記從頂端開始；筆記 → 清單回到離開時的位置", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, LIST, 640);
    expect(enterPhoneScreen(memory, LIST, note("/n/a/x"), null)).toBe(0);
    rememberPhoneScroll(memory, note("/n/a/x"), 1200);
    expect(enterPhoneScreen(memory, note("/n/a/x"), LIST, null)).toBe(640);
  });

  it("同一個畫面：不動（清單上換了 modal 路徑、同一篇換了 hash）", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, LIST, 300);
    expect(enterPhoneScreen(memory, LIST, LIST, null)).toBeNull();
    expect(enterPhoneScreen(memory, note("/n/a/x"), note("/n/a/x"), null)).toBeNull();
    expect(enterPhoneScreen(memory, SEARCH, SEARCH, null)).toBeNull();
  });

  it("筆記 → 另一篇：頂端；同一篇改了網址（收斂）：不動", () => {
    const memory = createPhoneScrollMemory();
    expect(enterPhoneScreen(memory, note("/n/a/x"), note("/n/a/y"), null)).toBe(0);
    expect(enterPhoneScreen(memory, note("/n/a/x"), note("/n/a/renamed"), "/n/a/x")).toBeNull();
  });

  it("清單 → 搜尋層：頂端；Cancel 回清單：回到原位", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, LIST, 480);
    expect(enterPhoneScreen(memory, LIST, SEARCH, null)).toBe(0);
    // 搜尋層裡的捲動不記成清單的位置。
    rememberPhoneScroll(memory, SEARCH, 900);
    expect(enterPhoneScreen(memory, SEARCH, LIST, null)).toBe(480);
  });

  it("搜尋層蓋在筆記上：Cancel（同一篇）回到那篇原本的位置；點到同一篇（網址相同）也是", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, note("/n/a/x"), 1500);
    expect(enterPhoneScreen(memory, note("/n/a/x"), SEARCH, null)).toBe(0);
    rememberPhoneScroll(memory, SEARCH, 200);
    expect(enterPhoneScreen(memory, SEARCH, note("/n/a/x"), null)).toBe(1500);
  });

  it("搜尋層蓋在筆記上、點了別篇：頂端；之後再從清單開搜尋層、點回原來那篇：頂端（舊位置不沿用）", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, note("/n/a/x"), 1500);
    enterPhoneScreen(memory, note("/n/a/x"), SEARCH, null);
    expect(enterPhoneScreen(memory, SEARCH, note("/n/a/y"), null)).toBe(0);
    rememberPhoneScroll(memory, note("/n/a/y"), 0);
    expect(enterPhoneScreen(memory, note("/n/a/y"), LIST, null)).toBe(0);
    expect(enterPhoneScreen(memory, LIST, SEARCH, null)).toBe(0);
    expect(enterPhoneScreen(memory, SEARCH, note("/n/a/x"), null)).toBe(0);
  });

  it("搜尋層蓋在筆記上時按系統返回到清單：回到清單的位置", () => {
    const memory = createPhoneScrollMemory();
    rememberPhoneScroll(memory, LIST, 360);
    enterPhoneScreen(memory, LIST, note("/n/a/x"), null);
    rememberPhoneScroll(memory, note("/n/a/x"), 700);
    enterPhoneScreen(memory, note("/n/a/x"), SEARCH, null);
    expect(enterPhoneScreen(memory, SEARCH, LIST, null)).toBe(360);
  });

  it("phoneScreenKey：筆記帶路徑，其他只看種類；沒有畫面是空字串", () => {
    expect(phoneScreenKey(null)).toBe("");
    expect(phoneScreenKey(LIST)).toBe("list");
    expect(phoneScreenKey(SEARCH)).toBe("search");
    expect(phoneScreenKey(note("/n/a/x"))).toBe("note:/n/a/x");
  });
});
