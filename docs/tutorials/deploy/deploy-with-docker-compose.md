---
title: Deploy with Docker Compose
sidebar_position: 1
---

# Deploy with Docker Compose

Docker Compose runs FINOS Workspace on a single server. That suits a pilot, a test environment or a small team. Everything runs on that one machine, so when it goes down, Workspace goes down with it. If Workspace has to keep running when a machine fails, use [Kubernetes](deploy-on-kubernetes.mdx) instead.

This guide follows [Production setup](production-setup.mdx), so read that page first.

## What you need

- A Linux server with Docker Engine and the Docker Compose plugin.
- Three DNS names on the same domain that point at the server. This guide uses `workspace.example.com` for the web app, `api.workspace.example.com` for the API and `agent.workspace.example.com` for the agent.
- A reverse proxy on the server that handles TLS for those three names.
- The four images. The server pulls them from Docker Hub as `finos/workspace-backend`, `finos/workspace-web`, `finos/workspace-agent` and `finos/workspace-agent-mcp`. To use images of your own, [build and push them](../build-from-source/build-the-images.md) to a registry that the server can pull from. The released images are built for `linux/amd64`, so use an x86-64 server: an arm64 server runs them through emulation.
- The secrets from [Production setup](production-setup.mdx#the-secrets-you-need-to-create), and an API key for the agent's model.

## Write the files

Make a folder on the server for six files:

```text
workspace/
  compose.yaml       the services
  .env               the images, the addresses and the database passwords
  backend.env        the secrets of the API and the worker
  agent.env          the model and the secrets of the agent and its MCP server
  config.toml        the first organization and its administrator
  user_create.json   an empty file that the init step fills in
```

### .env

`.env` holds the image names, the three addresses and the MySQL passwords. `compose.yaml` hands them to every service that needs them, so you set each one in one place:

```bash
BACKEND_IMAGE=finos/workspace-backend:<version>
WEB_IMAGE=finos/workspace-web:<version>
AGENT_IMAGE=finos/workspace-agent:<version>
AGENT_MCP_IMAGE=finos/workspace-agent-mcp:<version>

WEB_URL=https://workspace.example.com
API_URL=https://api.workspace.example.com
AGENT_URL=https://agent.workspace.example.com

MYSQL_ROOT_PASSWORD=<a random password>
MYSQL_PASSWORD=<another random password>
```

Set `<version>` to the tag of a [release](https://github.com/finos-labs/finos-workspace/releases), including its leading `v`. The four images of a release share that tag. Pin it: the tag `latest` moves to every new release, pre-releases included, so `docker compose pull` could upgrade you without your choosing to. If you build your own images, put your registry in front of the names, as in `<registry>/workspace-backend:<version>`.

MySQL reads the two passwords once, on its very first start, when it creates the database. Changing them in `.env` after that does not change them in MySQL, and the init step then fails with `Access denied`. [Change a database password](#change-a-database-password) shows how to change one.

### backend.env

`backend.env` holds the secrets of the API and the worker:

```bash
MODE=production
JWT_SECRET=<JWT_SECRET>
WORKSPACE_AES_KEY=<WORKSPACE_AES_KEY>
LOCAL_STORAGE_SECRET_KEY=<LOCAL_STORAGE_SECRET_KEY>
REDIS_PASS=
```

Valkey runs on the private network of Compose without a password, so `REDIS_PASS` is empty. Keep the line anyway: the API does not start when the variable is missing.

### agent.env

`agent.env` holds the model and the secrets of the agent, and the agent's MCP server reads it too. This example uses OpenAI:

```bash
DEFAULT_MODEL=openai:<model>
OPENAI_API_KEY=<your OpenAI API key>
AGENT_SCOPE_SECRET=<AGENT_SCOPE_SECRET>
AGENT_METERING_TOKEN=
```

For another provider, set its own key instead of `OPENAI_API_KEY`, or for Ollama `OLLAMA_BASE_URL`. [Pick the providers](../../features/agent/choose-the-agent-model.mdx#pick-the-providers) lists them. Leave `AGENT_METERING_TOKEN` empty for now. You create it in [Start it](#start-it).

### config.toml

`config.toml` names the first organization and its administrators:

```toml
[entity]
name = "Example Bank"

[[admins]]
email = "admin@example.com"
first_name = "Ada"
last_name = "Admin"
```

The init step creates them on the first start. On later starts it finds the organization by its name and the administrators by their emails, and changes nothing. If you change the name here, the init step creates a second organization and leaves the first one as it is.

### Create the empty file and protect the secrets

```bash
touch user_create.json
chmod 600 .env backend.env agent.env
```

## The Compose file

Save this as `compose.yaml`:

```yaml
name: finos-workspace

x-backend: &backend
  image: ${BACKEND_IMAGE:?Set BACKEND_IMAGE in .env}
  restart: unless-stopped
  env_file: ./backend.env
  environment:
    DATABASE_TYPE: mysql
    DB_HOST: mysql
    DB_PORT: "3306"
    DB_NAME: workspace
    WRITE_DB_USER: workspace
    WRITE_DB_PASSWORD: ${MYSQL_PASSWORD:?Set MYSQL_PASSWORD in .env}
    READ_DB_USER: workspace
    READ_DB_PASSWORD: ${MYSQL_PASSWORD:?Set MYSQL_PASSWORD in .env}
    REDIS_HOST: valkey
    APPURL: ${WEB_URL:?Set WEB_URL in .env}
    FRONTENDURL: ${WEB_URL:?Set WEB_URL in .env}
    SELFURL: ${API_URL:?Set API_URL in .env}
    BACKEND_CORS_ORIGINS: ${WEB_URL:?Set WEB_URL in .env}
    FOLDER_STORAGE_PATH: /opt/code/local_storage
    DEFAULT_MCP_SERVERS: '[{"id": "agent-tools", "name": "Agent Tools", "url": "http://agent-mcp:8787/mcp"}]'
  networks:
    - workspace

services:
  mysql:
    image: mysql:8.0
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:?Set MYSQL_ROOT_PASSWORD in .env}
      MYSQL_DATABASE: workspace
      MYSQL_USER: workspace
      MYSQL_PASSWORD: ${MYSQL_PASSWORD:?Set MYSQL_PASSWORD in .env}
    command: ["mysqld", "--character-set-server=utf8mb4", "--collation-server=utf8mb4_unicode_ci"]
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -u root -p$$MYSQL_ROOT_PASSWORD --silent"]
      interval: 5s
      timeout: 5s
      retries: 30
      start_period: 15s
    volumes:
      - db:/var/lib/mysql
    networks:
      - workspace

  valkey:
    image: valkey/valkey:9.1.2-alpine
    restart: unless-stopped
    command: valkey-server --save 20 1 --loglevel warning
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20
    volumes:
      - valkey:/data
    networks:
      - workspace

  init:
    <<: *backend
    restart: "no"
    user: root
    command:
      - python
      - -c
      - |
        import pathlib, subprocess, sys
        pathlib.Path("user_create.json").write_text("{}")
        subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True)
        subprocess.run([sys.executable, "-m", "scripts.init_users"], check=True)
    volumes:
      - type: bind
        source: ./user_create.json
        target: /opt/code/user_create.json
        bind:
          create_host_path: false
      - type: bind
        source: ./config.toml
        target: /opt/code/scripts/cfgs/config.toml
        read_only: true
        bind:
          create_host_path: false
    depends_on:
      mysql:
        condition: service_healthy
      valkey:
        condition: service_healthy

  api:
    <<: *backend
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    ports:
      - "127.0.0.1:8000:8000"
    volumes:
      - type: bind
        source: ./user_create.json
        target: /opt/code/user_create.json
        read_only: true
        bind:
          create_host_path: false
      - storage:/opt/code/local_storage
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=4)"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s
    depends_on:
      init:
        condition: service_completed_successfully

  worker:
    <<: *backend
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    command: ["python", "base_workers.py"]
    volumes:
      - type: bind
        source: ./user_create.json
        target: /opt/code/user_create.json
        read_only: true
        bind:
          create_host_path: false
      - storage:/opt/code/local_storage
    depends_on:
      init:
        condition: service_completed_successfully

  web:
    image: ${WEB_IMAGE:?Set WEB_IMAGE in .env}
    restart: unless-stopped
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    environment:
      BACKEND_URL: ${API_URL:?Set API_URL in .env}
      AI_API_URL: ${AGENT_URL:?Set AGENT_URL in .env}
      AI_COPILOT_ENABLED: "true"
    ports:
      - "127.0.0.1:3000:8080"
    depends_on:
      - api
      - agent
    networks:
      - workspace

  agent:
    image: ${AGENT_IMAGE:?Set AGENT_IMAGE in .env}
    restart: unless-stopped
    stop_grace_period: 30s
    init: true
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: 4g
    pids_limit: 1024
    env_file: ./agent.env
    environment:
      WORKSPACE_API_URL: http://api:8000
      WORKSPACE_ORIGIN: ${WEB_URL:?Set WEB_URL in .env}
      WORKSPACE_PUBLIC_URL: ${API_URL:?Set API_URL in .env}
      REDIS_URL: redis://valkey:6379
      AGENT_CORS_ORIGINS: ${WEB_URL:?Set WEB_URL in .env}
    ports:
      - "127.0.0.1:7777:7777"
    depends_on:
      api:
        condition: service_healthy
      valkey:
        condition: service_healthy
    networks:
      - workspace

  agent-mcp:
    image: ${AGENT_MCP_IMAGE:?Set AGENT_MCP_IMAGE in .env}
    restart: unless-stopped
    init: true
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: 4g
    pids_limit: 1024
    env_file: ./agent.env
    environment:
      WORKSPACE_API_URL: http://api:8000
      WORKSPACE_ORIGIN: ${WEB_URL:?Set WEB_URL in .env}
      WORKSPACE_PUBLIC_URL: ${API_URL:?Set API_URL in .env}
      REDIS_URL: redis://valkey:6379
    depends_on:
      valkey:
        condition: service_healthy
    networks:
      - workspace

networks:
  workspace:

volumes:
  db:
  valkey:
  storage:
```

A few things about this file:

- The project is called `finos-workspace`. That keeps its containers and volumes apart from the repository's local stack, which is called `workspace`, if both ever run on one machine.
- The web app, the API and the agent listen on `127.0.0.1` for your reverse proxy. The other services cannot be reached from outside the server.
- The addresses and the database passwords come from `.env`, so the services always agree on them.
- `user_create.json` and `config.toml` are mounted with `create_host_path: false`. When one of them is missing, `docker compose up` stops with `bind source path does not exist` and names the file, instead of putting an empty folder in its place.
- The init step runs as `root` because it writes `user_create.json` on the server. The API and the worker read that file to know which role to give new people. The backend image has no shell, so the init step starts a short Python program that runs its three actions, instead of a shell command.
- Every container except the init step drops all Linux capabilities and turns off privilege escalation.
- The agent gets 30 seconds to stop (`stop_grace_period`). When it is told to stop, it waits up to 25 seconds for the answers in progress to finish, as `AGENT_SHUTDOWN_GRACE_SECONDS` sets, while Compose stops a container after 10 seconds unless told otherwise. Without this line, an upgrade would cut off an answer in progress.
- The agent and its MCP server run with the [limits for the containers](production-setup.mdx#lock-down-the-containers) from Production setup.

## Start it

1. Create the metering token of the agent. This command runs the backend image with its settings and starts nothing else:

   ```bash
   docker compose run --rm --no-deps init python -m scripts.create_metering_token
   ```

   It prints the token, then the date on which it expires, a year from now. Copy the token into `agent.env` as `AGENT_METERING_TOKEN`.

2. Start everything:

   ```bash
   docker compose up -d
   docker compose ps
   ```

   On the first start, the init step creates the database tables, the organization and its administrator, and then exits. Next the API and the worker start, and then the agent and the web app. Workspace is ready when `docker compose ps` shows the API and the agent as `healthy`.

3. Give the administrator a password:

   ```bash
   docker compose run --rm init python -m scripts.init_users --new-password admin@example.com
   ```

   It asks for the password twice and does not show what you type. The password needs at least 8 characters, with an uppercase letter, a lowercase letter, a number and a special character, and no spaces. The underscore does not count as a special character.

Running `docker compose up -d` again later is safe. The init step runs again, finds everything in place and changes nothing.

Every service except the init step has `restart: unless-stopped`, so the stack comes back by itself after the server reboots, as long as Docker starts with the server.

### When the init step fails

`docker compose up -d` then stops with `service "init" didn't complete successfully: exit 1`, and the API does not start. The log of the init step says why:

```bash
docker compose logs init
```

The log ends with a long Python traceback, and the reason is a few lines above its end:

- `ValidationError: 1 validation error for Settings`, followed by the name of a setting and what is wrong with it, such as `JWT_SECRET must be at least 32 bytes`, or `Field required` for a setting that is missing.
- `Access denied for user 'workspace'` when the password in `.env` is not the one that MySQL has. [Change a database password](#change-a-database-password) explains why that happens.

Fix what it names in the files, then run `docker compose up -d` again.

### When the agent keeps restarting

`docker compose up -d` does not wait for the agent to become healthy, so it finishes without an error, but `docker compose ps` never shows the agent as `healthy`. The agent's log says why:

```bash
docker compose logs agent
```

A line with `AGENT_METERING_TOKEN is required` means that `agent.env` has no metering token. Create one as the first step of [Start it](#start-it) shows, put it into `agent.env` and run `docker compose up -d` again.

### When every question fails

If every question to the agent fails with status 503 and the message "The FINOS Workspace API is not available", while `docker compose ps` shows the agent as healthy, the API has refused the agent's metering token. The agent's log names the reason:

```bash
docker compose logs agent
```

Look for the line "The FINOS Workspace API refused this agent's metering token". After it comes the reason: "The metering token has expired", or "Invalid metering token", which is what a token shows after `JWT_SECRET` has changed. Create a new token as the first step of [Start it](#start-it) shows, put it into `agent.env` and run `docker compose up -d` again.

## Put TLS in front

Point your reverse proxy at the three ports on `127.0.0.1`:

| Address | Upstream |
|---|---|
| `https://workspace.example.com` | `http://127.0.0.1:3000` |
| `https://api.workspace.example.com` | `http://127.0.0.1:8000` |
| `https://agent.workspace.example.com` | `http://127.0.0.1:7777` |

Make the proxy pass on the address of each client in `X-Forwarded-For` and the scheme of the request in `X-Forwarded-Proto`. The API counts its rate limits per client address and reads that address from `X-Forwarded-For`. Without the header, every user shares the address of the proxy, and its limits.

The agent streams its answers, so the proxy must keep an idle connection to the agent open while a model call runs. [What the load balancer and the platform allow](run-the-agent-on-several-replicas.mdx#what-the-load-balancer-and-the-platform-allow) gives the timeout. Check the size limit of the proxy too: the agent accepts a request of up to 64 MB by default, as `AGENT_MAX_BODY_MB` sets, and nginx refuses anything over 1 MiB unless you raise `client_max_body_size` for the agent's name. Then go through the checks in [Production setup](production-setup.mdx#check-that-it-works).

## Upgrade

1. Back up the database:

   ```bash
   docker compose exec -T mysql sh -c 'exec mysqldump --single-transaction -u root -p"$MYSQL_ROOT_PASSWORD" workspace' > workspace.sql
   ```

   MySQL warns that a password on the command line can be insecure. The password stays inside the container, and the warning does not end up in the file.

2. Change the version in the four image names in `.env`.
3. Pull the new images and start them:

   ```bash
   docker compose pull
   docker compose up -d
   ```

   The init step runs first and updates the database tables, as [Run database migrations](run-database-migrations.mdx#upgrade-a-deployment) asks. Then Compose replaces the API and the worker, and the other services that have a new image.

## Back up

Back up these on a schedule:

- The database, with the command from the first step of [Upgrade](#upgrade).
- The uploaded files, in the volume `storage`. This command packs them into `storage.tar.gz` in the current folder:

  ```bash
  docker run --rm -v finos-workspace_storage:/data:ro -v "$PWD":/backup alpine:3.24.2 tar -czf /backup/storage.tar.gz -C /data .
  ```

- Every file in your folder except `user_create.json`, kept away from the server: `compose.yaml`, `.env` with the image versions, `backend.env`, `agent.env` and `config.toml`. The init step writes `user_create.json` again on every start. Without the `WORKSPACE_AES_KEY` in `backend.env`, the secrets stored in the database cannot be read.

## Restore

To bring back a backup, on a new server or after removing the volumes with `docker compose down -v`, use the same files as before. Create the containers and volumes without starting them, unpack the files, load the database into MySQL, then start the rest:

```bash
docker compose create
docker run --rm -v finos-workspace_storage:/data -v "$PWD":/backup alpine:3.24.2 tar -xzf /backup/storage.tar.gz -C /data
docker compose up -d --wait mysql
docker compose exec -T mysql sh -c 'exec mysql -u root -p"$MYSQL_ROOT_PASSWORD" workspace' < workspace.sql
docker compose up -d
```

The administrators sign in with the passwords they had when the backup was taken.

## Change a database password

Change the password inside MySQL first, then in `.env`. For the password of the user `workspace`:

```bash
docker compose exec mysql mysql -u root -p
```

Enter the root password, and at the `mysql>` prompt run:

```sql
ALTER USER 'workspace'@'%' IDENTIFIED BY '<the new password>';
```

Then put the same password into `.env` as `MYSQL_PASSWORD` and run `docker compose up -d`.
