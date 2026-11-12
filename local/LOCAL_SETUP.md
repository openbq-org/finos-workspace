# Running the FINOS Workspace locally for development

Everything for working on the app on your own machine lives in this folder. One command starts the frontend, the backend API and its worker, MySQL and Valkey, and code edits show up without restarting anything.

To run the built images instead (web app and API, as a user would), use `docker-compose.yml` at the repository root; [Run the stack from source](https://workspace.finos.org/tutorials/build-from-source/run-the-stack-from-source) explains it. The two stacks use port 8000, so run one at a time.

## Before you start

- Docker Desktop, running, with at least 8 GB of memory for Docker (Settings, Resources).
- Ports 3306, 6379, 8000 and 1420 free.
- `make`, which comes with macOS (Xcode command line tools) and Linux. On Windows, use WSL.
- `python3`, only the first time and only its standard library: it writes the settings.

Nothing else: the backend and Node run inside the containers.

## Start

```sh
cd local
ADMIN_EMAIL=<your-email> make up
```

`ADMIN_EMAIL` names the first administrator. It is needed only while `backend-api/backend/envs/.env` does not exist; the first `make up` creates that file with random secrets, and `backend-api/backend/scripts/cfgs/config.toml` with the organization and the administrator's address. Both files are yours: neither is for git. Later runs only need `make up`.

The first run builds the backend images and installs the frontend packages, so it takes several minutes. Later runs reuse the images and start much faster. `make up` waits until the app answers and then prints where to go:

- App: <http://localhost:1420>
- Backend: <http://localhost:8000>
- Sign in as the administrator in `backend-api/backend/scripts/cfgs/config.toml`, with the password that you set in the next step.

## Set the administrator's password

The `init` step creates the administrator without a password, so set it once, before the first sign-in. Run this in this folder while the stack is running:

```sh
docker compose run --rm init python -m scripts.init_users --new-password <your-email>
```

It asks for the password twice and does not show it. The same command sets a new password and ends every session of the account. The password is in the database, so `make down`, `make up` and a restart of Docker keep it. `make reset` deletes the database, and then you run the command again.

## Commands

Run these in this folder, or from the repo root as `make -C local <command>`.

| Command | What it does |
|---|---|
| `make up` | Checks your machine, builds, starts everything and waits until the app answers |
| `make down` | Stops everything and keeps the data |
| `make logs` | Follows all logs; `make logs s=backend` follows one service |
| `make ps` | Shows what is running |
| `make restart s=<service>` | Restarts one service |
| `make shell s=<service>` | Opens a shell in a service (default: `backend`) |
| `make reset` | Deletes the local database and frontend packages, then starts again |
| `make doctor` | Checks Docker, Docker Compose and the ports without starting anything |

Without `make`, use Docker Compose directly from this folder: `docker compose up --build -d`, `docker compose down`, `docker compose logs -f` and so on, after `./dev.sh env` has written the settings once.

## What runs

| Service | Port | What it is |
|---|---|---|
| `frontend` | 1420 | Vite dev server for `frontend/` |
| `backend` | 8000 | FastAPI app from `backend-api/backend/` |
| `backend-worker` | | Background jobs (RQ), same code as the backend |
| `init` | | Runs once per start: database migrations, then the administrator and the organization |
| `mysql` | 3306 | Database, user `root`, password `root`, database `workspace` |
| `valkey` | 6379 | Cache and job queue |

## Making changes

- Frontend code: the browser reloads on save.
- Backend code: the API restarts itself on save.
- Worker code: the worker does not reload; run `make restart s=backend-worker`.
- Database migrations: `init` applies new ones on every `make up`.
- Python dependencies (`pyproject.toml`): `make up` rebuilds the backend images.
- Frontend dependencies (`package.json`): `make restart s=frontend` runs `npm install` again.

## Settings

The backend reads `backend-api/backend/envs/.env`, the same file the root `docker-compose.yml` uses. `scripts.create_local_env` writes it from `envs/.env.example` and changes these values:

| Setting | Value | Why |
|---|---|---|
| `MODE` | `production` | What `create_local_env` writes; both compose files set `local`, which wins (Widget plugins, Your own data backend, Your own MCP server) |
| `SELFURL` | `http://localhost:8000` | Links the backend builds point at the API |
| `DB_HOST`, `REDIS_HOST` | `mysql`, `valkey` | The container names |
| `DB_NAME` | `workspace` | The database the MySQL container creates |
| `STORAGE_PROVIDER` | `folder` | Uploaded files go to `backend-api/backend/local_storage/` instead of cloud storage |
| `JWT_SECRET`, `WORKSPACE_AES_KEY`, `WORKSPACE_AUTH_TOKEN`, `LOCAL_STORAGE_SECRET_KEY` | generated | `WORKSPACE_AUTH_TOKEN` is a JWT signed with `JWT_SECRET`; the example leaves them blank, and the API refuses to start without strong values |
| `BACKEND_CORS_ORIGINS` | `http://localhost:3000`, `:1420` | The origins of the web app: the root `docker-compose.yml`'s and this stack's dev server |

`compose.yaml` sets `MODE` to `local`, and overrides `FRONTENDURL` and `APPURL` with `http://localhost:1420`, the address of the dev server, so links and redirects point at it. The dev server on another port reaches the API because `http://localhost:1420` is one of `BACKEND_CORS_ORIGINS`.

Edit `envs/.env` freely, then `make restart s=backend`. To get a fresh one, delete it, and `config.toml` next to it, and run `ADMIN_EMAIL=<your-email> make up`; if the database already holds the old administrator, run `make reset` instead.

The frontend uses `frontend/.env`, except that `compose.yaml` points the backend and AI URLs at `localhost`, and turns the
MCP Companion entry in the menu and the scripts of HTML widgets on (`VITE_UI_SHOW_COMPANION_MCP_MODE` and
`VITE_ALLOW_HTML_JS_EXECUTION`), which deployments leave off.

A new backend setting needs adding in more places than this folder: `envs/.env.example` for local runs, and the values of every environment you deploy to.

## Widget plugins

Widget plugins are packages built outside this repository (see the documentation site, How to build and try a widget plugin). Nothing installs from the app: on your own stack you are the deployer and the administrator. This stack runs with `MODE=local`, so you can also develop a new version of an approved plugin in place, which no deployment allows.

1. Nothing to configure: `compose.yaml` mounts `widget-plugins/` at the repository root (git ignores it) into the backend as `/opt/widget-plugins` and sets `WIDGET_PLUGINS_DIR`. The mount is writable, so that the app can start a new version in it. To keep your packages elsewhere, set `WORKSPACE_PLUGINS_DIR=<folder>` in your shell or in a `.env` next to `compose.yaml`, and `make up`.
2. Build the plugin into `widget-plugins/<plugin-id>/<version>/`, with its `plugin.json`.
3. Check it with the server's own validator, from `backend-api/backend`: `python -m scripts.plugin_check <plugins directory>/<plugin-id>/<version>`. `--digest` prints the checksum for the manifest and the version digest.
4. Sign in as the administrator, open Admin, Widgets, Deployment: Rescan, review what the version asks for, approve it, and enable it for your organization. Under Plugin widgets, enable it, and under Roles and Access grant it to a role you hold: a role is the only way to a plugin. `python -m scripts.workspace_admin plugin ...`, run in the backend container, does the same from a terminal.
5. To change the plugin, open its Deployment page and choose Patch, Minor or Major. The app copies the active version to `<plugins directory>/<plugin-id>/<next version>/` and serves that copy from its files as they are: edit them or build into the directory, and a dashboard picks the change up when its window gets focus. When it is done, write its `checksum` (`plugin_check --digest`, or your build) and approve it, or commit the directory and open a pull request. An approved version is never edited: changing its files blocks it.
6. A plugin that calls a keyed service through a proxy needs its secret: set it on the plugin's page under Deployment (the value is never shown again), or put it in a file `<secrets directory>/<plugin-id>/<secret-name>`, add `- <secrets directory>:/run/secrets/widget-plugins:ro` to the `volumes` of `x-backend` in `compose.yaml`, and set `WIDGET_PLUGIN_SECRETS_DIR=/run/secrets/widget-plugins`. The API refuses to call an address that is not public, which includes your own machine: to let a plugin reach a service there, override its server network on the same page and confirm private hosts. A service whose certificate your own authority signs needs that authority's file mounted and named by `WIDGET_PLUGIN_PROXY_CA_FILE`.

### Your own data backend

Add it under Connections with the address you use in your browser, for example `http://localhost:9000`. This stack runs with `MODE=local`, so the API accepts a private or plain `http` address for any user's connection, and for `localhost`, `127.0.0.1` and `[::1]` it calls your machine through `host.docker.internal`, which `compose.yaml` maps for the backend. You need no CORS settings, and the keys you type stay in this stack's database, encrypted, and are added by the API. On Linux the backend must listen on `0.0.0.0`, not only on `127.0.0.1`.

A deployment's data backend works the same way as long as it has a public `https` address: add it with your own key, read-only where the backend has such keys. The key is stored in this stack's database, so nothing is written to the deployment's FINOS Workspace. A deployment's agent and plugin backends accept only that deployment's sessions and call tokens; run them on your machine instead (the root `docker-compose.yml` runs the agent, `docs/examples/backend/compose.yaml` a plugin backend). The reverse does not work: a deployed Workspace cannot call a backend on your machine, so develop against a local backend on this stack.

### Your own MCP server

Add it under AI, MCP Servers, Add Server with the address you use in your browser, for example `http://localhost:8787/mcp`. The API makes every call to it, sign-in included, and for `localhost`, `127.0.0.1` and `[::1]` it calls your machine through `host.docker.internal`, like a data backend. You need no CORS settings, and the headers you type stay in this stack's database, encrypted, and are added by the API. On Linux the server must listen on `0.0.0.0`, not only on `127.0.0.1`. A deployed Workspace cannot reach an MCP server on your machine either.

## What does not work locally

- AI features. They need an AI service, which this setup does not run; `AI_API_URL` stays empty and `AI_COPILOT_ENABLED` stays `false`. The root `docker-compose.yml` runs the FINOS Workspace's agent.
- Google sign-in, unless `http://localhost:1420` is an allowed origin of the Google OAuth client. Use the email sign-in.

## Differences from a deployed environment

- Plain `http://localhost` with one port per service, instead of HTTPS hostnames behind a load balancer.
- The frontend runs the Vite dev server instead of the nginx image, which writes its settings into `config.js` at start.
- One copy of each service.
- MySQL with the password `root` and Valkey without a password, both without TLS.
- The backend images are built for `linux/amd64`, like the ones deployed; on Apple silicon set `PLATFORM=linux/arm64` (for example `PLATFORM=linux/arm64 make up`) to build for the host.

## Troubleshooting

- `make doctor` says a port is in use: stop whatever holds it (the message prints the `lsof` command that shows it), or stop another stack. The root `docker-compose.yml` stack also uses port 8000: `docker compose down` there.
- `make up` stops with "the init step failed": `make logs s=init` shows why.
- The app loads but login fails: `make logs s=backend` shows the request and the error.
- Start from scratch: `make reset`. This deletes the local database.
