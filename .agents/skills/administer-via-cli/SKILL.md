---
name: administer-via-cli
description: 'Runs the FINOS Workspace administration CLI, `python -m scripts.workspace_admin`, from inside the API container to create and update organizations (entities), create, list, move and reset passwords for users, add and remove data backends on an entity, bulk-provision from a JSON config, and manage widget plugins (rescan, approve, enable/disable, grant/ungrant, override the CSP and server network, set and clear secrets, check the backend, list events and blocked requests, revoke, restore and forget). Covers every noun and subcommand, the invocation shape for the `local/`, root and Kubernetes stacks, the `--json` mode, where secrets come from (stdin, never argv), the one-time password-set links that `user create` and `user reset-password` print, and the idempotency rules. Use for requests such as "create an organization", "create a user", "list users", "reset the password of X", "move a user to another entity", "add a data backend", "bulk provision an org from JSON", "approve plugin X version Y", "rescan plugins", "enable plugin for all", "grant plugin to role", "set a plugin secret", "check a plugin backend", "revoke a plugin", "forget a removed plugin".'
---

# Administer FINOS Workspace through the admin CLI

`scripts.workspace_admin` is the one command-line tool for everything an administrator does from a shell. It runs inside an API container, reads the live database through the same code the HTTP routes use, and exits non-zero on any error. Every subcommand accepts `--json` for machine-readable output (except the two `sample` commands, which only print a template). Reach for the CLI, not direct SQL, for anything an administrator can do in the web app.

Never run this against a production database without the operator's explicit sign-off; the operations are the same ones the web app guards behind the superuser role.

## Invocation

| Stack | Shell call |
|---|---|
| `local/` (project `workspace-local`) | `docker compose exec backend python -m scripts.workspace_admin <noun> <verb> [args]` (run from `local/`) |
| Root `docker-compose.yml` (project `workspace`) | `docker compose exec api python -m scripts.workspace_admin <noun> <verb> [args]` (run from the repository root) |
| Kubernetes | `kubectl -n finos-workspace exec deploy/api -- python -m scripts.workspace_admin <noun> <verb> [args]`, or `exec -it` when a step reads stdin |

- Nouns: `entity`, `user`, `data-backend`, `provision`, `plugin`. `python -m scripts.workspace_admin -h` lists them; `<noun> -h` lists its verbs; `<noun> <verb> -h` prints its arguments.
- Every subcommand that writes a result prints `✓ ...` to stdout; errors print `✗ Error: ...` to stderr and exit 1. With `--json`, stdout is JSON and `✓`/`✗` do not appear.
- Secrets never come from an argument. `plugin secret set` reads the value interactively with `getpass`, or from stdin when there is no TTY. Pipe or redirect the value in automation; never `--value`.

## Entity (organization)

| Verb | Arguments | Does |
|---|---|---|
| `create` | `--config FILE` | Creates the entity from a JSON config and prints its UUID. The JSON has `entity.name`, `entity.admin_email`, optional `entity.sharing_enabled`. |
| `list` | `[--page N] [--size N]` (default 1/100) | One row per entity: `UUID | name | Sharing: on/off`. |
| `sample` | — | Prints the shape of the create config. |
| `show` | `ENTITY_UUID` | Record view: `Entity`, `UUID`, `Sharing enabled`. |
| `update` | `ENTITY_UUID (--config FILE | --data JSON)` | Replaces only the fields named; `--data '{"sharing_enabled": true}'` is the shortest form. |
| `delete` | `ENTITY_UUID` | Refuses when any user still belongs to the entity; remove them first with `user delete` or `user move`. |

A config for `create`:

```json
{
  "entity": {
    "name": "Acme",
    "admin_email": "admin@acme.example",
    "sharing_enabled": true
  }
}
```

## User

| Verb | Arguments | Does |
|---|---|---|
| `create` | `ENTITY_UUID --email --first-name --last-name [--role admin|developer|user]` (default `user`) | Creates the user in the entity and prints a **one-time, expiring link** the user opens to set their password. Default role is `user`. |
| `list` | `[--email FILTER] [--page N] [--size N]` | One row per user: `UUID | email | role | entity`. `--email` substring-filters. |
| `delete` | `EMAIL` | Removes the user from their entity (soft-delete). |
| `reset-password` | `EMAIL` | Prints a new one-time link and signs the user out of every session. |
| `move` | `--entity-uuid UUID --email ADDR [--role R]` | Moves the user to another entity, keeping their account, with the role you give. |

The one-time link looks like `… Give <email> this link to set their password. It works once, until <ISO-timestamp>:` followed by the URL. Copy it only to the person; the link bypasses password-reset email.

## Data backend

A data backend is an HTTP source the entity's users can connect to. The CLI manages the entity-level catalog, not the live connections users open.

| Verb | Arguments | Does |
|---|---|---|
| `add` | `ENTITY_UUID --name --url [--header key:value[:location] ...]` | Adds the backend. Repeat `--header` for each endpoint header; `location` is optional (query, header, etc.; see the UI's description). |
| `delete` | `ENTITY_UUID --name NAME` | Removes it by name. |
| `list` | `ENTITY_UUID` | Rows: `UUID | name | URL`. |

## Provision (bulk)

For spinning up a whole organization: the entity, its administrators, its initial users.

| Verb | Arguments | Does |
|---|---|---|
| `check` | `--config FILE` | Validates the JSON (presence of `entity.name`, `entity.admin_email`, and `email`/`first_name`/`last_name` on every admin and user). Exits 1 on any error. |
| `sample` | — | Prints the full config shape. |
| `apply` | `--config FILE` | Runs `check`, creates the entity, then creates each admin (role `admin`) and each user (role `user`) in order. A failed user rolls back, lands in `failed`, and the next user continues. Prints a one-time link per created user. |

Config shape:

```json
{
  "entity": {"name": "Acme", "admin_email": "admin@acme.example", "sharing_enabled": true},
  "admins": [{"email": "a@acme.example", "first_name": "A", "last_name": "Admin"}],
  "users":  [{"email": "u@acme.example", "first_name": "U", "last_name": "User"}]
}
```

Always `check` before `apply` on a config a human hand-wrote.

## Plugin

A widget plugin is placed on the server by the operator (the files land in `WIDGET_PLUGINS_DIR`, mounted from `widget-plugins/` on the dev stacks). The CLI does not install packages; it reads the directory, approves, enables, grants, and controls the plugin's lifecycle. See `.agents/skills/develop-plugins/SKILL.md` for the author-side workflow.

| Verb | Arguments | Does |
|---|---|---|
| `list` | — | One row per plugin: `plugin_id | status | active <version> | update <version> | <n> organizations | versions and states`. Prints "Widget plugins are off" when `WIDGET_PLUGINS_DIR` is unset. |
| `rescan` | — | Reads the plugins directory again. Prints `✓ added`, `✓ changed`, `✓ removed` per kind, or `✓ Rescanned: no changes`. |
| `show` | `PLUGIN_ID` | Full view: every version (state, digest short, pin status, errors, review items for approval), effective CSP, server network, proxies and backend state, secrets, enabled organizations, recent events. |
| `approve` | `PLUGIN_ID VERSION [--digest D] [--acknowledge]` | Without `--acknowledge`, prints the review and refuses. With `--acknowledge`, accepts every `added` request and makes the version active. `--digest` must equal what `plugin_check --digest` printed; approval refuses otherwise. |
| `revoke` | `PLUGIN_ID` | Kill switch: stops the plugin everywhere. |
| `restore` | `PLUGIN_ID` | Undoes `revoke`. |
| `enable` | `PLUGIN_ID (--entity UUID | --all)` | Enables for one organization, or every organization. |
| `disable` | `PLUGIN_ID (--entity UUID | --all)` | The inverse. |
| `grant` | `PLUGIN_ID --role UUID [--widget ID]` | A grant is how a role reaches a plugin. `--widget` names one widget; omit it for every widget (`*`). |
| `ungrant` | `PLUGIN_ID --role UUID [--widget ID]` | Removes one grant. |
| `override` | `PLUGIN_ID [--csp-file F] [--server-network ORIGIN ...] [--confirm insecure-scheme|private-host|remote-script] [--clear]` | Replaces the superuser overrides for the plugin's CSP and server network. Pass `--clear` alone, or at least one of `--csp-file` / `--server-network`. Each `--confirm` accepts a dangerous source the overrides add (an http:// scheme, a private-address host, a remote script in the CSP). `private-host` on `--server-network` also lets the host resolve to a private address. |
| `secret set` | `PLUGIN_ID NAME` | Sets the named secret. Interactive: `Value of <name>:` without echo. Non-TTY: reads stdin, strips one trailing newline. Rejects empty. |
| `secret clear` | `PLUGIN_ID NAME` | Removes a superuser-set value. A deployment-configured value stays. |
| `check-backend` | `PLUGIN_ID` | Asks the plugin's backend for its identity now. Prints `<plugin_id> backend: identity ok (the approved version)` or the failure. |
| `events` | `PLUGIN_ID` | Lifecycle events: approvals, revokes, grants, enables, overrides. One line per event. |
| `reports` | `PLUGIN_ID` | Policy-blocked requests the plugin tried. Rows: `<directive> <origin> | <n>x | <version> | entity <uuid> | last <timestamp>`. |
| `forget` | `PLUGIN_ID` | Removes the plugin from the database, with every decision, grant and secret. Use when the files are gone and `list` shows `missing`. |

Approval flow, every time:

1. `plugin list` — confirm the version is `discovered`.
2. `plugin show <plugin-id>` — read the review items and the policy delta.
3. `python -m scripts.plugin_check --digest <mounted-path>` — read the digest.
4. `plugin approve <plugin-id> <version> --digest <digest>` — prints the review again, refuses, prompts to add `--acknowledge`.
5. `plugin approve <plugin-id> <version> --digest <digest> --acknowledge` — approves and activates.
6. `plugin enable <plugin-id> --all` (or `--entity <uuid>`).
7. `plugin grant <plugin-id> --role <uuid>` for every role that should reach it.
8. For every secret the manifest declares: `plugin secret set <plugin-id> <name>`; read the value from a source the shell does not log, e.g. `pass show <path>` piped in, or `read -s` into a variable, then `printf '%s' "$value" | docker compose exec -T backend python -m scripts.workspace_admin plugin secret set <plugin-id> <name>`.

## JSON mode

Pass `--json` to any verb that writes a result:

- `entity list --json` returns the pagination envelope (`items`, `total`, `page`, `size`, `pages`).
- `plugin show --json` returns the full plugin record (versions, review, policy, entities, events).
- `provision apply --json` returns `{"entity": {...}, "admins": [...], "users": [...], "failed": [...]}` with the link for each created user.
- Verbs that only act (delete, enable, grant, set-secret, …) return `{"success": true}`.

Use JSON when a script parses the result. The human mode is lossy on purpose: short digests, truncated event lists, no stack traces.

## Stdin for a secret

Non-TTY stdin is the only way to automate `plugin secret set`. From the host, pipe into `docker compose exec -T`:

```bash
printf '%s' "<the value>" | docker compose exec -T backend python -m scripts.workspace_admin plugin secret set <plugin-id> <name>
```

- `-T` disables TTY allocation so the script picks the stdin branch (`sys.stdin.isatty()` returns false).
- `printf '%s'` writes the value with no trailing newline; the script strips one `\n` and one `\r` anyway, but the explicit shape is safer against shell tooling.
- Never pass the value as an argument or an environment variable: it ends up in the API's process list and the container's environment file.
- On Kubernetes, use `kubectl exec -i deploy/api -- python -m scripts.workspace_admin plugin secret set <plugin-id> <name>` with the value on stdin.

## Finding UUIDs

- Entity UUID: `entity list` filters on `--size`; grep by name. With many entities, `entity list --json | jq '.items[] | select(.name=="Acme") | .uuid'`.
- Role UUID: there is no CLI role list today. On the dev stacks, `docker compose exec backend python -c "..."` with a short SQLAlchemy query, or query the API's `/entities/<uuid>/roles` with the admin's session cookie. Document the role UUID per environment; it is stable.
- User UUID: `user list --email <substring>` returns the UUID in the row.

## Common failures

| Output | Cause | Fix |
|---|---|---|
| `✗ Error: User <email> not found` | `delete`, `reset-password`, `move` against an email that is not registered | Check `user list --email <substring>`; emails are case-sensitive here. |
| `✗ Error: Permission map '<role>' not found for entity <uuid>` | The entity exists but a role map is missing | Entity is stale or not initialized; rerun `init` or recreate it. |
| `✗ Error (400): ...` | `create`/`update` validation | The error body tells which field failed. |
| `✗ Error: <plugin-id> has no version <version>` | `approve` on a version that never scanned | `plugin rescan` first, then `plugin list` to confirm the version is listed. |
| `✗ Error: The server has <X> for this version, not <Y>: the files are not the ones you checked` | `--digest` mismatch | The files under `widget-plugins/<plugin-id>/<version>/` differ from what you checked. Rebuild, `rsync` again, `plugin rescan`, re-check with `plugin_check --digest`, then approve. |
| `✗ Error: Nothing approved. Run again with --acknowledge ...` | `approve` without `--acknowledge` | Expected; review the printed items, re-run with `--acknowledge`. |
| `Widget plugins are off: the API has no WIDGET_PLUGINS_DIR` on `plugin list` | Environment not set | `WIDGET_PLUGINS_DIR=/opt/widget-plugins` on the API container. The dev stacks set it already. |
| `The value is empty` on `secret set` | Empty stdin or empty prompt | Pipe a non-empty value; a `printf ''` or a TTY return accidentally sends an empty string. |

## Compose with the three local-dev admins

The three seeded admins (`workspace-dev1..dev3@example.com`, `.agents/skills/install-locally/SKILL.md`) all have the Admin role, so each can run every verb above and each stay signed in alongside the primary. For multi-agent work on the same stack, use one seeded admin per agent and let the primary stay with the human.

## Reference

- Source: `backend-api/backend/scripts/workspace_admin.py`
- Plugin service used under the hood: `backend-api/backend/api/widget_plugins/service.py`, `api/widget_plugins/calls.py`, `api/widget_plugins/manifest.py`
- Companion workflows for the CLI's web-app equivalents: `.agents/skills/develop-plugins/SKILL.md` section 4 (Admin Portal), `.agents/skills/drive-workspace-via-companion/SKILL.md`
- Deployment context (which API to `exec` into): `.agents/skills/deploy-remotely/SKILL.md`
