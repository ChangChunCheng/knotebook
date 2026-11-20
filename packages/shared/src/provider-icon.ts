/** Must match DB CHECK auth_providers_icon_kind_chk. "gitlab" and "google" only remain as values stored in old rows; they can no longer be chosen. */
export type ProviderIconKind = "template" | "gitlab" | "google" | "upload" | "none";

/** The kinds PATCH accepts; `upload` goes through PUT, and `gitlab` / `google` can no longer be set. */
export type SettableProviderIconKind = "template" | "none";

export type ProviderIconBuiltinName = "generic";

/** null: the admin chose no icon. */
export type ProviderIconDto = { type: "builtin"; name: ProviderIconBuiltinName } | { type: "upload"; url: string } | null;

const GENERIC_ICON: ProviderIconDto = { type: "builtin", name: "generic" };

/** Same literal as DB CHECK auth_providers_icon_size_chk. */
export const MAX_PROVIDER_ICON_BYTES = 262144;
/** Source file limit, before the browser downscales it. */
export const MAX_PROVIDER_ICON_SOURCE_BYTES = 5 * 1024 * 1024;
/** Longest edge in px after the browser downscales. */
export const PROVIDER_ICON_SIZE = 128;

/** `v` changes with the icon, so the old URL's immutable cache can't serve the new image. */
export function providerIconUrl(id: string, version: number): string {
  return `/api/auth/providers/${id}/icon?v=${version}`;
}

/** Only the generic icon ships; "gitlab" and "google" are values old rows may still hold and they render as generic. Unknown values fall back the same way. */
export function resolveProviderIcon(p: { id: string; template: string; iconKind: string; iconVersion: number }): ProviderIconDto {
  switch (p.iconKind) {
    case "upload":
      return { type: "upload", url: providerIconUrl(p.id, p.iconVersion) };
    case "none":
      return null;
    default:
      return GENERIC_ICON;
  }
}
