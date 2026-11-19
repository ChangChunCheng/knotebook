/**
 * Logs only these fields, never the message: Node's fetch TypeError for `user:pass@` URLs carries the full URL with the password, and
 * credentials in a query can surface in other errors too. `errName` falls back to `constructor.name` (the Anthropic SDK's errors are all
 * named "Error"; SDK 0.116). `causeName` is the first cause level's name, `causeCode` the first string `code` within 3 levels (undici:
 * `cause.code`; Anthropic SDK: `cause.cause`).
 */
export interface FetchErrorSummary {
  errName: string;
  errCode?: string;
  causeName?: string;
  causeCode?: string;
}

const MAX_CAUSE_DEPTH = 3;

function nameOf(err: Error): string {
  return err.name === "Error" && err.constructor.name !== "" ? err.constructor.name : err.name;
}

export function fetchErrorSummary(err: unknown): FetchErrorSummary {
  if (!(err instanceof Error)) return { errName: typeof err };
  const summary: FetchErrorSummary = { errName: nameOf(err) };
  const ownCode = (err as { code?: unknown }).code;
  if (typeof ownCode === "string") summary.errCode = ownCode;

  let cause: unknown = err.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause !== null && typeof cause === "object"; depth += 1) {
    if (depth === 0) {
      const name = cause instanceof Error ? nameOf(cause) : (cause as { name?: unknown }).name;
      if (typeof name === "string") summary.causeName = name;
    }
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") {
      summary.causeCode = code;
      break;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return summary;
}

export function urlHasCredentials(url: string): boolean | undefined {
  try {
    const parsed = new URL(url);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return undefined;
  }
}
