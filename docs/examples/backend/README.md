# Examples backend

One backend serves the three example plugins, so that a single connection gives a dashboard every widget type and the widgets work on the same data. It is a Starlette application in one container, with a gateway in front and a Postgres beside it. It answers for two plugin backends, the SQL explorer's and the AgGrid plugin's.

| Path | Answers | For |
|---|---|---|
| `/widgets.json` | The definitions of the widgets below. | The web app, which adds them as a connection. |
| `/plotly/sales`, `/plotly/trend`, `/plotly/signal`, `/plotly/correlation` | A Plotly figure, drawn in the template of the `theme` the app sends. `/plotly/sales?raw=true` answers with its rows. | The `plotly-charts` plugin. |
| `/ag-grid/explicit`, `records`, `columns`, `split`, `dates`, `grouped`, `multicolumn`, `stream` | One table in each of the shapes the `aggrid-table` type accepts. `stream` moves every five seconds, so the plugin applies the difference as a transaction. | The `ag-grid` plugin, widget *AgGrid table*. |
| `/ag-grid/live`, and the WebSocket `/ws/ticks` | The columns and a first snapshot of 24 instruments, and a socket that sends a `snapshot` and then `upsert` messages by row id, so the rows keep their order. | The `ag-grid` plugin, widget *AgGrid live grid*, type `aggrid-livegrid`. |
| `/ssrm/trades` | Nothing the widget reads: the widget of type `aggrid-ssrm` gets its rows from the plugin's own backend. | The `ag-grid` plugin, widget *AgGrid server-side table*. The plugin's *AgGrid SQL* widget needs no entry here: it is in Add widget on its own. |
| `/sql/chart` | The first column of the `sql` parameter's query as categories and the others as bars, as a Plotly figure. | The `plotly-charts` plugin. |
| `/.workspace/identity`, `/.workspace/health`, `/.workspace/routes/<route>` | The requests of a plugin backend. | The API, for the `sql-explorer` plugin. |
| `/plugins/ag-grid/.workspace/...` | The same requests for the `ag-grid` plugin, whose routes also page, sort, filter, group and pivot `demo.trades`. | The API, through port 8082 of the gateway. |

## How the plugins work together

- The files in the image, `sales.csv`, `deals.csv`, `readings.parquet` and `stations.csv`, hold the data of the charts and grids. The SQL explorer's Files source, the *AgGrid SQL* widget and the *SQL chart* all read them with the same read-only DuckDB, so a query written in the explorer gives the same rows in the grid and in the chart.
- *AgGrid SQL* is a widget of the AgGrid plugin: the explorer's own editor, with its tables and its DuckDB completion, and the result in AgGrid in the same card, with the row group, pivot and column panels. *SQL chart* is a widget of type `plotly` that the Plotly plugin draws from `/sql/chart`.
- *Trades, server-side* shows `demo.trades`, 200,000 rows in the Postgres, through the AgGrid plugin's backend: every page, sort, filter, row group, aggregate and pivot is a query.
- *Live prices* declares `data.streamEndpoint: "/ws/ticks"`: the web app opens that WebSocket through the API, which connects to port 7798 as it does for the widget's endpoint, and passes the messages to the AgGrid plugin. Nothing in the plugin's policy changes.
- The SQL explorer declares the parameter `sql` and writes it when a query on its Files source has run. Put the explorer and the *SQL chart* on one dashboard and add their `sql` parameters to one group (the link beside the parameter, then +): the editor with its completion is then the input of the chart.
- *Sales by region* has `raw` and `data.rawType: "aggrid-table"`, so the database button of its card shows its rows in the AgGrid plugin ([the widgets.json contract](../../reference/schemas/widgets-json.mdx)).

## What can reach what

The backend runs as an unprivileged user on a read-only root, without capabilities, on two internal networks. Only the gateway joins the FINOS Workspace network and the host:

- Port 7798 of the gateway, published on `127.0.0.1`, forwards `/widgets.json`, `/plotly/`, `/ag-grid/`, `/sql/`, `/ssrm/` and the WebSocket under `/ws/`, which the web app opens. It never forwards `/.workspace/`, because those routes take a database URL from their caller. The backend allows the web apps at `http://localhost:3000` and `http://localhost:1420`.
- Ports 8081 and 8082 of the gateway, reachable only from the FINOS Workspace network, forward `/.workspace/` of the SQL explorer and of the AgGrid plugin and nothing else.
- The backend reaches the Postgres and the gateway, and not the API or the internet.

`/sql/chart` takes no credentials: they answer anyone who reaches port 7798, with the limits of the SQL explorer's Files source (one SELECT, 15 seconds, 1,000 rows, nothing outside `/data`).

## Run it

Build the SQL explorer package, then the AgGrid package, because the image carries `docs/examples/sql-explorer/dist/sql-explorer/<version>` and `docs/examples/ag-grid/dist/ag-grid/<version>` and reports their digests as the plugins' identities ([SQL explorer](../sql-explorer/README.md), [AgGrid](../ag-grid/README.md)).

```bash
python3 setup.py
```

writes the Postgres passwords to `.env`, which Compose reads, and each plugin's `postgres_url` secret to `secrets/`, both readable by you only. Then, with `<sql version>` and `<grid version>` the package versions of the SQL explorer and of AgGrid and `<network>` the network of the FINOS Workspace stack (`docker network ls`; `workspace_workspace` for the root `docker-compose.yml`):

```bash
SQL_EXPLORER_VERSION=<sql version> AG_GRID_VERSION=<grid version> WORKSPACE_NETWORK=<network> docker compose up -d --build
```

Place the three built packages in the plugins directory and approve, enable and grant them as [review and enable a plugin](../../tutorials/plugins/review-and-enable-a-plugin.md) describes. For the SQL explorer and for AgGrid, list the backends in the API's environment, `WIDGET_PLUGIN_BACKENDS={"sql-explorer": "http://examples-gateway:8081", "ag-grid": "http://examples-gateway:8082"}`, add `tcp://postgres:5432` to each one's server network with private hosts confirmed, and set each one's `postgres_url` secret from `secrets/workspace/<plugin>/postgres_url`. Then add `http://localhost:7798` under Connections and put the widgets of the categories *Plotly examples* and *AgGrid examples*, and the SQL explorer and AgGrid SQL, on a dashboard.

On Postgres, the SQL explorer has the `demo` schema; on Files it has `sales`, `deals`, `readings` and `stations`. For example:

```sql
SELECT region, sum(units) AS units FROM sales GROUP BY region ORDER BY region
```

`reach.py` shows what the backend can reach: `docker exec -i widget-examples-backend-1 python - postgres:5432 api:8000 < reach.py`.

## Test

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r requirements-test.txt
```

```bash
.venv/bin/python -m pytest -q tests
```

`tests/test_server.py` runs the application against files it writes. `tests/test_isolation.py` needs Docker and the built SQL explorer and AgGrid packages: it starts `compose.yaml` under a project name of its own, beside a stand-in for the API, and checks what each side can reach, what the gateway forwards and that the backend is unprivileged. It removes what it started.
