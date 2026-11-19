import type { ReactNode } from "react";
import { useTheme } from "@/theme";

/**
 * The toolbar lives outside `BlockNoteView`, but BlockNote swatches, `bn-color-icon` and the custom colour panel use CSS variables defined on `.bn-root`.
 * `contents` adds no box, it only borrows the variables.
 */
export function BlockNoteScope({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  return (
    <span className="bn-root contents" data-color-scheme={resolvedTheme}>
      {children}
    </span>
  );
}
