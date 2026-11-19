/** Bytes, not UTF-16 code units: numerically equal to `MD` in notes/schemas.ts but never merge them (262,144 code units of CJK is ~786 KB of UTF-8 and hits this 413 before zod's 400). */

export const WRITE_BODY_LIMIT = 262_144;

/** Same value as WRITE_BODY_LIMIT but a separate name: full parse cost is not linear in size (a 1 MiB file dense in inline formatting takes 9–22 s). */
export const TRANSFER_WRITE_BODY_LIMIT = WRITE_BODY_LIMIT;
