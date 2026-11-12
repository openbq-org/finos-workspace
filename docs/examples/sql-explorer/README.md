# SQL explorer for FINOS Workspace

A FINOS Workspace widget plugin with a backend of its own. The widget, in the user's browser, runs
read-only SQL. The plugin's backend, a process the deployment runs beside FINOS Workspace, carries
each query to one of two engines:

- **Postgres**: a database the deployment runs, over Postgres's own protocol, with the
  connection URL FINOS Workspace sends as the plugin's secret on each call.
- **Files**: DuckDB over Parquet, CSV and JSON files the deployment mounts read-only at
  `/data`, each file a view named after it.

It is the counterpart of a plugin that only draws (the Plotly plugin). Here the work cannot
happen in the browser: the database speaks its own protocol, its password must never
reach a browser, and the files are on a server. It is an example in the repository's
`docs/examples/`, a package of its own that nothing in FINOS Workspace imports, built and deployed the
way any plugin is ([build and try a widget plugin](../../tutorials/plugins/build-a-plugin.md), and
[run a plugin backend](../../tutorials/plugins/run-a-plugin-backend.md) for backends).

```
widget (frame)  ── core:backend:call {route, args: {sql}} ──▶  FINOS Workspace API
                                                                │ checks the route, the args,
                                                                │ the backend's identity, limits;
                                                                │ adds the secret and the caller's
                                                                │ pseudonym
                                                                ▼
                       gateway ── POST /.workspace/routes/<route> ──▶ backend
                                                                       ├─▶ Postgres  tcp://<host>:5432
                                                                       └─▶ DuckDB    /data (read-only)
```

## What it does, and what it refuses

- **One read-only SELECT per run.** Postgres runs the query as a cursor in a read-only
  transaction; a cursor takes nothing but a SELECT or VALUES, so `DELETE`, a second
  statement, a writing CTE or `SELECT INTO` is refused, and a function that writes fails on
  the read-only transaction. DuckDB checks the statement first (one, of type SELECT), then
  runs it in a connection that can read nothing outside `/data`, cannot attach a database
  or install an extension, and whose settings are locked.
- **Limits.** 15 seconds per query (Postgres's `statement_timeout`, and a cancel from the
  backend after 20 for anything that gets past it; DuckDB is interrupted), 1,000 rows and
  4 MiB of results. A query is at most 32,768 characters.
- **Answers.** The columns with their types, the rows as JSON (a decimal or an integer
  beyond 2^53 as text, so no digit is lost; dates and times in ISO 8601), whether more rows
  were left out, and the time. A query that fails answers with the engine's message.
- **Who ran it.** Postgres sees each session as `workspace-sql-explorer:<pseudonym>`
  (`pg_stat_activity.application_name`): the anonymous id FINOS Workspace gives the plugin for a
  user, the same for them every time and different in every other plugin. The backend
  never learns who the user is.
- **What it holds.** Nothing. The Postgres URL arrives with each call and is gone after
  it. The backend logs the route, the outcome, the row count, the time and the first
  characters of the pseudonym, never the query or the URL.

The widget keeps the chosen source and the SQL of each source in its saved state; it runs
the query when it opens and when the card is refreshed. The table on the left lists what
the engine has (the tables the Postgres role may read, the files), and a click inserts a
name. Ctrl+Enter or ⌘+Enter runs the query.

## Completion

The editor completes keywords, functions, tables and columns as you type, from DuckDB
itself: DuckDB-WASM runs in a worker inside the widget's frame and holds an empty copy of
the schema the table list shows, and DuckDB's `sql_auto_complete` answers what may come at
the cursor. Typing a letter, a digit, `_`, `"` or `.` opens the list; Ctrl+Space opens it
anywhere. Arrow keys move, Enter or Tab takes a suggestion, Escape closes. Nothing leaves
the frame while you type.

- It starts the first time the editor is used: a dashboard that only shows results never
  loads it. The frame asks FINOS Workspace for the package's own files (`core:asset:read`):
  DuckDB's worker script, its WebAssembly binary and the two extensions it would otherwise
  download on first use, `autocomplete` and `json`. DuckDB asks where an extension comes
  from (`runtime.whereToLoad`), and the answer is always the packaged file; no extension
  loads from the network, and none other loads at all.
- The frame's policy gains `script-src 'wasm-unsafe-eval'`, to compile the binary, and
  `connect-src blob:`, for DuckDB to read the files the frame hands it. No host becomes
  reachable. The admin sees both in the review, with the plugin's notes.
- Postgres's own functions are not DuckDB's: on the Postgres source the keywords, tables
  and columns are right, and a function DuckDB has and Postgres lacks may be offered. The export dialog offers the last result as
CSV, and with its query as JSON. The Copilot is told the query and the columns and row
count of the answer, not its values. Its look is its own, a light and a dark version that
follow the site's mode.

## The editor in other plugins

The editor, the table list and the completion are `src/widget.js`: `createWidget({ showGrid })` returns
the widget, and with a `showGrid(host, result, mode)` it draws a result there instead of in a plain table.
The AgGrid plugin's *AgGrid SQL* widget is this widget with AgGrid as `showGrid`, built from these same
sources, and its backend serves the same four routes from these same `backend/` files
([AgGrid](../ag-grid/README.md)). `duckdb-assets.mjs` fetches, checks and lists the DuckDB-WASM files and licences
that both builds ship.

## For the AI agent

The explorer declares an `artifact`: `source` (`postgres` or `files`) and `sql`. The agent writes a
query for a question about the deployment's data and shows the explorer in the chat; the card runs
the query from the user's own session, the user can edit and rerun it, and the dashboard widget made
from the card keeps the query. The skill `sql-explorer-queries`
(`src/skills/sql-explorer-queries.md`) gives the agent the exact steps, the two sources and their
dialects, what a query may be (one read-only SELECT, with the limits above), and the tables of the
example deployment. The [AgGrid plugin](../ag-grid/README.md) offers the same query in AgGrid.

## The package

| Path | |
|---|---|
| `src/plugin.json` | The manifest: the widget, its permissions (`core:backend:call`, `core:state:write`, `core:export:provide`, `core:copilot:context`), the four routes, the `postgres_url` secret, `identity: "pseudonymous"`. |
| `src/entry.js`, `src/widget.js`, `src/entry.css`, `src/assets/` | The widget, an Anywidget front-end module: `widget.js` builds it, `entry.js` exports it. |
| `src/completion.js`, `src/duckdb.js` | Completion: the schema DuckDB mirrors and what it suggests, and DuckDB-WASM started in the frame from the package's assets. |
| `third-party/` | Licence texts the DuckDB-WASM npm package does not carry. |
| `backend/server.py` | The three requests a FINOS Workspace backend answers: `GET /.workspace/identity`, `GET /.workspace/health`, `POST /.workspace/routes/<route>`. |
| `backend/engines.py`, `backend/values.py` | Postgres and DuckDB, and their values as JSON. |
| `backend/identity.py` | The plugin, version and version digest, computed from the package's files at start. |

The backend: Python 3.14 (the newest Python DuckDB 1.5.6 publishes wheels for),
Starlette 1.8, uvicorn 0.54, psycopg 3.3, DuckDB 1.5.6. The widget: DuckDB-WASM
1.33.1-dev57.0 (its npm `latest`, with DuckDB v1.5.4) and Apache Arrow 17.0.0, the version
DuckDB-WASM requires, bundled by esbuild 0.28. Node 20 or later for the build.

## Build and test

```bash
npm run build
```

writes `dist/sql-explorer/<version>/` (the version from `package.json`): `entry.js`, the
widget bundled by esbuild with DuckDB-WASM's browser client; in `assets/`, DuckDB-WASM's
worker script and binary and the `autocomplete` and `json` extensions; `backend/` file by
file; `licenses/`, the licence and notice files of everything bundled; and `plugin.json`
with the checksum. The extensions come from DuckDB's extension repository for the DuckDB
inside DuckDB-WASM (v1.5.4), checked against SHA-256s pinned in `build.mjs` and kept in
`.cache/`. It prints the checksum and the version digest; the backend reports the same
digest from the files it runs. A version is about 40 MB, most of it DuckDB's binary.

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r ../backend/requirements-test.txt
```

```bash
npm test
```

runs the widget's tests in Node, completion among them against DuckDB-WASM's Node build
with the same binary and extensions (from `.cache/`, so build first; nothing is
downloaded), and the backend's in pytest. The Postgres tests need a
database they may change: set `SQL_EXPLORER_TEST_POSTGRES` to an administrator's URL, or
`SQL_EXPLORER_TEST_POSTGRES_FILE` to a file holding it, for example of a throwaway
container (`docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD_FILE=...
postgres:18.6`). Without it they are skipped. The isolation of the backend's container is
tested with the [examples backend](../backend/README.md).

## Deploy

1. Copy `dist/sql-explorer/<version>/` into FINOS Workspace's plugins directory and check it,
   from `backend-api/backend`:
   `python -m scripts.plugin_check <plugins directory>/sql-explorer/<version> --digest`.
2. Build the backend's image. The [examples backend](../backend/README.md) does it: its
   `Dockerfile` copies this package's `dist/sql-explorer/<version>/` and serves the package's
   `backend/` beside the routes of the other examples.
3. Run it as [run a plugin backend](../../tutorials/plugins/run-a-plugin-backend.md) describes: no privileges, a read-only
   root, its own network that only a gateway joins from the FINOS Workspace side, the database
   on a second network, the data files at `/data`. The examples backend's `compose.yaml`
   does exactly this.
4. List it for the API: `WIDGET_PLUGIN_BACKENDS={"sql-explorer": "http://<gateway>:<port>"}`.
5. In Admin, Widgets, Deployment: review and approve the version. Under Overrides, add the
   database's address to the server network, `tcp://<host>:<port>`, and confirm private
   hosts if it is one. Set the `postgres_url` secret, for a role that may only read (or
   mount it as `WIDGET_PLUGIN_SECRETS_DIR/sql-explorer/postgres_url`). Check the backend:
   it should run the approved version.
6. Enable the plugin for the organization and grant it to the roles that may use it. The
   widget is in Add widget, under Data.

A deployment without Postgres leaves the secret unset: the Files source works, and
Postgres says it is not set up. Without files, the Files source has no tables.

## Try it

The [examples backend](../backend/README.md) runs the backend, a gateway and a Postgres with a
`demo` schema beside a FINOS Workspace stack on the same machine, and its README says how to
register it. Try

```sql
SELECT r.name AS region, sum(s.units) AS units, sum(s.revenue) AS revenue
FROM demo.monthly_sales s JOIN demo.regions r USING (region)
GROUP BY r.name
ORDER BY revenue DESC
```

on Postgres, and

```sql
SELECT s.site, count(*) AS readings, round(avg(r.celsius), 2) AS avg_celsius
FROM readings r JOIN stations s USING (sensor)
GROUP BY s.site
ORDER BY s.site
```

on Files. The files are the ones that the *SQL chart* widget of the Plotly examples queries.

## Notes

- Each call opens its own Postgres connection, which keeps the URL out of the process
  between calls and gives a wrong one a clear message. A busy deployment would pool them.
- The backend's digest covers every file of the version, so an image built from anything
  else, or a file changed in it, gets no calls until it is rebuilt from the approved one.
