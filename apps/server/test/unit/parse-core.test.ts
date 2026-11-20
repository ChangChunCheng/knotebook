import { describe, expect, it, vi } from "vitest";

const parseMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/notes/editing/markdown.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/notes/editing/markdown.js")>()),
  parseMarkdownForNote: parseMock,
}));
const { runParse, TOO_COMPLEX } = await import("../../src/notes/editing/parse-core.js");

const req = { markdown: "x", candidates: [], siteOrigin: "http://localhost" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake editor: runParse passes it unchanged to parseMarkdownForNote (mocked)
const ed = {} as any;

describe("runParse", () => {
  it("RangeError (Maximum call stack size exceeded) -> too_complex", () => {
    parseMock.mockImplementationOnce(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    expect(runParse(ed, req)).toEqual(TOO_COMPLEX);
  });
  it("rethrows other exceptions unchanged (a bug is a 500, not disguised as a content problem)", () => {
    parseMock.mockImplementationOnce(() => {
      throw new TypeError("boom");
    });
    expect(() => runParse(ed, req)).toThrow(TypeError);
  });
  it("returns a normal result unchanged", () => {
    parseMock.mockReturnValueOnce({ blocks: [], unbound: 0 });
    expect(runParse(ed, req)).toEqual({ blocks: [], unbound: 0 });
  });
});
