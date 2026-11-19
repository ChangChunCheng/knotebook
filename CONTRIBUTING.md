# Contributing to Knotebook

Thanks for your interest in Knotebook. This page covers how to get the code running, which checks a pull request has to pass, and the conventions the project follows. For how the code is organized, read [ARCHITECTURE.md](ARCHITECTURE.md) first.

## Where to start

- Bugs and feature requests go in the [issue tracker](https://github.com/sw-willie-wu/knotebook/issues). Planning lives in [GitHub Milestones](https://github.com/sw-willie-wu/knotebook/milestones).
- For a larger change, it helps to open an issue or comment on an existing one before you start, so the approach can be discussed first.
- Issues and pull requests in English are welcome. Code comments in the source, user-facing docs and the CHANGELOG are in English (see [Code comments](#code-comments)). Comments and test names in the test files are still mostly in Traditional Chinese; you don't need to read them to contribute, and asking about one in an issue or pull request is fine.

## Prerequisites

- **Node.js 24 or later** (`engines` in `package.json`; the exact version CI uses is in `.nvmrc`).
- **pnpm**, at the version pinned by `packageManager` in `package.json`. Get it through Corepack, as CI does: run `corepack enable` once, and `pnpm` then uses the pinned version in this repository. Newer Node.js releases no longer bundle Corepack; if the `corepack` command isn't found, install it first with `npm i -g corepack@latest` (CI runs that too).
- **Docker**, for the server integration tests (Testcontainers starts PostgreSQL), the end-to-end tests (Docker Compose), and for running a local database.

Install the dependencies and build every package once from the repository root:

```sh
pnpm install
pnpm build
```

pnpm applies the patches in `patches/` during install (see [Patched dependencies](ARCHITECTURE.md#patched-dependencies)). The build matters because both apps import `@knotebook/shared` from its compiled `dist/`: on a fresh clone, the web tests and the single-file `vitest` commands below fail until `packages/shared` has been built (`pnpm --filter @knotebook/shared build` builds just that package).

## Running Knotebook locally

### Development servers

For day-to-day work, run PostgreSQL in Docker and the server and web app from source with hot reload.

1. Start PostgreSQL, published on localhost. The image is the one `docker-compose.yml` uses (the bundled `db` service there doesn't publish a port, so it can't be used from the host):

   ```sh
   docker run -d --name knotebook-dev-db -p 127.0.0.1:5432:5432 -e POSTGRES_USER=knotebook -e POSTGRES_PASSWORD=knotebook -e POSTGRES_DB=knotebook pgvector/pgvector:pg17
   ```

2. Start the server. It reads its settings from environment variables only (it does not load a `.env` file by itself); the variables are described in [Environment variables](docs/self-hosting.md#environment-variables). In a POSIX shell (bash, zsh, Git Bash, WSL):

   ```sh
   export DATABASE_URL=postgres://knotebook:knotebook@localhost:5432/knotebook
   export APP_SECRET=<64 hex characters, e.g. from: openssl rand -hex 32>
   export PUBLIC_URL=http://localhost:5173
   export ADMIN_EMAIL=you@example.com
   export ADMIN_PASSWORD=<at least 12 characters>
   pnpm --filter @knotebook/server dev
   ```

   In PowerShell:

   ```powershell
   $env:DATABASE_URL = "postgres://knotebook:knotebook@localhost:5432/knotebook"
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
   $env:APP_SECRET = -join ($b | ForEach-Object { $_.ToString('x2') })
   $env:PUBLIC_URL = "http://localhost:5173"
   $env:ADMIN_EMAIL = "you@example.com"
   $env:ADMIN_PASSWORD = "<at least 12 characters>"
   pnpm --filter @knotebook/server dev
   ```

   `dev` builds `packages/shared` and then runs `apps/server/src/index.ts` with `tsx watch`. The server listens on port 3000 and runs the database migrations on startup. `ADMIN_EMAIL` and `ADMIN_PASSWORD` create the first admin account on an empty database. Keep the same `APP_SECRET` between restarts: it signs sessions and encrypts stored secrets.

3. In another terminal, start the web app:

   ```sh
   pnpm --filter @knotebook/web dev
   ```

   Open the URL Vite prints (`http://localhost:5173` by default) and sign in with the admin account. Vite proxies `/api` and `/collab` to the server on port 3000 (`apps/web/vite.config.ts`), and nothing else.

With `PUBLIC_URL` set to the Vite address, the server's OAuth metadata points MCP clients at `/oauth` and `/.well-known` on port 5173, which Vite doesn't proxy, so **connecting an MCP client over OAuth doesn't work in this setup**. To try MCP locally, create a personal API token in **Settings → Authorization** and point the client at `http://localhost:5173/api/mcp` with that token (see [API tokens](docs/api-tokens.md) and [MCP](docs/mcp.md)).

If you change `packages/shared`, rebuild it (`pnpm --filter @knotebook/shared build`) or restart the server's `dev` script, which builds it first.

### The full app in Docker

To run the app the way self-hosters do, built from your checkout:

```sh
cp .env.example .env    # then fill in APP_SECRET, PUBLIC_URL, ADMIN_EMAIL and ADMIN_PASSWORD
docker compose up -d --build
```

It listens on `http://localhost:3000`. See the [self-hosting guide](docs/self-hosting.md) for everything else.

## Checks before opening a pull request

CI (`.github/workflows/ci.yml`) runs all of the following on every pull request, and the `ci` status check must pass before a pull request can be merged into `main`. Run what's relevant to your change locally first; these are the root `package.json` scripts and the commands CI uses:

| Check | Command |
|---|---|
| Build every package | `pnpm build` |
| Entry bundle size (after building) | `node scripts/check-bundle-size.mjs` |
| Type check (including test files) | `pnpm typecheck` |
| Lint (no warnings allowed) | `pnpm lint` |
| Dependency licenses | `pnpm check-licenses` |
| Tests of the repository scripts | `pnpm test:scripts` |
| Shared unit tests | `pnpm --filter @knotebook/shared test` |
| Web unit and component tests | `pnpm --filter @knotebook/web test` |
| Server unit tests | `pnpm --filter @knotebook/server test:unit` |
| Server integration tests (needs Docker) | `pnpm --filter @knotebook/server test:integration` |
| End-to-end tests (needs Docker) | see below |

`pnpm test` runs the shared, web and server suites together, server integration tests included.

### Running one test file, or in watch mode

All three packages use Vitest, so you can pass a file path to it through `pnpm --filter <package> exec vitest`. `vitest run` runs once; `vitest` without `run` watches for changes and reruns:

```sh
pnpm --filter @knotebook/shared exec vitest run src/presence.test.ts
pnpm --filter @knotebook/web exec vitest run src/theme.test.tsx
pnpm --filter @knotebook/web exec vitest src/collab                    # watch mode, files under src/collab
pnpm --filter @knotebook/server exec vitest run --config vitest.unit.config.ts test/unit/agent-label.test.ts
pnpm --filter @knotebook/server exec vitest run test/app.test.ts        # one integration test file (needs Docker)
```

Server unit tests need `--config vitest.unit.config.ts`; without it Vitest uses `vitest.config.ts`, whose global setup starts the PostgreSQL container for the integration tests.

### Integration and end-to-end tests

**Integration tests** start their own PostgreSQL container through Testcontainers (`apps/server/test/global-setup.ts`), so they need a working Docker daemon. On Windows, if Docker runs only inside WSL, `bash scripts/test-integration.sh` copies the repository into WSL and runs them there.

**End-to-end tests** run Playwright against a Docker Compose stack. On Windows, use `bash scripts/test-e2e.sh`, described in [Running the e2e suite locally](docs/e2e-local.md). Elsewhere you can do what CI does:

```sh
pnpm --filter @knotebook/e2e stack:up
pnpm --filter @knotebook/e2e exec playwright install --with-deps chromium
pnpm --filter @knotebook/e2e exec playwright test            # or a single file, e.g. tests/02-collab.spec.ts
pnpm --filter @knotebook/e2e stack:down
```

On Linux, `--with-deps` installs the browser's system libraries with the package manager and asks for `sudo`; leave it out if they are already installed. The stack is rebuilt from your working tree on `stack:up`, so rerun it after changing application code.

## Conventions

### Branches and pull requests

- Branch from `main` and open the pull request against `main`.
- Name the branch after the kind of change, as in the history: `feat/…`, `fix/…`, `docs/…`, `chore/…`, `test/…`, `perf/…` (for example `fix/awareness-sanitise`, `docs/readme-positioning`).
- Keep one topic per pull request, and link the issue it addresses (`#123`).

### Commit messages

Commits follow the [Conventional Commits](https://www.conventionalcommits.org/) style, with an optional scope naming the package or area. Write commit messages in English (older history is partly in Chinese):

```
fix(server): limit collaboration messages by the note size limit (#312)
feat(web): fill the outline pin icon while the outline is pinned
docs: describe the \< escape for literal HTML in Markdown (#379)
test: cover literal HTML through bulk files, MCP and REST (#379)
```

Types in use include `feat`, `fix`, `docs`, `test`, `style`, `refactor`, `perf`, `chore` and `ci`. The scopes used most are `web`, `server`, `e2e`, `release`, `shared`, `editor` and `collab`. The subject is lowercase and in the imperative, and ends with the issue number in parentheses when there is one. Use the body to explain why, when that isn't obvious.

### Code comments

- Write comments in English. In test files, a Chinese comment or test name you change can be rewritten in English while you're there.
- Names and types already say what the code does, so most code needs no comment. Write one only for what reading the code can't tell you:
  - why it is done this way, when an obvious alternative would be wrong;
  - why a line that looks redundant or movable must stay where it is;
  - an invariant or constraint enforced somewhere else (a database constraint, another module, the client) that this code relies on;
  - an input precondition (ids already lowercased, a string already normalized, what `null` means);
  - something that must match another place exactly (an index expression, another route's error text);
  - a library, database or browser quirk being worked around, a security reason, or a unit or limit the number alone doesn't make clear;
  - on an exported function, a contract for callers that the name and types can't express.
- Don't describe what a function or file does step by step, repeat names, or narrate history ("used to…"). If a comment only makes up for an unclear name, rename instead.
- Keep each comment short, but don't drop facts: when you shorten one, every condition, exception and number it states should survive.
- Refer to public things only: a GitHub issue number (`#123`) is fine; personal details, internal document or item numbers, and links to private notes are not.

### CHANGELOG

[`CHANGELOG.md`](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). A pull request that changes anything users, self-hosters or API clients can notice adds its entry under `## [Unreleased]` (replacing `_Nothing yet._` if that's all there is), in the right subsection: `Upgrade notes`, `Added`, `Changed`, `Fixed`, `Removed` or `Security`. Releases move that section under a version heading (see [docs/releasing.md](docs/releasing.md)). The existing entries share a style:

- each entry starts with **one bold sentence** saying what changed, from the point of view of the person using it, followed by the details;
- it describes behaviour, not code: what used to happen, what happens now, and any limits, in plain language;
- it ends the bold sentence or the entry with the issue number, like `(#379)`, and links the relevant doc, like `See [AI editing](docs/ai-editing.md#markdown-round-trip).`;
- API and MCP changes name the endpoints, fields and tools exactly (`GET /api/storage`, `byKind`, `open_notes_as_files`);
- anything that needs action on upgrade, such as a migration, a changed environment variable or a breaking change for API clients, goes under `Upgrade notes`, and migrations also get a section in [Upgrading and rolling back](docs/self-hosting.md#upgrading-and-rolling-back).

User-facing documentation in `docs/` is updated in the same pull request as the behaviour it describes. A feature worth showing in the Help window's What's new list is added to `apps/web/src/components/shortcuts/release-highlights.ts` (see [Updating "New in this version"](docs/feature-tour.md#updating-new-in-this-version)).

### Database changes

The schema is `apps/server/src/db/schema.ts`. After changing it, generate a migration with a descriptive kebab-case name, as the existing files have:

```sh
pnpm --filter @knotebook/server db:generate --name <kebab-case-name>
```

(`--custom` instead creates an empty migration for SQL written entirely by hand.) Commit the new SQL file in `apps/server/drizzle/` together with the updated `apps/server/drizzle/meta/`. When the generated SQL isn't safe for existing data, or can't express what you need (triggers, special indexes), edit it by hand and explain why in a comment at the top of the file or next to the hand-written part; `apps/server/drizzle/0007_note-slug.sql` and `apps/server/drizzle/0034_folders.sql` are examples. Migrations run automatically when the server starts. They are normally written so that the previous release still runs on the migrated database (new columns get database-side defaults, for example), which keeps rolling back possible; describe in the CHANGELOG what yours changes and what rolling back means.

### New dependencies and licenses

`pnpm check-licenses` (`scripts/check-licenses.mjs`) fails on any dependency, direct or transitive and including dev dependencies, whose license name contains GPL (LGPL included) or that pnpm reports as `Unknown`, and on any `@blocknote/xl-` package (BlockNote's commercially licensed extensions). Exemptions are listed in the script with a written reason. Check the license before adding a package. If the package ships code or assets in the app, it may also need an entry in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

### Patched dependencies

Two packages are patched with `pnpm patch`: `y-prosemirror` and `@blocknote/core` (files in `patches/`, listed under `pnpm.patchedDependencies` in `package.json`). [ARCHITECTURE.md](ARCHITECTURE.md#patched-dependencies) explains what each patch fixes and which test covers it. A patch is tied to an exact version, so upgrading either package means recreating the patch for the new version (`pnpm patch <package>@<version>`, then `pnpm patch-commit`) or confirming upstream no longer needs it and removing it. The `@blocknote/core` patch is also recorded in `THIRD_PARTY_NOTICES.md`.

### Text that users or agents read

- Interface strings go through i18next, in both `apps/web/src/i18n/en.json` and `apps/web/src/i18n/zh-TW.json`; `apps/web/src/i18n/index.test.ts` checks that the two have the same keys. Some features keep their strings in a separate pair of files in the same folder (for example `folders.en.json` and `folders.zh-TW.json`), registered by the matching `*-strings.ts` module and checked by its `*-copy.test.ts`; add strings for those features there.
- Text an AI agent reads, such as MCP tool descriptions and tool error messages, is in English.

## Maintainers

Releases are cut by the maintainer; the process is in [docs/releasing.md](docs/releasing.md).

## License

Knotebook is MIT-licensed ([LICENSE](LICENSE)).
