/**
 * Used only by `RowIconButton` (components/ui/row-icon-button.tsx) on a ghost icon button. Neutral actions (edit, test
 * connection) use `ROW_ICON_BUTTON`; destructive ones (unlink, remove member, revoke token, delete role/plan/AI action) use
 * `ROW_ICON_DANGER`, red even when a confirm dialog follows; `disabled` and `aria-disabled` both dim to `opacity-40`.
 * twMerge lets `hover:bg-destructive/10` override the ghost button's `hover:bg-accent`.
 */
export const ROW_ICON_BUTTON = "h-8 w-8 text-muted-foreground";
export const ROW_ICON_DANGER =
  "h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 aria-disabled:opacity-40";
