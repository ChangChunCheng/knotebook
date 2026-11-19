import { useId, type ReactNode } from "react";
import { managementHeadingUpPhone } from "@/components/management/tray";
import { cn } from "@/lib/utils";

/**
 * Groups are separated by hairlines and whitespace, not cards: the modal is already a floating card, so cards
 * would nest and make one settings page read as unrelated things. Descriptions are neither width-limited nor
 * justified: justified text in a wide column opens visible rivers.
 */

/** The header gets `pr-6` so an `action` clears the panel's absolutely positioned close button (right-2 top-2), which the content's `p-8` only barely clears. */
export function SettingsPage({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <header className="flex items-start justify-between gap-4 pr-6 max-sm:flex-col max-sm:gap-3">
        <div className="space-y-1">
          <h1 className={cn("text-xl font-semibold tracking-tight max-sm:text-lg", managementHeadingUpPhone)}>{title}</h1>
          {description !== undefined && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action !== undefined && <div className="shrink-0">{action}</div>}
      </header>
      <div className="mt-8 divide-y divide-border">{children}</div>
    </div>
  );
}

/**
 * One group is one thing; its `action` sits in the group's own title row so it reads as belonging to that group,
 * not the whole page. `title` is optional: the SSO-only account hint has no title, and
 * `SettingsAccountSection.test.tsx` requires no change-password heading then.
 * `labelledByTitle` is opt-in: it makes the section a landmark so same-named controls on a page (two "Save") can be scoped; not default, to avoid landmark clutter.
 */
export function SettingsGroup({
  title,
  description,
  action,
  labelledByTitle = false,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  labelledByTitle?: boolean;
  children?: ReactNode;
}) {
  const titleId = useId();
  const named = labelledByTitle && title !== undefined;
  const hasHeader = title !== undefined || description !== undefined || action !== undefined;
  return (
    <section aria-labelledby={named ? titleId : undefined} className="py-8 first:pt-0 last:pb-0">
      {hasHeader && (
        <div className="flex items-start justify-between gap-4 max-sm:flex-col max-sm:gap-3">
          <div className="space-y-1">
            {title !== undefined && (
              <h2 id={named ? titleId : undefined} className="text-base font-semibold">
                {title}
              </h2>
            )}
            {description !== undefined && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {action !== undefined && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children !== undefined && <div className={hasHeader ? "mt-4" : undefined}>{children}</div>}
    </section>
  );
}
