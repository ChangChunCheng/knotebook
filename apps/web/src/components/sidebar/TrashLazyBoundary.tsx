import { Suspense, type ReactNode } from "react";
import { ChunkLoadBeacon, LazyRouteErrorBoundary } from "@/components/ErrorBoundary";

/**
 * `TrashLazy` 的兩個掛載點（AppShell 的 tabpanel、SidebarFooter）都包這一層（比照 `VersionsLazyBoundary`）。不包的話 chunk 載入失敗
 * 會一路冒到 `AppErrorBoundary`、整個 app 換成崩潰畫面：首頁沒有 route boundary；筆記頁的 route boundary 的載入／錯誤畫面本身含
 * AppShell，tab 仍是垃圾桶，又 throw 一次（tab 有持久化，壞部署時每次載入都崩）。
 * 額度別名 `trash`、`frame="inline"`：只在原位顯示 #66 的錯誤＋重試。兩個掛載點 `import()` 同一個模組，任一成功後另一個不會再以
 * chunk 錯誤失敗，滿足 ErrorBoundary.tsx 的收斂前提。
 * ⚠ `ChunkLoadBeacon` 必須在 `<Suspense>` **內**（見 ErrorBoundary.tsx 的 ChunkLoadBeacon 註解）。
 */
export function TrashLazyBoundary({
  fallback,
  errorClassName,
  children,
}: {
  fallback: ReactNode;
  /** 只在錯誤態套用的外框（見 `LazyRouteErrorBoundary` 的 `inlineErrorClassName`）。 */
  errorClassName?: string;
  children: ReactNode;
}) {
  return (
    <LazyRouteErrorBoundary resetKey={undefined} chunk="trash" frame="inline" inlineErrorClassName={errorClassName}>
      <Suspense fallback={fallback}>
        <ChunkLoadBeacon chunk="trash" />
        {children}
      </Suspense>
    </LazyRouteErrorBoundary>
  );
}
