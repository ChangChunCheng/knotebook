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

/**
 * 各主題下的實際頁底色（index.css 的 --background）。同步到 <meta name="theme-color">，
 * 讓 standalone／PWA 的上方列跟 app 內選的主題。index.html 的兩個 meta 初始值與
 * manifest 的 theme_color（淺色）須與此一致，由 pwa-manifest.test.ts 守住。
 */
export const THEME_COLOR = { light: "#f3f4f6", dark: "#0e1013" } as const;

/**
 * 手機寬度（< 640）、而且畫面是卡片底的頁面（`useCardPage`：清單與筆記、公開頁）時的 theme-color：那裡的頁面與
 * 釘在頂端的頂列、頁首都是卡片色（index.css 的 --card），瀏覽器塗在上方列的顏色要與它們相同，否則頂端會多一條不同色的帶子。
 * 其他頁面（登入、註冊、重設密碼、授權、載入中）是頁底色，照舊用 `THEME_COLOR`；640 起也一律用 `THEME_COLOR`。
 */
export const PHONE_THEME_COLOR = { light: "#ffffff", dark: "#1a1d23" } as const;

let cardPages = 0;
const cardPageListeners = new Set<() => void>();

function subscribeCardPage(listener: () => void): () => void {
  cardPageListeners.add(listener);
  return () => cardPageListeners.delete(listener);
}

/** 宣告「這一頁在手機上是卡片底」（AppShell、公開頁的外框）：掛著時手機寬度的 theme-color 改用卡片色。 */
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
  /** 使用者選擇的模式，含 'system'。 */
  theme: Theme;
  /** 'system' 展開後實際套用的模式，供 UI 顯示目前是亮/暗。 */
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
  /** 使用者選擇的主題色，六選一，預設 'indigo'。 */
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
  // 兩個 <meta name="theme-color">（淺／深，靠 media 查詢只認 OS）都改成 app 實際主題的頁底色（手機寬度是卡片色），
  // 讓 PWA 上方列跟 app 內選的主題。找不到 meta 就靜默略過。
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
  // resolvedTheme 是 state（不是從 theme 衍生的 useMemo）：theme === 'system' 時
  // 它可能在 theme 本身沒變的情況下改變（OS 切換 prefers-color-scheme），
  // 一定要是 state 才能觸發用到它的元件重渲染。
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => resolveTheme(theme));

  // theme 改變（含初始掛載）時，依當下的 theme 重新算一次 resolvedTheme。
  useEffect(() => {
    setResolvedTheme(resolveTheme(theme));
  }, [theme]);

  // 手機寬度、卡片底的頁面用卡片色（見 PHONE_THEME_COLOR）：轉向跨過 640、換到別種頁面時重寫。
  const phone = useIsPhone();
  const cardPage = useSyncExternalStore(subscribeCardPage, () => cardPages > 0, () => false);
  useEffect(() => {
    applyResolvedTheme(resolvedTheme, phone && cardPage);
  }, [resolvedTheme, phone, cardPage]);

  // theme === 'system' 時追隨作業系統切換（例如使用者在系統設定切換深色模式）：
  // 直接讀 change 事件當下的 media.matches 寫回 state，而不是重新呼叫
  // resolveTheme('system')（兩者理論上同值，但直接用事件值更貼近「這次事件告訴我們什麼」）。
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

  // 屬性存在語意：恆設 data-accent（indigo 也設），與防閃腳本「非法值不設屬性」
  // 不對稱——兩者在 indigo 情況下呈現同色（基底 fallback＝indigo 值），見 index.css
  // 與防閃腳本上方註解。
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
