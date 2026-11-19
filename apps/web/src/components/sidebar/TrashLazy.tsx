/**
 * Sole lazy entry for the trash tab (`TrashPanel` and `TrashFooter`; first-bundle limit, `scripts/check-bundle-size.mjs`): reference only via `lazy(() => import(...))`; a static import pulls them and `trash-dialogs` back into the first bundle.
 * Accepted cost: the first switch to the trash tab per load shows content ~300 ms later (React 19's Suspense fallback holds at least 300 ms, and `GET /api/trash` waits for the chunk and mount).
 * Preloading with a bare `import()` doesn't help: `React.lazy`'s first render always suspends once, so the throttle still applies.
 */
export { TrashPanel } from "./TrashPanel";
export { TrashFooter } from "./TrashFooter";
