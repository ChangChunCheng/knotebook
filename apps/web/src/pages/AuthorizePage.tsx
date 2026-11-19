import { SAFE_PAGE_PADDING } from "@/components/ui/safe-area";
import { useId, useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { narrowerScope, type OauthRequestDto } from "@knotebook/shared";
import { useSession } from "@/auth/useSession";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiFail } from "@/api/client";
import { useOauthDecision, useOauthRequest } from "@/api/oauth";
import { checksFromScope, scopeFromChecks, type ScopeChecks } from "@/lib/token-scope";
import { ScopeChecksField } from "@/settings/ScopeChecksField";

/**
 * Only `req` is trusted, not loose authorization params (validated server-side and sealed into the pending request).
 * Allow and deny both consume it, so a wrong click means restarting from the client.
 */
export default function AuthorizePage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const req = searchParams.get("req") || null; // `||`: an empty `?req=` counts as absent
  const request = useOauthRequest(req);

  const errorMessage = ((): string | null => {
    if (req === null) return t("authorize.errorMissingReq");
    if (!request.isError) return null;
    // 410 is the most common one: login or SSO alone can use up the request's 10 minutes.
    const invalid = request.error instanceof ApiFail && request.error.code === "oauth_request_invalid";
    return invalid ? t("authorize.errorInvalidRequest") : t("authorize.errorGeneric");
  })();

  return (
    <main className={`flex min-h-screen items-center justify-center ${SAFE_PAGE_PADDING}`}>
      <div className="w-full max-w-md space-y-4">
        {errorMessage !== null ? (
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold">{t("authorize.errorTitle")}</h1>
            <p className="text-sm text-muted-foreground" role="alert">
              {errorMessage}
            </p>
          </div>
        ) : request.data === undefined || req === null ? (
          <p className="text-muted-foreground">{t("authorize.loading")}</p>
        ) : (
          <ConsentBody req={req} data={request.data} />
        )}
      </div>
    </main>
  );
}

/** Separate component so the checkbox initial state (defaults from `existingScope`) is computed once the data arrives; in the parent `useState` would freeze before that. */
function ConsentBody({ req, data }: { req: string; data: OauthRequestDto }) {
  const { t } = useTranslation();
  const { user, logout } = useSession();
  const decision = useOauthDecision();
  const scopesTitleId = useId();
  // #239: first authorization starts unchecked; re-authorization keeps existing scopes, capped at what is requested (intersection).
  const [checks, setChecks] = useState<ScopeChecks>(() =>
    data.existingScope === null
      ? { write: false, move: false, delete: false }
      : checksFromScope(narrowerScope(data.existingScope, data.scope))
  );
  // Checked per entry in `scopes`; unknown values aren't rendered.
  const offersWrite = data.scopes.includes("notes:write");
  const offersMove = data.scopes.includes("notes:move");
  const offersDelete = data.scopes.includes("notes:delete");
  // Existing scopes not a subset of the request: Allow would silently downgrade them, so say so. With the intersection-based `narrowerScope`,
  // `narrower(existing, request) !== existing` iff existing is not a subset of request (since #181 scopes form a lattice, not a chain).
  const wider = data.existingScope !== null && narrowerScope(data.existingScope, data.scope) !== data.existingScope;

  function submit(choice: "allow" | "deny"): void {
    // deny sends only `{req, decision}`; allow carries the checked scopes, and any box not shown counts as unchecked.
    const body =
      choice === "allow"
        ? {
            req,
            decision: "allow" as const,
            scope: scopeFromChecks(checks.write && offersWrite, checks.move && offersMove, checks.delete && offersDelete),
          }
        : { req, decision: "deny" as const };
    decision.mutate(body, {
      onSuccess: res => window.location.assign(res.redirectTo),
      onError: err => {
        // 409: the pending request was already consumed (single use, before the quota check) and revoking can't return here, so the message must say so.
        // 410 (double click/expired) uses the same message as at load time.
        const code = err instanceof ApiFail ? err.code : undefined;
        const key =
          code === "token_limit"
            ? "authorize.errorTokenLimit"
            : code === "oauth_request_invalid"
              ? "authorize.errorInvalidRequest"
              : "authorize.errorGeneric";
        toast({ title: t(key), variant: "destructive" });
      },
    });
  }

  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">
          {/* The name is self-declared by the client and unverified. It must be its own span to stay isolated: otherwise bidi characters (U+202E)
              could visually push the "unverified" note below out of place. */}
          <span dir="ltr" data-testid="authorize-client-name" className="break-words [unicode-bidi:isolate]">
            {data.clientName}
          </span>
          {t("authorize.titleSuffix")}
        </h1>
        <p className="text-xs text-muted-foreground">{t("authorize.unverifiedName")}</p>
        {data.replacesExisting && <p className="text-xs text-muted-foreground">{t("authorize.replacesExisting")}</p>}
      </div>

      <div className="space-y-1 rounded-md border border-border p-3">
        <p className="text-sm font-medium">{t("authorize.redirectTo", { host: data.redirectHost })}</p>
        {/* redirectHost is always loopback for now, so shown unconditionally; make it host-dependent if redirects ever allow non-loopback. */}
        <p className="text-xs text-muted-foreground">{t("authorize.loopbackWarning")}</p>
      </div>

      {/* Named by its title (like the create-token dialog's fieldset); Tailwind preflight already strips the fieldset's default border and padding. */}
      <fieldset aria-labelledby={scopesTitleId} className="space-y-2">
        <p id={scopesTitleId} className="text-sm font-medium">
          {offersWrite || offersMove || offersDelete ? t("authorize.scopesTitleChoose") : t("authorize.scopesTitle")}
        </p>
        <p className="text-sm">{t("authorize.scopeRead")}</p>
        <ScopeChecksField
          value={checks}
          onChange={setChecks}
          showWrite={offersWrite}
          showMove={offersMove}
          showDelete={offersDelete}
          granted={data.existingScope ? checksFromScope(data.existingScope) : undefined}
        />
        {wider && (
          <p className="text-xs text-muted-foreground">
            {offersWrite ? t("authorize.replacesWithLess") : t("authorize.replacesWithLessReadOnly")}
          </p>
        )}
      </fieldset>

      <p className="text-xs text-muted-foreground">
        {t("authorize.signedInAs", { handle: user?.handle ?? "" })}{" "}
        <button type="button" className="underline" onClick={() => void logout()}>
          {t("authorize.notYou")}
        </button>
      </p>

      <div className="flex gap-2">
        {/* isSuccess also locks: navigation after assign is still in flight, and a second click would get 410 */}
        <Button
          type="button"
          variant="brandSolid"
          size="lg"
          disabled={decision.isPending || decision.isSuccess}
          onClick={() => submit("allow")}
        >
          {t("authorize.allow")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={decision.isPending || decision.isSuccess}
          onClick={() => submit("deny")}
        >
          {t("authorize.deny")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("authorize.denyHint")}</p>
    </>
  );
}
