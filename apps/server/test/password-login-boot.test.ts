import { describe, expect, it, vi } from "vitest";
import { siteSettings } from "../src/db/schema.js";
import {
  PASSWORD_LOGIN_FORCED_LOG,
  PASSWORD_LOGIN_FORCED_NOOP_LOG,
  PASSWORD_LOGIN_LOCKOUT_LOG,
  PASSWORD_LOGIN_SETTINGS_MISSING_LOG,
  warnPasswordLoginAtBoot,
} from "../src/auth/password-login.js";
import { buildTestApp } from "./helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";

const fakeLogger = () => ({ warn: vi.fn(), error: vi.fn() });

describe("warnPasswordLoginAtBoot (#187: logs only, never blocks boot)", () => {
  it("prints nothing by default (DB on, env unset)", async () => {
    const { db } = await buildTestApp();
    const logger = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: false }, logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("env force + DB off -> warns 'regardless of the Site admin setting'; env force + DB on -> warns 'has no effect'", async () => {
    const { db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: "https://idp.example" });
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const off = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: true }, off);
    expect(off.warn.mock.calls).toEqual([[PASSWORD_LOGIN_FORCED_LOG]]);
    expect(off.error).not.toHaveBeenCalled();

    await db.update(siteSettings).set({ passwordLoginEnabled: true });
    const on = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: true }, on);
    expect(on.warn.mock.calls).toEqual([[PASSWORD_LOGIN_FORCED_NOOP_LOG]]);
  });

  it("effective off with zero enabled providers (only possible by hand-editing the DB) -> one error line; none when a provider is enabled", async () => {
    const { db } = await buildTestApp();
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const none = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: false }, none);
    expect(none.error.mock.calls).toEqual([[PASSWORD_LOGIN_LOCKOUT_LOG]]);

    await seedAuthProvider(db, { issuerUrl: "https://idp.example" });
    const one = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: false }, one);
    expect(one.error).not.toHaveBeenCalled();
    expect(one.warn).not.toHaveBeenCalled();
  });

  it("disabled providers do not count (enabled is false) -> still errors", async () => {
    const { db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: "https://other.example", enabled: false, clientSecret: null });
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const logger = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: false }, logger);
    expect(logger.error.mock.calls).toEqual([[PASSWORD_LOGIN_LOCKOUT_LOG]]);
  });

  it("unreadable site_settings row -> logs SETTINGS_MISSING error only (password login treated as on)", async () => {
    const { db } = await buildTestApp();
    await db.delete(siteSettings);
    const logger = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: false }, logger);
    expect(logger.error.mock.calls).toEqual([[PASSWORD_LOGIN_SETTINGS_MISSING_LOG]]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("env force prints no error even with DB off and zero providers (effective value is on)", async () => {
    const { db } = await buildTestApp();
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const logger = fakeLogger();
    await warnPasswordLoginAtBoot(db, { passwordLoginForceEnable: true }, logger);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls).toEqual([[PASSWORD_LOGIN_FORCED_LOG]]);
  });
});
