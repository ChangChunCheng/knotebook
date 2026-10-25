/**
 * 垃圾桶 tab 的 lazy 模組唯一入口：`TrashPanel`（AppShell 的 tabpanel）與 `TrashFooter`（SidebarFooter），只有打開垃圾桶 tab 才下載
 * （首包上限，`scripts/check-bundle-size.mjs`）。**只准用 `lazy(() => import("@/components/sidebar/TrashLazy"))` 引用**——靜態 import
 * 會把它們連同 `trash-dialogs` 併回首包。兩個呼叫端共用這一個 chunk，第一次切到垃圾桶時一起到。
 */
export { TrashPanel } from "./TrashPanel";
export { TrashFooter } from "./TrashFooter";
