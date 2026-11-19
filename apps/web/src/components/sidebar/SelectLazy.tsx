/** Sole lazy entry for select mode (first-bundle limit), shared by NoteList's header/list and SidebarFooter's action bar: reference only via `lazy(() => import(...))`. */
import "@/i18n/select-strings";
export { SelectHeader } from "./SelectHeader";
export { SelectableTree } from "./SelectableTree";
export { SelectActionBar } from "./SelectActionBar";
