---
name: deploy-remotely
description: Builds the FINOS Workspace images (backend, web app, agent, agent MCP server) and deploys them to a remote server with Docker Compose or to a Kubernetes cluster, then upgrades that deployment and its database. Covers preconditions, the docker build commands and targets, the published Docker Hub release images, generating each secret and where it goes, the settings that stop the API from starting or make it refuse requests, the Kubernetes apply order, the first administrator password and health checks. Use for "deploy Workspace to a server", "deploy on Kubernetes", "production setup", "build and push the images", "generate the secrets", "create the metering token", "set the admin password on the server", "upgrade the deployment", "run the migrations".
---

# Deploy remotely

## Preconditions

| Item | Requirement |
|---|---|
| Target | Linux server with Docker Engine and the Compose plugin, or a cluster reachable with `kubectl` plus an ingress controller |
| Images | Pulled from Docker Hub as `finos/workspace-<image>:<version>`, or from your own registry, written `<registry>` below. One tag for all four images, written `<version>`. The released images are `linux/amd64` only |
| DNS and TLS | Three names on one registrable domain, `workspace.example.com` (web), `api.workspace.example.com` (API) and `agent.workspace.example.com` (agent), with a certificate ended at a reverse proxy or ingress that sets `X-Forwarded-For` and `X-Forwarded-Proto` |
| Proxy limits | Request body of at least 64 MB on the agent name (`AGENT_MAX_BODY_MB`); idle timeout longer than the slowest streamed answer |
| `DEFAULT_MODEL` | `<provider>:<model>` and that provider's key, for example `OPENAI_API_KEY` |

## Get the images

Pull the released images from Docker Hub unless the deployment needs code or build settings of its own. `.github/workflows/docker-publish.yml` publishes `finos/workspace-backend`, `finos/workspace-web`, `finos/workspace-agent` and `finos/workspace-agent-mcp` on every published GitHub release, only when the repository owner is `finos` or `finos-labs`. They are built for `linux/amd64` only and tagged with the release tag, leading `v` included, and `latest`. Set `<version>` to the release tag, never `latest`, which moves to every release, pre-releases included, and use `finos/workspace-<image>:<version>` wherever `<registry>/workspace-<image>:<version>` appears below. An arm64 target runs them through emulation. With the released images, skip the next section and go to "Generate the secrets".

### Build and push your own images

Use this when the code or a build-time white label setting changes, or when the target cannot reach Docker Hub. `workspace-backend` also runs the worker (`python base_workers.py`) and the init step; `agent` and `agent-mcp` are stages of `agent/Dockerfile`. Details: `docs/tutorials/build-from-source/build-the-images.md`.

1. From the repository root, log in to `ghcr.io` with a classic GitHub token that has `read:packages` and can read the `finos-labs` packages, then read the `finos-node` base pinned in `docker-compose.yml`:
   ```bash
   echo <token> | docker login ghcr.io -u <github-username> --password-stdin
   NODE_BASE=$(grep -m 1 -o 'docker-image://[^ ]*' docker-compose.yml)
   echo "$NODE_BASE"
   ```
   Confirm: `Login Succeeded`, then `docker-image://ghcr.io/finos-labs/finos-node:<release>@sha256:<digest>`.
2. Build from a clone with no `backend-api/backend/user_create.json`, such as a fresh clone: a local stack writes that file, `.dockerignore` does not exclude it, and a copy in the image overrides `DEFAULT_USER_MAPPING` on Kubernetes. On Apple silicon for x86-64 servers, add `--platform linux/amd64` to the backend build too. Rerun a build that stops on a network error; finished steps are cached.
   ```bash
   docker build -f backend-api/backend/fastapi.Dockerfile -t <registry>/workspace-backend:<version> backend-api/backend
   docker build --platform linux/amd64 --build-context "node=$NODE_BASE" -t <registry>/workspace-web:<version> frontend
   docker build --platform linux/amd64 --build-context "node=$NODE_BASE" --target agent --build-arg GIT_SHA="$(git rev-parse HEAD)" -t <registry>/workspace-agent:<version> agent
   docker build --platform linux/amd64 --build-context "node=$NODE_BASE" --target agent-mcp -t <registry>/workspace-agent-mcp:<version> agent
   ```
3. Push, and confirm that each push ends with a `digest: sha256:` line:
   ```bash
   for image in backend web agent agent-mcp; do docker push <registry>/workspace-$image:<version>; done
   ```

## Generate the secrets

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

| Secret | Value | Compose file | Kubernetes Secret | Rule |
|---|---|---|---|---|
| `JWT_SECRET` | First command | `backend.env` | `workspace-backend` | At least 32 bytes, the same in every API, worker and init container. Changing it invalidates every service token, the metering token included |
| `WORKSPACE_AES_KEY` | Second command | `backend.env` | `workspace-backend` | Base64url of at least 32 bytes, the same everywhere. Back it up with the database: no other key reads what it encrypted |
| `LOCAL_STORAGE_SECRET_KEY` | Second command | `backend.env` | `workspace-backend` | At least 32 bytes, the same everywhere. Required while `STORAGE_PROVIDER` is `folder`, the default |
| `AGENT_SCOPE_SECRET` | Second command | `agent.env` | `workspace-agent` | At least 16 characters, same value for the agent and the agent MCP server |
| Database passwords | Second command, once for the `workspace` account and once for root | `.env` as `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD` | `workspace-backend`: the `workspace` password as both `WRITE_DB_PASSWORD` and `READ_DB_PASSWORD`; `mysql`: `MYSQL_ROOT_PASSWORD` | URL-safe characters only: the API writes the `workspace` password into the database URL unescaped. MySQL reads them only on its first start; a later change fails the init step with `Access denied for user 'workspace'` until `ALTER USER` runs in MySQL |
| `AGENT_METERING_TOKEN` | `python -m scripts.create_metering_token` in a backend container with the API settings | `agent.env` | `workspace-agent` | Signed with `JWT_SECRET`. Expires after 365 days, or `--days <n>`; the expiry prints on stderr |

## Settings that block startup or refuse requests

| Setting | Set it to | When wrong |
|---|---|---|
| `MODE` | `production` on the API, worker and init step | Missing: `ValidationError` with `Field required`, no start. `local` admits private and plain `http` addresses from any account; `test` keeps rate limits in process |
| `BACKEND_CORS_ORIGINS` | The web origin exactly, `https://workspace.example.com`; comma-separated or JSON list, no path, no `*` | Missing or not an origin: no start. Unlisted `Origin`: 403 `Requests must come from an allowed origin`; `/health` and `/healthz` need no `Origin` |
| `APPURL`, `FRONTENDURL`, `SELFURL` | Web address, web address, API address, all `https://` on one registrable domain; `SELFURL` equals the web app's `BACKEND_URL` and the agent's `WORKSPACE_PUBLIC_URL` | Missing: no start. Plain `http` or another site: the browser drops the `Secure`, `HttpOnly`, `SameSite=Strict` session cookie and sign-in stays on the sign-in page |
| `REDIS_PASS` | Present; empty when Valkey has no password | Missing: no start |
| `GOOGLE_OAUTH_CLIENT_ID`; `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`; `OKTA_CLIENT_ID`, `OKTA_DOMAIN`, `OKTA_CLIENT_SECRET` | Google: one value on the web app and the API. Microsoft and Okta: API only, `OKTA_DOMAIN` is the `https://` issuer, redirect URI `<SELFURL>/app/sign-in/microsoft/callback` or `<SELFURL>/app/sign-in/okta/callback` | 400 `Google sign-in is not configured`, `Microsoft sign-in is not configured` or `Okta sign-in is not configured` |
| `AUTHENTICATION_IDENTITY_PROVIDERS`, `AUTHENTICATION_ALLOW_EMAIL_LOGIN` | Web app only: `google`, `microsoft`, `okta`, comma-separated; `false` hides the password form | Unlisted provider: no button. The API reads neither, so it still accepts password sign-in |
| `WORKSPACE_API_URL`, `WORKSPACE_ORIGIN`, `WORKSPACE_PUBLIC_URL`, `AGENT_CORS_ORIGINS`, `AGENT_METERING_TOKEN`, `AGENT_SCOPE_SECRET` | Agent; origins without a path; `WORKSPACE_ORIGIN` listed in `BACKEND_CORS_ORIGINS`. The agent MCP server needs the same `AGENT_SCOPE_SECRET` | The process exits and its log names the setting |
| `AI_COPILOT_ENABLED` | `true` on the web app, next to `BACKEND_URL` and `AI_API_URL` | Default `false`: no Agent. Any web-app boolean other than `true` or `false`: `/healthz` and `/config.js` answer 500 |

Every service reads its settings at start: after a change run `docker compose up -d`, or `kubectl -n finos-workspace rollout restart deployment/<name>`. Full lists: `docs/reference/configuration/overview.md`.

## Deploy with Docker Compose

1. On the server, create a folder with `compose.yaml`, `.env`, `backend.env`, `agent.env` and `config.toml`, copied from `docs/tutorials/deploy/deploy-with-docker-compose.md`. Set the four `*_IMAGE` values, `WEB_URL`, `API_URL`, `AGENT_URL` and both MySQL passwords in `.env`; `MODE=production`, the three API secrets and `REDIS_PASS=` in `backend.env`; `DEFAULT_MODEL`, the provider key, `AGENT_SCOPE_SECRET` and `AGENT_METERING_TOKEN=` in `agent.env`; the `[entity]` name and at least one `[[admins]]` email in `config.toml`.
2. Create the empty file, protect the secrets and validate:
   ```bash
   touch user_create.json && chmod 600 .env backend.env agent.env && docker compose config --quiet
   ```
   Confirm: no output. A missing value stops with an error that ends `Set <NAME> in .env`.
3. Create the metering token and put it into `agent.env` as `AGENT_METERING_TOKEN`:
   ```bash
   docker compose run --rm --no-deps init python -m scripts.create_metering_token
   ```
   Confirm: the token on stdout, then `Expires <date> UTC`.
4. Start:
   ```bash
   docker compose up -d
   docker compose ps
   ```
   Confirm: `api` and `agent` show `healthy`. On `service "init" didn't complete successfully`, read `docker compose logs init`; on a restarting agent, read `docker compose logs agent`. Then point the reverse proxy at `http://127.0.0.1:3000` (web), `http://127.0.0.1:8000` (API) and `http://127.0.0.1:7777` (agent).

## Deploy on Kubernetes

Write `backend.env`, `mysql.env`, `config.yaml`, `data.yaml`, `init-job.yaml`, `backend.yaml`, `agent.env`, `agent.yaml`, `web.yaml` and `ingress.yaml` from `docs/tutorials/deploy/deploy-on-kubernetes.mdx`. Set the addresses and `DEFAULT_MODEL` (in the `workspace-agent` ConfigMap) in `config.yaml`, the image names in the four manifests, the storage class in `backend.yaml` and `ingressClassName` in `ingress.yaml`. With managed MySQL and Valkey, leave out `mysql.env`, `data.yaml` and the StatefulSet checks, and point `DB_HOST`, `REDIS_HOST` and the passwords at them.

1. Secrets, settings, MySQL, Valkey and the init job:
   ```bash
   kubectl create namespace finos-workspace
   kubectl -n finos-workspace create secret generic workspace-backend --from-env-file=backend.env
   kubectl -n finos-workspace create secret generic mysql --from-env-file=mysql.env
   kubectl -n finos-workspace apply -f config.yaml -f data.yaml
   for s in mysql valkey; do kubectl -n finos-workspace rollout status statefulset/$s --timeout=5m; done
   kubectl -n finos-workspace apply -f init-job.yaml
   kubectl -n finos-workspace wait --for=condition=complete job/workspace-init --timeout=5m
   kubectl -n finos-workspace logs job/workspace-init
   ```
   Confirm: the log ends with a JSON object holding `"permissions_uuid": "<uuid>"`. Add `DEFAULT_USER_MAPPING: "<uuid>"` under `data` of the `workspace-backend` ConfigMap in `config.yaml`.
2. API, worker and the metering token:
   ```bash
   kubectl -n finos-workspace apply -f config.yaml -f backend.yaml
   for d in api worker; do kubectl -n finos-workspace rollout status deployment/$d --timeout=5m; done
   kubectl -n finos-workspace exec deploy/api -- python -m scripts.create_metering_token
   ```
   Confirm: the token, then `Expires <date> UTC`. Put the token into `agent.env` as `AGENT_METERING_TOKEN`. A rollout that hangs while `kubectl -n finos-workspace get pvc storage` shows `Pending` needs a `ReadWriteMany` storage class.
3. Agent, web app and ingress:
   ```bash
   kubectl -n finos-workspace create secret generic workspace-agent --from-env-file=agent.env
   kubectl -n finos-workspace create secret tls workspace-tls --cert=tls.crt --key=tls.key
   kubectl -n finos-workspace apply -f agent.yaml -f web.yaml -f ingress.yaml
   for d in agent agent-mcp web; do kubectl -n finos-workspace rollout status deployment/$d --timeout=5m; done
   ```
   Confirm: `successfully rolled out` for each. On ingress-nginx, add the annotation `nginx.ingress.kubernetes.io/proxy-body-size: 64m` to `ingress.yaml`.

## Check the deployment

1. Set the first administrator password, with an `[[admins]]` email from `config.toml`, on Compose or on Kubernetes:
   ```bash
   docker compose run --rm init python -m scripts.init_users --new-password <admin-email>
   kubectl -n finos-workspace exec -it deploy/api -- python -m scripts.init_users --new-password <admin-email>
   ```
   Type the password twice. It needs 8 or more characters, an uppercase letter, a lowercase letter, a digit and a special character other than `_`, and no spaces. Confirm: `The password of <admin-email> is set. Every session of the account has ended.`
2. Probe each service:
   ```bash
   curl -fsS https://api.workspace.example.com/health
   curl -fsS https://workspace.example.com/healthz
   curl -fsS https://agent.workspace.example.com/ready
   curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://workspace.example.com' https://api.workspace.example.com/
   ```
   Confirm: `{"success":true}`, `{"status": "ok"}`, `{"status":"ready"}`, then `200`. `403` means the origin is missing from `BACKEND_CORS_ORIGINS`; a 503 from `/ready` means the agent cannot reach the API.
3. Sign in at `https://workspace.example.com` and ask the Agent a question. `No model is configured`: set `DEFAULT_MODEL`. 503 `The FINOS Workspace API is not available`, with `refused this agent's metering token` in the agent log: the token expired or `JWT_SECRET` changed; create a new token, update `agent.env` or the `workspace-agent` Secret, and restart the agent.

## Upgrade

1. Back up the database, on Compose or on Kubernetes:
   ```bash
   docker compose exec -T mysql sh -c 'exec mysqldump --single-transaction -u root -p"$MYSQL_ROOT_PASSWORD" workspace' > workspace.sql
   kubectl -n finos-workspace exec mysql-0 -- sh -c 'exec mysqldump --single-transaction -u root -p"$MYSQL_ROOT_PASSWORD" workspace' > workspace.sql
   ```
   Confirm: `tail -n 1 workspace.sql` prints `-- Dump completed on <date>`.
2. Set the new `<version>` in the four `*_IMAGE` values of `.env`, or in `init-job.yaml`, `backend.yaml`, `agent.yaml` and `web.yaml`. The init step migrates first, then the API and the worker roll out together; never run an older image against a database that a newer one migrated. Compose: `docker compose pull`, then `docker compose up -d`. Kubernetes:
   ```bash
   kubectl -n finos-workspace delete job workspace-init
   kubectl -n finos-workspace apply -f init-job.yaml
   kubectl -n finos-workspace wait --for=condition=complete job/workspace-init --timeout=5m
   kubectl -n finos-workspace apply -f backend.yaml
   kubectl -n finos-workspace rollout status deployment/api --timeout=5m
   kubectl -n finos-workspace apply -f agent.yaml -f web.yaml
   ```
3. Every API container also runs `python -m alembic upgrade head` before it serves. Check the revision on Compose or on Kubernetes:
   ```bash
   docker compose exec api python -m alembic current
   kubectl -n finos-workspace exec deploy/api -- python -m alembic current
   ```
   Confirm: a revision marked `(head)`, and `Database migrations completed successfully` in `docker compose logs api` or `kubectl -n finos-workspace logs deploy/api`. `Database migrations failed` stops the container; the lines above it name the cause.

## Topic docs

| Topic | Doc |
|---|---|
| Services, start order, secrets; migrations | `docs/tutorials/deploy/production-setup.mdx`, `docs/tutorials/deploy/run-database-migrations.mdx` |
| Compose files, backup, restore, password change | `docs/tutorials/deploy/deploy-with-docker-compose.md` |
| Kubernetes manifests, backup, password change | `docs/tutorials/deploy/deploy-on-kubernetes.mdx` |
| Addresses, HTTPS, CORS | `docs/tutorials/deploy/serve-over-https-and-cors.mdx` |
| Database engines and Valkey; uploaded files in a folder or bucket | `docs/tutorials/deploy/connect-the-database-and-cache.md`, `docs/tutorials/deploy/choose-file-storage.md` |
| Single sign-on; more organizations | `docs/tutorials/deploy/set-up-single-sign-on.md`, `docs/tutorials/deploy/provision-an-organization.mdx` |
| Several agent replicas, proxy timeouts; logs, metrics, traces | `docs/tutorials/deploy/run-the-agent-on-several-replicas.mdx`, `docs/tutorials/deploy/ship-logs-and-metrics.mdx`, `docs/tutorials/deploy/export-traces.mdx` |
| Widget plugins | `docs/tutorials/plugins/deploy-a-plugin.md` |
| Everyday administration from a shell (entities, users, data backends, plugins) | `.agents/skills/administer-via-cli/SKILL.md` |
