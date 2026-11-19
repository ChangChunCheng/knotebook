/**
 * Sole lazy entry for the sidebar body-search section (#93, `scripts/check-bundle-size.mjs`): reference it only via `lazy(() => import(...))`; a static import pulls the whole section back into the first bundle.
 * Debounce and gate stay in the first bundle (`debounced` is a prop), so mounting and unmounting the lazy component never re-sends a request.
 * Accepted costs: a React 19 Suspense fallback shows for at least 300 ms (overlaps the 300 ms debounce, so the first body search feels no slower);
 * a chunk load failure makes `LazyRouteErrorBoundary` reload the page once, losing a half-typed query.
 */
export { BodySearchResults } from "./BodySearchResults";
