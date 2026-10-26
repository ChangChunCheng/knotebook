/**
 * 垃圾桶 tab 的 lazy 模組唯一入口：`TrashPanel`（AppShell 的 tabpanel）與 `TrashFooter`（SidebarFooter），只有打開垃圾桶 tab 才下載
 * （首包上限，`scripts/check-bundle-size.mjs`）。**只准用 `lazy(() => import("@/components/sidebar/TrashLazy"))` 引用**——靜態 import
 * 會把它們連同 `trash-dialogs` 併回首包。兩個呼叫端共用這一個 chunk，第一次切到垃圾桶時一起到；兩個掛載點都包 `SidebarLazyBoundary chunk="trash"`。
 * 已知代價（接受）：每次載入後**第一次**切到垃圾桶，內容比靜態 import 晚約 300 ms 出現——React 19 的 Suspense fallback 節流
 * （佔位一旦顯示至少停 300 ms），加上 `GET /api/trash` 要等 chunk 到、TrashPanel 掛上才發（chunk→API 串行）。
 * 單純先 `import()` 預載沒用（實測）：`React.lazy` 第一次 render 一定 suspend 一次，節流照樣套。
 */
export { TrashPanel } from "./TrashPanel";
export { TrashFooter } from "./TrashFooter";
