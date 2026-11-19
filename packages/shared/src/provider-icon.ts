/** Must match DB CHECK auth_providers_icon_kind_chk. */
export type ProviderIconKind = "template" | "gitlab" | "google" | "upload" | "none";

export type ProviderIconBuiltinName = "gitlab" | "google" | "generic";

/** null: the admin chose no icon. */
export type ProviderIconDto = { type: "builtin"; name: ProviderIconBuiltinName } | { type: "upload"; url: string } | null;

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

function templateIcon(template: string): ProviderIconDto {
  if (template === "gitlab") return { type: "builtin", name: "gitlab" };
  if (template === "google") return { type: "builtin", name: "google" };
  return { type: "builtin", name: "generic" };
}

/** Unknown `iconKind` values fall back to the template. */
export function resolveProviderIcon(p: { id: string; template: string; iconKind: string; iconVersion: number }): ProviderIconDto {
  switch (p.iconKind) {
    case "gitlab":
      return { type: "builtin", name: "gitlab" };
    case "google":
      return { type: "builtin", name: "google" };
    case "upload":
      return { type: "upload", url: providerIconUrl(p.id, p.iconVersion) };
    case "none":
      return null;
    default:
      return templateIcon(p.template);
  }
}
