import { describe, expect, it, vi } from "vitest";
import { ApiFail } from "@/api/client";
import { classifyAddError, isRateLimited, parseEmailList, runBulkAdd } from "./bulk-add";

describe("parseEmailList", () => {
  it("逗號、分號、空白、換行都能分隔；空段略過", () => {
    expect(parseEmailList(" a@x.com,b@x.com;c@x.com d@x.com\ne@x.com\r\n\tf@x.com ,, ;").emails).toEqual([
      "a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com",
    ]);
  });

  it("大小寫不分去重，保留第一次出現的寫法", () => {
    expect(parseEmailList("Ann@X.com, ann@x.com\nANN@x.COM, bob@x.com").emails).toEqual(["Ann@X.com", "bob@x.com"]);
  });

  it("剝掉信件收件人欄的 <…> 與引號；不像 email 的片段進 invalid（也去重）", () => {
    expect(parseEmailList('"Ann" <ann@x.com>; nope, nope, <bob@x.com>, @x.com')).toEqual({
      emails: ["ann@x.com", "bob@x.com"],
      invalid: ["Ann", "nope", "@x.com"],
    });
  });

  it("空字串 → 什麼都沒有", () => {
    expect(parseEmailList("  \n ")).toEqual({ emails: [], invalid: [] });
  });
});

describe("classifyAddError", () => {
  it("逐項結果略過；其餘停下", () => {
    expect(classifyAddError(new ApiFail(404, "user_not_found", "x"))).toBe("notFound");
    expect(classifyAddError(new ApiFail(409, "already_member", "x"))).toBe("alreadyMember");
    expect(classifyAddError(new ApiFail(400, "invalid_body", "x"))).toBe("invalid");
    expect(classifyAddError(new ApiFail(404, "not_found", "x"))).toBe("stop"); // 群組不見了／我已不是成員
    expect(classifyAddError(new ApiFail(404, "role_not_found", "x"))).toBe("stop"); // 角色被刪
    expect(classifyAddError(new ApiFail(403, "forbidden", "x"))).toBe("stop"); // 管理權被收回
    expect(classifyAddError(new ApiFail(429, "too_many_requests", "x"))).toBe("stop");
    expect(classifyAddError(new ApiFail(500, "internal", "x"))).toBe("stop");
    expect(classifyAddError(new TypeError("Failed to fetch"))).toBe("stop");
  });

  it("isRateLimited 只認 429", () => {
    expect(isRateLimited(new ApiFail(429, "too_many_requests", "x"))).toBe(true);
    expect(isRateLimited(new ApiFail(500, "internal", "x"))).toBe(false);
    expect(isRateLimited(new Error("x"))).toBe(false);
  });
});

describe("runBulkAdd", () => {
  it("依序送出；added／notFound／alreadyMember／invalid 逐項記錄、繼續；onProgress 每項一次", async () => {
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
    });
    expect(onProgress.mock.calls).toEqual([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
  });

  it("非預期錯誤 → 停下：那一項 failed、其後 notProcessed、不再送出", async () => {
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

  it("429 → 停下（不硬跑剩下的），cause 是 429", async () => {
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

  it("網路錯誤（非 ApiFail）也停下", async () => {
    const report = await runBulkAdd(["a@x.com"], () => Promise.reject(new TypeError("Failed to fetch")));
    expect(report.results).toEqual([{ email: "a@x.com", outcome: "failed" }]);
    expect(report.stopped?.cause).toBeInstanceOf(TypeError);
  });
});
