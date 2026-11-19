import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { SidebarLazyBoundary } from "./SidebarLazyBoundary";

// Error text follows Chromium's wording for a failed bare dynamic import (CHUNK_ERROR_PATTERNS in ErrorBoundary.tsx).
function Boom(): never {
  throw new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/SelectLazy-abc.js");
}

const SELECT_FLAG = "knotebook:chunk-reload:select";
const TRASH_FLAG = "knotebook:chunk-reload:trash";
const FOLDER_FLAG = "knotebook:chunk-reload:folder";

describe("SidebarLazyBoundary", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("chunk=\"select\" first failure: reloads once using select's own allowance, trash's allowance is untouched", async () => {
    render(
      <SidebarLazyBoundary chunk="select" fallback={null}>
        <Boom />
      </SidebarLazyBoundary>,
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(SELECT_FLAG)).not.toBeNull();
    expect(sessionStorage.getItem(TRASH_FLAG)).toBeNull();
  });

  it("select's allowance already used: no reload; error plus retry shown in place, errorClassName applied to the outer frame", async () => {
    sessionStorage.setItem(SELECT_FLAG, "1");
    render(
      <SidebarLazyBoundary chunk="select" fallback={null} errorClassName="kb-test-frame">
        <Boom />
      </SidebarLazyBoundary>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(alert.parentElement?.className).toBe("kb-test-frame");
    expect(reload).not.toHaveBeenCalled();
  });

  it("chunk=\"folder\" first failure: reloads once using folder's own allowance, select's and trash's allowances are untouched", async () => {
    render(
      <SidebarLazyBoundary chunk="folder" fallback={null}>
        <Boom />
      </SidebarLazyBoundary>,
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(FOLDER_FLAG)).not.toBeNull();
    expect(sessionStorage.getItem(SELECT_FLAG)).toBeNull();
    expect(sessionStorage.getItem(TRASH_FLAG)).toBeNull();
  });

  it("chunk=\"select\" loads successfully: clears select's own allowance, trash's allowance is untouched", async () => {
    sessionStorage.setItem(SELECT_FLAG, "1");
    sessionStorage.setItem(TRASH_FLAG, "1");
    render(
      <SidebarLazyBoundary chunk="select" fallback={null}>
        <p>ok</p>
      </SidebarLazyBoundary>,
    );
    expect(await screen.findByText("ok")).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem(SELECT_FLAG)).toBeNull());
    expect(sessionStorage.getItem(TRASH_FLAG)).toBe("1");
  });
});
