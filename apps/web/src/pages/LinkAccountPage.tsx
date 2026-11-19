import { SAFE_PAGE_PADDING } from "@/components/ui/safe-area";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ERROR_CODES, type OidcRedirectDto, type PendingLinkConfirmDto, type PendingLinkDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { ProviderIcon } from "@/components/ProviderIcon";

/** `?error=` allowlist (#187): codes the prove round-trip returns; anything else falls back (arbitrary query values must never reach i18next). */
const LINK_ERROR_CODES = new Set<string>([
  "oidc_link_proof_mismatch", "oidc_link_expired", "identity_taken", "identity_already_linked",
  "account_disabled", "oidc_exchange_failed", "oidc_unavailable", "oidc_state_mismatch", "oidc_claim_too_long",
]);

/** Carries `code` only if it is in `ERROR_CODES` (LoginPage applies its own allowlist again). */
function loginLocation(code: string | null): string {
  return code !== null && (ERROR_CODES as readonly string[]).includes(code) ? `/login?error=${code}` : "/login";
}

/**
 * Outside RequireAuth: relies only on the pending-link cookie (HttpOnly, unreadable by the page, so always via `GET /api/auth/oidc/pending`),
 * not on the current session; linking in a browser signed in as someone else works, as the session the server issues replaces the old one.
 * An expired pending link (401) quietly returns to `/login` with the current `?error=` (so the prove round-trip's `oidc_link_expired` stays
 * visible). After success only the confirm response's `next` is used, never URL params. The provider display name is admin input: text nodes only.
 */
export default function LinkAccountPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // Sampled once (same as LoginPage): the URL's error is cleared later but is still needed for the 401 redirect.
  const [initialError] = useState<string | null>(() => searchParams.get("error"));
  const [errorMessage, setErrorMessage] = useState<string | null>(() =>
    initialError === null ? null : t(`errors.${LINK_ERROR_CODES.has(initialError) ? initialError : "fallback"}`, { defaultValue: t("errors.fallback") }),
  );
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (searchParams.has("error")) {
      const params = new URLSearchParams(searchParams);
      params.delete("error");
      setSearchParams(params, { replace: true });
    }
    // Mount only: clears the one-shot `?error=`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingQuery = useQuery({
    queryKey: ["oidc-pending"],
    queryFn: () => api<PendingLinkDto>("/api/auth/oidc/pending"),
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    const fail = pendingQuery.error;
    if (!(fail instanceof ApiFail)) return;
    if (fail.status === 401) navigate(loginLocation(initialError), { replace: true });
    else if (fail.code === "oidc_link_expired") navigate(loginLocation("oidc_link_expired"), { replace: true });
  }, [pendingQuery.error, navigate, initialError]);

  function showFailure(err: unknown): void {
    if (!(err instanceof ApiFail)) {
      setErrorMessage(t("errors.fallback"));
      return;
    }
    if (err.status === 401 && err.code === "unauthorized") {
      navigate("/login", { replace: true });
      return;
    }
    if (err.code === "oidc_link_expired") {
      navigate(loginLocation("oidc_link_expired"), { replace: true });
      return;
    }
    if (err.code === "too_many_attempts" && typeof err.retryAfterMs === "number") setRetryAfterSeconds(Math.ceil(err.retryAfterMs / 1000));
    setErrorMessage(t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }));
  }

  async function handleConfirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const pending = pendingQuery.data;
    if (pending === undefined) return;
    setErrorMessage(null);
    setRetryAfterSeconds(null);
    setBusy(true);
    try {
      const res = await api<PendingLinkConfirmDto>("/api/auth/oidc/pending/confirm", {
        method: "POST",
        body: JSON.stringify({ password, pendingId: pending.pendingId }),
      });
      queryClient.setQueryData(SESSION_QUERY_KEY, res.user);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      navigate(res.next, { replace: true });
    } catch (err) {
      showFailure(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleProve(providerId: string): Promise<void> {
    const pending = pendingQuery.data;
    if (pending === undefined) return;
    setErrorMessage(null);
    // A previous password-submit 429 countdown must not carry over to this error.
    setRetryAfterSeconds(null);
    setBusy(true);
    try {
      const res = await api<OidcRedirectDto>(`/api/auth/oidc/pending/prove/${encodeURIComponent(providerId)}`, {
        method: "POST",
        body: JSON.stringify({ pendingId: pending.pendingId }),
      });
      // The second OIDC round-trip is a top-level navigation (the state cookie was set by this fetch's Set-Cookie).
      window.location.assign(res.url);
    } catch (err) {
      showFailure(err);
      if (err instanceof ApiFail && err.code === "provider_not_found") void pendingQuery.refetch();
      setBusy(false);
    }
  }

  async function handleCancel(showNotice: boolean): Promise<void> {
    try {
      await api<void>("/api/auth/oidc/pending/cancel", { method: "POST" });
    } catch {
      // Leave anyway: the cookie expires on its own after 15 minutes.
    }
    if (showNotice) toast({ title: t("linkAccount.cancelled") });
    navigate("/login", { replace: true });
  }

  const loadError = pendingQuery.error;
  const noProofMethod = loadError instanceof ApiFail && loadError.code === "oidc_link_no_proof_method";
  // 401/`oidc_link_expired` go to login via the effect above; other failures (500, network) get a generic error and an exit, so the page
  // never sits on Loading.
  const loadFailed =
    loadError !== null &&
    !noProofMethod &&
    !(loadError instanceof ApiFail && (loadError.status === 401 || loadError.code === "oidc_link_expired"));
  const pending = pendingQuery.data;

  return (
    <main className={`flex min-h-screen items-center justify-center ${SAFE_PAGE_PADDING}`}>
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t("linkAccount.title")}</h1>

        {noProofMethod && (
          <>
            <p>{t("errors.oidc_link_no_proof_method")}</p>
            <Button type="button" variant="outline" size="lg" className="w-full" onClick={() => void handleCancel(false)}>
              {t("linkAccount.backToLogin")}
            </Button>
          </>
        )}

        {loadFailed && (
          <>
            <p role="alert" className="text-sm text-destructive">
              {t("errors.fallback")}
            </p>
            <Button type="button" variant="outline" size="lg" className="w-full" onClick={() => void handleCancel(false)}>
              {t("linkAccount.backToLogin")}
            </Button>
          </>
        )}

        {pending === undefined && !noProofMethod && !loadFailed && <p className="text-sm text-muted-foreground">{t("linkAccount.loading")}</p>}

        {pending !== undefined && (
          <>
            <p>{t("linkAccount.body", { email: pending.email, provider: pending.providerDisplayName ?? t("linkAccount.unknownProvider") })}</p>

            {errorMessage && (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage}
                {retryAfterSeconds !== null && " " + t("login.retryAfter", { seconds: retryAfterSeconds })}
              </p>
            )}

            {pending.methods.password && (
              <form onSubmit={e => void handleConfirm(e)} className="space-y-2">
                <label htmlFor="link-account-password" className="text-sm font-medium">
                  {t("linkAccount.passwordLabel")}
                </label>
                <Input id="link-account-password" type="password" autoComplete="current-password" required className="h-11" value={password} onChange={e => setPassword(e.target.value)} />
                <Button type="submit" variant="brandSolid" size="lg" className="w-full" disabled={busy}>
                  {busy ? t("linkAccount.confirming") : t("linkAccount.confirmWithPassword")}
                </Button>
              </form>
            )}

            {pending.methods.providers.map(provider => (
              <Button key={provider.id} type="button" variant="outline" size="lg" className="w-full" disabled={busy} onClick={() => void handleProve(provider.id)}>
                <ProviderIcon icon={provider.icon} />
                {t("linkAccount.proveWith", { name: provider.displayName })}
              </Button>
            ))}

            <Button type="button" variant="outline" size="lg" className="w-full" disabled={busy} onClick={() => void handleCancel(true)}>
              {t("linkAccount.cancel")}
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
