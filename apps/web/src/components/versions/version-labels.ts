import type { TFunction } from "i18next";
import { derivedVersionName, type VersionBaseRefDto, type VersionCurrentDto, type VersionEditorDto } from "@knotebook/shared";

/**
 * Pressed state for the toggle buttons (banner and full page). The banner background is `bg-brand-soft` (14% brand tint), so pressed is a step deeper `bg-brand/25` (the full page header is `bg-card`, where the same set is just a light brand tint). brand, not primary: `--primary` is neutral near-black and renders grey.
 * `hover:` must be given with it: ghost's `hover:bg-accent` would override the pressed background while the pointer rests on the button, looking unpressed; `cn` (tailwind-merge) replaces it.
 * Idle hover also can't use ghost's `hover:bg-accent`: light `--accent` is a grey of oklch L 0.94 and the banner composites to about L 0.93, nearly identical, so hover would show no change; on this background hover uses a brand tint (`TINT_HOVER_CLASS`, replacing ghost's the same way).
 * Steps: idle → hover 15% → pressed 25% → pressed hover 35% (neighbouring alpha gaps must be wide; 5 points isn't visible).
 */
export const TINT_HOVER_CLASS = "hover:bg-brand/15";
export const PRESSED_CLASS = "bg-brand/25 hover:bg-brand/35";

export function shortVersionId(id: string): string {
  return id.slice(0, 7).toLowerCase();
}

export function versionName(v: { id: string; name: string | null }): string {
  return v.name ?? derivedVersionName(v.id);
}

/** Unnamed versions' derived names can collide (4096 possibilities): the short id is what identifies. */
export function versionLabel(v: { id: string; name: string | null }): string {
  return `${versionName(v)} (${shortVersionId(v.id)})`;
}

/** Deleted with an id → derived name + short id + "(deleted)" (a user-chosen name isn't kept); data deleted before the upgrade has no id → "a deleted version". */
export function baseLabel(t: TFunction, base: VersionBaseRefDto): string {
  if (base.id === null) return t("versions.deletedVersion");
  if (base.deleted) return t("versions.deletedSuffix", { label: `${derivedVersionName(base.id)} (${shortVersionId(base.id)})` });
  return versionLabel({ id: base.id, name: base.name });
}

/** If `base` is null despite `baseSeq` being set, it is shown as a deleted version rather than blank. */
export function baseLabelOrDeleted(t: TFunction, base: VersionBaseRefDto | null): string {
  return base === null ? t("versions.deletedVersion") : baseLabel(t, base);
}

/** Looks only at `baseSeq`/`dirty`, never the list: the list may be filtered to manual only. The base is shown from `current.base` (named even if it isn't on this page). */
export function currentSubtitle(t: TFunction, current: VersionCurrentDto): string {
  if (current.baseSeq === null) return t("versions.current.noBase");
  const label = baseLabelOrDeleted(t, current.base);
  return t(current.dirty ? "versions.current.dirty" : "versions.current.clean", { label });
}

export function editorsText(t: TFunction, editors: VersionEditorDto[]): string {
  return editors
    .map((e) => {
      const who = e.handle === "" ? t("versions.deletedUser") : e.handle;
      return e.agentLabel === null ? who : `${who} (${e.agentLabel})`;
    })
    .join(", ");
}

export function formatVersionTime(iso: string, language: string): string {
  return new Date(iso).toLocaleString(language, { dateStyle: "short", timeStyle: "short" });
}
