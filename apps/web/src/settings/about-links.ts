/** Neither the root nor apps/web package.json has a `repository` field, so the repo URL is a constant (from `git remote get-url origin`); docs and license URLs derive from it. */
export const REPO_URL = "https://github.com/sw-willie-wu/knotebook";
export const DOCS_URL = `${REPO_URL}/tree/main/docs`;
/** Install-as-app guide (Android, iOS, desktop). */
export const INSTALL_APP_DOCS_URL = `${REPO_URL}/blob/main/docs/install-app.md`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
