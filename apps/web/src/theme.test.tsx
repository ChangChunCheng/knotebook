import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { PHONE_THEME_COLOR, THEME_COLOR, ThemeProvider, useCardPage, useTheme } from "./theme";
import { stubLayoutTier } from "@/test/layout-tier";

const STORAGE_KEY = "knotebook:theme";
const ACCENT_STORAGE_KEY = "knotebook:accent";

function Probe() {
  const { theme, resolvedTheme, setTheme, accent, setAccent } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <span data-testid="accent">{accent}</span>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setTheme("system")}>system</button>
      <button onClick={() => setAccent("teal")}>set-accent-teal</button>
    </div>
  );
}

interface InlineScriptResult {
  dark: boolean;
  accent: string | null;
}

/** Grabs the pre-hydration script from index.html's <head> and runs it in jsdom with the given
 * storage values and OS preference, returning its decision about the dark class and the data-accent attribute.
 * The accent and theme flash-prevention logic share the same <script> (see the comment in index.html),
 * and what is grabbed here is the source of the whole first <script>...</script>. */
function runInlineThemeScript(
  stored: string | null,
  prefersDark: boolean,
  storedAccent: string | null = null,
): InlineScriptResult {
  const html = readFileSync(`${process.cwd()}/index.html`, "utf8");
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  const source = head.slice(head.indexOf("<script>") + "<script>".length, head.indexOf("</script>"));

  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-accent");
  window.localStorage.clear();
  if (stored !== null) window.localStorage.setItem(STORAGE_KEY, stored);
  if (storedAccent !== null) window.localStorage.setItem(ACCENT_STORAGE_KEY, storedAccent);
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: prefersDark && query.includes("dark") })) as unknown as typeof window.matchMedia;

  try {
    new Function(source)();
    return {
      dark: document.documentElement.classList.contains("dark"),
      accent: document.documentElement.getAttribute("data-accent"),
    };
  } finally {
    window.matchMedia = originalMatchMedia;
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
  }
}

/** Hands the same input to the real ThemeProvider and returns its decision about the dark class and
 * the data-accent attribute after mounting. ThemeProvider always sets data-accent (indigo too) - asymmetric with the
 * flash-prevention script's "don't set the attribute for an invalid value", so the literal values must not be compared directly; see the callers. */
function renderThemeProvider(
  stored: string | null,
  prefersDark: boolean,
  storedAccent: string | null = null,
): InlineScriptResult {
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-accent");
  window.localStorage.clear();
  if (stored !== null) window.localStorage.setItem(STORAGE_KEY, stored);
  if (storedAccent !== null) window.localStorage.setItem(ACCENT_STORAGE_KEY, storedAccent);
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: prefersDark && query.includes("dark"),
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;

  try {
    const view = render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    const dark = document.documentElement.classList.contains("dark");
    const accent = document.documentElement.getAttribute("data-accent");
    view.unmount();
    return { dark, accent };
  } finally {
    window.matchMedia = originalMatchMedia;
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
  }
}

describe("ThemeProvider / useTheme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
  });

  it("defaults to 'system' and does not add .dark when the OS prefers light", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme")).toHaveTextContent("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("switching to 'dark' writes localStorage and adds the .dark class to <html>", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByText("dark").click();
    });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });

  it("switching to 'light' writes localStorage and removes the .dark class", () => {
    window.localStorage.setItem(STORAGE_KEY, "dark");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    act(() => {
      screen.getByText("light").click();
    });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("reads a previously stored theme from localStorage on mount", () => {
    window.localStorage.setItem(STORAGE_KEY, "dark");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("updates resolvedTheme when the OS theme flips while theme === 'system'", () => {
    // jsdom doesn't implement matchMedia; add a minimal fake MediaQueryList: a mutable
    // `matches`, recording change listeners so tests can manually trigger "the OS switches to dark mode".
    let changeListener: (() => void) | undefined;
    const fakeMql = {
      matches: false,
      addEventListener: (event: string, listener: () => void) => {
        if (event === "change") changeListener = listener;
      },
      removeEventListener: (event: string, listener: () => void) => {
        if (event === "change" && changeListener === listener) changeListener = undefined;
      },
    };
    const originalMatchMedia = window.matchMedia;
    // Only the light/dark query uses this fake; layout-width queries (phone width has its own theme-color) never match.
    const wide = { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
    window.matchMedia = ((query: string) => (query.includes("prefers-color-scheme") ? fakeMql : wide)) as unknown as typeof window.matchMedia;
    const metas = ["light", "dark"].map((scheme) => {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.setAttribute("media", `(prefers-color-scheme: ${scheme})`);
      meta.content = "#sentinel";
      document.head.append(meta);
      return meta;
    });

    try {
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );

      expect(screen.getByTestId("theme")).toHaveTextContent("system");
      expect(screen.getByTestId("resolved")).toHaveTextContent("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      for (const meta of metas) expect(meta.getAttribute("content")).toBe(THEME_COLOR.light);

      act(() => {
        fakeMql.matches = true;
        changeListener?.();
      });

      expect(screen.getByTestId("theme")).toHaveTextContent("system");
      expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      for (const meta of metas) expect(meta.getAttribute("content")).toBe(THEME_COLOR.dark);

      act(() => {
        // Only the OS flipped, theme unchanged: the theme-color meta must follow this too, not only theme changes.
        fakeMql.matches = false;
        changeListener?.();
      });
      for (const meta of metas) expect(meta.getAttribute("content")).toBe(THEME_COLOR.light);
    } finally {
      for (const meta of metas) meta.remove();
      window.matchMedia = originalMatchMedia;
    }
  });

  it("throws when useTheme() is used outside a ThemeProvider", () => {
    function Bare() {
      useTheme();
      return null;
    }
    // React 18+ in development prints console.error one extra time for an uncaught render error;
    // all that matters here is that it throws, and expect(...).toThrow is enough without extra silencing.
    expect(() => render(<Bare />)).toThrow(/ThemeProvider/);
  });

  /**
   * The first-paint dark background is handled by the synchronous script inlined in `index.html` (the class must be put on before React mounts,
   * otherwise there is a white flash). That script can't import this file's constants, so it can only copy the literal values.
   *
   * This case really extracts the script and runs it, comparing against `ThemeProvider`'s result for each storage value: once the script
   * stops being equivalent to `readStoredTheme` + `resolveTheme` (e.g. treating a bad value as light rather than system),
   * those users' first paint would flash until React mounts.
   */
  it.each([null, "dark", "light", "system", "", "Dark", "sepia", "auto"])(
    "pre-hydration script's decision for storage value %o is equivalent to ThemeProvider (checked once each with OS dark and light)",
    (stored) => {
      for (const prefersDark of [false, true]) {
        expect(runInlineThemeScript(stored, prefersDark).dark).toBe(
          renderThemeProvider(stored, prefersDark).dark,
        );
      }
    },
  );

  /**
   * Equivalence case for accent flash prevention: for an invalid value the script "doesn't set the attribute" (getAttribute
   * returns null), while ThemeProvider always sets it (indigo too) - the two show the same colour because the
   * `:root` / `:root.dark` base fallback in index.css = the indigo value, not because the attribute literals are equal.
   * Compare by normalizing both sides to `attribute value ?? "indigo"`.
   */
  it.each([null, "", "indigo", "blue", "teal", "sage", "rose", "gold", "Teal", "cyan"])(
    "pre-hydration script's decision for accent storage value %o is equivalent to ThemeProvider (compared after normalizing)",
    (storedAccent) => {
      const scriptResult = runInlineThemeScript(null, false, storedAccent);
      const providerResult = renderThemeProvider(null, false, storedAccent);

      expect(scriptResult.accent ?? "indigo").toBe(providerResult.accent ?? "indigo");
    },
  );

  it("the pre-hydration script in index.html and theme.tsx use the same storage key and class", () => {
    // Under vitest `import.meta.url` is vite's http URL and can't be fed to fs - build the path from cwd
    // (always apps/web when running tests).
    const html = readFileSync(`${process.cwd()}/index.html`, "utf8");
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    // Take only the script body: the head also has `<meta name="theme-color" media="(prefers-color-scheme: dark)">` (#336),
    // and matching against the whole head would let the "prefers-color-scheme: dark" assertion below stay green even after the script loses it.
    const inlineScript = head.slice(head.indexOf("<script>"), head.indexOf("</script>"));

    expect(inlineScript).toContain(STORAGE_KEY);
    expect(inlineScript).toContain("prefers-color-scheme: dark");
    expect(inlineScript).toMatch(/classList\.(add|toggle)\(\s*"dark"/);
    expect(inlineScript).toContain(ACCENT_STORAGE_KEY);
    expect(inlineScript).toMatch(/setAttribute\(\s*"data-accent"/);
  });

  it("defaults accent to 'indigo' and sets data-accent on <html>", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("accent")).toHaveTextContent("indigo");
    expect(document.documentElement.getAttribute("data-accent")).toBe("indigo");
  });

  it("reads a previously stored valid accent from localStorage on mount", () => {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, "teal");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("accent")).toHaveTextContent("teal");
    expect(document.documentElement.getAttribute("data-accent")).toBe("teal");
  });

  it("falls back to 'indigo' when the stored accent is not one of the six valid names", () => {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, "chartreuse");

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("accent")).toHaveTextContent("indigo");
    expect(document.documentElement.getAttribute("data-accent")).toBe("indigo");
  });

  it("switching accent writes localStorage and updates data-accent on <html>", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByText("set-accent-teal").click();
    });

    expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("teal");
    expect(document.documentElement.getAttribute("data-accent")).toBe("teal");
    expect(screen.getByTestId("accent")).toHaveTextContent("teal");
  });
});

/**
 * #336: <meta name="theme-color"> follows the theme chosen inside the app, not only the device setting
 * (the two metas in index.html rely on a media query and only recognise the OS). The test creates two metas in the head itself and cleans them up afterwards.
 */
describe("ThemeProvider syncs <meta name=\"theme-color\">", () => {
  let lightMeta: HTMLMetaElement;
  let darkMeta: HTMLMetaElement;
  const originalMatchMedia = window.matchMedia;

  function fakeSystem(prefersDark: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: prefersDark && query.includes("dark"),
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  }

  function renderProvider() {
    return render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
  }

  function expectBoth(color: string) {
    expect(lightMeta.getAttribute("content")).toBe(color);
    expect(darkMeta.getAttribute("content")).toBe(color);
  }

  beforeEach(() => {
    window.localStorage.clear();
    lightMeta = document.createElement("meta");
    lightMeta.name = "theme-color";
    lightMeta.setAttribute("media", "(prefers-color-scheme: light)");
    lightMeta.content = "#sentinel-light";
    darkMeta = document.createElement("meta");
    darkMeta.name = "theme-color";
    darkMeta.setAttribute("media", "(prefers-color-scheme: dark)");
    darkMeta.content = "#sentinel-dark";
    document.head.append(lightMeta, darkMeta);
  });

  afterEach(() => {
    lightMeta.remove();
    darkMeta.remove();
    window.matchMedia = originalMatchMedia;
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
  });

  it("THEME_COLOR is light #f3f4f6 / dark #0e1013", () => {
    expect(THEME_COLOR).toEqual({ light: "#f3f4f6", dark: "#0e1013" });
  });

  it("PHONE_THEME_COLOR is the hex in the index.css card colour --card comment (light / dark)", () => {
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8");
    const cards = [...css.matchAll(/--card:\s*[^;]+;\s*\/\*\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]!.toLowerCase());
    expect(cards.slice(0, 2)).toEqual([PHONE_THEME_COLOR.light, PHONE_THEME_COLOR.dark]);
  });

  it("phone width (< 640) with a card-background page (list and note, public page) mounted: both metas are the card colour; from 640 up they switch back to the page-background colour, and back again to the card colour", () => {
    const tier = stubLayoutTier("phone", (query) => query.includes("dark"));
    function CardPage() {
      useCardPage();
      return null;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, "dark");
      render(
        <ThemeProvider>
          <Probe />
          <CardPage />
        </ThemeProvider>,
      );
      expectBoth(PHONE_THEME_COLOR.dark);
      act(() => tier.setLayoutTier("overlay"));
      expectBoth(THEME_COLOR.dark);
      act(() => tier.setLayoutTier("phone"));
      expectBoth(PHONE_THEME_COLOR.dark);
      act(() => screen.getByRole("button", { name: "light" }).click());
      expectBoth(PHONE_THEME_COLOR.light);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("phone width but not a card-background page (sign-in, register, authorize, loading): still the page-background colour; it switches when a card-background page mounts and back when it unmounts", () => {
    stubLayoutTier("phone", (query) => query.includes("dark"));
    function CardPage() {
      useCardPage();
      return null;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, "dark");
      const tree = (card: boolean) => (
        <ThemeProvider>
          <Probe />
          {card && <CardPage />}
        </ThemeProvider>
      );
      const view = render(tree(false));
      expectBoth(THEME_COLOR.dark);
      view.rerender(tree(true));
      expectBoth(PHONE_THEME_COLOR.dark);
      view.rerender(tree(false));
      expectBoth(THEME_COLOR.dark);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("system light, app dark: both metas are the dark page-background colour", () => {
    fakeSystem(false);
    window.localStorage.setItem(STORAGE_KEY, "dark");
    renderProvider();
    expectBoth(THEME_COLOR.dark);
  });

  it("system dark, app light: both metas are the light page-background colour", () => {
    fakeSystem(true);
    window.localStorage.setItem(STORAGE_KEY, "light");
    renderProvider();
    expectBoth(THEME_COLOR.light);
  });

  it("app chooses system: follows the system (dark system -> dark, light system -> light)", () => {
    fakeSystem(true);
    window.localStorage.setItem(STORAGE_KEY, "system");
    const dark = renderProvider();
    expectBoth(THEME_COLOR.dark);
    dark.unmount();

    fakeSystem(false);
    renderProvider();
    expectBoth(THEME_COLOR.light);
  });

  it("after a theme switch both metas follow (light -> dark -> light)", () => {
    fakeSystem(false);
    renderProvider();
    expectBoth(THEME_COLOR.light);

    act(() => {
      screen.getByText("dark").click();
    });
    expectBoth(THEME_COLOR.dark);

    act(() => {
      screen.getByText("light").click();
    });
    expectBoth(THEME_COLOR.light);
  });

  it("doesn't throw when the head has no theme-color meta", () => {
    lightMeta.remove();
    darkMeta.remove();
    fakeSystem(false);
    window.localStorage.setItem(STORAGE_KEY, "dark");
    expect(() => renderProvider()).not.toThrow();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    // Put it back so afterEach's remove is also safe on an already-removed node
    document.head.append(lightMeta, darkMeta);
  });

  it("only touches theme-color: other metas in the head are unaffected", () => {
    const other = document.createElement("meta");
    other.name = "description";
    other.content = "keep-me";
    document.head.append(other);
    try {
      fakeSystem(false);
      window.localStorage.setItem(STORAGE_KEY, "dark");
      renderProvider();
      expect(other.getAttribute("content")).toBe("keep-me");
    } finally {
      other.remove();
    }
  });
});
