import type { VersionEditorDto } from "@knotebook/shared";
import { Avatar } from "@/components/Avatar";

const MAX_SHOWN = 3;
const SIZE = 20;

/** Deduped by handle (the same person as human and as agent draws once); a deleted user (empty handle) collapses into one "?" placeholder; an agent write shows the user's own avatar. aria-hidden as a whole: accessible info comes from `editorsText` on the row. */
export function EditorAvatars({ editors }: { editors: VersionEditorDto[] }) {
  const seen = new Set<string>();
  const unique: VersionEditorDto[] = [];
  for (const e of editors) {
    if (seen.has(e.handle)) continue;
    seen.add(e.handle);
    unique.push(e);
  }
  if (unique.length === 0) return null;
  const shown = unique.slice(0, MAX_SHOWN);
  const extra = unique.length - shown.length;
  return (
    <span aria-hidden="true" className="inline-flex h-5 shrink-0 items-center">
      {shown.map((e, i) => (
        <span key={e.handle} data-editor-avatar="" className={i === 0 ? "inline-flex rounded-full ring-2 ring-card" : "-ms-1.5 inline-flex rounded-full ring-2 ring-card"}>
          <Avatar name={e.handle} avatar={e.avatar ?? null} size={SIZE} />
        </span>
      ))}
      {extra > 0 && <span aria-hidden="true" className="ms-1 text-[11px] leading-none text-muted-foreground">{`+${extra}`}</span>}
    </span>
  );
}
