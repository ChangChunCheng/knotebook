import { describe, expect, it } from "vitest";
import { BASIC_STORAGE_QUOTA_BYTES, STORAGE_KINDS, STORAGE_PLAN_NAME_MAX, STORAGE_QUOTA_MAX_BYTES, emptyStorageByKind, formatBytes, kindOfMime } from "./storage.js";
import { ERROR_CODES } from "./index.js";

describe("storage constants", () => {
  it("the 1 PiB cap is a JS safe integer; Basic = 2 GiB; name cap 40", () => {
    expect(STORAGE_QUOTA_MAX_BYTES).toBe(2 ** 50);
    expect(Number.isSafeInteger(STORAGE_QUOTA_MAX_BYTES)).toBe(true);
    expect(BASIC_STORAGE_QUOTA_BYTES).toBe(2 * 1024 ** 3);
    expect(STORAGE_PLAN_NAME_MAX).toBe(40);
  });

  it("the five new error codes are all in ERROR_CODES", () => {
    for (const code of ["storage_quota_exceeded", "storage_plan_in_use", "storage_plan_is_default", "storage_plan_name_taken", "storage_plan_not_found"]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});

describe("formatBytes (1024-based; integers without .0, otherwise one decimal; the server's MCP messages and web share this one)", () => {
  it("0 -> 0 B", () => expect(formatBytes(0)).toBe("0 B"));
  it("1023 -> 1023 B (under 1 KB prints an integer)", () => expect(formatBytes(1023)).toBe("1023 B"));
  it("1024 -> 1 KB (an integer without .0)", () => expect(formatBytes(1024)).toBe("1 KB"));
  it("1536 -> 1.5 KB", () => expect(formatBytes(1536)).toBe("1.5 KB"));
  it("2^31 -> 2 GB (the Basic plan cap)", () => expect(formatBytes(2 ** 31)).toBe("2 GB"));
  it("500 MiB -> 500 MB", () => expect(formatBytes(500 * 1024 ** 2)).toBe("500 MB"));
  it("1288490189 -> 1.2 GB (non-integers get one decimal)", () => expect(formatBytes(1288490189)).toBe("1.2 GB"));
  it("2^50 -> 1024 TB (TB is the largest unit; the quota cap 1125899906842624 = 2^50)", () => expect(formatBytes(2 ** 50)).toBe("1024 TB"));
  it("1048575 -> 1 MB (when rounding carries up to 1024 KB the next unit is used)", () => expect(formatBytes(1048575)).toBe("1 MB"));
  it("1572864 -> 1.5 MB (the web toast example)", () => expect(formatBytes(1572864)).toBe("1.5 MB"));
  it("1048525 -> 1 MB (toFixed(1) of 1023.9502 KB is \"1024.0\" -> switch unit; must not print \"1024 KB\"; 1048524 is \"1023.9\" and does not carry)", () => expect(formatBytes(1048525)).toBe("1 MB"));
});

describe("kindOfMime (#247: the one copy of the classification rules, used by the server's byKind and by web)", () => {
  it("one case per rule", () => {
    const cases: Array<[string, string]> = [
      ["image/png", "image"],
      ["image/svg+xml", "image"],
      ["audio/mpeg", "audio"],
      ["video/mp4", "video"],
      ["application/pdf", "document"],
      ["text/plain", "document"],
      ["text/markdown", "document"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document"],
      ["application/msword", "document"],
      ["application/vnd.ms-excel", "document"],
      ["application/vnd.ms-powerpoint", "document"],
      ["application/rtf", "document"],
    ];
    for (const [mime, kind] of cases) expect(kindOfMime(mime), mime).toBe(kind);
  });

  it("everything else is other: unknown, empty string, only prefix-like, openxml that is not under officedocument", () => {
    for (const mime of ["application/zip", "application/octet-stream", "", "imagex/png", "application/json", "application/vnd.openxmlformats-package.relationships+xml", "application/vnd.ms-word"]) {
      expect(kindOfMime(mime), JSON.stringify(mime)).toBe("other");
    }
  });

  it("case and parameters do not affect classification (take what is before `;`, trim, lower-case)", () => {
    expect(kindOfMime("IMAGE/PNG")).toBe("image");
    expect(kindOfMime("text/plain; charset=utf-8")).toBe("document");
    expect(kindOfMime("  Application/PDF ;x=1")).toBe("document");
    expect(kindOfMime("Audio/OGG")).toBe("audio");
  });

  it("STORAGE_KINDS is the UI's fixed five-row order; emptyStorageByKind returns a new object each call, all five keys 0", () => {
    expect(STORAGE_KINDS).toEqual(["image", "audio", "video", "document", "other"]);
    const a = emptyStorageByKind();
    expect(a).toEqual({ image: 0, audio: 0, video: 0, document: 0, other: 0 });
    a.image = 5;
    expect(emptyStorageByKind().image).toBe(0);
  });
});
