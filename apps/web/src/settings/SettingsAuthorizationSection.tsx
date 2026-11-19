import { useTranslation } from "react-i18next";
import { ApiTokensSection } from "./ApiTokensSection";
import { McpConnectGuide } from "./McpConnectGuide";
import { SettingsPage } from "./SettingsLayout";
import "@/i18n/management-strings";

/** Not gated on having a password: SSO-only accounts have none and need tokens all the more. */
export function SettingsAuthorizationSection() {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t("settings.nav.authorization")} description={t("settings.authorization.description")}>
      <ApiTokensSection />
      <McpConnectGuide />
    </SettingsPage>
  );
}
