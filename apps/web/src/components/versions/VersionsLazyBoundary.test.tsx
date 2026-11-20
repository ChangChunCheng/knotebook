import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { VersionsLazyBoundary } from "./VersionsLazyBoundary";

function Boom(): never {
  throw new TypeError("Failed to fetch dynamically imported module: /assets/VersionsLazy-abc.js");
}

describe("VersionsLazyBoundary", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("chunk load failure: reloads once using versions' own allowance and NotePage's allowance flag is untouched", async () => {
    await i18n.changeLanguage("en");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(
      <VersionsLazyBoundary noteId="n1" reload={reload}>
        <Boom />
      </VersionsLazyBoundary>,
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem("knotebook:chunk-reload:versions")).not.toBeNull();
    expect(sessionStorage.getItem("knotebook:chunk-reload:notepage")).toBeNull();
  });

  it("second failure in the same session: no further reload, shows an inline error in place (not wrapped in AppShell)", async () => {
    await i18n.changeLanguage("en");
    vi.spyOn(console, "error").mockImplementation(() => {});
    sessionStorage.setItem("knotebook:chunk-reload:versions", "1");
    const reload = vi.fn();
    const { container } = render(
      <VersionsLazyBoundary noteId="n1" reload={reload}>
        <Boom />
      </VersionsLazyBoundary>,
    );
    await waitFor(() => expect(container.textContent?.length ?? 0).toBeGreaterThan(0));
    expect(reload).not.toHaveBeenCalled();
    expect(container.querySelector("main")).toBeNull();
  });

  it("a non-chunk render error -> shows the version history's own text (not the note-crash text of app.noteCrash), with the error view wrapped in the frame class given by the caller; the normal state has no such frame", async () => {
    await i18n.changeLanguage("en");
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Crash(): never {
      throw new Error("render bug");
    }
    const { container, unmount } = render(
      <VersionsLazyBoundary noteId="n1" reload={vi.fn()} errorClassName="kb-test-frame">
        <Crash />
      </VersionsLazyBoundary>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Version history couldn't be shown.");
    expect(alert).not.toHaveTextContent(i18n.t("app.noteCrash"));
    expect(alert.closest(".kb-test-frame")).not.toBeNull();
    unmount();
    const ok = render(
      <VersionsLazyBoundary noteId="n1" errorClassName="kb-test-frame">
        <span>fine</span>
      </VersionsLazyBoundary>,
    );
    expect(await ok.findByText("fine")).toBeInTheDocument();
    expect(ok.container.querySelector(".kb-test-frame")).toBeNull();
    expect(container).toBeDefined();
  });

  it("#263: crashMessageKey replaces the text for non-chunk errors (the selection AI preview passes ai.box.previewCrash)", async () => {
    await i18n.changeLanguage("en");
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Crash(): never {
      throw new Error("render bug");
    }
    render(
      <VersionsLazyBoundary noteId="n1" reload={vi.fn()} crashMessageKey="ai.box.previewCrash">
        <Crash />
      </VersionsLazyBoundary>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The preview couldn't be shown.");
    expect(alert).not.toHaveTextContent("Version history couldn't be shown.");
  });

  it("successful load: the beacon inside Suspense clears versions' flag", async () => {
    sessionStorage.setItem("knotebook:chunk-reload:versions", "1");
    render(
      <VersionsLazyBoundary noteId="n1">
        <span>ok</span>
      </VersionsLazyBoundary>,
    );
    expect(await screen.findByText("ok")).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem("knotebook:chunk-reload:versions")).toBeNull());
  });
});
