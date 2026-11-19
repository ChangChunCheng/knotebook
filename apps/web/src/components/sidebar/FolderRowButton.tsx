import { ChevronRight, Folder } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/** The outer row must carry `group/folderrow`. */
export function FolderRowButton({ name, open, onToggle }: { name: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[13px] max-sm:text-[15px] font-medium text-foreground group-hover/folderrow:text-brand-on-soft"
    >
      <ChevronRight
        aria-hidden="true"
        className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover/folderrow:text-brand-on-soft", open && "rotate-90")}
      />
      <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover/folderrow:text-brand-on-soft" />
      <span className="truncate" title={name}>
        {name}
      </span>
    </button>
  );
}
