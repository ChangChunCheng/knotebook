/**
 * Fixed ids and labels for the versions tests. `vid(seq)`: seq is encoded into the first 4 hex digits (the first 7 characters of the short ids all differ) and into hex digits 1-8 of the last group (the two indexes the name is derived from).
 * e.g. `vid(1)` = `0001aaaa-0000-4000-8000-000100010000`, `vlabel(1)` = `agile-beaver (0001aaa)`, `vlabel(2)` = `amber-bison (0002aaa)`,
 * `vlabel(3)` = `ample-bobcat (0003aaa)`. Assertions go through the `versionLabel` under test (`vlabel`); a test file with vN assertions should also hard-code at least one literal.
 */
import type { VersionBaseRefDto } from "@knotebook/shared";
import type { VersionTarget } from "@/api/versions";
import { versionLabel } from "@/components/versions/version-labels";

export function vid(seq: number): string {
  const h = seq.toString(16).padStart(4, "0");
  return `${h}aaaa-0000-4000-8000-${h}${h}0000`;
}

export function vlabel(seq: number, name: string | null = null): string {
  return versionLabel({ id: vid(seq), name });
}

/** e2e has its own copy of the same `reEscape` (`e2e/tests/helpers.ts`; e2e can't depend on the web package); the two must stay in sync. */
export function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function vrow(seq: number, name: string | null = null): RegExp {
  return new RegExp(`^${reEscape(vlabel(seq, name))}`);
}

export function vtarget(seq: number, name: string | null = null): VersionTarget {
  return { seq, id: vid(seq), name };
}

export function baseRef(seq: number, name: string | null = null): VersionBaseRefDto {
  return { id: vid(seq), name, deleted: false };
}

export function baseRefOrNull(baseSeq: number | null | undefined): VersionBaseRefDto | null {
  return baseSeq === undefined || baseSeq === null ? null : baseRef(baseSeq);
}
