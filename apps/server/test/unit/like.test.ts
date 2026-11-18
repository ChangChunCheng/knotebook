import { describe, expect, it } from "vitest";
import { escapeLike } from "../../src/db/like.js";

describe("escapeLike", () => {
  it("escapes \\, % and _", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });
});
