import { describe, expect, it } from "vitest";
import {
  foreignKeyViolationConstraint,
  isFolderSpaceViolation,
  isLockTimeout,
  isNoteFolderSpaceViolation,
  isRetryableTxError,
  notNullViolationColumn,
} from "../../src/db/pg-errors.js";

// Both error shapes must be recognised: node-postgres native, and drizzle 0.44's DrizzleQueryError, which keeps the original error under `.cause`.
const wrap = (e: object) => new Error("Failed query", { cause: e });

describe("pg-errors: quota-related predicates", () => {
  it("isLockTimeout recognises only 55P03; isRetryableTxError recognises 40001/40P01/55P03", () => {
    expect(isLockTimeout({ code: "55P03" })).toBe(true);
    expect(isLockTimeout(wrap({ code: "55P03" }))).toBe(true);
    expect(isLockTimeout({ code: "40P01" })).toBe(false);
    for (const code of ["40001", "40P01", "55P03"]) {
      expect(isRetryableTxError({ code }), code).toBe(true);
      expect(isRetryableTxError(wrap({ code })), `wrapped ${code}`).toBe(true);
    }
    expect(isRetryableTxError({ code: "23503" })).toBe(false);
    expect(isRetryableTxError(new Error("x"))).toBe(false);
  });

  it("foreignKeyViolationConstraint: 23503 returns the constraint name (both shapes), other codes return null", () => {
    expect(foreignKeyViolationConstraint({ code: "23503", constraint: "users_storage_plan_fk" })).toBe("users_storage_plan_fk");
    expect(foreignKeyViolationConstraint(wrap({ code: "23503", constraint: "groups_storage_plan_fk" }))).toBe("groups_storage_plan_fk");
    expect(foreignKeyViolationConstraint({ code: "23505", constraint: "x" })).toBeNull();
    expect(foreignKeyViolationConstraint({ code: "23503" })).toBeNull();
  });

  it("notNullViolationColumn: 23502 returns the column name (both shapes), other codes return null", () => {
    expect(notNullViolationColumn({ code: "23502", column: "storage_plan_id" })).toBe("storage_plan_id");
    expect(notNullViolationColumn(wrap({ code: "23502", column: "storage_plan_id" }))).toBe("storage_plan_id");
    expect(notNullViolationColumn({ code: "23503", column: "storage_plan_id" })).toBeNull();
  });
});

describe("pg-errors: folder trigger predicates", () => {
  it("isNoteFolderSpaceViolation recognises KF001 (native and drizzle shapes)", () => {
    expect(isNoteFolderSpaceViolation({ code: "KF001" })).toBe(true);
    expect(isNoteFolderSpaceViolation(Object.assign(new Error(), { cause: { code: "KF001" } }))).toBe(true);
  });

  it("isFolderSpaceViolation recognises KF001/KF002/KF003 (both shapes); KF002/KF003 are not isNoteFolderSpaceViolation", () => {
    for (const code of ["KF001", "KF002", "KF003"]) {
      expect(isFolderSpaceViolation({ code }), code).toBe(true);
      expect(isFolderSpaceViolation(Object.assign(new Error(), { cause: { code } })), `wrapped ${code}`).toBe(true);
    }
    for (const code of ["KF002", "KF003"]) {
      expect(isNoteFolderSpaceViolation({ code }), code).toBe(false);
      expect(isNoteFolderSpaceViolation(Object.assign(new Error(), { cause: { code } })), `wrapped ${code}`).toBe(false);
    }
  });

  it("23503 is false for both", () => {
    for (const err of [{ code: "23503" }, Object.assign(new Error(), { cause: { code: "23503" } })]) {
      expect(isNoteFolderSpaceViolation(err)).toBe(false);
      expect(isFolderSpaceViolation(err)).toBe(false);
    }
  });
});
