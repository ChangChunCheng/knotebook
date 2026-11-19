import { useTranslation } from "react-i18next";
import { DOCS_URL, INSTALL_APP_DOCS_URL, LICENSE_URL, REPO_URL } from "./about-links";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import "@/i18n/management-strings";

const LINK_CLASS = "text-brand-on-soft underline-offset-4 hover:underline";

/** No update check and no network requests. */
export function SettingsAboutSection() {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t("settings.nav.about")} description={t("settings.about.description")}>
      <SettingsGroup>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted-foreground">{t("settings.about.version")}</dt>
          <dd>{`v${__APP_VERSION__}`}</dd>
          <dt className="text-muted-foreground">{t("settings.about.source")}</dt>
          <dd>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              {REPO_URL.replace(/^https:\/\//, "")}
            </a>
          </dd>
          <dt className="text-muted-foreground">{t("settings.about.docs")}</dt>
          <dd>
            <a href={DOCS_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              {t("settings.about.docsLink")}
            </a>
          </dd>
          <dt className="text-muted-foreground">{t("settings.about.installApp")}</dt>
          <dd>
            <a href={INSTALL_APP_DOCS_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              {t("settings.about.installAppLink")}
            </a>
          </dd>
          <dt className="text-muted-foreground">{t("settings.about.license")}</dt>
          <dd>
            <a href={LICENSE_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              LICENSE
            </a>
          </dd>
        </dl>
      </SettingsGroup>
    </SettingsPage>
  );
}
