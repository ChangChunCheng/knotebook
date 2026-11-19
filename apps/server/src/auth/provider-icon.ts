import { resolveProviderIcon, type AuthProviderPublicDto } from "@knotebook/shared";
import { authProviders } from "../db/schema.js";

// Deliberately excludes icon_data/icon_mime: list responses must not carry the image body; it leaves only via `GET /api/auth/providers/:id/icon`.

export function providerIconColumns() {
  return { template: authProviders.template, iconKind: authProviders.iconKind, iconVersion: authProviders.iconVersion };
}

export function toPublicProvider(row: { id: string; displayName: string; template: string; iconKind: string; iconVersion: number }): AuthProviderPublicDto {
  return { id: row.id, displayName: row.displayName, icon: resolveProviderIcon(row) };
}
