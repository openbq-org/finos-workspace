# Backend

FastAPI + SQLAlchemy backend for FINOS Workspace.

## Setup

See [DEVELOPMENT_SETUP.md](../DEVELOPMENT_SETUP.md) for full local development instructions.

Quick start for local UI testing:

```bash
docker compose -f docker-compose-local-dev.yml up --build --watch

# in a second shell
cd backend
../.venv/bin/python -m scripts.init_users
```

This runs the API and RQ worker in Docker with the local `backend/` folder mounted.
The API reloads automatically, and Compose can restart the worker when files change.
See [DEVELOPMENT_SETUP.md](../DEVELOPMENT_SETUP.md) for the full workflow.

## Project Layout

| Path | Description |
|---|---|
| `api/` | Core application — models, schemas, helpers, auth |
| `routers/` | API route handlers |
| `utilities/` | Configuration, shared utilities |
| `alembic/` | Database migration revisions |
| `envs/` | Environment files (`.env`) |
| `scripts/` | Dev-only scripts and config (excluded from Docker images) |
| `tests/` | Test suite (`pytest`) |
| `run.py` | Application entrypoint (Gunicorn + Uvicorn) |
| `main.py` | FastAPI app factory |

## Conventions

- Use `api.base.get_now()` instead of `datetime.datetime.now`.
- The `User.password` column uses a `PasswordType` TypeDecorator that bcrypt-hashes
  on write. Always pass plaintext passwords — never pre-hash.
- Secrets at rest (`api/crypto.py`): a secret the API uses again (authenticator secrets,
  users' provider keys, data-backend, Copilot and MCP headers) is stored in an
  `EncryptedType` or `EncryptedStringType` column, AES-256-GCM under a key derived from
  `WORKSPACE_AES_KEY`. A credential the API only checks (an MCP token) is stored as
  its SHA-256 (`crypto.hash_token`). No secret goes into a plain column, a log line or a
  response to the browser. Random secrets come from the `secrets` module.
- Sessions (`api/auth_helpers.py`) are random tokens stored as their SHA-256. The web app
  holds its own in an HttpOnly cookie and names itself in the `X-Workspace-Client` header
  (`web`). A cookie request with an `Origin`, and
  every one that changes anything, must come from one of `BACKEND_CORS_ORIGINS`. Every answer to a request that carried a cookie or
  a token is `Cache-Control: no-store`. No session is a bearer token. The default Copilot acts for
  the user with an agent token (`POST /app/copilot/token`), which only `GET /app/user`,
  `PUT /app/usage` and `POST /app/copilot/authorize` accept.

## Secrets and keys

The API does not start without these, and refuses short or malformed values:

| Setting | What it is |
|---|---|
| `WORKSPACE_AES_KEY` | Key of the encryption at rest: base64url, at least 32 bytes. Keep it: data stored under it cannot be read with another key. |
| `JWT_SECRET` | Signs the service tokens (`WORKSPACE_AUTH_TOKEN`, the metering token); at least 32 bytes. |
| `LOCAL_STORAGE_SECRET_KEY` | Signs pre-signed file URLs with `STORAGE_PROVIDER=folder`; at least 32 bytes. |

`python -m scripts.create_local_env` writes all of them, random, into `envs/.env`. To make
one yourself: `python -c "import secrets; print(secrets.token_urlsafe(32))"`.

`BACKEND_CORS_ORIGINS` is required too: the origins of the web app, exactly as browsers
send them (scheme, host and port; never `*`). The
session cookie reaches the API only when it is on the same site as the web app: serve it
under the web app's registrable domain, or under `/api` of the web app's origin, over
HTTPS. The cookies are scoped to the API's host, whatever the port, so a
deployment serves the API on a host of its own that no other server shares. On localhost
(the compose stack) that cannot hold: browsers treat `http://localhost` as secure,
and the session cookie also reaches every other server on a local port that the browser
navigates to or loads a frame or an image from, such as a local data backend or an app
in an iframe widget. Run only servers you trust on localhost next to a signed-in FINOS Workspace.
Sign-in with Google checks the access token the browser gets against `GOOGLE_OAUTH_CLIENT_ID`,
the public value the web app uses too (its `VITE_` setting of the same name). Sign-in with
Microsoft or Okta runs on the server, so the browser never holds a token of the provider:
the web app asks `POST /app/sign-in/{provider}/start` for the address of the provider's
sign-in page and goes there, and the provider sends the browser back to
`<SELFURL>/app/sign-in/{provider}/callback`, where the API exchanges the authorization code
(with PKCE), checks the ID token against the provider's keys, signs the user in, and
redirects to `APPURL`. A sign-in that fails redirects to the web app's login page with the
reason. A sign-in has ten minutes, one browser (a `Lax` cookie holds a secret that only
that browser has), one use, and a nonce that must come back in the ID token.

- Microsoft needs `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` (the tenant's id or domain, or
  `organizations` or `common` for a multi-tenant app) and `AZURE_CLIENT_SECRET`. Register the
  app as a **Web** platform with the redirect URI above and a client secret; a single-page
  app registration, which has no secret, makes Microsoft limit the refresh token to 24 hours.
  The app registration must send the optional ID-token claims `email` and `xms_edov`: without
  them Microsoft vouches for no address, so a Microsoft sign-in reaches no existing account,
  claims no invitation and makes no new account; it is refused, unless the account is already
  linked to that Microsoft user.
- Okta needs `OKTA_CLIENT_ID` and `OKTA_DOMAIN`, the issuer (`https://<your-org>.okta.com`, or
  `https://<your-org>.okta.com/oauth2/default` for a custom authorization server), and
  `OKTA_CLIENT_SECRET` for a web app. Allow the redirect URI above, and the
  authorization code and, for the next paragraph, refresh token grants.
- A provider without its settings refuses every sign-in.

A backend or an agent that verifies tokens with Microsoft Entra or Okta can keep doing so.
Set `AUTHENTICATION_SEND_MICROSOFT_IDTOKEN` or `AUTHENTICATION_SEND_OKTA_IDTOKEN` to `true`:
the API then asks the provider for `offline_access`, keeps the user's ID token and refresh
token encrypted at rest and tied to the session, renews the ID token before it expires, replaces
the refresh token whenever the provider rotates it, deletes both when the session ends however it
ends (sign-out at once, any other end within a minute) and then revokes the refresh token when the
provider has a revocation endpoint (Okta has one; Microsoft Entra has none), and sends the ID token to the data connections and agents as
`X-Microsoft-Id-Token` or `X-Okta-Id-Token`. A provider that issues no refresh token refuses
the sign-in, and one that refuses a refresh token ends the session. Every call also carries
`X-Workspace-Identity`, a short-lived token that the API signs and publishes the keys of at
`<SELFURL>/.well-known/jwks.json`; see [Requests that a widget sends](https://workspace.finos.org/tutorials/build-a-backend/requests-from-a-widget).

The API reaches users' MCP servers only at public internet addresses. An MCP server on a
private network (an internal host, a compose service) has to be listed by host name in
`ALLOWED_MCP_HOSTNAMES`, a JSON list. A superuser's servers, and every user's servers when
`MODE=local`, may be at any address, as a data backend may.

No password is printed, logged or kept in a file: `scripts.init_users` creates the first
administrator without one, and `python -m scripts.init_users --new-password <email>` sets it,
read from the terminal without echo or from standard input.

Rate limits count requests per client address. The API takes that address from
`X-Forwarded-For` only when the request comes from loopback or a private network
(`api/rate_limit.py` `TRUSTED_PROXIES`), where load balancers, ingresses and compose networks
connect from; a client on the internet cannot pick its own address.

## Database Migrations

```bash
# Apply pending migrations
../.venv/bin/python -m alembic upgrade head

# Create a new migration after model changes
../.venv/bin/python -m alembic revision --autogenerate -m "description"
```

## Testing

```bash
../.venv/bin/python -m pytest
```

Requires a running MySQL instance (see [DEVELOPMENT_SETUP.md](../DEVELOPMENT_SETUP.md)).
Coverage report is generated at `htmlcov/index.html`.
