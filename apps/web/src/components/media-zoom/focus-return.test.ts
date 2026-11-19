import { afterEach, describe, expect, it } from "vitest";
import { focusReturnTarget } from "./focus-return";

afterEach(() => {
  document.body.innerHTML = "";
});

function build(html: string): void {
  document.body.innerHTML = html;
}

function byId(id: string): HTMLElement {
  return document.getElementById(id)!;
}

describe("focusReturnTarget", () => {
  it("preferred on the page: returns it", () => {
    build(`<div tabindex="0" id="wrap"><img id="media"></div><button id="btn">z</button>`);
    expect(focusReturnTarget(byId("btn"), byId("media"))).toBe(byId("btn"));
  });

  it("preferred removed: returns the nearest tabindex=0 ancestor of fallback", () => {
    build(`<div tabindex="0" id="wrap"><span><img id="media"></span></div><button id="btn">z</button>`);
    const btn = byId("btn");
    btn.remove();
    expect(focusReturnTarget(btn, byId("media"))).toBe(byId("wrap"));
  });

  it("fallback itself has tabindex=0: returns itself", () => {
    build(`<div tabindex="0" id="outer"><div tabindex="0" id="media"></div></div>`);
    expect(focusReturnTarget(null, byId("media"))).toBe(byId("media"));
  });

  it("ancestors with tabindex=-1 are skipped", () => {
    build(`<div tabindex="0" id="outer"><div tabindex="-1" id="inner"><img id="media"></div></div>`);
    expect(focusReturnTarget(null, byId("media"))).toBe(byId("outer"));
  });

  it("none focusable: returns null", () => {
    build(`<div><img id="media"></div><button id="btn">z</button>`);
    const btn = byId("btn");
    btn.remove();
    expect(focusReturnTarget(btn, byId("media"))).toBeNull();
  });

  it("fallback itself is not on the page either: returns null", () => {
    build(`<div tabindex="0" id="wrap"><img id="media"></div>`);
    const wrap = byId("wrap");
    const media = byId("media");
    wrap.remove();
    expect(focusReturnTarget(null, media)).toBeNull();
  });

  it("both null: returns null", () => {
    expect(focusReturnTarget(null, null)).toBeNull();
  });
});
