import { afterEach, describe, expect, it } from "vitest";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { enterPresentationFullscreen, msSinceFullscreenExit } from "./fullscreen";
import {
  exitFullscreenIfLeftPresentation, hashForSlide, isPresentingSearch, PRESENT_PUSHED_KEY, PRESENT_SEARCH,
  presentPushedState, searchWithoutPresent, slideIdFromHash, wasPresentPushed,
} from "./present-url";

describe("present-url", () => {
  it("PRESENT_SEARCH is exactly ?present; flag key names", () => {
    expect(PRESENT_SEARCH).toBe("?present");
    expect(PRESENT_PUSHED_KEY).toBe("knotebookPresentPushed");
  });

  it.each([
    ["?present", true], ["?present=1", true], ["?a=1&present", true], ["", false], ["?presentation", false], ["?x=present", false],
  ])("isPresentingSearch(%j) -> %s", (search, expected) => {
    expect(isPresentingSearch(search)).toBe(expected);
  });

  it.each([
    ["?present", ""], ["?present&a=1", "?a=1"], ["?present&x=1", "?x=1"], ["?a=1&present&b=2", "?a=1&b=2"], ["", ""],
  ])("searchWithoutPresent(%j) -> %j", (search, expected) => {
    expect(searchWithoutPresent(search)).toBe(expected);
  });

  it("presentPushedState holds only the flag; wasPresentPushed accepts only true", () => {
    expect(presentPushedState()).toEqual({ knotebookPresentPushed: true });
    expect(wasPresentPushed({ knotebookPresentPushed: true, knotebookCanonicalizedFrom: "/x" })).toBe(true);
    expect(wasPresentPushed({ knotebookPresentPushed: "true" })).toBe(false);
    expect(wasPresentPushed(null)).toBe(false);
  });

  it("hash round trip: hashForSlide / slideIdFromHash", () => {
    expect(hashForSlide("_title")).toBe("#/_title");
    expect(slideIdFromHash(hashForSlide("a b"))).toBe("a b");
  });

  it.each(["#/%E0%A4%A", "#/", "#x", "", "#"])("malformed or empty hash %j -> null, no throw", (hash) => {
    expect(slideIdFromHash(hash)).toBeNull();
  });
});

describe("exitFullscreenIfLeftPresentation (unmount call site: reads the real URL)", () => {
  let fake: FakeFullscreen | null = null;
  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    window.history.replaceState(null, "", "/");
  });

  it("URL still contains present (StrictMode fake unmount) -> doesn't exit; without it -> exits", async () => {
    fake = installFakeFullscreen();
    enterPresentationFullscreen();
    await fake.grantEventFirst();

    window.history.replaceState(null, "", "/n/a/b?present");
    exitFullscreenIfLeftPresentation();
    expect(fake.exitFullscreen).not.toHaveBeenCalled();

    window.history.replaceState(null, "", "/n/a/b");
    exitFullscreenIfLeftPresentation();
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("the fake's uninstall resets the module's lastExitAt to 0: afterwards a case without the fake sees msSinceFullscreenExit() as Infinity (not swallowed by exit debouncing)", async () => {
    fake = installFakeFullscreen();
    enterPresentationFullscreen();
    await fake.grantEventFirst();
    await fake.userExit();
    await fake.uninstall();
    fake = null;
    expect(msSinceFullscreenExit()).toBe(Infinity);
  });
});
