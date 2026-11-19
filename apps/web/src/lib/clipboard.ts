/**
 * `navigator.clipboard` is missing in non-secure contexts (plain-http LAN is a supported
 * topology), so the deprecated `execCommand("copy")` path stays as the fallback.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
    }
  }

  return copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // Not display:none / visibility:hidden: the text could not be selected.
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Mount inside the open dialog/menu: Radix's document-level `focusin` listener reclaims focus from
  // a textarea on document.body, and `execCommand("copy")` then copies nothing while still returning
  // true. The ⋮ menu is `role="menu"` with the same trap.
  const host = active?.closest('[role="dialog"],[role="menu"]') ?? document.body;

  host.appendChild(textarea);
  try {
    textarea.select();
    // queryCommandEnabled is false in the "returns true but nothing copied" case.
    if (typeof document.queryCommandEnabled === "function" && !document.queryCommandEnabled("copy")) {
      return false;
    }
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    active?.focus();
  }
}
