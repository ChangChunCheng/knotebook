import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStaleOneTimeTokens, INVITE_TOKEN_KEY, ONE_TIME_TOKEN_PAGES, readSessionToken, RESET_TOKEN_KEY, writeSessionToken } from "./resetTokenStorage";

describe("clearStaleOneTimeTokens (#286; main.tsx calls it before render)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem(RESET_TOKEN_KEY, "knbp_X");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("the table has knotebook:reset-token for /reset-password", () => {
    expect(ONE_TIME_TOKEN_PAGES).toContainEqual({ path: "/reset-password", key: "knotebook:reset-token" });
  });

  it.each(["/", "/login", "/n/alice/x", "/reset-passwords"])("initial path %s -> key deleted", (pathname) => {
    clearStaleOneTimeTokens(pathname);
    expect(sessionStorage.getItem(RESET_TOKEN_KEY)).toBeNull();
  });

  it.each(["/reset-password", "/reset-password/", "/reset-password//", "/RESET-PASSWORD"])("initial path %s (react-router renders the reset page too) -> kept", (pathname) => {
    clearStaleOneTimeTokens(pathname);
    expect(sessionStorage.getItem(RESET_TOKEN_KEY)).toBe("knbp_X");
  });

  it("leaves other keys alone", () => {
    sessionStorage.setItem("knotebook:chunk-reload:register", "1");
    clearStaleOneTimeTokens("/");
    expect(sessionStorage.getItem("knotebook:chunk-reload:register")).toBe("1");
  });

  it("sessionStorage throws -> doesn't throw", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => clearStaleOneTimeTokens("/")).not.toThrow();
  });
});

describe("clearStaleOneTimeTokens: invite row (#285)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem(INVITE_TOKEN_KEY, "knbi_X");
  });
  afterEach(() => sessionStorage.clear());

  it("the table has knotebook:invite-token for /register", () => {
    expect(ONE_TIME_TOKEN_PAGES).toContainEqual({ path: "/register", key: "knotebook:invite-token" });
  });

  it.each(["/", "/login", "/registerx"])("initial path %s -> invite key deleted", (pathname) => {
    clearStaleOneTimeTokens(pathname);
    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBeNull();
  });

  it.each(["/register", "/register/", "/REGISTER"])("initial path %s -> invite key kept", (pathname) => {
    clearStaleOneTimeTokens(pathname);
    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBe("knbi_X");
  });

  it("the two keys don't affect each other: /reset-password deletes the invite key and keeps the reset key; /register deletes the reset key and keeps the invite key", () => {
    sessionStorage.setItem(RESET_TOKEN_KEY, "knbp_X");
    clearStaleOneTimeTokens("/reset-password");
    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(RESET_TOKEN_KEY)).toBe("knbp_X");
    sessionStorage.setItem(INVITE_TOKEN_KEY, "knbi_X");
    clearStaleOneTimeTokens("/register");
    expect(sessionStorage.getItem(RESET_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBe("knbi_X");
  });
});

describe("readSessionToken / writeSessionToken: don't throw when sessionStorage is unavailable (the page reads in a useState initializer)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("getItem throws -> readSessionToken returns null", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readSessionToken(RESET_TOKEN_KEY)).toBeNull();
  });

  it("setItem throws -> writeSessionToken doesn't throw", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeSessionToken(RESET_TOKEN_KEY, "knbp_X")).not.toThrow();
  });
});
