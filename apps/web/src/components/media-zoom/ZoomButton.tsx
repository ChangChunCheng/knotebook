import type { ButtonHTMLAttributes, JSX } from "react";
import { useTranslation } from "react-i18next";
import { ZoomIn } from "@/components/ui/icons-extra";
import { cn } from "@/lib/utils";
import { prefetchMediaLightbox } from "./lightbox-chunk";

/** Shared by images and mermaid. All styling (incl. hover/press/focus feedback) comes from `.block-control`; the caller's container positions it. */
export function ZoomButton({
  className,
  onPointerEnter,
  onFocus,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">): JSX.Element {
  const { t } = useTranslation();
  const label = t("note.zoom.open");
  return (
    <button
      {...props}
      type="button"
      aria-label={label}
      title={label}
      className={cn("block-control", className)}
      onPointerEnter={event => {
        prefetchMediaLightbox();
        onPointerEnter?.(event);
      }}
      onFocus={event => {
        prefetchMediaLightbox();
        onFocus?.(event);
      }}
    >
      <ZoomIn className="h-3.5 w-3.5" />
    </button>
  );
}
