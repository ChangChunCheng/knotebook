import { useState, type CSSProperties, type ReactNode } from "react";
import { AGENT_PRESENCE_COLOR, avatarUrl, type AvatarRef } from "@knotebook/shared";
import { firstGrapheme } from "@/lib/first-grapheme";
import { Sparkles } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export interface AvatarProps {
  name: string;
  avatar: AvatarRef | null;
  size: number;
  ringColor?: string;
  offsetColor?: string;
  kind?: "user" | "agent";
  className?: string;
}

/** Light = `AGENT_PRESENCE_COLOR` (Tailwind needs full literals; Avatar.test keeps them equal); dark uses a brighter purple for contrast (WCAG 1.4.11). */
const AGENT_ICON = "text-[#7c3aed] dark:text-[#a78bfa]";

/** The ring colour is a runtime value, so it must be inline. */
export function Avatar({ name, avatar, size, ringColor, offsetColor = "var(--color-card)", kind = "user", className }: AvatarProps) {
  // Keyed by `id:v` so a new version retries without a reset effect.
  const imgKey = avatar ? `${avatar.id}:${avatar.v}` : null;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const showImg = kind !== "agent" && avatar !== null && imgKey !== failedKey;
  const style: CSSProperties = {
    width: size,
    height: size,
    boxShadow: ringColor ? `0 0 0 2px ${ringColor}, 0 0 0 3px ${offsetColor}` : undefined,
  };
  let content: ReactNode;
  if (kind === "agent") {
    style.backgroundColor = `color-mix(in srgb, ${AGENT_PRESENCE_COLOR} 15%, transparent)`;
    content = <Sparkles className={cn("h-[55%] w-[55%]", AGENT_ICON)} />;
  } else if (showImg) {
    content = (
      <img
        src={avatarUrl(avatar.id, avatar.v)}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
        onError={() => setFailedKey(imgKey)}
      />
    );
  } else {
    style.fontSize = Math.round(size * 0.42);
    content = firstGrapheme(name);
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
        kind !== "agent" && !showImg && "bg-muted font-semibold text-foreground",
        className,
      )}
      style={style}
    >
      {content}
    </span>
  );
}
