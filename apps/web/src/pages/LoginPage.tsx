import { SAFE_PAGE_PADDING } from "@/components/ui/safe-area";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { ERROR_CODES, safeNextPath, type UserDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { ProviderIcon } from "@/components/ProviderIcon";

/** Tests repeat this literal on purpose: they assert the output contract toward `/api/auth/oidc/login/:providerId`. */
const OIDC_LOGIN_PREFIX = "/api/auth/oidc/login/";

/**
 * The SSO entry is a plain `<a>`, not `api()`/fetch: the 302 chain through the IdP and back to the callback needs a top-level
 * browser navigation (fetch's redirect semantics and cookie timing are wrong for it). First SSO sign-in creates the account
 * through the SSO button, never the register page.
 * `?error=` seeds `errorMessage` lazily (first render only) and shares its alert UI, so a new submit's `setErrorMessage(null)` clears it;
 * deriving it on every render would resurface the stale error while submitting.
 * `code` is arbitrary input: it is checked against the shared `ERROR_CODES` before `t()` (`__proto__` hits Object.prototype;
 * `constructor` resolves to the `errors` object's constructor, a function, which crashes as a React child); anything else becomes `fallback`, so the key always exists.
 * The param is removed from the URL after use (replace, no history entry), so reload or a bookmark doesn't bring it back.
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // `next` always goes through `safeNextPath` (the same function the server uses); invalid means absent, landing on `/`.
  // The server validates again: users can hit the SSO URL directly.
  // Unlike `?error=` it isn't one-shot, so it is recomputed on every render.
  const nextPath = safeNextPath(searchParams.get("next"));

  // Output contract toward `GET /api/auth/oidc/login/:providerId`, which the server consumes.
  const ssoHref = (providerId: string): string => {
    const base = `${OIDC_LOGIN_PREFIX}${encodeURIComponent(providerId)}`;
    return nextPath === null ? base : `${base}?next=${encodeURIComponent(nextPath)}`;
  };

  const authConfigQuery = useAuthConfig();

  // Show the form when the config can't be read (loading or failed; fail-open): failing to read settings must not lock people
  // out; if it is really off the server answers 403 and `errors.password_login_disabled` shows.
  const passwordLoginEnabled = authConfigQuery.data?.passwordLogin.enabled !== false;
  const providers = authConfigQuery.data?.providers ?? [];
  // The register link is for password signup only, and hidden while the config is loading or failed.
  const config = authConfigQuery.data;
  const passwordSignup = config !== undefined && config.registration.enabled && config.passwordLogin.enabled;
  const registerHref = nextPath === null ? "/register" : `/register?next=${encodeURIComponent(nextPath)}`;

  useEffect(() => {
    if (searchParams.has("error")) {
      // Delete only the `error` key: replacing all params would drop `next` (a test asserts error goes and next stays).
      // Named `params`, not `next`: in this file `next` means the query param.
      const params = new URLSearchParams(searchParams);
      params.delete("error");
      setSearchParams(params, { replace: true });
    }
    // Mount only: clears the one-shot `?error=`, not on every searchParams/setSearchParams identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(() => {
    const rawQueryError = searchParams.get("error");
    if (!rawQueryError) return null;
    const code = (ERROR_CODES as readonly string[]).includes(rawQueryError) ? rawQueryError : "fallback";
    return t(`errors.${code}`, { defaultValue: t("errors.fallback") });
  });
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setRetryAfterSeconds(null);
    setSubmitting(true);

    try {
      const user = await api<UserDto>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      queryClient.setQueryData(SESSION_QUERY_KEY, user);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      navigate(nextPath ?? "/", { replace: true });
      return;
    } catch (err) {
      if (err instanceof ApiFail) {
        if (err.code === "too_many_attempts" && typeof err.retryAfterMs === "number") {
          setRetryAfterSeconds(Math.ceil(err.retryAfterMs / 1000));
        }
        setErrorMessage(t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }));
      } else {
        setErrorMessage(t("errors.fallback"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className={`flex min-h-screen items-center justify-center ${SAFE_PAGE_PADDING}`}>
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t("login.title")}</h1>

        {errorMessage && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
            {retryAfterSeconds !== null && " " + t("login.retryAfter", { seconds: retryAfterSeconds })}
          </p>
        )}

        {passwordLoginEnabled && (
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="login-email" className="text-sm font-medium">
                {t("login.email")}
              </label>
              <Input id="login-email" name="email" type="email" autoComplete="email" required className="h-11" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="login-password" className="text-sm font-medium">
                {t("login.password")}
              </label>
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="h-11"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" variant="brandSolid" size="lg" className="w-full" disabled={submitting}>
              {submitting ? t("login.submitting") : t("login.submit")}
            </Button>
          </form>
        )}

        {providers.length > 0 && (
          <>
            {passwordLoginEnabled && <div className="border-t" aria-hidden="true" />}
            {providers.map((provider) => (
              // displayName is admin input: interpolated into a text node only (escapeValue: false).
              <Button key={provider.id} asChild variant="outline" size="lg" className="w-full">
                <a href={ssoHref(provider.id)}>
                  <ProviderIcon icon={provider.icon} />
                  {t("login.signInWith", { name: provider.displayName })}
                </a>
              </Button>
            ))}
          </>
        )}

        {authConfigQuery.data !== undefined && !passwordLoginEnabled && providers.length === 0 && (
          // Only possible through a manual DB edit (disabling password login needs an enabled provider).
          <p role="status" className="text-sm text-muted-foreground">
            {t("login.noMethods")}
          </p>
        )}

        {passwordSignup && (
          // Outline, not solid: the page's only solid button is "Sign in".
          <Button asChild variant="outline" size="lg" className="w-full">
            <Link to={registerHref}>{t("login.register")}</Link>
          </Button>
        )}
      </div>
    </main>
  );
}
