import { describe, expect, it, vi } from "vitest";
import type { Location } from "react-router";
import { createHashWriter } from "./hash-writer";

function location(pathname: string, hash = "", key = "k1", state: unknown = null): Location {
  return { pathname, search: "?present", hash, key, state };
}

describe("createHashWriter", () => {
  it("writes #/<id> using the latest location: replace, keeps search and state", () => {
    const navigate = vi.fn();
    const latest = location("/n/a/b", "", "k1", { knotebookPresentPushed: true });
    const writer = createHashWriter({ latest: () => latest, currentKey: () => "k1", historyKey: () => "k1", navigate });
    writer.request("h2");
    expect(navigate).toHaveBeenCalledWith(
      { pathname: "/n/a/b", search: "?present", hash: "#/h2" },
      { replace: true, state: { knotebookPresentPushed: true } },
    );
  });

  it("hash already the target -> no write", () => {
    const navigate = vi.fn();
    const writer = createHashWriter({ latest: () => location("/n/a/b", "#/h2"), currentKey: () => "k1", historyKey: () => "k1", navigate });
    writer.request("h2");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigation in flight (history key != rendered key) -> deferred; flush uses the latest pathname at that time (doesn't write the old pathname back)", () => {
    const navigate = vi.fn();
    let latest = location("/notes/uuid", "#/x", "k1");
    let historyKey = "k2"; // the settle step already replaced; the router hasn't caught up
    const writer = createHashWriter({ latest: () => latest, currentKey: () => latest.key, historyKey: () => historyKey, navigate });
    writer.request("h2");
    expect(navigate).not.toHaveBeenCalled();
    latest = location("/n/tester/my-note", "#/x", "k2");
    historyKey = "k2";
    writer.flush();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toEqual({ pathname: "/n/tester/my-note", search: "?present", hash: "#/h2" });
  });

  it("historyKey unreadable (undefined) -> writes as usual", () => {
    const navigate = vi.fn();
    const writer = createHashWriter({ latest: () => location("/n/a/b"), currentKey: () => "k1", historyKey: () => undefined, navigate });
    writer.request("h2");
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("flush does nothing when no id is pending", () => {
    const navigate = vi.fn();
    createHashWriter({ latest: () => location("/n/a/b"), currentKey: () => "k1", historyKey: () => "k1", navigate }).flush();
    expect(navigate).not.toHaveBeenCalled();
  });
});
