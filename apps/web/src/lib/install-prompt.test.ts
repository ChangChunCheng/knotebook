import { afterEach, describe, expect, it } from "vitest";
import { installPublicPageInstallPromptGuard } from "./install-prompt";

function fireBeforeInstallPrompt(): Event {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("installPublicPageInstallPromptGuard", () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    window.history.replaceState(null, "", "/");
  });

  it.each(["/p/abc123", "/p/alice/my-note", "/P/abc123", "/p"])("public share page %s: intercepts the install prompt", (path) => {
    uninstall = installPublicPageInstallPromptGuard();
    window.history.replaceState(null, "", path);
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(true);
  });

  it.each(["/", "/notes/abc", "/login", "/n/alice/my-note", "/people", "/settings/about"])("other page %s: not intercepted", (path) => {
    uninstall = installPublicPageInstallPromptGuard();
    window.history.replaceState(null, "", path);
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(false);
  });

  it("looks at the path when the event fires: not intercepted on a normal page, intercepted after an SPA switch to a public page, not intercepted again after switching back", () => {
    window.history.replaceState(null, "", "/notes/abc");
    uninstall = installPublicPageInstallPromptGuard();
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(false);

    window.history.pushState(null, "", "/p/abc123");
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(true);

    window.history.pushState(null, "", "/");
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(false);
  });

  it("after the listener is removed, public pages are no longer intercepted", () => {
    installPublicPageInstallPromptGuard()();
    window.history.replaceState(null, "", "/p/abc123");
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(false);
  });
});
