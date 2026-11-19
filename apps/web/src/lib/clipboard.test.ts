import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

/**
 * `navigator.clipboard` exists only in secure contexts (https or localhost). One of the most common self-hosted topologies is a
 * plain-http LAN address, where the whole API is missing, so each case must separately control whether the clipboard API exists
 * and whether execCommand succeeds.
 */
function stubClipboard(writeText: (() => Promise<void>) | null): void {
  vi.stubGlobal("navigator", writeText === null ? {} : { clipboard: { writeText } });
}

function stubExecCommand(result: boolean | (() => never)): ReturnType<typeof vi.fn> {
  const execCommand = vi.fn(typeof result === "function" ? result : () => result);
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true });
  return execCommand;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The two document methods are added with defineProperty (jsdom does not implement them); clear them per case to avoid leaking.
  Reflect.deleteProperty(document, "execCommand");
  Reflect.deleteProperty(document, "queryCommandEnabled");
});

describe("copyText", () => {
  it("secure context: uses navigator.clipboard.writeText", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    const execCommand = stubExecCommand(true);

    await expect(copyText("https://example.test/notes/x")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://example.test/notes/x");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("non-secure context (no navigator.clipboard): falls back to execCommand and still copies", async () => {
    stubClipboard(null);
    const execCommand = stubExecCommand(true);

    await expect(copyText("http://192.168.0.2:3000/notes/x")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("clipboard API present but throws (permission denied): falls back to execCommand", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    const execCommand = stubExecCommand(true);

    await expect(copyText("x")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("both paths fail -> false (the caller uses this to show the manual-copy fallback)", async () => {
    stubClipboard(null);
    stubExecCommand(false);

    await expect(copyText("x")).resolves.toBe(false);
  });

  it("an execCommand throw also counts as failure and is not rethrown", async () => {
    stubClipboard(null);
    stubExecCommand(() => {
      throw new Error("nope");
    });

    await expect(copyText("x")).resolves.toBe(false);
  });

  /**
   * Pins a real failure: Radix's modal dialog installs a document-level `focusin` listener that synchronously grabs focus back whenever
   * it lands outside the container. A textarea attached to `document.body` loses focus right after `select()`, and
   * `execCommand("copy")` runs on an unfocused textarea: Chromium still returns `true` but the clipboard is empty, so the user
   * sees "copied" with nothing copied. So the textarea must be attached inside the dialog container that has focus.
   */
  it("when focus is inside a modal dialog, the temporary textarea is attached inside that dialog, not document.body", async () => {
    stubClipboard(null);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();

    let hostAtCopyTime: string | null = null;
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => {
        const textarea = document.querySelector("textarea");
        hostAtCopyTime = textarea?.parentElement === dialog ? "dialog" : (textarea?.parentElement?.tagName ?? "none");
        return true;
      }),
      configurable: true,
      writable: true,
    });

    await expect(copyText("x")).resolves.toBe(true);
    expect(hostAtCopyTime).toBe("dialog");

    dialog.remove();
  });

  /**
   * The host selector is widened to `[role="dialog"],[role="menu"]`: the note card's ⋮ menu (Radix DropdownMenu, `role="menu"`) is
   * the same focus-trap surface as a dialog. Mirrors the dialog case above with a `role="menu"` container, to cover the widened selector branch.
   */
  it("when focus is inside a role=menu container, the temporary textarea is attached inside that container, not document.body", async () => {
    stubClipboard(null);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("div");
    item.setAttribute("tabindex", "-1");
    menu.appendChild(item);
    document.body.appendChild(menu);
    item.focus();

    let hostAtCopyTime: string | null = null;
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => {
        const textarea = document.querySelector("textarea");
        hostAtCopyTime = textarea?.parentElement === menu ? "menu" : (textarea?.parentElement?.tagName ?? "none");
        return true;
      }),
      configurable: true,
      writable: true,
    });

    await expect(copyText("x")).resolves.toBe(true);
    expect(hostAtCopyTime).toBe("menu");

    menu.remove();
  });

  it("browser reports the copy command unavailable (queryCommandEnabled false) -> always treated as failure, no false success", async () => {
    stubClipboard(null);
    stubExecCommand(true); // Chromium still returns true when focus has been stolen, so it cannot be trusted alone
    Object.defineProperty(document, "queryCommandEnabled", {
      value: vi.fn(() => false),
      configurable: true,
      writable: true,
    });

    await expect(copyText("x")).resolves.toBe(false);
  });

  it("fallback leaves no temporary textarea behind", async () => {
    stubClipboard(null);
    stubExecCommand(true);

    await copyText("x");

    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});
