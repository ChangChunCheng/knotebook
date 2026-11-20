// Columns (error messages): the MCP messages of the two new codes are pinned verbatim. The two REST sentences are compared verbatim by the integration test mcp-write-guards.
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@knotebook/shared";
import { writeFailureMessage } from "../../src/mcp/write-messages.js";

describe("writeFailureMessage: columns and sizes", () => {
  it("unsupported_columns and unsupported_size verbatim, each", () => {
    expect(writeFailureMessage("unsupported_columns")).toBe(
      "That markdown has layout or editor-internal HTML this editor cannot store, so nothing was written. Write side-by-side columns exactly as read_note_section returns them: <div data-kb-columns style=\"display:flex;gap:16px\"> holding 2 to 4 <div data-kb-column style=\"flex:N\"> columns, N from 0.1 to 10 with at most two decimal places, with a blank line after each column's opening tag and another before its </div>, at the top level of the markdown, not nested inside a list, a quote or anything else. Other <div> elements cannot use display:flex or display:grid, and no element can carry data-node-type."
    );
    expect(writeFailureMessage("unsupported_size")).toBe(
      "An image width or table column width in that markdown is not in a form this editor can store, so nothing was written. Write sizes exactly as read_note_section returns them, as whole numbers of pixels from 32 to 4000: an image's width on the <img> inside a <figure> that is outside any table, the <img> carrying only alt (optional), src and width, in that order, and a table's column widths as colwidth on its first row's cells, one comma-separated value for each column a cell spans, left empty for a column with no width."
    );
  });

  it("unsupported_size does not mention images inside table cells (image widths in cells are not supported yet; this keeps the model from being steered into writing them)", () => {
    expect(writeFailureMessage("unsupported_size")).not.toContain("table cell");
  });

  // The old sentence is false in reachable cases - a non-column element carrying data-node-type also returns unsupported_columns,
  // and an image with a width in a table cell is still refused under the "img inside figure" rewrite (the cell branch), so the model would go round in circles.
  it("the two false statements of the old sentence are absent", () => {
    expect(writeFailureMessage("unsupported_columns")).not.toContain("has side-by-side columns");
    expect(writeFailureMessage("unsupported_size")).not.toContain("on the <img> inside <figure>,");
  });

  it("both codes are in ERROR_CODES (web's errors.<code> and REST's sendError depend on it)", () => {
    expect(ERROR_CODES).toEqual(expect.arrayContaining(["unsupported_columns", "unsupported_size"]));
  });
});
