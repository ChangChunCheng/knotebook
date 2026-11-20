import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { Toaster, dismissAllToasts } from "@/components/ui/toast";
import {
  UPDATE_CHECK_INTERVAL_MS,
  currentEntryScript,
  entryScriptFromHtml,
  installUpdateCheck,
  showUpdateAvailableToast,
} from "./update-check";

const CURRENT = "/assets/index-AAAA1111.js";
const NEWER = "/assets/index-BBBB2222.js";

function indexHtml(entry: string): string {
  return `<!doctype html><html><head>
    <link rel="manifest" href="/manifest.webmanifest" />
    <script type="module" crossorigin src="${entry}"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-CCCC.js">
    <link rel="stylesheet" crossorigin href="/assets/index-DDDD.css">
  </head><body><div id="root"></div></body></html>`;
}

function fakeDocument(entry: string | null) {
  const target = new EventTarget();
  const doc = document.implementation.createHTMLDocument("t");
  if (entry !== null) {
    const script = doc.createElement("script");
    script.type = "module";
    script.setAttribute("src", entry);
    doc.head.append(script);
  }
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(doc, "visibilityState", { get: () => visibility });
  doc.addEventListener = target.addEventListener.bind(target) as Document["addEventListener"];
  doc.removeEventListener = target.removeEventListener.bind(target) as Document["removeEventListener"];
  return {
    doc,
    show() {
      visibility = "visible";
      target.dispatchEvent(new Event("visibilitychange"));
    },
    hide() {
      visibility = "hidden";
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("entryScriptFromHtml / currentEntryScript", () => {
  it("extracts the entry script from a vite-built index.html, without picking modulepreload or CSS", () => {
    expect(entryScriptFromHtml(indexHtml(NEWER))).toBe(NEWER);
  });

  it("no /assets/index-*.js in the HTML (error page, dev server) -> null", () => {
    expect(entryScriptFromHtml("<html><body>502 Bad Gateway</body></html>")).toBeNull();
    expect(entryScriptFromHtml('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
  });

  it("current page: reads the raw src attribute", () => {
    expect(currentEntryScript(fakeDocument(CURRENT).doc)).toBe(CURRENT);
    expect(currentEntryScript(fakeDocument("/src/main.tsx").doc)).toBeNull();
    expect(currentEntryScript(fakeDocument(null).doc)).toBeNull();
  });
});

describe("installUpdateCheck", () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
  });

  function setup(html: string | (() => Promise<string>), entry: string | null = CURRENT) {
    const page = fakeDocument(entry);
    const fetchHtml = vi.fn(typeof html === "string" ? () => Promise.resolve(html) : html);
    const onUpdate = vi.fn();
    const uninstall = installUpdateCheck({ onUpdate, fetchHtml, now, doc: page.doc });
    return { page, fetchHtml, onUpdate, uninstall };
  }

  it("the interval is 30 minutes", () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(30 * 60 * 1000);
  });

  it("returning to the foreground before 30 minutes after load: does not fetch", async () => {
    const { page, fetchHtml } = setup(indexHtml(NEWER));
    clock += UPDATE_CHECK_INTERVAL_MS - 1;
    page.show();
    await flush();
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it("returning to the foreground after 30 minutes with a different entry script: prompts once", async () => {
    const { page, fetchHtml, onUpdate } = setup(indexHtml(NEWER));
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("same entry script: no prompt, and the next check waits another 30 minutes", async () => {
    const { page, fetchHtml, onUpdate } = setup(indexHtml(CURRENT));
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();

    clock += UPDATE_CHECK_INTERVAL_MS - 1;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);

    clock += 1;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(2);
  });

  it("going to the background (hidden): does not fetch", async () => {
    const { page, fetchHtml } = setup(indexHtml(NEWER));
    clock += UPDATE_CHECK_INTERVAL_MS * 2;
    page.hide();
    await flush();
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it("after prompting, neither checks nor prompts again", async () => {
    const { page, fetchHtml, onUpdate } = setup(indexHtml(NEWER));
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    clock += UPDATE_CHECK_INTERVAL_MS * 3;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("returning to the foreground while the previous fetch has not finished: does not fetch again", async () => {
    let resolve!: (html: string) => void;
    const { page, fetchHtml, onUpdate } = setup(() => new Promise<string>((r) => (resolve = r)));
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    resolve(indexHtml(NEWER));
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("fetch failure or a response that is not the app's HTML: no prompt, retry after 30 minutes", async () => {
    let attempt = 0;
    const { page, fetchHtml, onUpdate } = setup(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("offline"));
      if (attempt === 2) return Promise.resolve("<html>502 Bad Gateway</html>");
      return Promise.resolve(indexHtml(NEWER));
    });
    for (let i = 0; i < 3; i++) {
      clock += UPDATE_CHECK_INTERVAL_MS;
      page.show();
      await flush();
    }
    expect(fetchHtml).toHaveBeenCalledTimes(3);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("after a fetch failure it also waits the full 30 minutes before retrying", async () => {
    const { page, fetchHtml } = setup(() => Promise.reject(new Error("offline")));
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);

    clock += UPDATE_CHECK_INTERVAL_MS - 1;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);

    clock += 1;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(2);
  });

  it("no hashed entry script on the current page (dev server): no check at all", async () => {
    const { page, fetchHtml } = setup(indexHtml(NEWER), "/src/main.tsx");
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it("after the listener is removed, no more checks", async () => {
    const { page, fetchHtml, uninstall } = setup(indexHtml(NEWER));
    uninstall();
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    expect(fetchHtml).not.toHaveBeenCalled();
  });
});

describe("default fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches / with Accept: text/html and no-store (the server returns index.html only for requests that accept HTML)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(indexHtml(NEWER), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const page = fakeDocument(CURRENT);
    const onUpdate = vi.fn();
    let clock = 1_000_000;
    installUpdateCheck({ onUpdate, now: () => clock, doc: page.doc });
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/");
    expect((init.headers as Record<string, string>).Accept).toContain("text/html");
    expect(init.cache).toBe("no-store");
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("showUpdateAvailableToast", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    act(() => dismissAllToasts());
  });

  it("shows the updated notice and a Reload button; reloads only when clicked", () => {
    render(<Toaster />);
    const reload = vi.fn();
    act(() => showUpdateAvailableToast(reload));
    expect(screen.getByText("Knotebook has been updated")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    act(() => screen.getByRole("button", { name: "Reload" }).click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not disappear on its own", () => {
    vi.useFakeTimers();
    try {
      render(<Toaster />);
      act(() => showUpdateAvailableToast(() => {}));
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText("Knotebook has been updated")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Chinese UI", async () => {
    await i18n.changeLanguage("zh-TW");
    render(<Toaster />);
    act(() => showUpdateAvailableToast(() => {}));
    expect(screen.getByText("Knotebook 已更新")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新整理" })).toBeInTheDocument();
  });
});
