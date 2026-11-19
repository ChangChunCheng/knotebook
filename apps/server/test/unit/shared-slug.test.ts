import { describe, it, expect } from "vitest";
import {
  normalizeSlug,
  validateSlug,
  titleSlug,
  extractRefUuid,
  canonicalNotePath,
  publicAliasPath,
  autoSlugFromTitle,
} from "@knotebook/shared";

describe("normalizeSlug", () => {
  it("NFD -> NFC", () => {
    // Built purely from \u escapes (plain ASCII source) so the NFD vs. NFC
    // distinction can never get silently collapsed by an editor/tool re-encoding
    // the file. NFD: bare "e" + U+0301 combining acute accent (two code units for
    // the accented letter). NFC: U+00E9 precomposed accented "e" (one code unit).
    const nfd = "e\u0301cole";
    const nfc = "\u00e9cole";
    expect(nfd.normalize("NFC")).toBe(nfc); // sanity-check the fixture itself
    expect(nfd).not.toBe(nfc); // and confirm they really are distinct code unit sequences
    expect(normalizeSlug(nfd)).toBe(nfc);
  });

  it("upper case -> lower case", () => {
    expect(normalizeSlug("Hello-World")).toBe("hello-world");
  });
});

describe("validateSlug", () => {
  it("valid slug -> null", () => {
    expect(validateSlug("hello-world")).toBeNull();
    expect(validateSlug("你好-世界")).toBeNull();
  });

  it("lower-cased dotted capital I carries a combining dot above -> charset (combining marks not allowed)", () => {
    // normalizeSlug("İ") produces "i̇" = i + U+0307 (combining dot above), which is \p{M}
    const s = normalizeSlug("İstanbul");
    expect(validateSlug(s)).toBe("charset");
  });

  it("whole uuid -> uuid_like", () => {
    expect(validateSlug("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe("uuid_like");
  });

  it("ending in report-<uuid> -> uuid_like", () => {
    expect(validateSlug("report-3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("uuid_like");
  });

  it("reserved word new -> reserved", () => {
    expect(validateSlug("new")).toBe("reserved");
  });

  it("leading/trailing dash -> dash", () => {
    expect(validateSlug("-a-")).toBe("dash");
    expect(validateSlug("-abc")).toBe("dash");
    expect(validateSlug("abc-")).toBe("dash");
  });

  it("consecutive dashes -> dash", () => {
    expect(validateSlug("a--b")).toBe("dash");
  });

  it("only dashes -> dash", () => {
    expect(validateSlug("-")).toBe("dash");
    expect(validateSlug("---")).toBe("dash");
  });

  it("101 characters -> length", () => {
    expect(validateSlug("a".repeat(101))).toBe("length");
  });

  it("empty string -> length", () => {
    expect(validateSlug("")).toBe("length");
  });

  it("exactly 100 characters is valid -> null", () => {
    expect(validateSlug("a".repeat(100))).toBeNull();
  });

  it("whitespace/symbols -> charset", () => {
    expect(validateSlug("a b")).toBe("charset");
    expect(validateSlug("a_b")).toBe("charset");
    expect(validateSlug("a.b")).toBe("charset");
  });
});

describe("titleSlug", () => {
  it("Chinese is kept", () => {
    expect(titleSlug("你好世界")).toBe("你好世界");
  });

  it("case is kept (titleSlug does not lowercase, only normalizeSlug does); whitespace becomes dash", () => {
    expect(titleSlug("Hello World")).toBe("Hello-World");
  });

  it('"!!!" -> ""', () => {
    expect(titleSlug("!!!")).toBe("");
  });

  it("collapses consecutive separators and trims leading/trailing dashes", () => {
    expect(titleSlug("  Hello   World!!  ")).toBe("Hello-World");
  });

  it("an astral character repeated 40 times: after truncation encodeURIComponent does not throw, truncation leaves no trailing dash", () => {
    const title = "𠮷".repeat(40);
    const slug = titleSlug(title);
    expect(() => encodeURIComponent(slug)).not.toThrow();
    expect(slug.endsWith("-")).toBe(false);
    expect(Array.from(slug).length).toBeLessThanOrEqual(60);
  });

  it("a cut that lands inside a surrogate pair does not leave half a pair (does not throw, safe to encode)", () => {
    // 61 astral chars (each 2 UTF-16 code units) forces the 60-code-point Array.from
    // truncation to land mid-way through the surrogate-pair boundary handling.
    const title = "𠮷".repeat(61);
    const slug = titleSlug(title);
    expect(Array.from(slug).length).toBeLessThanOrEqual(60);
    expect(() => encodeURIComponent(slug)).not.toThrow();
  });

  it("empty string -> empty string", () => {
    expect(titleSlug("")).toBe("");
  });
});

describe("autoSlugFromTitle", () => {
  it("normal title -> lower-case slug", () => {
    expect(autoSlugFromTitle("Hello World")).toBe("hello-world");
  });

  it("a valid non-ASCII candidate passes the first validation untouched - accents are not stripped (deliberately differs from the 0007 SQL version)", () => {
    expect(autoSlugFromTitle("École Normale")).toBe("école-normale");
    expect(autoSlugFromTitle("Tiếng Việt")).toBe("tiếng-việt");
    expect(autoSlugFromTitle("你好世界")).toBe("你好世界");
  });

  it("uuid-shaped title -> untitled (uuid_like blocks it, stripping marks does not help)", () => {
    expect(autoSlugFromTitle("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe("untitled");
    expect(autoSlugFromTitle("Report 3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("untitled");
  });

  it("dotted capital I: fails the first validation, after NFD and stripping combining marks it validates -> istanbul", () => {
    // normalizeSlug yields i + U+0307 (a combining mark) for it -> the first validation fails on charset; after stripping marks it is valid
    expect(autoSlugFromTitle("İstanbul")).toBe("istanbul");
  });

  it("the fallback runs only after the first validation fails, and strips marks after NFD: precomposed accents in the same string are stripped too", () => {
    // Only the dotted capital I causes it, but the fallback removes diacritics from the whole string - the é in Café becomes e too
    expect(autoSlugFromTitle("İstanbul Café")).toBe("istanbul-cafe");
  });

  it("after stripping marks it returns NFC: the output is a fixed point of normalizeSlug", () => {
    // NFD splits Hangul into conjoining jamo (\p{Lo}, not marks, so not stripped) -
    // without the final NFC the decomposed form would come back and not match the NFC form the DB unique comparison uses
    const out = autoSlugFromTitle("İ한글");
    expect(out).toBe("i한글");
    expect(normalizeSlug(out)).toBe(out);
  });

  it("reserved-word title new -> untitled", () => {
    expect(autoSlugFromTitle("new")).toBe("untitled");
    expect(autoSlugFromTitle("New")).toBe("untitled");
  });

  it("empty title -> untitled", () => {
    expect(autoSlugFromTitle("")).toBe("untitled");
  });

  it("all-symbol title -> untitled", () => {
    expect(autoSlugFromTitle("!!! ??? ***")).toBe("untitled");
  });

  it("untitled is itself a valid slug (the fallback does not conflict with itself)", () => {
    expect(validateSlug("untitled")).toBeNull();
  });

  it("truncation: a title over 60 characters -> cut to 60 (same boundary as the 0007 SQL version)", () => {
    // These inputs/expectations are reused to compare the 0007 SQL and TS implementations - change the values in both places
    const title = "Q3 Planning Meeting Notes For The Whole Engineering Organization Retro";
    expect(autoSlugFromTitle(title)).toBe("q3-planning-meeting-notes-for-the-whole-engineering-organiza");
  });

  it("a cut right after a dash -> trailing dash removed instead of falling back to untitled", () => {
    // The 60th code point is a dash; if titleSlug lacked the "strip trailing dash after truncation" step,
    // validateSlug would say dash and the whole string would fall back to untitled (the 0007 comparison reuses this value too)
    expect(autoSlugFromTitle("a".repeat(59) + " bbbb")).toBe("a".repeat(59));
  });

  it("property: for inputs not pinned exactly, the output passes validateSlug and is a fixed point of normalizeSlug", () => {
    for (const t of ["Ünsal Çelik Ötesi", "𠮷".repeat(61), "ヘッダー The-Header", "école--fancy!!"]) {
      const out = autoSlugFromTitle(t);
      expect(validateSlug(out)).toBeNull();
      expect(normalizeSlug(out)).toBe(out);
    }
  });
});

describe("extractRefUuid", () => {
  it("an upper-case uuid is extracted too", () => {
    const uuid = "F47AC10B-58CC-4372-A567-0E02B2C3D479";
    expect(extractRefUuid(`note-${uuid}`)).toBe(uuid.toLowerCase());
  });

  it("a lower-case uuid is extracted", () => {
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    expect(extractRefUuid(uuid)).toBe(uuid);
  });

  it("no uuid -> null", () => {
    expect(extractRefUuid("hello-world")).toBeNull();
  });
});

describe("canonicalNotePath", () => {
  // Personal notes: `/n/<ownerHandle>/<slug>` (#122); since #175 group notes have another shape `/g/<groupId>/<slug>`.
  // Neither segment is URL-encoded - the handle is a-z0-9-, the group id is a uuid, the slug has been through normalizeSlug;
  // non-ASCII is left to the transport layer (same convention as the old /notes/<slug> shape).
  it("-> /n/<ownerHandle>/<slug>", () => {
    expect(canonicalNotePath({ ownerHandle: "alice", groupId: null, slug: "hello-world" })).toBe("/n/alice/hello-world");
  });

  it("a non-ASCII slug is output as is (not pre-encoded)", () => {
    expect(canonicalNotePath({ ownerHandle: "alice", groupId: null, slug: "café" })).toBe("/n/alice/café");
  });

  it("#175: group note -> /g/<groupId>/<slug> (ownerHandle is null)", () => {
    const groupId = "0b6c1a52-5f1e-4c8e-9d2a-3f4e5a6b7c8d";
    expect(canonicalNotePath({ ownerHandle: null, groupId, slug: "plan" })).toBe(`/g/${groupId}/plan`);
  });

  it("#175: missing groupId field (an old object from before #175, value undefined) -> still builds the /n/ shape, not /g/undefined/...", () => {
    expect(canonicalNotePath({ ownerHandle: "alice", groupId: undefined as unknown as null, slug: "x" })).toBe("/n/alice/x");
  });

  it("#175: ownerHandle and groupId both null -> throws (impossible under XOR; does not build a URL that cannot be opened)", () => {
    expect(() => canonicalNotePath({ ownerHandle: null, groupId: null, slug: "x" })).toThrow(/皆為 null/);
  });
});

describe("publicAliasPath", () => {
  // #122: the `/p/` two-segment **page** URL builder - ShareDialog's prefix/copy use it; the API URL is built by
  // web's public-note-ref.ts (different encoding policy, deliberately not shared; see the JSDoc in shared).
  // Not encoding, for the same reason as canonicalNotePath.
  it("-> /p/<handle>/<slug>; non-ASCII as is", () => {
    expect(publicAliasPath({ handle: "alice", slug: "team-doc" })).toBe("/p/alice/team-doc");
    expect(publicAliasPath({ handle: "alice", slug: "café" })).toBe("/p/alice/café");
  });
});
