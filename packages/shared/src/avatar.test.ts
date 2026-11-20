import { describe, expect, it } from "vitest";
import {
  AVATAR_DISPLAY_SIZE,
  AVATAR_MIME_TYPES,
  MAX_AVATAR_DISPLAY_BYTES,
  MAX_OIDC_AVATAR_BYTES,
  avatarUrl,
  parseAvatarRef,
} from "./avatar.js";

const id = "0f0e1d2c-3b4a-4958-8677-665544332211";

describe("avatarUrl", () => {
  it("carries the ?v= version", () => {
    expect(avatarUrl(id, 3)).toBe(`/api/avatars/${id}?v=3`);
  });
  it("id goes through encodeURIComponent", () => {
    expect(avatarUrl("a/b", 1)).toBe("/api/avatars/a%2Fb?v=1");
  });
});

describe("parseAvatarRef valid", () => {
  it("lower-case uuid unchanged", () => {
    expect(parseAvatarRef({ id, v: 1 })).toEqual({ id, v: 1 });
  });
  it("upper-case uuid lowercased", () => {
    expect(parseAvatarRef({ id: id.toUpperCase(), v: 7 })).toEqual({ id, v: 7 });
  });
  it("extra fields ignored; only id and v returned", () => {
    const r = parseAvatarRef({ id, v: 2, extra: "x", url: "https://evil" });
    expect(r).toEqual({ id, v: 2 });
    expect(Object.keys(r!).sort()).toEqual(["id", "v"]);
  });
});

describe("parseAvatarRef returns null", () => {
  it.each<[string, unknown]>([
    ["https URL", "https://example.com/a.png"],
    ["javascript:", "javascript:alert(1)"],
    ["in-site URL string", `/api/avatars/${id}?v=1`],
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["array", []],
    ["empty object", {}],
    ["id is not a uuid", { id: "x", v: 1 }],
    ["id path traversal", { id: "../../api/auth/me", v: 1 }],
    ["id prefix traversal", { id: "../" + id, v: 1 }],
    ["id suffix", { id: id + "/x", v: 1 }],
    ["id is an array", { id: [id], v: 1 }],
    ["missing v", { id }],
    ["missing id", { v: 1 }],
    ["v=0", { id, v: 0 }],
    ["v=-1", { id, v: -1 }],
    ["v=1.5", { id, v: 1.5 }],
    ["v=1e300", { id, v: 1e300 }],
    ["v=NaN", { id, v: Number.NaN }],
    ["v=Infinity", { id, v: Infinity }],
    ["v is a string", { id, v: "1" }],
    ["id is a number", { id: 123, v: 1 }],
  ])("%s", (_name, input) => {
    expect(parseAvatarRef(input)).toBeNull();
  });
});

describe("avatar constants", () => {
  it("literal values", () => {
    expect(MAX_AVATAR_DISPLAY_BYTES).toBe(262144);
    expect(AVATAR_DISPLAY_SIZE).toBe(256);
    expect(MAX_OIDC_AVATAR_BYTES).toBe(1048576);
  });
  it("acceptable original image MIME types are png/jpeg/webp, not gif", () => {
    expect([...AVATAR_MIME_TYPES]).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(AVATAR_MIME_TYPES).not.toContain("image/gif" as never);
  });
});
