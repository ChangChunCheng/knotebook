import { SAFE_PAGE_PADDING } from "@/components/ui/safe-area";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { MAX_REGISTER_DISPLAY_NAME_LENGTH, MAX_REGISTER_EMAIL_LENGTH, MIN_PASSWORD_LENGTH, safeNextPath, type UserDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { acceptInvite, inspectInvite } from "@/api/invites";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_QUERY_KEY, useSession } from "@/auth/useSession";
import { INVITE_TOKEN_KEY } from "@/auth/oneTimeTokenStorage";
import { useOneTimeLinkToken } from "@/auth/useOneTimeLinkToken";

/**
 * Outside `RequireAuth`, at the same level as `/login` (#187).
 * Open mode only does password self-signup: first SSO sign-in creates accounts via the login page's SSO button. While settings or session
 * can't be read (loading or failed) the form shows anyway, since the server is the final judge.
 * Invite mode (#285): `#invite=...` in the URL (or still in sessionStorage after a same-tab reload). It branches before `OpenRegistration`
 * and ignores the self-signup settings (no redirect even when self-signup is off), so redirects can only live inside `OpenRegistration`.
 * In invite mode a signed-in user must log out first, so an admin testing a link in their own browser isn't switched to the new account.
 */
export default function RegisterPage() {
  const { user, query, logout } = useSession();
  const { token, forget } = useOneTimeLinkToken({ param: "invite", storageKey: INVITE_TOKEN_KEY, user });
  return token !== null ? <InviteRegistration key={token} token={token} forget={forget} user={user} sessionError={query.isError ? { code: query.error instanceof ApiFail ? query.error.code : null } : null} refetch={() => void query.refetch()} logout={logout} /> : <OpenRegistration />;
}

function validateRegistration(t: TFunction, v: { email: string; displayName: string; password: string; confirm: string }): string | null {
  // Limits match the server: email by trimmed `.length`, display name by code points.
  if (v.email.trim().length > MAX_REGISTER_EMAIL_LENGTH) return t("register.emailTooLong", { max: MAX_REGISTER_EMAIL_LENGTH });
  if ([...v.displayName.trim()].length > MAX_REGISTER_DISPLAY_NAME_LENGTH) return t("register.displayNameTooLong", { max: MAX_REGISTER_DISPLAY_NAME_LENGTH });
  if (v.password.length < MIN_PASSWORD_LENGTH) return t("errors.password_too_short");
  if (v.password !== v.confirm) return t("register.mismatch");
  return null;
}

function OpenRegistration() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const nextPath = safeNextPath(searchParams.get("next"));
  const { user } = useSession();
  const config = useAuthConfig();

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Signed in (including the render right after signup writes the session cache) -> `next` or `/`. Must match handleSubmit's navigate: `user` is already truthy right after the cache write, and `/` here would override its `next`.
  if (user) return <Navigate to={nextPath ?? "/"} replace />;

  const loginHref = nextPath === null ? "/login" : `/login?next=${encodeURIComponent(nextPath)}`;
  const data = config.data;
  const loaded = data !== undefined;
  const passwordSignup = loaded && data.registration.enabled && data.passwordLogin.enabled;
  // Redirect only when config has loaded and says unavailable and the user is definitely signed out; while config or session is loading or
  // failed, show the form (signed-in is handled above).
  if (loaded && !passwordSignup && user === null) return <Navigate to={loginHref} replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    const invalid = validateRegistration(t, { email, displayName, password, confirm });
    if (invalid !== null) {
      setErrorMessage(invalid);
      return;
    }
    setSubmitting(true);
    try {
      const body = displayName.trim() === "" ? { email, password } : { email, password, displayName };
      const created = await api<UserDto>("/api/auth/register", { method: "POST", body: JSON.stringify(body) });
      queryClient.setQueryData(SESSION_QUERY_KEY, created);
      navigate(nextPath ?? "/", { replace: true });
    } catch (err) {
      setErrorMessage(err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className={`flex min-h-screen items-center justify-center ${SAFE_PAGE_PADDING}`}>
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t("register.title")}</h1>

        {errorMessage && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        )}
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="register-email" className="text-sm font-medium">{t("register.email")}</label>
            <Input id="register-email" type="email" autoComplete="email" required className="h-11" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="register-display-name" className="text-sm font-medium">{t("register.displayName")}</label>
            <Input id="register-display-name" autoComplete="name" className="h-11" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="register-password" className="text-sm font-medium">{t("register.password")}</label>
            <Input id="register-password" type="password" autoComplete="new-password" required className="h-11" value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("changePassword.passwordHint", { min: MIN_PASSWORD_LENGTH })}</p>
          </div>
          <div className="space-y-1">
            <label htmlFor="register-confirm" className="text-sm font-medium">{t("register.confirmPassword")}</label>
            <Input id="register-confirm" type="password" autoComplete="new-password" required className="h-11" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <Button type="submit" variant="brandSolid" size="lg" className="w-full" disabled={submitting}>
            {submitting ? t("register.submitting") : t("register.submit")}
          </Button>
        </form>
        <p className="text-center text-sm">
          <Link to={loginHref} className="underline underline-offset-4">
            {t("register.haveAccount")}
          </Link>
        </p>
      </div>
    </main>
  );
}

type InviteState =
  | { kind: "ok"; expiresAt: string }
  | { kind: "invalid" }
  | { kind: "loginOff" }
  | { kind: "tooMany" }
  | { kind: "error"; code: string | null };

interface InviteRegistrationProps {
  token: string;
  forget: () => void;
  user: UserDto | null | undefined;
  sessionError: { code: string | null } | null;
  refetch: () => void;
  logout: () => Promise<void>;
}

/** The inspect/accept token travels only in the POST body, never in a queryKey. */
function InviteRegistration({ token, forget, user, sessionError, refetch, logout }: InviteRegistrationProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const [inspected, setInspected] = useState<{ token: string; state: InviteState } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (user !== null) return;
    let cancelled = false;
    inspectInvite(token).then(
      (res) => {
        if (!cancelled) setInspected({ token, state: { kind: "ok", expiresAt: res.expiresAt } });
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiFail && err.status === 410) {
          forget();
          setInspected({ token, state: { kind: "invalid" } });
        } else if (err instanceof ApiFail && err.code === "password_login_disabled") {
          setInspected({ token, state: { kind: "loginOff" } });
        } else if (err instanceof ApiFail && err.status === 429) {
          setInspected({ token, state: { kind: "tooMany" } });
        } else {
          setInspected({ token, state: { kind: "error", code: err instanceof ApiFail ? err.code : null } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [user, token, forget]);

  const errorText = (code: string | null) => (code === null ? t("errors.fallback") : t(`errors.${code}`, { defaultValue: t("errors.fallback") }));
  const frame = (children: ReactNode) => (
    <main className={`flex min-h-screen items-center justify-center ${SAFE_PAGE_PADDING}`}>
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t("register.title")}</h1>
        {children}
      </div>
    </main>
  );
  const message = (text: string, role: "alert" | "status" = "alert") => (
    <p role={role} className="text-sm text-muted-foreground">
      {text}
    </p>
  );
  const backToLogin = (
    <p className="text-center text-sm">
      <Link to="/login" className="underline underline-offset-4">
        {t("register.backToLogin")}
      </Link>
    </p>
  );

  // `accepted` is set before the session cache updates: avoids flashing "already signed in" and ignores `?next`.
  if (accepted) return <Navigate to="/" replace />;

  if (sessionError !== null && user === undefined) {
    return frame(
      <>
        {message(errorText(sessionError.code))}
        <Button type="button" variant="outline" size="lg" className="w-full" onClick={refetch}>
          {t("app.retry")}
        </Button>
      </>,
    );
  }

  if (user === undefined) return frame(message(t("register.invite.checking"), "status"));

  if (user) {
    return frame(
      <>
        {message(t("register.invite.signedIn", { email: user.email }), "status")}
        {errorMessage && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          onClick={() => {
            setErrorMessage(null);
            logout().catch((err: unknown) => setErrorMessage(errorText(err instanceof ApiFail ? err.code : null)));
          }}
        >
          {t("register.invite.signOut")}
        </Button>
      </>,
    );
  }

  const state = inspected?.token === token ? inspected.state : null;
  if (state === null) return frame(message(t("register.invite.checking"), "status"));
  if (state.kind === "invalid") return frame(<>{message(t("errors.invite_invalid"))}{backToLogin}</>);
  if (state.kind === "loginOff") return frame(<>{message(t("register.invite.passwordLoginOff"))}{backToLogin}</>);
  if (state.kind === "tooMany") return frame(<>{message(t("errors.too_many_requests"))}{backToLogin}</>);
  if (state.kind === "error") return frame(<>{message(errorText(state.code))}{backToLogin}</>);

  const when = new Date(state.expiresAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    const invalid = validateRegistration(t, { email, displayName, password, confirm });
    if (invalid !== null) {
      setErrorMessage(invalid);
      return;
    }
    setSubmitting(true);
    try {
      const created = await acceptInvite(displayName.trim() === "" ? { token, email, password } : { token, email, password, displayName });
      setAccepted(true);
      forget();
      queryClient.setQueryData(SESSION_QUERY_KEY, created);
    } catch (err) {
      if (err instanceof ApiFail && err.status === 410) {
        forget();
        setInspected({ token, state: { kind: "invalid" } });
      } else {
        setErrorMessage(errorText(err instanceof ApiFail ? err.code : null));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return frame(
    <>
      <p className="text-sm text-muted-foreground">{t("register.invite.notice", { when })}</p>
      {errorMessage && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="register-email" className="text-sm font-medium">{t("register.email")}</label>
          <Input id="register-email" type="email" autoComplete="email" required className="h-11" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label htmlFor="register-display-name" className="text-sm font-medium">{t("register.displayName")}</label>
          <Input id="register-display-name" autoComplete="name" className="h-11" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label htmlFor="register-password" className="text-sm font-medium">{t("register.password")}</label>
          <Input id="register-password" type="password" autoComplete="new-password" required className="h-11" value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t("changePassword.passwordHint", { min: MIN_PASSWORD_LENGTH })}</p>
        </div>
        <div className="space-y-1">
          <label htmlFor="register-confirm" className="text-sm font-medium">{t("register.confirmPassword")}</label>
          <Input id="register-confirm" type="password" autoComplete="new-password" required className="h-11" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button type="submit" variant="brandSolid" size="lg" className="w-full" disabled={submitting}>
          {submitting ? t("register.submitting") : t("register.submit")}
        </Button>
      </form>
    </>,
  );
}
