/** #247: a touchLastLogin failure must not block login (the outer catch of the OIDC callback turns any exception into oidc_exchange_failed). */
import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../src/db/index.js";
import { touchLastLogin } from "../../src/auth/last-login.js";

describe("touchLastLogin", () => {
  it("UPDATE throws: not rethrown; log.warn once with an object carrying err and userId", async () => {
    const boom = new Error("db down");
    const db = { execute: () => Promise.reject(boom) } as unknown as Db;
    const warn = vi.fn();
    await expect(touchLastLogin(db, "u-1", { warn } as unknown as FastifyBaseLogger)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ err: boom, userId: "u-1" });
  });

  it("0 rows (row locked, skipped by SKIP LOCKED): doesn't throw; log.warn once with userId; 1 row doesn't warn", async () => {
    const warn = vi.fn();
    const log = { warn } as unknown as FastifyBaseLogger;
    await expect(touchLastLogin({ execute: () => Promise.resolve({ rowCount: 0 }) } as unknown as Db, "u-2", log)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([{ userId: "u-2" }, "last_login_at skipped: row locked"]);
    await touchLastLogin({ execute: () => Promise.resolve({ rowCount: 1 }) } as unknown as Db, "u-3", log);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
