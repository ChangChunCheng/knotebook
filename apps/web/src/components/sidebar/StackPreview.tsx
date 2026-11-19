import { Folder } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { DROP_SCOPE_CLASS } from "./useSidebarDrag";

/** The whole block is the drop target (`data-node-kind="preview"`, recognised first by `readDragTarget`; inner elements must not carry `data-node-kind`). */
export function StackPreview({
  name,
  anchorTitle,
  sourceTitle,
  creating,
  variant,
}: {
  name: string;
  anchorTitle: string;
  sourceTitle: string;
  creating: boolean;
  variant: "plain" | "group";
}) {
  return (
    <li
      data-node-kind="preview"
      data-drop-scope={creating ? undefined : ""}
      aria-busy={creating ? "true" : undefined}
      className={cn("flex flex-col gap-0.5 rounded-md", creating ? "opacity-60" : DROP_SCOPE_CLASS)}
    >
      <div className={cn("flex h-11 items-center gap-1.5 pr-2 text-[13px] font-medium pointer-fine:h-7", variant === "group" ? "pl-3" : "pl-2")}>
        <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
      </div>
      <div className="ml-[15px] border-l border-muted-foreground/35 pl-2">
        <ul className="space-y-0.5">
          <li className="flex h-11 items-center pr-2 pl-3 text-[13px] pointer-fine:h-7">
            <span className="truncate">{anchorTitle}</span>
          </li>
          <li className="flex h-11 items-center rounded-md border border-dashed border-muted-foreground/50 pr-2 pl-3 text-[13px] text-muted-foreground pointer-fine:h-7">
            <span className="truncate">{sourceTitle}</span>
          </li>
        </ul>
      </div>
    </li>
  );
}
