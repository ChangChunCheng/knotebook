import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import pkg from "../../package.json";
import { SettingsAboutSection } from "./SettingsAboutSection";
import { DOCS_URL, INSTALL_APP_DOCS_URL, LICENSE_URL, REPO_URL } from "./about-links";

describe("SettingsAboutSection (#247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("version = version in apps/web/package.json (injected as __APP_VERSION__ via vite define)", () => {
    render(<SettingsAboutSection />);
    expect(__APP_VERSION__).toBe(pkg.version);
    expect(screen.getByText(`v${pkg.version}`)).toBeInTheDocument();
  });

  it("all four links are built from REPO_URL and open in a new tab", () => {
    render(<SettingsAboutSection />);
    expect(REPO_URL).toBe("https://github.com/sw-willie-wu/knotebook");
    expect(screen.getByRole("link", { name: "github.com/sw-willie-wu/knotebook" })).toHaveAttribute("href", REPO_URL);
    expect(screen.getByRole("link", { name: "docs/ folder" })).toHaveAttribute("href", DOCS_URL);
    expect(screen.getByRole("link", { name: "LICENSE" })).toHaveAttribute("href", LICENSE_URL);
    expect(screen.getByRole("link", { name: "How to install Knotebook as an app" })).toHaveAttribute("href", INSTALL_APP_DOCS_URL);
    expect(INSTALL_APP_DOCS_URL).toBe(`${REPO_URL}/blob/main/docs/install-app.md`);
    expect(screen.getAllByRole("link")).toHaveLength(4);
    expect(DOCS_URL).toBe(`${REPO_URL}/tree/main/docs`);
    expect(LICENSE_URL).toBe(`${REPO_URL}/blob/main/LICENSE`);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer");
    }
  });

  it("makes no network requests (there is no \"check for updates\")", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<SettingsAboutSection />);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
