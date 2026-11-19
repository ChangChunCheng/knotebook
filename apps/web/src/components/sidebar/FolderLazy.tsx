import "@/i18n/folder-strings";

/** Sole lazy entry for the folder dialogs (first-bundle limit): reference only via `lazy(() => import(...))`; the `folders.*.json` strings and the three dialogs come in only through this chain. */
export { FolderDialogs } from "./FolderDialogs";
