/**
 * #108: the write tools' schemas match the **same** schemas REST uses.
 *
 * This file holds the same-source assertions for the write-tool schemas: both sides of the op set, the identity assertions and the behaviour probes,
 * and (since #180) the identity of each new tool's input fields.
 *
 * `op` has no shared object: REST has five `z.literal` (the discriminator of the `discriminatedUnion`), while MCP needs one `z.enum` with `.describe()`
 * (a raw shape can't express a union). Since #180 the MCP op set is REST's five plus {rename} (`rename` is MCP-only; REST deliberately doesn't add it;
 * see the `MCP_OPS` assertion below). The two string sets can therefore only be matched by the case below: without it, if REST gained an op only one side would
 * know (an extra `editBodySchema` branch means MCP can't receive that op; an extra raw-shape member means REST's `safeParse` fails with
 * `invalid_union_discriminator`; either drift just leaves the feature unconnected).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createBodySchema, editBodySchema, FP, GROUP_ID, MD, NOTE_ID, NUL, SEC, TITLE, updateBodyObject } from "../../src/notes/schemas.js";
import { editNoteInput, mcpEditBodySchema } from "../../src/mcp/tools/edit-note.js";
import { createNoteInput } from "../../src/mcp/tools/create-note.js";
import {
  COPY_FOLDER_ID_DESCRIBE,
  COPY_FOLDER_ID_DESCRIBE_NO_MOVE,
  COPY_GROUP_ID_DESCRIBE_NO_MOVE,
  copyNoteInput,
  copyNoteInputNoMove,
} from "../../src/mcp/tools/copy-note.js";
import { moveNoteToGroupInput } from "../../src/mcp/tools/move-note-to-group.js";
import { moveNoteToFolderInput } from "../../src/mcp/tools/move-note-to-folder.js";
import { deleteFolderInput } from "../../src/mcp/tools/delete-folder.js";
import { FOLDER_ID } from "../../src/mcp/folder-fields.js";
import { readNoteSectionOutput } from "../../src/mcp/tools/read-note-section.js";

/** Hard-coded copy (not derived from the implementation): otherwise a change on both sides would stay green together. */
const OPS = ["replace_all", "replace_section", "insert_after", "append", "delete_section"];
/** #180: MCP has one more op (REST's five plus {rename}); deliberately unequal: REST `/edits` doesn't add rename on purpose (rename doesn't go into `note_ai_edits`, REST already has PATCH, adding an op to MCP is cheaper than another tool). Don't "fix" it to be equal later. */
const MCP_OPS = [...OPS, "rename"];

describe("#108 both sides of the write schemas", () => {
  it("the five branches' op literals of editBodySchema equal the hard-coded five-element array (including order)", () => {
    expect(editBodySchema.options).toHaveLength(5);
    expect(editBodySchema.options.map(o => o.shape.op.value)).toEqual(OPS);
  });

  it("the op enum of edit_note = REST's five + {rename}; the literals of mcpEditBodySchema = MCP_OPS, and its first five are the same objects as in editBodySchema", () => {
    expect(editNoteInput.op.options).toEqual(MCP_OPS);
    expect(mcpEditBodySchema.options.map(o => o.shape.op.value)).toEqual(MCP_OPS);
    for (let i = 0; i < OPS.length; i += 1) expect(mcpEditBodySchema.options[i]).toBe(editBodySchema.options[i]);
  });
});

/**
 * Identity assertion (the **source** half of the same-source check): each of the six raw-shape fields is the **same object reference** as the base in
 * `notes/schemas.ts`, not "two sides that happen to write the same rule".
 *
 * In zod 3.25.76 `.describe()` on any type is `new This({ ...this._def, description })`: apart from description the `_def` properties are the same references as the callee's.
 * - Optional fields (`markdown`/`if_match`/`section_id`/`title`/`content`) are always built as `BASE.optional().describe(...)`: `.optional()` wraps a `ZodOptional`
 *   whose `_def.innerType` is `BASE` itself, and that reference survives `.describe()`, so a direct `toBe` is cleanest.
 * - The required field (`note_id`) has no `.optional()` and is `NOTE_ID.describe(...)` directly: there is no `innerType` to compare, but after stripping `description`
 *   the remaining `_def` (`schema`/`effect` etc.) and `NOTE_ID._def` (also stripped) are the same references one by one, so `toEqual`'s recursion always meets the same
 *   object: equivalent to a wordier `toBe`.
 */
function expectSameSchema(field: z.ZodTypeAny, base: z.ZodTypeAny): void {
  if (field instanceof z.ZodOptional) {
    expect(field._def.innerType).toBe(base);
    return;
  }
  const { description: _fieldDescription, ...fieldRest } = field._def as Record<string, unknown>;
  const { description: _baseDescription, ...baseRest } = base._def as Record<string, unknown>;
  expect(fieldRest).toEqual(baseRest);
}

describe("#108 same source: the six raw-shape fields match the base in notes/schemas.ts", () => {
  it("editNoteInput's markdown/if_match/section_id/note_id come from the same source as MD/FP/SEC/NOTE_ID", () => {
    expectSameSchema(editNoteInput.markdown, MD);
    expectSameSchema(editNoteInput.if_match, FP);
    expectSameSchema(editNoteInput.section_id, SEC);
    expectSameSchema(editNoteInput.note_id, NOTE_ID);
  });

  it("#180: editNoteInput.title comes from the same source as TITLE; so does updateBodyObject.title of PATCH", () => {
    expectSameSchema(editNoteInput.title, TITLE);
    expectSameSchema(updateBodyObject.shape.title, TITLE);
  });

  it("createNoteInput's title/content/group_id come from the same source as TITLE/MD/GROUP_ID", () => {
    expectSameSchema(createNoteInput.title, TITLE);
    expectSameSchema(createNoteInput.content, MD);
    expectSameSchema(createNoteInput.group_id, GROUP_ID);
  });

  it("#175: groupId of REST createBodySchema comes from the same source as GROUP_ID (the write side doesn't invent a second contract)", () => {
    expectSameSchema(createBodySchema.shape.groupId, GROUP_ID);
    expectSameSchema(createBodySchema.shape.title, TITLE);
    expectSameSchema(createBodySchema.shape.content, MD);
  });

  it("#175: GROUP_ID accepts uuids of any case, rejects non-uuids and empty strings", () => {
    expect(GROUP_ID.safeParse(randomUUID()).success).toBe(true);
    expect(GROUP_ID.safeParse(randomUUID().toUpperCase()).success).toBe(true);
    for (const bad of ["", "not-a-uuid", `${randomUUID()}x`, randomUUID().replace(/-/g, "")]) expect(GROUP_ID.safeParse(bad).success).toBe(false);
  });

  it("#240: NOTE_ID lowercases uppercase/mixed-case uuids; NUL and non-uuids are still rejected", () => {
    const lower = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const mixed = "0F8fAd5B-d9Cb-469F-a165-70867728950E";
    expect(NOTE_ID.parse(lower.toUpperCase())).toBe(lower);
    expect(NOTE_ID.parse(mixed)).toBe(lower);
    expect(NOTE_ID.parse(lower)).toBe(lower);
    for (const bad of ["", "not-a-uuid", `${lower}${NUL}`, `${lower}x`]) expect(NOTE_ID.safeParse(bad).success).toBe(false);
  });
});

/**
 * Behaviour probes (the **behaviour** half): three calls straight at the schema objects (no HTTP) verify that runtime really rejects.
 *
 * The 262,145 code unit case must not go through HTTP: a markdown that long hits the `bodyLimit` 413 first, an always-green shape that can't exercise the `.max` of `MD`;
 * so it is checked at schema level only. The handler itself doesn't run raw-shape validation (the SDK does): what is hit here is the `z.object(editNoteInput)`/
 * `z.object(createNoteInput)` objects themselves, not `editNote()`/`createNote()`.
 *
 * The HTTP half of the NUL and empty-title cases (the same payload sent through tools/call) lives in `test/mcp-write-guards.test.ts`: it needs `buildCollabTestApp()`
 * (a real DB), while `vitest.unit.config.ts` deliberately has no `globalSetup` (its header says it must never start testcontainers), the repo's existing promise that
 * `test:unit` never needs docker. Without `TEST_DATABASE_URL`, that half fails complaining that it is not set, which would break this file's "fast, no docker" promise.
 * The schema-level safeParse half (no DB) stays here; the HTTP half is in `mcp-write-guards.test.ts` (already an integration file).
 */
describe("#108 behaviour probes", () => {
  it("markdown of 262,145 code units: z.object(editNoteInput) safeParse rejects it directly, the issue points at markdown", () => {
    const tooLong = "x".repeat(262_145);
    const parsed = z.object(editNoteInput).safeParse({ note_id: randomUUID(), op: "append", markdown: tooLong });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.path).toContain("markdown");
  });

  it("markdown containing NUL: z.object(editNoteInput) safeParse rejects it directly, the issue points at markdown (the HTTP half is in mcp-write-guards.test.ts)", () => {
    const parsed = z.object(editNoteInput).safeParse({ note_id: randomUUID(), op: "append", markdown: "x" + NUL });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.path).toContain("markdown");
  });

  it("create_note with an empty title: z.object(createNoteInput) safeParse rejects it directly, the issue points at title (the HTTP half is in mcp-write-guards.test.ts)", () => {
    const parsed = z.object(createNoteInput).safeParse({ title: "" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.path).toContain("title");
  });
});

// #222/#378: the model-facing strings must say how to write colors, which names and hex codes are accepted, and that reading returns the same form (hex colors
// read back as lowercase `#rrggbb`); otherwise the model could only guess from HTML it happened to see in read_note_section.
// The color name list is hard-coded (not derived from PALETTE_COLORS): otherwise a change on both sides stays green together.
describe("#222 colors in tool descriptions", () => {
  const NAMES = "default, gray, brown, red, orange, yellow, green, blue, purple, pink";
  it("edit_note markdown description: an HTML-form example, the 10 color names verbatim, reads back in the same form", () => {
    const d = editNoteInput.markdown.description ?? "";
    expect(d).toContain(NAMES);
    expect(d).toContain('<span style="color:red">');
    expect(d).toContain("#ff6600");
    expect(d).toContain("#rgb or #rrggbb");
    expect(d).not.toContain("Only these names are accepted");
    expect(d).toContain("read_note_section");
  });
  it("create_note's content description points back to edit_note; read_note_section's markdown description says colors are HTML and are kept when written back as-is", () => {
    expect(createNoteInput.content.description).toContain("Colors, side-by-side columns and sizes work as in edit_note");
    const d = readNoteSectionOutput.section.shape.markdown.description ?? "";
    expect(d).toContain("Colored text and blocks come back as HTML");
    expect(d).toContain("unchanged");
  });
  // #379: reading emits `\<`, and writing `\<` is a literal `<`; both sentences must exclude code and whole-block HTML (in code `<` stays as is, in whole-block HTML it reads as `&lt;`; the backslash is no escape in either).
  it("literal `<`: read_note_section says reading puts a backslash before `<`, edit_note says writing a backslash before `<` keeps it as text", () => {
    expect(readNoteSectionOutput.section.shape.markdown.description).toContain(
      "Outside code and blocks that come back as HTML, a `<` that could start an HTML tag or comment comes back as `\\<`; write it back unchanged to keep it as text."
    );
    expect(editNoteInput.markdown.description).toContain(
      "HTML in the markdown is read as HTML; to keep a `<` that would start a tag or comment as text, write `\\<` (as read_note_section returns it), except inside code or a block written as HTML."
    );
  });
});

// Columns: the canonical tags and column counts and the shape and range of sizes belong in the tool description; the size sentence doesn't mention images inside
// table cells. The verbatim full sentence on the wire is in mcp-tools-list.test.ts.
describe("columns and sizes in tool descriptions", () => {
  it("edit_note markdown description: the canonical outer and column tags, 2 to 4 columns, width inside figure, colwidth in the first row, 32 to 4000", () => {
    const d = editNoteInput.markdown.description ?? "";
    expect(d).toContain('<div data-kb-columns style="display:flex;gap:16px">');
    expect(d).toContain('<div data-kb-column style="flex:N">');
    expect(d).toContain("Writes take 2 to 4 columns.");
    expect(d).toContain('<figure><img … width="W">…</figure>');
    expect(d).toContain("colwidth on its first row's cells");
    expect(d).toContain("whole pixels from 32 to 4000");
    expect(d).not.toContain("table cell");
  });
  it("read_note_section's markdown description says columns and sizes are HTML too; create_note points back to edit_note", () => {
    const d = readNoteSectionOutput.section.shape.markdown.description ?? "";
    expect(d).toContain("side-by-side columns");
    expect(d).toContain("images shown at a set width");
    expect(d).toContain("tables with set column widths");
    expect(createNoteInput.content.description).not.toContain("Colors work as in edit_note.");
  });
});

describe("#180 copy_note input comes from the same source as notes/schemas.ts", () => {
  it("copyNoteInput.note_id <-> NOTE_ID; copyNoteInput.group_id (optional) <-> GROUP_ID", () => {
    expectSameSchema(copyNoteInput.note_id, NOTE_ID);
    expectSameSchema(copyNoteInput.group_id, GROUP_ID);
    expect(copyNoteInput.group_id).toBeInstanceOf(z.ZodOptional);
  });

  it("#239: copyNoteInputNoMove.note_id <-> NOTE_ID; .group_id (optional) <-> GROUP_ID; the description is the no-move form", () => {
    expectSameSchema(copyNoteInputNoMove.note_id, NOTE_ID);
    expectSameSchema(copyNoteInputNoMove.group_id, GROUP_ID);
    expect(copyNoteInputNoMove.group_id).toBeInstanceOf(z.ZodOptional);
    expect(copyNoteInputNoMove.group_id.description).toBe(COPY_GROUP_ID_DESCRIBE_NO_MOVE);
  });
});

describe("#180 move_note_to_group input comes from the same source as notes/schemas.ts", () => {
  it("moveNoteToGroupInput.note_id <-> NOTE_ID; .group_id (required, not optional) <-> GROUP_ID", () => {
    expectSameSchema(moveNoteToGroupInput.note_id, NOTE_ID);
    expectSameSchema(moveNoteToGroupInput.group_id, GROUP_ID);
    expect(moveNoteToGroupInput.group_id).not.toBeInstanceOf(z.ZodOptional);
  });
});

describe("folders: folder_id of four tools comes from the same source as FOLDER_ID", () => {
  it("folder_id of create_note/copy_note (both forms)/move_note_to_group (optional) and of move_note_to_folder (nullable, required) <-> FOLDER_ID; the two copy forms have their own descriptions", () => {
    for (const field of [createNoteInput.folder_id, copyNoteInput.folder_id, copyNoteInputNoMove.folder_id, moveNoteToGroupInput.folder_id]) {
      expect(field).toBeInstanceOf(z.ZodOptional);
      expectSameSchema(field, FOLDER_ID);
    }
    expect(moveNoteToFolderInput.folder_id).toBeInstanceOf(z.ZodNullable);
    expect(moveNoteToFolderInput.folder_id._def.innerType).toBe(FOLDER_ID);
    expectSameSchema(moveNoteToFolderInput.note_id, NOTE_ID);
    expect(copyNoteInput.folder_id.description).toBe(COPY_FOLDER_ID_DESCRIBE);
    expect(copyNoteInputNoMove.folder_id.description).toBe(COPY_FOLDER_ID_DESCRIBE_NO_MOVE);
  });
});

describe("folders: input of delete_folder", () => {
  it("the input keys are exactly folder_id (MCP offers no option like 'delete only empty folders'), required, and from the same source as FOLDER_ID", () => {
    expect(Object.keys(deleteFolderInput)).toEqual(["folder_id"]);
    expect(deleteFolderInput.folder_id).not.toBeInstanceOf(z.ZodOptional);
    expectSameSchema(deleteFolderInput.folder_id, FOLDER_ID);
  });
});
