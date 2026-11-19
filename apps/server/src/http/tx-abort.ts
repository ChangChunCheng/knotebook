import type { ErrorCode } from "@knotebook/shared";

/** Thrown inside a transaction: drizzle rolls back only on throw. The field is `errCode` because pg errors carry SQLSTATE in `.code`. */
export class TxAbort extends Error {
  constructor(
    readonly status: number,
    readonly errCode: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TxAbort";
  }
}
