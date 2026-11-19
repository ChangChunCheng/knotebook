// Single source for request string schemas (format guard, then NUL rejection, so request strings never reach SQL unchecked); MCP reuses them, and a route→route dependency would couple route modules. `MD`'s `.max(262_144)` and the `POST /edits` bodyLimit are the same number in different units (UTF-16 units vs bytes); both are needed. `NOTE_ID` needs `UUID_RE` from `notes/service.ts`, so this isn't a pure leaf.
import { z } from "zod";
import { SECTION_ID_RE } from "@knotebook/shared";
import { UUID_RE } from "./service.js";

export const NUL = String.fromCharCode(0);
export const noNul = (s: string) => !s.includes(NUL);
// `.refine` must come after `.regex`/`.max`: it returns ZodEffects.

// `.refine()` always last (ZodEffects has no `.regex`/`.max`; the wrong order throws at import and the server won't start). The noNul refines on `SEC`, `FP` and `NOTE_ID` are covered by their character sets today and no test can fail without them: a deliberate second layer in case the sets are loosened. `MD`'s is the only one with a test.
export const MD = z.string().max(262_144).refine(noNul);
export const FP = z.string().regex(/^[0-9a-f]{16}$/).refine(noNul);
export const SEC = z.string().max(64).regex(SECTION_ID_RE).refine(noNul);

export const TITLE = z.string().min(1).refine(noNul);

/** Not authorization: the format guard only keeps garbage out of uuid columns (`22P02` → 500). `.transform` lowercases (#240): live docs, presence, the write queue and version state are keyed by lowercase, so an uppercase id would hit another one; handler `toLowerCase()` calls are defensive. */
export const NOTE_ID = z.string().regex(UUID_RE).refine(noNul).transform(s => s.toLowerCase());

/** Shared by REST and MCP; no `.optional()` (callers add it); any case accepted. No `.refine(noNul)`: the uuid format already excludes NUL. Format only; membership is decided by `loadCreateTarget`. */
export const GROUP_ID = z.string().uuid();

// `.strict()`: unknown keys are a 400, so a mistyped `content` (`contents`/`body`) doesn't silently create an empty note. `title` gets `.refine(noNul)`: a NUL title reached pg text columns (22021) → 500. `folderId` is deliberately not `z.string().uuid()`: a non-UUID folder id must 404 `folder_not_found` like a missing one; the route checks `UUID_RE`.
export const createBodySchema = z
  .object({ title: TITLE.optional(), content: MD.optional(), groupId: GROUP_ID.optional(), folderId: z.string().optional() })
  .strict();

// The per-op required-field matrix lives only here (REST and MCP share it). `append`'s `if_match` is optional (absent skips the check); the other four ops require it. MCP must conditionally spread keys: `.strict()` checks `Object.keys`, so `{op:"append", section_id: undefined}` is `unrecognized_keys` (guard: `mcp-edit-note.test.ts`).
export const editBodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace_all"), markdown: MD, if_match: FP }).strict(),
  z.object({ op: z.literal("replace_section"), section_id: SEC, markdown: MD, if_match: FP }).strict(),
  z.object({ op: z.literal("insert_after"), section_id: SEC, markdown: MD, if_match: FP }).strict(),
  z.object({ op: z.literal("append"), markdown: MD, if_match: FP.optional() }).strict(),
  z.object({ op: z.literal("delete_section"), section_id: SEC, if_match: FP }).strict(),
]);

// At least one of title/slug is required (else 400 `invalid_body`); a string slug is normalized by `prepareSlugForPatch`. `slug: null` clears the custom URL name, undefined leaves it alone (`nullable().optional()`, not `nullable()` alone). The inner object is exported for the same-source assertion in `mcp-write-schemas.test.ts` (a ZodEffects has no `.shape`).
// Intentionally not `.strict()`: unknown keys are stripped.
export const updateBodyObject = z.object({
  title: TITLE.optional(),
  slug: z.string().nullable().optional(),
});
export const updateBodySchema = updateBodyObject.refine(b => b.title !== undefined || b.slug !== undefined, {
  message: "Invalid request body: send at least one of title and slug.",
});
