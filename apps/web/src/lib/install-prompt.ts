import { isPublicSharePath } from "@knotebook/shared";

/**
 * Public pages are served the same index.html (manifest link included), so Chromium would prompt
 * anonymous readers to install an app that only opens the login page. Not done by omitting the
 * link: iOS reads the DOM at add-to-home-screen time and dynamic insertion is fragile. The path is
 * checked when the event fires because SPA navigation does not reload.
 */
export function installPublicPageInstallPromptGuard(target: Window = window): () => void {
  const onBeforeInstallPrompt = (event: Event) => {
    if (isPublicSharePath(target.location.pathname)) event.preventDefault();
  };
  target.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  return () => target.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
}
