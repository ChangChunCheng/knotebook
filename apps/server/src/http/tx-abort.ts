import type { ErrorCode } from "@knotebook/shared";

/**
 * Thrown inside a transaction for a rejection: drizzle rolls back only on throw (a normal return always COMMITs). The caller checks
 * instanceof outside the transaction and sends the error. The field is `errCode` because pg errors carry SQLSTATE in `.code`.
 */
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
