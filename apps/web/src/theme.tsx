import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useIsPhone } from "@/lib/layout-tiers";

export type Theme = "light" | "dark" | "system";

export const ACCENTS = ["indigo", "blue", "teal", "sage", "rose", "gold"] as const;

export type Accent = (typeof ACCENTS)[number];

/** Must match index.css --background, index.html's theme-color metas and the manifest (pwa-manifest.test.ts checks). */
export const THEME_COLOR = { light: "#f3f4f6", dark: "#0e1013" } as const;

/**
 * On phones, card-backed pages (useCardPage) have a --card top bar; the browser bar must match it or a strip of the
 * page background shows above it. Other pages, and widths from 640 up, use THEME_COLOR.
 */
export const PHONE_THEME_COLOR = { light: "#ffffff", dark: "#1a1d23" } as const;

let cardPages = 0;
const cardPageListeners = new Set<() => void>();

function subscribeCardPage(listener: () => void): () => void {
  cardPageListeners.add(listener);
  return () => cardPageListeners.delete(listener);
}

export function useCardPage(): void {
  useLayoutEffect(() => {
    cardPages += 1;
    cardPageListeners.forEach((listener) => listener());
    return () => {
      cardPages -= 1;
      cardPageListeners.forEach((listener) => listener());
    };
  }, []);
}

const STORAGE_KEY = "knotebook:theme";
const ACCENT_STORAGE_KEY = "knotebook:accent";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
  accent: Accent;
  setAccent: (accent: Accent) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
}

function applyResolvedTheme(resolved: "light" | "dark", phone: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  // The metas' media queries follow only the OS, so both get the app's chosen color.
  const color = (phone ? PHONE_THEME_COLOR : THEME_COLOR)[resolved];
  for (const meta of document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.setAttribute("content", color);
  }
}

function readStoredAccent(): Accent {
  if (typeof window === "undefined") return "indigo";
  const stored = window.localStorage.getItem(ACCENT_STORAGE_KEY);
  return (ACCENTS as readonly string[]).includes(stored ?? "") ? (stored as Accent) : "indigo";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  // State, not derived from theme: with "system" it changes when the OS scheme does.
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => resolveTheme(theme));

  useEffect(() => {
    setResolvedTheme(resolveTheme(theme));
  }, [theme]);

  const phone = useIsPhone();
  const cardPage = useSyncExternalStore(subscribeCardPage, () => cardPages > 0, () => false);
  useEffect(() => {
    applyResolvedTheme(resolvedTheme, phone && cardPage);
  }, [resolvedTheme, phone, cardPage]);

  useEffect(() => {
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setResolvedTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const [accent, setAccentState] = useState<Accent>(() => readStoredAccent());

  // Always set, indigo included, while the anti-flash script omits invalid values; both render indigo through the
  // base fallback in index.css.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-accent", accent);
  }, [accent]);

  const setAccent = useCallback((next: Accent) => {
    setAccentState(next);
    window.localStorage.setItem(ACCENT_STORAGE_KEY, next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, accent, setAccent }),
    [theme, resolvedTheme, setTheme, accent, setAccent],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
