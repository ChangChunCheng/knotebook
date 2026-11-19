/**
 * #130: the API token scope contract (`packages/shared`).
 *
 * The stored shape is a **set, not a single value**: write always spells read out in the string, move/delete always carry write, so only
 * R, RW, RWM, RWD, RWMD exist (a lattice, not a chain, since #181); `hasScope` is therefore a membership check, not a hard-coded
 * hierarchy. The point of this group is "token matching, not substring matching":
 * an `includes`-style "simplification" would give `scope=notes:writer` write access.
 */
import { describe, expect, it } from "vitest";
import { hasScope, narrowerScope, normalizeScope, TOKEN_SCOPES, type ScopeName, type TokenScope } from "@knotebook/shared";

const R = "notes:read";
const RW = "notes:read notes:write";
const RWM = "notes:read notes:write notes:move";
const RWD = "notes:read notes:write notes:delete";
const RWMD = "notes:read notes:write notes:move notes:delete";

describe("normalizeScope", () => {
  it("undefined/null/empty/all-whitespace -> notes:read (least privilege)", () => {
    expect(normalizeScope(undefined)).toBe("notes:read");
    expect(normalizeScope(null)).toBe("notes:read");
    expect(normalizeScope("")).toBe("notes:read");
    expect(normalizeScope("   ")).toBe("notes:read");
  });

  it("with notes:write -> read is added explicitly to the stored shape", () => {
    expect(normalizeScope("notes:write")).toBe("notes:read notes:write");
    expect(normalizeScope("notes:write notes:read")).toBe("notes:read notes:write");
    expect(normalizeScope("notes:read  notes:write")).toBe("notes:read notes:write");
  });

  it("read only (including duplicates)", () => {
    expect(normalizeScope("notes:read")).toBe("notes:read");
    expect(normalizeScope("notes:read notes:read")).toBe("notes:read");
  });

  it("ignores unknown values (RFC 6749 section 3.3; an MCP client may add offline_access itself)", () => {
    expect(normalizeScope("offline_access notes:write")).toBe("notes:read notes:write");
    expect(normalizeScope("openid profile email")).toBe("notes:read");
  });

  it("token matching, not substring matching: an unknown value containing the notes:write substring must not escalate", () => {
    // Guards against simplifying to input.includes("notes:write"). In #132 normalizeScope's
    // input is the client-controlled authorize `scope` parameter, so substring matching would amplify scope.
    expect(normalizeScope("notes:writer")).toBe("notes:read");
    expect(normalizeScope("xnotes:write")).toBe("notes:read");
    expect(normalizeScope("notes:write-all")).toBe("notes:read");
  });

  it("the delimiter is a plain space only (RFC 6749 scope is SP-delimited); anything else fails closed", () => {
    // A tab-delimited string is not split -> the whole string is one unknown value -> least privilege. The direction is deliberately conservative.
    expect(normalizeScope("notes:read\tnotes:write")).toBe("notes:read");
  });
});

describe("hasScope", () => {
  it("required=notes:read holds for all five stored shapes", () => {
    expect(hasScope("notes:read", "notes:read")).toBe(true);
    expect(hasScope("notes:read notes:write", "notes:read")).toBe(true);
    expect(hasScope("notes:read notes:write notes:move", "notes:read")).toBe(true);
    expect(hasScope("notes:read notes:write notes:delete", "notes:read")).toBe(true);
    expect(hasScope("notes:read notes:write notes:move notes:delete", "notes:read")).toBe(true);
  });

  it("required=notes:write needs stored to contain write", () => {
    expect(hasScope("notes:read", "notes:write")).toBe(false);
    expect(hasScope("notes:read notes:write", "notes:write")).toBe(true);
    expect(hasScope("notes:read notes:write notes:move", "notes:write")).toBe(true);
  });

  it("membership check, not whole-string equality - an extra space in the stored shape must not downgrade read-write to read-only", () => {
    // The cast is deliberate: `TokenScope` has only five literals, so this value cannot occur by type, but
    // `stored` really comes from a `text` column and its type is an `as TokenScope` assertion. This pins
    // that the authorisation decision does not depend on the scope column's CHECK - a version written as
    // `stored === "notes:read notes:write"` goes red here.
    const drifted = "notes:read  notes:write" as TokenScope;
    expect(hasScope(drifted, "notes:write")).toBe(true);
    expect(hasScope(drifted, "notes:read")).toBe(true);

    // The mirror image: membership must not degrade into a substring match on `stored` (that would fail open and
    // give `notes:writer` write access); same reasoning as the tokenize guard of normalizeScope.
    expect(hasScope("notes:writer" as TokenScope, "notes:write")).toBe(false);
  });
});

describe("#239 normalizeScope: notes:move", () => {
  it("move without write -> move dropped, notes:read given (write is not added, fail closed)", () => {
    expect(normalizeScope("notes:move")).toBe("notes:read");
    expect(normalizeScope("notes:read notes:move")).toBe("notes:read");
  });
  it("write + move -> the third shape (order and duplicates do not matter)", () => {
    expect(normalizeScope("notes:move notes:write")).toBe("notes:read notes:write notes:move");
    expect(normalizeScope("notes:read notes:write notes:move notes:move")).toBe("notes:read notes:write notes:move");
  });
  it("token matching: notes:mover is not move; a tab-delimited string is not recognised", () => {
    expect(normalizeScope("notes:mover notes:write")).toBe("notes:read notes:write");
    expect(normalizeScope("notes:write\tnotes:move")).toBe("notes:read");
  });
  it("the five valid stored shapes map to themselves (the server normalises DB scope values with it, so valid values must come back as is)", () => {
    for (const s of TOKEN_SCOPES) expect(normalizeScope(s)).toBe(s);
  });
});

describe("#181 normalizeScope: notes:delete", () => {
  it("delete without write -> delete dropped, notes:read given (write is not added, fail closed)", () => {
    expect(normalizeScope("notes:delete")).toBe(R);
    expect(normalizeScope("notes:read notes:delete")).toBe(R);
  });
  it("write + delete -> RWD; all four -> RWMD (order does not matter)", () => {
    expect(normalizeScope("notes:delete notes:write")).toBe(RWD);
    expect(normalizeScope("notes:delete notes:move notes:write notes:read")).toBe(RWMD);
  });
  it("token matching: notes:deleter is not delete; a tab-delimited string is not recognised", () => {
    expect(normalizeScope("notes:deleter notes:write")).toBe(RW);
    expect(normalizeScope("notes:write\tnotes:delete")).toBe(R);
  });
});

describe("#239 / #181 narrowerScope (intersection)", () => {
  it("TOKEN_SCOPES is pinned as the five literal shapes (including order; not derived from its own indexes)", () => {
    expect(TOKEN_SCOPES).toEqual([R, RW, RWM, RWD, RWMD]);
  });
  // Expected values written out cell by cell (the meet on the lattice); TOKEN_SCOPES indexes are not used as the oracle - move and delete do not contain each other.
  const TABLE: Record<string, Record<string, string>> = {
    [R]: { [R]: R, [RW]: R, [RWM]: R, [RWD]: R, [RWMD]: R },
    [RW]: { [R]: R, [RW]: RW, [RWM]: RW, [RWD]: RW, [RWMD]: RW },
    [RWM]: { [R]: R, [RW]: RW, [RWM]: RWM, [RWD]: RW, [RWMD]: RWM },
    [RWD]: { [R]: R, [RW]: RW, [RWM]: RW, [RWD]: RWD, [RWMD]: RWD },
    [RWMD]: { [R]: R, [RW]: RW, [RWM]: RWM, [RWD]: RWD, [RWMD]: RWMD },
  };
  for (const a of [R, RW, RWM, RWD, RWMD])
    for (const b of [R, RW, RWM, RWD, RWMD])
      it(`25 cells: ${a} meet ${b} = ${TABLE[a]![b]}`, () => {
        expect(narrowerScope(a as TokenScope, b as TokenScope)).toBe(TABLE[a]![b]);
      });
  it("symmetric: 25 cells, a meet b = b meet a", () => {
    for (const a of [R, RW, RWM, RWD, RWMD])
      for (const b of [R, RW, RWM, RWD, RWMD])
        expect(narrowerScope(a as TokenScope, b as TokenScope)).toBe(narrowerScope(b as TokenScope, a as TokenScope));
  });
  it("a value outside the five shapes is treated as notes:read (fail closed, no garbage string returned)", () => {
    expect(narrowerScope("garbage" as TokenScope, RWM)).toBe(R);
    expect(narrowerScope(RW, "notes:read notes:move" as TokenScope)).toBe(R);
  });
  it("a non-canonical value is treated as notes:read before intersecting: a bare notes:write must not be normalised to read-write", () => {
    expect(narrowerScope("notes:write" as TokenScope, RWMD)).toBe(R);
  });
  it("a four-item string in the wrong order is outside the five shapes -> notes:read", () => {
    expect(narrowerScope(RWMD, "notes:read notes:write notes:delete notes:move" as TokenScope)).toBe(R);
  });
});

describe("#239 / #181 hasScope: five shapes x four ScopeNames", () => {
  const MEMBERS: Record<string, Record<ScopeName, boolean>> = {
    [R]: { "notes:read": true, "notes:write": false, "notes:move": false, "notes:delete": false },
    [RW]: { "notes:read": true, "notes:write": true, "notes:move": false, "notes:delete": false },
    [RWM]: { "notes:read": true, "notes:write": true, "notes:move": true, "notes:delete": false },
    [RWD]: { "notes:read": true, "notes:write": true, "notes:move": false, "notes:delete": true },
    [RWMD]: { "notes:read": true, "notes:write": true, "notes:move": true, "notes:delete": true },
  };
  it("membership table", () => {
    for (const [stored, row] of Object.entries(MEMBERS))
      for (const [name, want] of Object.entries(row))
        expect(hasScope(stored as TokenScope, name as ScopeName), `${stored} ∋ ${name}`).toBe(want);
  });
  it("move only in RWM, RWMD", () => {
    expect(hasScope(RWM, "notes:move")).toBe(true);
    expect(hasScope(RWMD, "notes:move")).toBe(true);
    expect(hasScope(RWD, "notes:move")).toBe(false);
    expect(hasScope(RW, "notes:move")).toBe(false);
    expect(hasScope(R, "notes:move")).toBe(false);
  });
  it("delete only in RWD, RWMD", () => {
    expect(hasScope(RWD, "notes:delete")).toBe(true);
    expect(hasScope(RWMD, "notes:delete")).toBe(true);
    expect(hasScope(RWM, "notes:delete")).toBe(false);
    expect(hasScope(RW, "notes:delete")).toBe(false);
    expect(hasScope(R, "notes:delete")).toBe(false);
  });
  it("drifted values get an honest membership check (authorisation does not rest on it alone but on canDeleteNotes: write AND delete)", () => {
    expect(hasScope("notes:read notes:delete" as TokenScope, "notes:delete")).toBe(true);
  });
});
