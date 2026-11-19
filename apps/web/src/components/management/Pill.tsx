import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Lists only granted permissions; missing ones are neither shown nor crossed out. `destructive` = a permission with irreversible
 * consequences (a token's move). `data-pill` is the tests' handle.
 */
export function Pill({ tone = "default", children }: { tone?: "default" | "destructive"; children: ReactNode }) {
  return (
    <span
      data-pill=""
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs leading-4",
        tone === "destructive" ? "border-transparent bg-destructive/10 text-destructive" : "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
