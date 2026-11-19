/** #200: upload_id accepts a bare UUID or exactly /api/uploads/<uuid>, transformed into a lowercase bare id; other forms and NUL are rejected. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UPLOAD_ID } from "../../src/mcp/tools/read-note-image.js";

describe("#200 upload_id schema", () => {
  const id = randomUUID();
  it.each([
    ["bare", id],
    ["prefix", `/api/uploads/${id}`],
    ["uppercase", id.toUpperCase()],
    ["prefix + uppercase", `/api/uploads/${id.toUpperCase()}`],
  ])("%s -> accepted and transformed into a lowercase bare id", (_l, input) => {
    const r = UPLOAD_ID.safeParse(input);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(id);
  });
  it.each([
    ["extra segment at the end", `/api/uploads/${id}/x`],
    ["absolute URL", `https://example.com/api/uploads/${id}`],
    ["contains NUL", `${id}${String.fromCharCode(0)}`],
    ["empty string", ""],
  ])("%s -> rejected", (_l, input) => {
    expect(UPLOAD_ID.safeParse(input).success).toBe(false);
  });
});
