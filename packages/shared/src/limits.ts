import { UPLOAD_MAX_BYTES_DEFAULT } from "./site-limits.js";

/** Bytes. From the standalone default, not `SITE_LIMITS`: reading the registry at module top level defeats tree-shaking. */
export const MAX_UPLOAD_BYTES: number = UPLOAD_MAX_BYTES_DEFAULT;

/** Counted after dedupe and self-link filtering. */
export const MAX_LINK_TARGETS = 1000;

export const MAX_BACKLINKS = 200;
