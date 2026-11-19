import i18n from "@/i18n";
import { toast } from "@/components/ui/toast";

/**
 * Installed (standalone) apps can sit in the background for days on an old version; a cold start is fine because
 * `index.html` is `no-cache`. Compares the entry script's filename (vite's `/assets/index-<hash>.js`) in a fresh `/`.
 * Never reloads automatically, so it cannot interrupt typing. A failed fetch or a non-app response (e.g. a proxy error
 * page during a deploy) counts as no new version. Without a hashed entry script (vite dev) no check is made.
 */

export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

const ENTRY_SCRIPT_PATH = /^\/assets\/index-[^/"]+\.js$/;
const ENTRY_SCRIPT_IN_HTML = /<script\b[^>]*\bsrc="(\/assets\/index-[^/"]+\.js)"/;

export function entryScriptFromHtml(html: string): string | null {
  return ENTRY_SCRIPT_IN_HTML.exec(html)?.[1] ?? null;
}

export function currentEntryScript(doc: Document = document): string | null {
  for (const script of doc.querySelectorAll<HTMLScriptElement>("script[src]")) {
    const src = script.getAttribute("src");
    if (src !== null && ENTRY_SCRIPT_PATH.test(src)) return src;
  }
  return null;
}

// The server returns index.html only for requests whose Accept includes text/html; others (`*/*`) get a JSON 404, so Accept must be sent.
async function fetchIndexHtml(): Promise<string> {
  const res = await fetch("/", { headers: { Accept: "text/html" }, cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`GET / ${res.status}`);
  return res.text();
}

export interface UpdateCheckOptions {
  onUpdate: () => void;
  fetchHtml?: () => Promise<string>;
  now?: () => number;
  intervalMs?: number;
  doc?: Document;
}

/** Load time counts as the first check, so the earliest real fetch is 30 minutes after load. */
export function installUpdateCheck({
  onUpdate,
  fetchHtml = fetchIndexHtml,
  now = Date.now,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
  doc = document,
}: UpdateCheckOptions): () => void {
  const current = currentEntryScript(doc);
  if (current === null) return () => {};

  let lastCheck = now();
  let checking = false;
  let notified = false;

  const onVisibilityChange = () => {
    if (doc.visibilityState !== "visible" || checking || notified) return;
    if (now() - lastCheck < intervalMs) return;
    lastCheck = now();
    checking = true;
    fetchHtml()
      .then((html) => {
        const latest = entryScriptFromHtml(html);
        if (latest !== null && latest !== current && !notified) {
          notified = true;
          onUpdate();
        }
      })
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  };

  doc.addEventListener("visibilitychange", onVisibilityChange);
  return () => doc.removeEventListener("visibilitychange", onVisibilityChange);
}

/** `reload` is injectable only for tests (jsdom's `location.reload` cannot be replaced). */
export function showUpdateAvailableToast(reload: () => void = () => window.location.reload()): void {
  toast({
    title: i18n.t("app.updateAvailable"),
    durationMs: Infinity,
    action: { label: i18n.t("app.reload"), onClick: reload },
  });
}
