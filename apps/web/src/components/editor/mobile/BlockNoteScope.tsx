import type { ReactNode } from "react";
import { useTheme } from "@/theme";

/**
 * 工具列在 `BlockNoteView` 外面。BlockNote 的色票、`bn-color-icon`、自訂色面板的顏色都吃定義在 `.bn-root` 上的 CSS 變數，
 * 離開它就沒有顏色。這一層不產生盒子（`contents`），只借它的變數。
 */
export function BlockNoteScope({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  return (
    <span className="bn-root contents" data-color-scheme={resolvedTheme}>
      {children}
    </span>
  );
}
