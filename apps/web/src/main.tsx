import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { clearStaleOneTimeTokens } from "./auth/oneTimeTokenStorage";
import { installCustomColors } from "./lib/custom-colors";
import { installPublicPageInstallPromptGuard } from "./lib/install-prompt";
import { installUpdateCheck, showUpdateAvailableToast } from "./lib/update-check";
import "./i18n";
import "./index.css";
// Only the logo's Latin "K" uses this font, so the latin subset is enough.
import "@fontsource/playfair-display/latin-700-italic.css";

// No default staleTime: ShareDialog waits on isFetchedAfterMount, which would then never become true (tests may
// still pass).
const queryClient = new QueryClient();

clearStaleOneTimeTokens(window.location.pathname);

// Custom colors have no prebuilt CSS, so observing the DOM must start before React renders note content.
installCustomColors();

// Must be installed before the browser fires beforeinstallprompt.
installPublicPageInstallPromptGuard();

// Installed-app tabs can sit in the background for days; check for a new version on returning to the foreground.
installUpdateCheck({ onUpdate: () => showUpdateAvailableToast() });

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
