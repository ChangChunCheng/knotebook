import { useState } from "react";
import type { ProviderIconDto } from "@knotebook/shared";
import { GitLabLogo, GoogleLogo } from "@/components/ui/brand-icons";
import { SignInGeneric } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/** Decorative only (aria-hidden), so the surrounding accessible name is unchanged. Load failure is remembered by URL so a new `?v=` retries. */
export function ProviderIcon({ icon, className }: { icon: ProviderIconDto | undefined; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (icon == null) return null;
  const cls = cn("h-4 w-4 shrink-0", className);
  if (icon.type === "upload" && icon.url !== failedUrl) {
    const url = icon.url;
    return (
      <img
        src={url}
        alt=""
        aria-hidden="true"
        data-provider-icon="upload"
        className={cn(cls, "object-contain")}
        draggable={false}
        onError={() => setFailedUrl(url)}
      />
    );
  }
  const name = icon.type === "builtin" ? icon.name : "generic";
  if (name === "gitlab") return <GitLabLogo className={cls} aria-hidden="true" focusable="false" data-provider-icon="gitlab" />;
  if (name === "google") return <GoogleLogo className={cls} aria-hidden="true" focusable="false" data-provider-icon="google" />;
  return <SignInGeneric className={cls} aria-hidden="true" focusable="false" data-provider-icon="generic" />;
}
