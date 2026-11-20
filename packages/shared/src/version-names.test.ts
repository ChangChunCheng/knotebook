import { describe, expect, it } from "vitest";
import { VERSION_NAME_ADJECTIVES, VERSION_NAME_NOUNS, derivedVersionName } from "./version-names.js";

describe("derivedVersionName (#272: word lists frozen)", () => {
  it("example: 3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c -> plucky-finch; an upper-case uuid gives the same name", () => {
    expect(derivedVersionName("3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c")).toBe("plucky-finch");
    expect(derivedVersionName("3F2A9C1E-7B4D-4E8A-9C21-5D6E7F8A9B0C")).toBe("plucky-finch");
  });

  it("indexes = hex digits 1-4 and 5-8 of the last group, each % 64 (65536 is divisible by 64)", () => {
    expect(derivedVersionName("00000000-0000-4000-8000-000000000000")).toBe("able-badger");
    expect(derivedVersionName("00000000-0000-4000-8000-003f003f0000")).toBe("witty-deer");
    expect(derivedVersionName("00000000-0000-4000-8000-00400041ffff")).toBe("able-beaver");
  });

  it("word lists frozen: 64 each, no duplicates, no overlap between the two, lower-case a-z of 3-8 letters; the first three and the last one", () => {
    for (const list of [VERSION_NAME_ADJECTIVES, VERSION_NAME_NOUNS]) {
      expect(list).toHaveLength(64);
      expect(new Set(list).size).toBe(64);
      for (const w of list) expect(w).toMatch(/^[a-z]{3,8}$/);
    }
    expect(VERSION_NAME_ADJECTIVES.filter((w) => VERSION_NAME_NOUNS.includes(w))).toEqual([]);
    expect([...VERSION_NAME_ADJECTIVES.slice(0, 3), VERSION_NAME_ADJECTIVES[63]]).toEqual(["able", "agile", "amber", "witty"]);
    expect([...VERSION_NAME_NOUNS.slice(0, 3), VERSION_NAME_NOUNS[63]]).toEqual(["badger", "beaver", "bison", "deer"]);
  });

  it("word lists frozen: the whole table equals the fixed list word for word (order is the index; changing any word in the middle would rename existing versions)", () => {
    expect(VERSION_NAME_ADJECTIVES.join(" ")).toBe(
      "able agile amber ample azure bold brave bright brisk calm candid cheery civil clever cosmic crisp curious daring deft eager early earnest fair fancy fleet fond frank gentle glad golden grand happy hardy honest humble jolly keen kind lively loyal lucid merry mellow mighty modest noble plucky polite proud quick quiet rapid ready sharp shiny snowy steady sunny swift tidy upbeat vivid warm witty",
    );
    expect(VERSION_NAME_NOUNS.join(" ")).toBe(
      "badger beaver bison bobcat crane cricket dolphin eagle falcon ferret finch fox gecko gibbon heron hare ibis jackal jaguar koala lemur leopard lynx magpie marten mole moose newt ocelot orca osprey otter owl panda parrot pelican penguin puffin quail rabbit raven robin salmon seal sparrow squid stork swan tapir tiger toucan trout turtle walrus weasel whale wombat wolf wren yak zebra bee crow deer",
    );
  });

  it("not 32 hex digits (test ids, empty string, one extra, non-hex) -> \"version\"", () => {
    for (const id of ["v-1", "", "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c0", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"]) {
      expect(derivedVersionName(id), JSON.stringify(id)).toBe("version");
    }
  });
});
