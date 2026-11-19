import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { __resetCollapseForTests } from "./collapse";
import { __resetFolderSortForTests, folderSortOf, setFolderSort, useFolderSort, useFolderSortOf, type FolderSort } from "./folder-sort";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

function throwQuota(): never {
  throw new DOMException("quota", "QuotaExceededError");
}

function SortProbe({ id, folderId }: { id: string; folderId: string }) {
  return <span data-testid={id}>{useFolderSort(folderId)}</span>;
}

describe("folder-sort store", () => {
  it("nothing stored -> recent", () => {
    expect(folderSortOf("f1")).toBe("recent");
  });

  it("setFolderSort(\"f1\",\"name\") stores the literal value in localStorage and folderSortOf returns name; \"recent\" is also written literally", () => {
    setFolderSort("f1", "name");
    expect(localStorage.getItem("sidebar.sort.folder:f1")).toBe("name");
    expect(folderSortOf("f1")).toBe("name");
    setFolderSort("f1", "recent");
    expect(localStorage.getItem("sidebar.sort.folder:f1")).toBe("recent");
  });

  it("unrecognized stored value -> default", () => {
    localStorage.setItem("sidebar.sort.folder:f1", "bogus");
    expect(folderSortOf("f1")).toBe("recent");
  });

  it("setItem throws -> the overlay takes effect (it is checked first, so an old localStorage value does not override the fresh choice)", () => {
    localStorage.setItem("sidebar.sort.folder:f1", "size");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(throwQuota);
    expect(() => setFolderSort("f1", "name")).not.toThrow();
    expect(localStorage.getItem("sidebar.sort.folder:f1")).toBe("size");
    expect(folderSortOf("f1")).toBe("name");
  });

  it("getItem throws -> folderSortOf returns the default and useFolderSort does not crash", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(throwQuota);
    expect(folderSortOf("f1")).toBe("recent");
    render(<SortProbe id="a" folderId="f1" />);
    expect(screen.getByTestId("a")).toHaveTextContent("recent");
  });

  it("two components on one id: a change in one re-renders the other; after setFolderSort useFolderSortOf returns a new function that sees the new value, and without a change re-renders return the same one", () => {
    const seen: Array<(folderId: string) => FolderSort> = [];
    function SortOfProbe({ tick }: { tick: number }) {
      seen.push(useFolderSortOf());
      return <span data-testid="tick">{tick}</span>;
    }
    const { rerender } = render(
      <>
        <SortProbe id="a" folderId="f1" />
        <SortProbe id="b" folderId="f1" />
        <SortOfProbe tick={0} />
      </>,
    );
    rerender(
      <>
        <SortProbe id="a" folderId="f1" />
        <SortProbe id="b" folderId="f1" />
        <SortOfProbe tick={1} />
      </>,
    );
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);

    act(() => {
      setFolderSort("f1", "size");
    });
    expect(screen.getByTestId("a")).toHaveTextContent("size");
    expect(screen.getByTestId("b")).toHaveTextContent("size");
    expect(seen.at(-1)).not.toBe(seen[0]);
    expect(seen.at(-1)!("f1")).toBe("size");
  });
});
