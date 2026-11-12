---
name: develop-plugins
description: Covers building a FINOS Workspace widget plugin from the docs/examples packages, checking it with scripts.plugin_check, writing its checksum, approving, enabling and granting it in Admin Portal, Widgets, iterating with Patch, Minor and Major development versions on a MODE=local stack, proxies, secrets, plugin backends, plugin skills, tests and the nightly interop workflow, and shipping pinned versions to a deployment. Use for requests such as "build a widget plugin", "try the plotly example", "run plugin_check", "write the plugin checksum", "approve the plugin", "start a patch version of a plugin", "add a proxy secret", "run a plugin backend", "ship the plugin to production".
---

# Develop widget plugins

## Stack

Use `local/` (`local/compose.yaml`, `MODE=local`, Vite and uvicorn hot reload). It exists for exactly this. Do not rebuild the backend image, the web image or the agent image between plugin iterations; do not `docker compose up --build` on a plugin change; do not copy files into a running container. The plugins directory is a bind mount — writes to `widget-plugins/<plugin-id>/<version>/` on the host appear in the API process without any container action, and the tab reloads the plugin list every 30 seconds on focus and every 60 seconds otherwise.

| Stack | Start | App | API service | Run compose from | Docker network |
|---|---|---|---|---|---|
| **`local/compose.yaml` (use this)** | `make up` | `http://localhost:1420` | `backend` | `local/` | `workspace-local_default` |
| `docker-compose.yml` | `docker compose up --build -d` | `http://localhost:3000` | `api` | repository root | `workspace_workspace` |

- Both set `MODE: local` and `WIDGET_PLUGINS_DIR: /opt/widget-plugins` and mount `widget-plugins/` at the repository root (git-ignored) there, writable, into the API, worker and `init`. `WORKSPACE_PLUGINS_DIR=<folder>` mounts another folder.
- Only `MODE=local` offers development versions (section 6). The deploy tutorials set `MODE=production`.
- After the first start and administrator sign-in (the `install-locally` skill), confirm: as a superuser, `/admin/widgets` (menu **Admin Portal**, **Widgets**), tab **Deployment** shows **Rescan**, not "Widget plugins are off".
- For multiple agents on the same stack at once, sign each one in as a different seeded dev admin (`workspace-dev1@example.com` / `WorkspaceDev!1`, `-dev2` / `WorkspaceDev!2`, `-dev3` / `WorkspaceDev!3`). They all hold the Admin role so each can reach `/admin/widgets` without waiting on your session. The `install-locally` skill lists them in full and names the `--no-extra-admins` opt-out.
- The root `docker-compose.yml` is for seeing production-shaped images (nginx-served web app, built agent, `MODE=local` only for the plugin flag). Reach for it to check the final image, never to iterate; frontend and backend code changes there need an image rebuild, and that round trip is the "frozen container" trap this skill is here to steer agents away from.

Never, when iterating on a plugin:

- Rebuild `workspace-backend`, `workspace-web`, `workspace-agent` or any other image.
- Run `docker cp` into a running container, or shell in and edit files there. The container is a view of `widget-plugins/` on the host; edit the host.
- Treat an image as the source of truth. The source of truth is `widget-plugins/<plugin-id>/<version>/` on the host and the `src/` of the example in `docs/examples/`.

## 1. Build an example

| Example (plugin id) | Widgets: types | Before `npm run build` |
|---|---|---|
| `docs/examples/plotly-charts` (`plotly-charts`) | Plotly chart: `plotly` | nothing |
| `docs/examples/ag-grid` (`ag-grid`) | `aggrid-table`, `aggrid-livegrid`, `aggrid-ssrm`, `aggrid-sql` (also standalone) | `npm ci --ignore-scripts` in `docs/examples/sql-explorer` |
| `docs/examples/sql-explorer` (`sql-explorer`) | SQL explorer: standalone, with a backend | nothing |

1. For `ag-grid` and `sql-explorer`, whose `npm test` also runs pytest, create the venv in the example folder:
   ```bash
   python3 -m venv .venv
   .venv/bin/pip install -r ../backend/requirements.txt pytest==9.1.1 httpx2==2.13.1
   ```
2. Install, build and test, from the example folder:
   ```bash
   npm ci --ignore-scripts
   npm run build
   npm test
   ```
3. Confirm: the build prints `built dist/<plugin-id>/<version>`, `checksum sha256-...` and `version digest sha256-...`, and `npm test` exits 0. Postgres tests are skipped unless `SQL_EXPLORER_TEST_POSTGRES` (a URL) or `SQL_EXPLORER_TEST_POSTGRES_FILE` (a file holding it) is set.

`build.mjs` writes `dist/<plugin-id>/<version>/`, `<version>` from `package.json`: `entry.js` (an esbuild bundle of `src/entry.js`; `plotly-charts` inlines plotly.js into it instead), `entry.css`, `assets/`, `skills/` from `src/skills/`, `backend/` and `licenses/` (`ag-grid`, `sql-explorer`), then `plugin.json` from `src/plugin.json` plus `version` and `checksum`. Commit `src/` and the `package.json` version; `dist/` and `widget-plugins/` are git-ignored.

## 2. Package rules

```text
<plugin-id>/<version>/
  plugin.json
  entry.js
  entry.css
  assets/
  skills/
  backend/
  licenses/
```

| Rule | Value (source: `backend-api/backend/api/widget_plugins/manifest.py`, `discovery.py`) |
|---|---|
| Plugin id / version directory | `^[a-z][a-z0-9-]{1,47}$` / `major.minor.patch`; equal to the manifest's `id` and `version` |
| Files | each name `[A-Za-z0-9._-]{1,128}`, no symlinks, at most 200 files and 64 MiB (`WIDGET_PLUGINS_MAX_FILES`, `WIDGET_PLUGINS_MAX_UNPACKED_BYTES`), `plugin.json` at most 256 KiB |
| Required keys | `manifestVersion: 1`, `id`, `version`, `name`, `publisher.name`, `host: {"api": 1, "afm": "0.11"}`, `checksum`, `entry.module` (`.js` outside `backend/`), `contributes.widgets` (1 to 20) |
| Widget | `id`, `name`, and `handles` (types, not `markdown`, `html`, `iframe`, `newsfeed`, `pdf`) or `standalone: true` |
| Pairing | `core:proxy:call` exactly when the widget names `server.proxies`; `core:backend:call` exactly when it names `server.routes`; `artifact` needs `core:data:read` |
| Closed | an unknown key, a non-null `signatures`, or `core:data:query` blocks the version |
| Served to browsers | `entry.module`, `entry.styles`, `icon`, `assets/*`; never `plugin.json`, `skills/`, `backend/`, `licenses/` |

Every key: `docs/reference/plugins/package-and-manifest.mdx`, `docs/reference/schemas/plugin-json.mdx`, `docs/reference/plugins/module-contract.mdx`.

## 3. Place and check the version

1. Copy the build into the plugins directory, from the repository root:
   ```bash
   mkdir -p widget-plugins/<plugin-id>
   cp -R docs/examples/<example>/dist/<plugin-id>/<version> widget-plugins/<plugin-id>/
   ```
2. Run the server's validator in the API container (from `local/`; on the root stack use `docker compose exec api` from the repository root):
   ```bash
   docker compose exec backend python -m scripts.plugin_check /opt/widget-plugins/<plugin-id>/<version>
   ```
3. Confirm: the last line is `ok: the server would offer this version for approval`. `blocked: ...` exits 1 and lists `error` lines; `warning` lines do not block.
4. For a hand-built package, print the checksum with `--digest`, write the `checksum` line's value as `"checksum"` in `plugin.json`, and run step 2 again.

| Flag | Effect |
|---|---|
| `--digest` | prints only `checksum` (every file except `plugin.json`) and `digest` (every file), no checks |
| `--max-files <n>` | file cap, default 200 |
| `--max-bytes <n>` | size cap, default 67108864 |

Exit codes: 0 ok, 1 blocked, 2 not a directory. It ignores pins and `WIDGET_PLUGINS_REQUIRE_PINS`, and treats a stale checksum as an error even for a development copy.

## 4. Approve, enable and grant

1. On **Deployment**, select **Rescan**. Confirm: toast `Rescanned: 1 discovered`; the row shows `discovered`, or `blocked` with the reason under **Versions**.
2. Select the plugin row. Under **Review <version>** read **What it is**, **Integrity** (Checksum "matches the manifest"), **Network of the frame** and **Server side**; tick every item under **What it asks for** (**Changes since <active-version>** for a later version) and the "I have reviewed ..." box; select **Approve <version>**. Confirm: toast `<name> <version> approved`.
3. Under **Enabled for**, switch on the organization, or select **Enable for all**. An organization admin uses the plugin's **Enabled** switch on the **Plugin widgets** tab instead.
4. In **Roles and Access**, select the role's **Widget plugins** button, tick **All widgets of this plugin** or single widgets, **Save**. Grant a role you hold. Confirm: toast `Widget plugin access saved`.

Same steps from a shell with `python -m scripts.workspace_admin plugin <action>` (`rescan`, `show`, `approve`, `enable`, `grant`). Full command surface and failure table: `.agents/skills/administer-via-cli/SKILL.md`. Tutorial walkthrough: `docs/tutorials/plugins/review-and-enable-a-plugin.md`.

## 5. Add the widget to a dashboard

1. A handled type needs a connection whose `widgets.json` declares `"type": "<viz-type>"`. The examples backend (`docs/examples/backend/README.md`) serves every example type. After building `sql-explorer` and `ag-grid`, run from `docs/examples/backend`, with `<network>` from the Stack table (check `docker network ls`):
   ```bash
   python3 setup.py
   SQL_EXPLORER_VERSION=<sql-version> AG_GRID_VERSION=<grid-version> WORKSPACE_NETWORK=<network> docker compose up -d --build
   ```
   Confirm: `setup.py` prints `Wrote .env for Compose and secrets/workspace/<plugin>/postgres_url for each plugin.` Then add `http://localhost:7798` under **Connections**.
2. On a dashboard, select **Add widgets** in the toolbar at the bottom right. In **Widget Menu**, tab **Widgets Library**, search the widget name and add it.
3. Confirm: the card renders. "This widget type is not available to you": no grant or enablement, or a development copy with an error; "Failed to load: the plugin's files do not match the approved version": changed files; "Plugin error" or "Not responding": the module.

## 6. Iterate with a development version

1. Select the plugin row on **Deployment**. Under **Versions** ("Develop a new version from <version>:"), select **Patch**, **Minor** or **Major**. Confirm: toast `<next-version> is in development`, the version shows `development`, and `widget-plugins/<plugin-id>/<next-version>/` exists with `version` and `checksum` rewritten.
2. Set `version` in the example's `package.json` to `<next-version>`, rebuild, and mirror the build into the copy, from the example folder:
   ```bash
   npm run build
   rsync -a --delete dist/<plugin-id>/<next-version>/ ../../../widget-plugins/<plugin-id>/<next-version>/
   ```
3. Focus the dashboard window: the plugin list reloads on focus once it is 30 seconds old, and every 60 seconds. Everyone granted the plugin on this stack gets the copy. A stale `checksum` shows only as a warning under **Integrity**.
4. A copy with an error drops the whole plugin from dashboards, and **Deployment** lists only its warnings. Read the errors (lines with `✗`):
   ```bash
   docker compose exec backend python -m scripts.workspace_admin plugin show <plugin-id>
   ```
5. Finish: with the `checksum` current (the example builds write it), tick the **Changes since <version>** items and select **Approve <next-version> and replace <version>**. To abandon it, delete its directory and **Rescan**; the version becomes `missing`.

- The buttons appear only for a superuser, with `MODE=local`, an active version and no version in `development`.
- `The plugins directory cannot be written: ...`: the mount must be writable by uid 1000 (`USER 1000:1000` in `backend-api/backend/fastapi.Dockerfile`); a `:ro` override of the mount causes it.
- `workspace_admin plugin approve` refuses a `development` version; approve it on **Deployment**.

## 7. Proxies, secrets and backends

| Need | Do | Doc |
|---|---|---|
| Call a keyed API | declare `secrets`, `server.network` (https origins only), `server.proxies`; on the widget `core:proxy:call` and `server.proxies` | `docs/tutorials/plugins/call-an-api-from-a-plugin.md`, `docs/reference/plugins/proxies.mdx` |
| Set a secret | **Deployment**, plugin, **Secrets**, enter the value, **Set**; or `plugin secret set <plugin-id> <secret-name>` (prompts without echo, or reads stdin); or a file `<WIDGET_PLUGIN_SECRETS_DIR>/<plugin-id>/<secret-name>`, which wins | `docs/tutorials/plugins/deploy-a-plugin.md` |
| Reach a private host (any `MODE`) | **Overrides**, tick **server network**, enter `https://<host>` (or `tcp://<host>:<port>` with a backend), tick "Allow private hosts ..." or "Let the server network's hosts resolve to private addresses ...", **Save overrides**; CLI `plugin override <plugin-id> --server-network <origin> --confirm private-host` | `docs/reference/plugins/frame-policy.mdx` |
| Trust a private CA | mount the CA file and set `WIDGET_PLUGIN_PROXY_CA_FILE` | `local/LOCAL_SETUP.md` |
| Frame request blocked | **Blocked requests**, **Allow** fills the source into **Overrides**; tick the "Allow ..." confirmation it shows, **Save overrides** | `docs/reference/plugins/frame-policy.mdx` |
| Plugin backend | declare `server.backend` (`protocol: 1`, `routes`); on the widget `core:backend:call` and `server.routes`; run `backend/` isolated; set `WIDGET_PLUGIN_BACKENDS={"<plugin-id>": "<internal-url>"}` in `backend-api/backend/envs/.env`; recreate the API (`make up` in `local/`, `docker compose up -d` at the root; `make restart` keeps the old values) | `docs/tutorials/plugins/run-a-plugin-backend.md`, `docs/reference/plugins/backends.mdx` |

Examples backend: `WIDGET_PLUGIN_BACKENDS={"sql-explorer": "http://examples-gateway:8081", "ag-grid": "http://examples-gateway:8082"}`, server network override `tcp://postgres:5432` with private hosts confirmed, and each plugin's `postgres_url` secret from `docs/examples/backend/secrets/workspace/<plugin>/postgres_url`.

Confirm a backend: **Backend**, **Check now** shows "Runs the approved version."; `python -m scripts.workspace_admin plugin check-backend <plugin-id>` prints `<plugin-id> backend: identity ok (the approved version)`.

## 8. Plugin skills

Add a markdown file under `skills/` and an entry in `contributes.skills` (at most 20):

| Key | Rule |
|---|---|
| `slug` | 2 to 50 characters, `^[a-z0-9]+(?:-[a-z0-9]+)*$`, unique in the plugin |
| `description` | 1 to 300 characters |
| `file` | `skills/<name>.md`, UTF-8, not empty, at most 32 KiB, unique in the plugin |

Confirm: `plugin_check` passes, the review lists `the skill <slug>` to tick, and once the version is active and enabled for the organization it appears in `/app/ai` (**AI Library**), tab **Skills**, and as `/skill:<slug>`. A personal skill with the same slug hides it.

## 9. Tests and CI

| What | Where | Trigger |
|---|---|---|
| Example tests | `npm test` in each example | `.github/workflows/examples.yml`, pull requests touching `docs/examples/**` |
| Host plugin behaviour | `frontend/tests/e2e/plugin*.spec.ts`, `backend-api/backend/tests/test_widget_plugin*.py` | `.github/workflows/e2e.yml`, `.github/workflows/backend-checks.yml` |
| Public anywidget modules in plugin frames (`frontend/tests/e2e/plugins/interop-modules.json`) on Chromium, Firefox, WebKit | `frontend/tests/e2e/plugin-interop.spec.ts`, needs `E2E_INTEROP=1` and `E2E_PLUGINS_DIR` | `.github/workflows/plugin-interop.yml`, nightly at 03:17 UTC, or manually |

Run the interop workflow and check its result:

```bash
gh workflow run plugin-interop.yml --ref <branch>
gh run list --workflow plugin-interop.yml --limit 1
```

## 10. Ship to a deployment

1. Work through "Before you publish" in `docs/tutorials/plugins/build-a-plugin.md`. Raise `version` in `package.json`, `npm run build`, and run `plugin_check` on the new directory. Never change an approved version's files.
2. Print the digest with `python -m scripts.plugin_check --digest <plugins-dir>/<plugin-id>/<version>` and pin it: `WIDGET_PLUGINS_PINS={"<plugin-id>@<version>": "<digest>"}`, plus `WIDGET_PLUGINS_REQUIRE_PINS=true`.
3. Deliver the directory with identical files to every API replica: `COPY` it into the API image, or mount a volume read-only on every replica, with `WIDGET_PLUGINS_DIR` set.
4. Keep the previous version's directory until the new one is approved; a removed directory turns `missing`.
5. Rescan and approve; in the API container, `python -m scripts.workspace_admin plugin approve <plugin-id> <version> --digest <digest> --acknowledge` stops if the server's files differ.
6. Provide secrets as files under `WIDGET_PLUGIN_SECRETS_DIR` and run any backend as in section 7.

A `MODE=production` stack has no Patch, Minor or Major. Detail: `docs/tutorials/plugins/deploy-a-plugin.md`, `docs/reference/plugins/lifecycle.mdx`.
