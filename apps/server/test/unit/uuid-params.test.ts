import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { LOWERCASED_PARAMS, lowercaseUuidParams } from "../../src/http/uuid-params.js";

const run = async (params: Record<string, unknown>) => {
  await lowercaseUuidParams({ params } as unknown as FastifyRequest);
  return params;
};

describe("#240: lowercaseUuidParams", () => {
  it("the parameter list is exactly id and userId", () => {
    expect([...LOWERCASED_PARAMS]).toEqual(["id", "userId"]);
  });

  it("upper-case and mixed-case UUIDs in id / userId are lowercased", async () => {
    const a = randomUUID();
    const b = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const mixed = "0F8fAd5B-d9Cb-469F-a165-70867728950E"; // hard-coded: guarantees it really is mixed case
    expect(await run({ id: a.toUpperCase(), userId: mixed })).toEqual({ id: a, userId: b });
  });

  it("non-UUID values are unchanged; parameters outside the list are unchanged even if UUID-shaped", async () => {
    const u = randomUUID().toUpperCase();
    const p = { id: "NOT-A-UUID", userId: `${u}x`, ref: u, handle: u, slug: u, editId: u, groupId: u };
    expect(await run({ ...p })).toEqual(p);
  });

  it("no params (the 404 handler's `{'*': ...}`, a route without parameters) does not throw", async () => {
    expect(await run({ "*": "nope" })).toEqual({ "*": "nope" });
    await expect(lowercaseUuidParams({ params: undefined } as unknown as FastifyRequest)).resolves.toBeUndefined();
  });
});
