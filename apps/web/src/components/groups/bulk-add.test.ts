import { describe, expect, it, vi } from "vitest";
import { ApiFail } from "@/api/client";
import { classifyAddError, isRateLimited, parseEmailList, runBulkAdd } from "./bulk-add";

describe("parseEmailList", () => {
  it("commas, semicolons, spaces and line breaks all separate; empty segments are skipped", () => {
    expect(parseEmailList(" a@x.com,b@x.com;c@x.com d@x.com\ne@x.com\r\n\tf@x.com ,, ;").emails).toEqual([
      "a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com",
    ]);
  });

  it("case-insensitive dedup, keeping the first spelling", () => {
    expect(parseEmailList("Ann@X.com, ann@x.com\nANN@x.COM, bob@x.com").emails).toEqual(["Ann@X.com", "bob@x.com"]);
  });

  it("strips the <...> and quotes of a mail recipient field (the name does not count); fragments that do not look like an email go to invalid (also deduplicated); all follows input order", () => {
    expect(parseEmailList('"Ann" <ann@x.com>; nope, nope, <bob@x.com>, @x.com')).toEqual({
      emails: ["ann@x.com", "bob@x.com"],
      invalid: ["nope", "@x.com"],
      all: ["ann@x.com", "nope", "bob@x.com", "@x.com"],
    });
  });

  it("pasting `name <address>` from a mail recipient field: the name (including spaces, and quoted names containing commas) is not listed as invalid", () => {
    expect(parseEmailList("Ann Lee <ann@x.com>; Bob Chen <bob@x.com>")).toEqual({
      emails: ["ann@x.com", "bob@x.com"],
      invalid: [],
      all: ["ann@x.com", "bob@x.com"],
    });
    expect(parseEmailList('"Lee, Ann" <ann@x.com>, carol@x.com\nDave <dave@x.com> Erin <erin@x.com>')).toEqual({
      emails: ["ann@x.com", "carol@x.com", "dave@x.com", "erin@x.com"],
      invalid: [],
      all: ["ann@x.com", "carol@x.com", "dave@x.com", "erin@x.com"],
    });
  });

  it("mixing space-separated addresses and `name <address>` in one segment: email-looking text outside the brackets is accepted (in original order), the name is skipped; an empty <> does not swallow the neighbouring address", () => {
    expect(parseEmailList("a@x.com b@x.com Carol <c@x.com>")).toEqual({
      emails: ["a@x.com", "b@x.com", "c@x.com"],
      invalid: [],
      all: ["a@x.com", "b@x.com", "c@x.com"],
    });
    expect(parseEmailList("ann@x.com <>")).toEqual({ emails: ["ann@x.com"], invalid: [], all: ["ann@x.com"] });
  });

  it("in a segment with <...>, text outside the brackets that contains `@` but does not look like an email (a mistyped address) goes to invalid and is not swallowed as a name", () => {
    expect(parseEmailList("bob@@x.com Carol <c@x.com>")).toEqual({
      emails: ["c@x.com"],
      invalid: ["bob@@x.com"],
      all: ["bob@@x.com", "c@x.com"],
    });
    expect(parseEmailList("bob@ Carol <c@x.com>")).toEqual({ emails: ["c@x.com"], invalid: ["bob@"], all: ["bob@", "c@x.com"] });
  });

  it("full-width comma, semicolon, enumeration comma and full-width space also separate (same as the half-width ones)", () => {
    expect(parseEmailList("a@x.com，b@x.com；c@x.com、d@x.com　e@x.com")).toEqual({
      emails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"],
      invalid: [],
      all: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"],
    });
  });

  it("a segment without <...> still splits on whitespace; a lone quoted address is accepted", () => {
    expect(parseEmailList('a@x.com b@x.com, "c@x.com"')).toEqual({
      emails: ["a@x.com", "b@x.com", "c@x.com"],
      invalid: [],
      all: ["a@x.com", "b@x.com", "c@x.com"],
    });
  });

  it("an empty string gives nothing", () => {
    expect(parseEmailList("  \n ")).toEqual({ emails: [], invalid: [], all: [] });
  });
});

describe("classifyAddError", () => {
  it("per-item results are skipped; everything else stops", () => {
    expect(classifyAddError(new ApiFail(404, "user_not_found", "x"))).toBe("notFound");
    expect(classifyAddError(new ApiFail(409, "already_member", "x"))).toBe("alreadyMember");
    expect(classifyAddError(new ApiFail(400, "invalid_body", "x"))).toBe("invalid");
    expect(classifyAddError(new ApiFail(404, "not_found", "x"))).toBe("stop"); // the group is gone / I am no longer a member
    expect(classifyAddError(new ApiFail(404, "role_not_found", "x"))).toBe("stop"); // role deleted
    expect(classifyAddError(new ApiFail(403, "forbidden", "x"))).toBe("stop"); // management rights revoked
    expect(classifyAddError(new ApiFail(429, "too_many_requests", "x"))).toBe("stop");
    expect(classifyAddError(new ApiFail(500, "internal", "x"))).toBe("stop");
    expect(classifyAddError(new TypeError("Failed to fetch"))).toBe("stop");
  });

  it("isRateLimited recognizes only 429", () => {
    expect(isRateLimited(new ApiFail(429, "too_many_requests", "x"))).toBe(true);
    expect(isRateLimited(new ApiFail(500, "internal", "x"))).toBe(false);
    expect(isRateLimited(new Error("x"))).toBe(false);
  });
});

describe("runBulkAdd", () => {
  it("sends in order; added/notFound/alreadyMember/invalid are recorded per item and it continues; onProgress is called once per item", async () => {
    const order: string[] = [];
    const add = vi.fn(async (email: string) => {
      order.push(email);
      if (email === "ghost@x.com") throw new ApiFail(404, "user_not_found", "x");
      if (email === "dup@x.com") throw new ApiFail(409, "already_member", "x");
      if (email === "bad@x") throw new ApiFail(400, "invalid_body", "x");
      return {};
    });
    const onProgress = vi.fn();
    const report = await runBulkAdd(["a@x.com", "ghost@x.com", "dup@x.com", "bad@x", "b@x.com"], add, onProgress);
    expect(order).toEqual(["a@x.com", "ghost@x.com", "dup@x.com", "bad@x", "b@x.com"]);
    expect(report).toEqual({
      results: [
        { email: "a@x.com", outcome: "added" },
        { email: "ghost@x.com", outcome: "notFound" },
        { email: "dup@x.com", outcome: "alreadyMember" },
        { email: "bad@x", outcome: "invalid" },
        { email: "b@x.com", outcome: "added" },
      ],
      stopped: null,
      cancelled: false,
    });
    expect(onProgress.mock.calls).toEqual([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
  });

  it("unexpected error stops: that item is failed, the following are notProcessed and nothing more is sent", async () => {
    const boom = new ApiFail(500, "internal", "x");
    const add = vi.fn(async (email: string) => {
      if (email === "b@x.com") throw boom;
      return {};
    });
    const report = await runBulkAdd(["a@x.com", "b@x.com", "c@x.com", "d@x.com"], add);
    expect(add).toHaveBeenCalledTimes(2);
    expect(report.stopped).toEqual({ cause: boom });
    expect(report.results).toEqual([
      { email: "a@x.com", outcome: "added" },
      { email: "b@x.com", outcome: "failed" },
      { email: "c@x.com", outcome: "notProcessed" },
      { email: "d@x.com", outcome: "notProcessed" },
    ]);
  });

  it("429 stops (does not push through the rest), the cause is 429", async () => {
    const limited = new ApiFail(429, "too_many_requests", "x");
    const add = vi.fn(async (email: string) => {
      if (email !== "a@x.com") throw limited;
      return {};
    });
    const report = await runBulkAdd(["a@x.com", "b@x.com", "c@x.com"], add);
    expect(add).toHaveBeenCalledTimes(2);
    expect(isRateLimited(report.stopped?.cause)).toBe(true);
    expect(report.results.map((r) => r.outcome)).toEqual(["added", "failed", "notProcessed"]);
  });

  it("a network error (not ApiFail) also stops", async () => {
    const report = await runBulkAdd(["a@x.com"], () => Promise.reject(new TypeError("Failed to fetch")));
    expect(report.results).toEqual([{ email: "a@x.com", outcome: "failed" }]);
    expect(report.stopped?.cause).toBeInstanceOf(TypeError);
  });

  it("signal abort (stop button / dialog close / unmount): the one being sent finishes and its result is recorded, nothing is sent after, the rest are recorded as notProcessed, cancelled", async () => {
    const controller = new AbortController();
    const add = vi.fn(async (email: string) => {
      if (email === "b@x.com") {
        controller.abort(); // stop pressed while b is being sent
        throw new ApiFail(404, "user_not_found", "x"); // that item's result is still recorded
      }
      return {};
    });
    const onProgress = vi.fn();
    const report = await runBulkAdd(["a@x.com", "b@x.com", "c@x.com", "d@x.com"], add, onProgress, controller.signal);
    expect(add.mock.calls.map(([email]) => email)).toEqual(["a@x.com", "b@x.com"]);
    expect(report).toEqual({
      results: [
        { email: "a@x.com", outcome: "added" },
        { email: "b@x.com", outcome: "notFound" },
        { email: "c@x.com", outcome: "notProcessed" },
        { email: "d@x.com", outcome: "notProcessed" },
      ],
      stopped: null,
      cancelled: true,
    });
    expect(onProgress.mock.calls).toEqual([[1, 4], [2, 4]]);
  });

  it("aborting at the very start sends nothing; aborting after the last item has been sent does not count as cancelled", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const add = vi.fn(async () => ({}));
    expect(await runBulkAdd(["a@x.com"], add, undefined, aborted.signal)).toEqual({
      results: [{ email: "a@x.com", outcome: "notProcessed" }],
      stopped: null,
      cancelled: true,
    });
    expect(add).not.toHaveBeenCalled();

    const late = new AbortController();
    const report = await runBulkAdd(["a@x.com"], async () => late.abort(), undefined, late.signal);
    expect(report).toEqual({ results: [{ email: "a@x.com", outcome: "added" }], stopped: null, cancelled: false });
  });
});
