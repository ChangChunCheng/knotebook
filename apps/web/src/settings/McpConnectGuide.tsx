import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { OAUTH_APP_IDLE_DAYS } from "@knotebook/shared";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { REPO_URL } from "./about-links";
import {
  buildClaudeCodeOauthSnippet,
  buildClaudeCodeSnippet,
  buildDesktopOauthSnippet,
  buildDesktopSnippet,
  mcpEndpoint,
  oauthAvailable,
} from "./mcp-snippets";
import { SettingsGroup } from "./SettingsLayout";
import "@/i18n/management-strings";

/** Built from REPO_URL like the About page; docs/mcp.md's How to connect covers the Windows Desktop `cmd /c` form. */
const MCP_DOCS_URL = `${REPO_URL}/blob/main/docs/mcp.md#how-to-connect`;
const LINK_CLASS = "text-brand-on-soft underline-offset-4 hover:underline";
const LIST_CLASS = "list-none space-y-4 pl-0";
const HEADING_CLASS = "text-sm font-semibold";

/**
 * Endpoint, then OAuth and personal-token sections with Claude Code/Claude Desktop snippets (built in `mcp-snippets.ts`), then a permission
 * summary that must stay in sync with the docs/mcp.md tool table. PAT snippets always use the `<YOUR_TOKEN>` placeholder and never inject a
 * real token. OAuth shows on https only (#159); on http that section is just its heading and one line. `origin` defaults to
 * `window.location.origin` and is a test hook (jsdom is always http). This is user-facing documentation: verify snippets against a real deployment before editing.
 */
export function McpConnectGuide({ origin = window.location.origin }: { origin?: string } = {}) {
  const { t } = useTranslation();

  async function copy(text: string): Promise<void> {
    const ok = await copyText(text);
    toast(ok ? { title: t("settings.authorization.mcp.copied") } : { title: t("settings.authorization.mcp.copyFailed"), variant: "destructive" });
  }

  const row = (label: string, text: string, testId: string, note?: ReactNode) => (
    <SnippetRow label={label} text={text} testId={testId} copyLabel={t("settings.authorization.mcp.copy")} onCopy={() => void copy(text)}>
      {note}
    </SnippetRow>
  );

  return (
    <SettingsGroup title={t("settings.authorization.mcp.title")} description={t("settings.authorization.mcp.description")}>
      <div className="space-y-6 text-sm">
        {row(t("settings.authorization.mcp.endpoint"), mcpEndpoint(origin), "mcp-endpoint")}

        <div className="space-y-3">
          <h3 className={HEADING_CLASS}>{t("settings.authorization.mcp.oauthTitle")}</h3>
          {oauthAvailable(origin) ? (
            <>
              <p className="text-muted-foreground">{t("settings.authorization.mcp.oauthDescription", { days: OAUTH_APP_IDLE_DAYS })}</p>
              <ul className={LIST_CLASS}>
                <li>{row(t("settings.authorization.mcp.oauthClaudeCode"), buildClaudeCodeOauthSnippet(origin), "mcp-oauth-claude-code")}</li>
                <li>
                  {row(
                    t("settings.authorization.mcp.oauthClaudeDesktop"),
                    buildDesktopOauthSnippet(origin),
                    "mcp-oauth-claude-desktop",
                    <p data-testid="mcp-oauth-desktop-note" className="text-xs text-muted-foreground">
                      {t("settings.authorization.mcp.oauthDesktopNote")}
                    </p>,
                  )}
                </li>
              </ul>
              <p data-testid="mcp-oauth-consent-note" className="text-xs text-muted-foreground">
                {t("settings.authorization.mcp.oauthConsentNote", {
                  allow: t("authorize.allow"),
                  edit: t("settings.account.apiTokensScopeEdit"),
                })}
              </p>
            </>
          ) : (
            <p data-testid="mcp-oauth-https-only" className="text-muted-foreground">
              {t("settings.authorization.mcp.oauthHttpsOnly")}
            </p>
          )}
        </div>

        <div className="space-y-3">
          <h3 className={HEADING_CLASS}>{t("settings.authorization.mcp.patTitle")}</h3>
          <p className="text-muted-foreground">{t("settings.authorization.mcp.patDescription")}</p>
          <ul className={LIST_CLASS}>
            <li>{row(t("settings.authorization.mcp.claudeCode"), buildClaudeCodeSnippet(origin), "mcp-snippet-claude-code")}</li>
            <li>
              {row(
                t("settings.authorization.mcp.claudeDesktop"),
                buildDesktopSnippet(origin),
                "mcp-snippet-claude-desktop",
                <p data-testid="mcp-windows-note" className="text-xs text-muted-foreground">
                  {t("settings.authorization.mcp.windowsNote")}{" "}
                  <a href={MCP_DOCS_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                    {t("settings.authorization.mcp.windowsNoteLink")}
                  </a>
                </p>,
              )}
            </li>
          </ul>
        </div>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{t("settings.authorization.mcp.scopes")}</p>
    </SettingsGroup>
  );
}

function SnippetRow({
  label,
  text,
  testId,
  copyLabel,
  onCopy,
  children,
}: {
  label: string;
  text: string;
  testId: string;
  copyLabel: string;
  onCopy: () => void;
  children?: ReactNode;
}) {
  const preId = useId();
  return (
    <div className="space-y-1">
      <p>{label}</p>
      <div className="flex items-start gap-2">
        <pre
          id={preId}
          data-testid={testId}
          className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs"
        >
          {text}
        </pre>
        <Button type="button" variant="outline" size="sm" aria-describedby={preId} onClick={onCopy}>
          {copyLabel}
        </Button>
      </div>
      {children}
    </div>
  );
}
