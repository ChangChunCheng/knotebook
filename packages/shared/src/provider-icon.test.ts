import { describe, expect, it } from "vitest";
import {
  MAX_PROVIDER_ICON_BYTES,
  MAX_PROVIDER_ICON_SOURCE_BYTES,
  PROVIDER_ICON_SIZE,
  providerIconUrl,
  resolveProviderIcon,
} from "./provider-icon.js";

const ID = "11111111-1111-4111-8111-111111111111";
const r = (template: string, iconKind: string, iconVersion = 0) => resolveProviderIcon({ id: ID, template, iconKind, iconVersion });

describe("resolveProviderIcon (lookup table)", () => {
  it("template: gitlab template -> GitLab logo, google template -> Google logo, oidc and any other template value -> generic icon", () => {
    expect(r("gitlab", "template")).toEqual({ type: "builtin", name: "gitlab" });
    expect(r("google", "template")).toEqual({ type: "builtin", name: "google" });
    expect(r("oidc", "template")).toEqual({ type: "builtin", name: "generic" });
    expect(r("github", "template")).toEqual({ type: "builtin", name: "generic" });
  });

  it("gitlab / google regardless of template", () => {
    for (const template of ["gitlab", "google", "oidc"]) {
      expect(r(template, "gitlab"), template).toEqual({ type: "builtin", name: "gitlab" });
      expect(r(template, "google"), template).toEqual({ type: "builtin", name: "google" });
    }
  });

  it("upload -> providerIconUrl(id, iconVersion) (regardless of template; the version is the current value)", () => {
    expect(r("gitlab", "upload", 7)).toEqual({ type: "upload", url: `/api/auth/providers/${ID}/icon?v=7` });
    expect(r("oidc", "upload", 0)).toEqual({ type: "upload", url: `/api/auth/providers/${ID}/icon?v=0` });
  });

  it("none -> null (regardless of template)", () => {
    for (const template of ["gitlab", "google", "oidc"]) expect(r(template, "none"), template).toBeNull();
  });

  it("an unknown iconKind is treated as template (the DB CHECK guarantees the domain; this is a defensive shape)", () => {
    expect(r("google", "svg")).toEqual({ type: "builtin", name: "google" });
    expect(r("oidc", "")).toEqual({ type: "builtin", name: "generic" });
  });
});

describe("providerIconUrl", () => {
  it("shape is /api/auth/providers/<id>/icon?v=<version>", () => {
    expect(providerIconUrl(ID, 3)).toBe(`/api/auth/providers/${ID}/icon?v=3`);
  });
});

describe("constants", () => {
  it("256 KB equals the literal 262144 of the DB CHECK `auth_providers_icon_size_chk`; file picker cap 5 MB; thumbnail longest side 128", () => {
    // the CHECK in schema.ts is deliberately written as a literal (interpolation would become an SQL parameter); this case keeps the two sides aligned.
    expect(MAX_PROVIDER_ICON_BYTES).toBe(262144);
    expect(MAX_PROVIDER_ICON_SOURCE_BYTES).toBe(5 * 1024 * 1024);
    expect(PROVIDER_ICON_SIZE).toBe(128);
  });
});
