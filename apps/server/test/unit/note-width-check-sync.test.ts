/**
 * note-width: the allowed values of notes_public_width_chk equal NOTE_WIDTHS. Reads the snapshot of the journal's last entry (so renumbering migrations needs no change here).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOTE_WIDTHS } from "@knotebook/shared";

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as { entries: { idx: number }[] };
const lastIdx = journal.entries.at(-1)!.idx;
const snapshot = JSON.parse(
  readFileSync(path.join(drizzleDir, `meta/${String(lastIdx).padStart(4, "0")}_snapshot.json`), "utf8")
) as { tables: Record<string, { checkConstraints?: Record<string, { value: string }> }> };

describe("note-width: public_width CHECK matches NOTE_WIDTHS", () => {
  it("notes_public_width_chk matches NOTE_WIDTHS", () => {
    const value = snapshot.tables["public.notes"]!.checkConstraints!["notes_public_width_chk"]!.value;
    expect(value).toBe(`"notes"."public_width" in (${NOTE_WIDTHS.map(w => `'${w}'`).join(",")})`);
  });
});
