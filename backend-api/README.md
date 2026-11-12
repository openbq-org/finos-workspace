# Backend

The backend and admin tooling of FINOS Workspace.

## Repository structure

| Directory | Description |
|---|---|
| `backend/` | FastAPI application: API server, database models, migrations, background workers |

## Getting started

To run the whole stack, follow [Run the stack from source](https://workspace.finos.org/tutorials/build-from-source/run-the-stack-from-source). See [DEVELOPMENT_SETUP.md](DEVELOPMENT_SETUP.md) for local development of the backend itself.

## Infrastructure

- `docker-compose.yml`: full-stack deployment (API, workers, database, Valkey)
- `docker-compose-local-dev.yml`: infrastructure only (MySQL, Valkey, worker) for local backend development
- `docker-compose-local-dev-postgres.yml`, `docker-compose-local-dev-sqlite.yml`: the same on PostgreSQL and on SQLite

## Admin CLI

`backend/scripts/workspace_admin.py` manages entities, users, data backends and widget plugins. It runs
inside the API container and works on the database itself: it sends no request to the API,
so it needs no sign-in.

```bash
docker compose exec api python -m scripts.workspace_admin --help    # the root docker-compose.yml
```

| Command | Does |
|---|---|
| `entity create --config <file>`, `entity list`, `entity show <uuid>`, `entity update <uuid> --data '<json>'`, `entity delete <uuid>` | Entities; `entity sample` prints a config |
| `user create <entity-uuid> --email <email> --first-name <name> --last-name <name> [--role admin\|developer\|user]` | Prints the link with which the user sets their password (once, within 24 hours) |
| `user reset-password <email>` | The password stops working, every session ends; prints the link that sets a new one |
| `user list [--email <part>]`, `user move --entity-uuid <uuid> --email <email> [--role ...]`, `user delete <email>` | `delete` removes the user from their entity |
| `data-backend add <entity-uuid> --name <name> --url <url> [--header key:value[:location]]`, `data-backend list <entity-uuid>`, `data-backend delete <entity-uuid> --name <name>` | Data backends of an entity |
| `provision check --config <file>`, `provision apply --config <file>` | An entity with its admins and users in one go; `provision sample` prints a config |
| `plugin list`, `plugin rescan`, `plugin show <id>`, `plugin approve <id> <version> [--digest <d>] --acknowledge` | Widget plugins: discovery, the review (without `--acknowledge` it prints the review and approves nothing) and approval |
| `plugin enable\|disable <id> (--entity <uuid> \| --all)`, `plugin grant\|ungrant <id> --role <uuid> [--widget <id>]` | Enable a plugin for organizations; a role that grants it is the only way to it |
| `plugin revoke\|restore <id>`, `plugin override <id> ...`, `plugin secret set\|clear <id> <name>`, `plugin check-backend <id>`, `plugin events <id>`, `plugin reports <id>`, `plugin forget <id>` | The kill switch, the policy overrides, secrets (read without echo or from standard input), the backend's identity, the activity and blocked requests, and a plugin whose files are gone ([Plugin lifecycle and administration](https://workspace.finos.org/reference/plugins/lifecycle) on the documentation site) |

`--json` prints the outcome as JSON. A refused action prints why and exits with 1.
