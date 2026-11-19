import { ChevronRight, Users } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/** The leading icon is `Users`, swapped for a chevron on row hover or `:focus-visible` inside (not focus left by a mouse click); touch (`hover: none`) always shows the chevron. The outer row must carry `group/grouprow`. */
export function GroupRowButton({ name, open, onToggle }: { name: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[13px] max-sm:text-[15px] font-medium text-foreground group-hover/grouprow:text-brand-on-soft"
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground group-hover/grouprow:text-brand-on-soft">
        <Users
          aria-hidden="true"
          className="h-3.5 w-3.5 group-hover/grouprow:hidden group-has-[:focus-visible]/grouprow:hidden [@media(hover:none)]:hidden"
        />
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "hidden h-3 w-3 transition-transform group-hover/grouprow:block group-has-[:focus-visible]/grouprow:block [@media(hover:none)]:block",
            open && "rotate-90",
          )}
        />
      </span>
      <span className="truncate">{name}</span>
    </button>
  );
}
