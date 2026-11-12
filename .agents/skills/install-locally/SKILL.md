---
name: install-locally
description: Runs FINOS Workspace on a workstation with either the hot-reload development stack in local/ (make up) or the stack that builds every image from the root docker-compose.yml, covering prerequisites, first start, the administrator password, the three local-dev administrator accounts seeded with known passwords so multiple agents can sign in at once, health checks, which change needs a restart or rebuild, settings files, turning on the agent, stopping, resetting and troubleshooting. Use for "run the stack locally", "make up", "docker compose up", "start FINOS Workspace on my machine", "set the admin password", "sign another agent in as admin", "seed extra local admins", "reset the local database", "port 8000 is in use", "turn on the agent locally", "PLATFORM=linux/arm64".
---

# Install locally

## Prerequisites

| Need | Development stack (`local/`) | Built-image stack (repo root) |
|---|---|---|
| Docker with Docker Compose v2, running | yes | yes |
| Memory for Docker | 8 GB or more | 8 GB or more (the `web` build gives Node a 4608 MB heap) |
| Free ports | 3306, 6379, 8000, 1420 | 3000, 8000, 7777 |
| `python3` 3.10 or later, standard library only; the 3.9 `/usr/bin/python3` of macOS fails | first start | first start |
| `curl`, and `make` (WSL on Windows) | both | `curl` only |
| `docker login ghcr.io` with a token that has `read:packages` | no | yes, for `ghcr.io/finos-labs/finos-node` |
| Apple silicon | `export PLATFORM=linux/arm64` in the shell before any `make` or `docker compose` | same |

## Choose a stack

| Goal | Stack | Web app | API |
|---|---|---|---|
| Change code with hot reload; no agent (`VITE_AI_API_URL` is empty, so the Copilot panel has no service) | `local/compose.yaml` (project `workspace-local`) | http://localhost:1420 | http://localhost:8000 |
| Production images built from this checkout, with the agent | `docker-compose.yml` (project `workspace`) | http://localhost:3000 | http://localhost:8000 |

Run one stack at a time: both publish port 8000. Both read the same `backend-api/backend/envs/.env` and `scripts/cfgs/config.toml`, but each has its own database, so set the password once per stack.

## Development stack: first start

1. Check the machine from `local/`. Confirm `ok: Docker Compose <version>` and, while the stack is down and `lsof` exists, `ok: ports 3306 6379 8000 1420 are free`.
   ```bash
   cd local
   make doctor
   ```
2. Start everything; `ADMIN_EMAIL` is needed only while `backend-api/backend/envs/.env` does not exist. The first run builds the backend images and installs the frontend packages, and `make up` waits up to `WAIT_SECONDS` (default 1200). Confirm `Ready.` followed by `App:` http://localhost:1420 and `Backend:` http://localhost:8000.
   ```bash
   ADMIN_EMAIL=<your-email> make up
   ```
3. Set the administrator's password, in `local/`, while the stack runs. Type it twice at `New password:` and `Repeat the new password:`. Confirm `The password of <your-email> is set. Every session of the account has ended.`
   ```bash
   docker compose run --rm init python -m scripts.init_users --new-password <your-email>
   ```
   Rule: 8 or more characters, an uppercase and a lowercase letter, a digit, a special character other than `_`, no spaces.
4. Confirm the API answers `{"success":true}` and the dev server prints `200`, then sign in at http://localhost:1420 with the email and password.
   ```bash
   curl -fs http://localhost:8000/health
   curl -fs -o /dev/null -w '%{http_code}\n' http://localhost:1420
   ```

## Development stack: dev admins for other agents

`scripts.create_local_env` seeds three extra administrators alongside yours, each with a known password, so another AI agent or another browser session can sign in at the same time without racing on your login. The accounts only exist in `scripts/cfgs/config.toml` written by the script, so they never reach a deployment. Pass `--no-extra-admins` to turn this off.

| Email | Password |
|---|---|
| `workspace-dev1@example.com` | `WorkspaceDev!1` |
| `workspace-dev2@example.com` | `WorkspaceDev!2` |
| `workspace-dev3@example.com` | `WorkspaceDev!3` |

- The passwords are set once on the `init` step's first run; `scripts.init_users` picks the known value for these emails and `base.random_password()` for every other admin. Subsequent runs are idempotent and leave an already-set password alone.
- Reset erases them with the rest of the database, and the next `make up` seeds them again.
- Never reach for these emails in production code, tests outside `backend-api/backend/tests/scripts/`, or a production `config.toml`. They are only for the local development stack.

Everything else an administrator does from a shell — organizations, users, data backends, bulk provisioning, widget plugins — runs through `python -m scripts.workspace_admin`, covered in `.agents/skills/administer-via-cli/SKILL.md`.

## Development stack: commands

Run in `local/`, or from the repo root as `make -C local <target>`. `make` alone lists the targets.

| Command | Effect |
|---|---|
| `make up` | `doctor`, write settings if missing, `docker compose up --build --detach --remove-orphans`, wait |
| `make down` | Stop everything, keep the data |
| `make ps` | List services, stopped ones included |
| `make logs` / `make logs s=<service>` | Follow all logs / one service |
| `make restart s=<service>` | `docker compose restart` one service (default `backend`) |
| `make shell s=frontend` | Shell in a service; the backend images have no `sh`, so use `docker compose exec backend python` |
| `make reset` | `docker compose down --volumes` (database and frontend packages), then `make up` |
| `ADMIN_EMAIL=<your-email> ./dev.sh env` | Write the settings without `make`; then `docker compose up --build -d` |

Services: `frontend` (1420), `backend` (8000), `backend-worker`, `init`, `mysql` (3306, `root`/`root`, database `workspace`), `valkey` (6379).

## Development stack: after a change

| Change | Action |
|---|---|
| `frontend/src/` | None: Vite reloads the browser |
| Backend code | None: uvicorn `--reload` restarts the API |
| Code the worker runs | `make restart s=backend-worker` |
| `backend-api/backend/pyproject.toml` or `poetry.lock` | `make up` (rebuilds the backend images) |
| `frontend/package.json` | `make restart s=frontend` (runs `npm install` again) |
| New migration | `make up` (`init` runs `alembic upgrade head`) |
| `backend-api/backend/envs/.env` | `make up` (recreates the containers; `make restart` keeps the old values) |
| `scripts/cfgs/config.toml` | `make up` (`init` runs `scripts.init_users`) |
| `frontend/.env` | `make restart s=frontend` |

## Built-image stack: first start, from the repository root

1. Log in to the GitHub container registry once. Confirm `Login Succeeded`.
   ```bash
   echo <token> | docker login ghcr.io -u <github-username> --password-stdin
   ```
2. Write the settings, unless `backend-api/backend/envs/.env` already exists. Confirm the output starts with `Wrote` and names `agent/.env`.
   ```bash
   (cd backend-api/backend && python3 -m scripts.create_local_env --admin-email <your-email>)
   ```
3. Build and start. Repeat `docker compose ps` until `api` and `agent` show `(healthy)`.
   ```bash
   docker compose up --build -d
   docker compose ps
   ```
4. Set the administrator's password from the repository root, as in the development stack, step 3.
   ```bash
   docker compose run --rm init python -m scripts.init_users --new-password <your-email>
   ```
5. Confirm the API (`{"success":true}`), web app (`{"status": "ok"}`) and agent (`"status":"ok"`) answer, then sign in at http://localhost:3000. The main menu offers Admin Portal (http://localhost:3000/admin).
   ```bash
   curl -fs http://localhost:8000/health
   curl -fs http://localhost:3000/health
   curl -fs http://localhost:7777/status
   ```

Services: `mysql`, `valkey`, `init`, `api` (8000), `worker`, `web` (3000), `agent` (7777), `agent-mcp`. Day to day: `docker compose ps`, `docker compose logs -f <service>`. After a change:

| Change | Action |
|---|---|
| Code in `backend-api/`, `frontend/` or `agent/`, or `frontend/.env` | `docker compose up --build -d` |
| `backend-api/backend/envs/.env` or `agent/.env` | `docker compose up -d` |
| A shell variable of the `web` or `agent` service | `docker compose up -d` with the variable set |
| `scripts/cfgs/config.toml` | `docker compose run --rm init` |

## Turn on the agent (built-image stack)

1. In `agent/.env`, set `DEFAULT_MODEL=<provider>:<model>` and that provider's key: `openai` with `OPENAI_API_KEY`, `openrouter` with `OPENROUTER_API_KEY`, `groq` with `GROQ_API_KEY`, `nvidia` with `NVIDIA_API_KEY`, or `ollama` with `OLLAMA_BASE_URL=http://host.docker.internal:11434/api` (Docker Desktop). Optional: `AGENT_MODELS` (comma-separated extra `<provider>:<model>` choices), `AGENT_EMBED_MODEL` (document search).
2. Recreate the agent containers.
   ```bash
   docker compose up -d
   ```
3. Confirm `{"status":"ready"}`, that `docker compose logs agent` no longer shows `DEFAULT_MODEL is not set`, and that a question in the web app gets an answer instead of `No model is configured`.
   ```bash
   curl -fs http://localhost:7777/ready
   ```

## Settings files

| File | Read by | Written by | Notes |
|---|---|---|---|
| `backend-api/backend/envs/.env` | API, worker and `init` of both stacks | `scripts.create_local_env` from `envs/.env.example` | Secrets; git-ignored. Compose `environment` wins for `MODE` (`local`), `DB_HOST`, `REDIS_HOST`, `FOLDER_STORAGE_PATH`, `WIDGET_PLUGINS_DIR`; root also `DEFAULT_MCP_SERVERS`, `local/` also `FRONTENDURL`, `APPURL` |
| `backend-api/backend/scripts/cfgs/config.toml` | `init` (`scripts.init_users` reads every `cfgs/*.toml`) | `scripts.create_local_env` | `[entity] name`, `[[admins]] email`; no password |
| `backend-api/backend/user_create.json` | `init`, API | `scripts.create_local_env`, `init` | Git-ignored; the root stack bind-mounts it |
| `frontend/.env` | Vite dev server of `local/`; the root `web` build | Tracked in git | `local/compose.yaml` overrides `VITE_BACKEND_URL`, `VITE_AI_API_URL`, `VITE_UI_SHOW_COMPANION_MCP_MODE`, `VITE_ALLOW_HTML_JS_EXECUTION` |
| `agent/.env` | `agent`, `agent-mcp` (root only) | `scripts.create_local_env` from `agent/.env.example` | Gets `AGENT_METERING_TOKEN` and `AGENT_SCOPE_SECRET`; add `DEFAULT_MODEL` |

The root `web` image serves `/config.js` from its container variables, which `docker-compose.yml` takes from the shell: `API_URL` (also the agent's `WORKSPACE_PUBLIC_URL`), `AI_API_URL`, `AI_COPILOT_ENABLED`, `ALLOW_HTML_JS_EXECUTION`, `UI_SHOW_COMPANION_MCP_MODE`. `WEB_URL` sets the agent's `WORKSPACE_ORIGIN` and `AGENT_CORS_ORIGINS`. Both stacks take `WORKSPACE_PLUGINS_DIR` (default `widget-plugins/` at the repo root); the root agent takes `AGENT_MEM_LIMIT` (default `4g`).

To regenerate the settings, run this, then reset the database of the stack in use: `JWT_SECRET` and `WORKSPACE_AES_KEY` change. `--force` keeps `AGENT_SCOPE_SECRET` and the other settings in `agent/.env` and writes a new `AGENT_METERING_TOKEN`; `--config-only --force` rewrites only `config.toml`.

```bash
(cd backend-api/backend && python3 -m scripts.create_local_env --admin-email <your-email> --force)
```

## Stop and reset

| Action | Development stack (`local/`) | Built-image stack (repo root) |
|---|---|---|
| Stop, keep data and password | `make down` | `docker compose down` |
| Delete data, start again | `make reset` | `docker compose down -v`, then `docker compose up --build -d` |

After a reset, set the password again. The root services have `restart: unless-stopped`: they start again with Docker until `docker compose stop` or `docker compose down`. Uploaded files of the development stack stay in `backend-api/backend/local_storage/`; those of the root stack are in the `storage` volume.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `port <port> is in use` from `make doctor` | `lsof -nP -iTCP:<port> -sTCP:LISTEN`; for 8000 run `docker compose down` at the repo root, or `make down` in `local/` |
| `TypeError: unsupported operand type(s) for \|` | Put Python 3.10 or later first on `PATH` as `python3` |
| `envs/.env does not exist yet` | `ADMIN_EMAIL=<your-email> make up` |
| `the init step failed` | `make logs s=init` (root: `docker compose logs init`) |
| `not ready after 1200s` | `make logs`; on a slow first build `WAIT_SECONDS=2400 make up` |
| Root `docker compose` stops because `envs/.env` or `agent/.env` is missing | Built-image stack, step 2 |
| `IsADirectoryError` for `user_create.json` in the `init` logs | `docker compose down`, `rmdir backend-api/backend/user_create.json && echo '{}' > backend-api/backend/user_create.json`, then `docker compose up -d` |
| Root build cannot pull `ghcr.io/finos-labs/finos-node` | Built-image stack, step 1 |
| Root `web` build fails with `PLATFORM=linux/arm64` | `unset PLATFORM` and build again: the `finos-node` base is `linux/amd64` only, so Docker builds through emulation |
| `<your-email> is not an administrator of this FINOS Workspace.` | Use the `[[admins]]` email of `config.toml`; start the stack once so `init` creates it |
| `Password must be at least 8 characters long, ...` | Follow the rule in development stack, step 3 |
| Sign-in fails | `make logs s=backend` (root: `docker compose logs api`) |
| An edited `envs/.env` value has no effect | `make up` (root: `docker compose up -d`), not `make restart` |
| `exec: "sh": executable file not found` from `make shell` | `docker compose exec backend python` |
| `curl -fs http://localhost:7777/ready` fails (503, `not ready`) | `docker compose logs api`; the agent checks the API's `/health` |

## Reference

- Stacks: `local/LOCAL_SETUP.md`, `docs/tutorials/contribute/run-the-development-stack.md`, `docs/tutorials/build-from-source/run-the-stack-from-source.md`, `docs/tutorials/build-from-source/build-the-images.md`
- Settings: `docs/reference/configuration/backend.mdx`, `docs/reference/configuration/web-app.mdx`, `docs/reference/configuration/agent.mdx`, `agent/README.md`
- Widget plugins on a local stack: `.agents/skills/develop-plugins/SKILL.md`
