import { describe, expect, it } from "vitest";
import { locateSlide, repositionAfterUpdate, type SlideStructure } from "./reposition";

const deck = (spec: string): SlideStructure[] =>
  // "a:a1,a2|b:b1" -> [{id:"a", slides:[a1,a2]}, {id:"b", slides:[b1]}] (a section's id is its first slide, as in noteToSlides)
  spec.split("|").map((part) => {
    const ids = part.split(":")[1].split(",");
    return { id: ids[0], slides: ids.map((id) => ({ id })) };
  });

describe("locateSlide", () => {
  it("returns (h, v); null when not found", () => {
    const d = deck("_:_title|a:a1,a2|b:b1");
    expect(locateSlide(d, "a2")).toEqual({ h: 1, v: 1 });
    expect(locateSlide(d, "b1")).toEqual({ h: 2, v: 0 });
    expect(locateSlide(d, "zz")).toBeNull();
  });
});

describe("repositionAfterUpdate", () => {
  it("current slide still exists -> its new position (structure moved forward: an earlier section deleted)", () => {
    const old = deck("_:_title|a:a1|b:b1,b2");
    const next = deck("_:_title|b:b1,b2");
    expect(repositionAfterUpdate(old, "b2", next)).toEqual({ h: 1, v: 1, id: "b2" });
  });

  it("current slide still exists, structure moved back: a section inserted before -> new h recomputed by ID", () => {
    const old = deck("_:_title|b:b1,b2");
    const next = deck("_:_title|n:n1|b:b1,b2");
    expect(repositionAfterUpdate(old, "b2", next)).toEqual({ h: 2, v: 1, id: "b2" });
  });

  it("current slide gone -> the slide right before it in the old structure (previous slide in the same section)", () => {
    const old = deck("_:_title|a:a1,a2,a3");
    const next = deck("_:_title|a:a1,a2");
    expect(repositionAfterUpdate(old, "a3", next)).toEqual({ h: 1, v: 1, id: "a2" });
  });

  it("section's first slide gone -> last slide of the previous section", () => {
    const old = deck("_:_title|a:a1,a2|b:b1,b2");
    const next = deck("_:_title|a:a1,a2|b2:b2");
    expect(repositionAfterUpdate(old, "b1", next)).toEqual({ h: 1, v: 1, id: "a2" });
  });

  it("previous slide also gone -> first slide of the section it belonged to in the old structure", () => {
    const old = deck("_:_title|a:a1,a2,a3");
    const next = deck("_:_title|a:a1");
    expect(repositionAfterUpdate(old, "a3", next)).toEqual({ h: 1, v: 0, id: "a1" });
  });

  it("none exist -> cover (0,0)", () => {
    const old = deck("_:_title|a:a1,a2");
    const next = deck("_:_title|z:z1");
    expect(repositionAfterUpdate(old, "a2", next)).toEqual({ h: 0, v: 0, id: "_title" });
  });

  it("falls back only one step: if the previous slide is gone it doesn't keep searching backward (lands on the section's first slide)", () => {
    const old = deck("_:_title|a:a1,a2,a3,a4");
    const next = deck("_:_title|a:a1,a2");
    expect(repositionAfterUpdate(old, "a4", next)).toEqual({ h: 1, v: 0, id: "a1" });
  });

  it("uses the **old** structure's section start: doesn't follow the new section start when the section at the same index changed", () => {
    const old = deck("_:_title|a:a1,a2,a3");
    // Using the new structure's section at old.h would give q1; the old structure's section start a1 is the right one.
    const next = deck("_:_title|q:q1|a1:a1");
    expect(repositionAfterUpdate(old, "a3", next)).toEqual({ h: 2, v: 0, id: "a1" });
  });

  it("old current id not in the old structure (shouldn't happen) -> cover", () => {
    expect(repositionAfterUpdate(deck("_:_title"), "ghost", deck("_:_title|a:a1"))).toEqual({ h: 0, v: 0, id: "_title" });
  });
});
