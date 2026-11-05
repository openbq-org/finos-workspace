---
title: widgets.json Spec
uri: workspace://specs/widgets-json
use_when: You are authoring or editing widgets.json and need the top-level shape and the critical fields per widget.
language_specific: false
related:
  - workspace://specs/widget-types
  - workspace://specs/widget-parameters
  - workspace://specs/apps-json
  - workspace://validation/common-errors
---

# `widgets.json` Spec

`widgets.json` is the metadata contract that tells FINOS Workspace which widgets your backend offers, what type each one is, and which endpoint serves its data.

## Top-level shape

`widgets.json` is a JSON **object**. Keys are widget ids, values are widget definitions:

```json
{
  "weekly_summary": { "...widget definition..." },
  "audit_report":   { "...widget definition..." }
}
```

Returning a JSON array is the most common mistake here — FINOS Workspace will reject it. Widget ids are referenced by app layouts (the `i` field in `apps.json` layout items), so they must be stable.

## Widget definition fields

Each value is an object with these keys and no others:

<!-- generated:widget-fields -->
| Field | Required | Value | Notes |
|---|---|---|---|
| `type` | Yes | `markdown`, `html`, `newsfeed`, `pdf`, `iframe`, or a plugin type enabled for the organization | What renders the widget |
| `name` | Yes | text, at most 200 characters | The title the widget shows |
| `description` | Yes | text, at most 4,000 characters | What the widget shows; the catalog shows it, and the AI Agent finds widgets by it |
| `endpoint` | Yes | text, at most 2,048 characters | A path or an absolute URL with no `?` and no `#` (a static query value is a param with show: false) |
| `method` | No | `GET`, `POST` | How FINOS Workspace calls the endpoint: GET (the default) or POST, which a param `in: body` needs |
| `category` | No | text, at most 100 characters | The group the catalog lists the widget under |
| `subCategory` | No | text, at most 100 characters | The subgroup within the category |
| `source` | No | text, at most 100 characters or list of text, at most 16 | Where the data comes from: a label, or a list of labels |
| `showTitle` | No | `true` or `false` | False leaves the title off the widget |
| `params` | No | list of params | The widget's parameters; an item that is a list of params is one row of the parameter bar |
| `gridData` | No | object | The default size on a dashboard, in grid units: `w` of 40 columns, and `h` rows |
| `staleTime` | No | number, 1,000 to 10,000,000,000 or `false` | Milliseconds a response is reused before it is fetched again; false fetches every time |
| `refetchInterval` | No | number, 1,000 to 10,000,000,000 or `false` or text, at most 100 characters or `null` | Fetch again every so many milliseconds, or on a 5-field cron schedule; false never |
| `dataUpdateDisplay` | No | text, at most 100 characters | When the data changes, as a 5-field cron expression shown to the user |
| `runButton` | No | `true` or `false` | The widget fetches only when the user clicks Run |
| `disableRetrievalForCopilot` | No | `true` or `false` | Keeps the widget's data from the AI Agent; such a widget has no `mcp_tool` |
| `exportable` | No | `true` or `false` | False removes Export from the widget's menu |
| `mcp_tool` | No | object | The MCP tool of this backend the AI Agent uses to query what the widget shows: a server named in this backend's apps.json mcpServers, and the tool |
| `data` | No | object | `dataKey`, `rawDataKey` and `rawType` where the type has `raw`, and for a plugin's type the configuration its plugin defines |
| `raw` | No | `true` or `false` | Only for `html` and plugin types. The endpoint also answers `raw=true` with the rows the widget shows, as JSON: the AI Agent and MCP get those rows, and the widget's rows button shows them |
| `requires_auth` | No | `true` or `false` | Only for `iframe`. The page needs the backend connection's credentials. The browser then opens it through the FINOS Workspace API, which adds them, in a sandbox without storage. For trusted pages only: the API checks this declaration itself |
| `storage` | No | object | Only for `iframe`. `mcpUrl`: an MCP server of the page's own, connected for the widget without the backend's credentials |
<!-- /generated:widget-fields -->

The contract defines every key and bounds every value. A key it does not define is ignored: the widget loads without it, and FINOS Workspace names the key under the backend's unrecognized fields. A value outside its bounds leaves the widget out, and FINOS Workspace names the widget and the path of each problem when the backend is connected; the other widgets load. `workspace://specs/widgets-json-schema` is the JSON Schema in force for the signed-in user, for an editor or a test. Set `runButton` only for heavy work (more than 5 seconds).

## `gridData` is a hint, not the layout

`gridData` is the default placement when a widget is dragged onto a dashboard from the catalog. It is *not* the layout used by an app template — that lives in `apps.json` under `tabs[].layout[]`. Don't try to express tabs or coordinates inside `widgets.json`.

Common mistakes:

- Returning an array instead of an object.
- A `type` nothing renders for the user: the widget is left out of their catalog.
- A key the table does not list, such as `defaultViz`, `widgetId` or `widgetType`: the widget is refused.
- A `?` or `#` in `endpoint`: a static query value is a param with a default value and `"show": false`.

## The request

`endpoint` is a path on the backend, or an absolute URL, with no `?` and no `#`; it does not have to match the widget id. For the current param values FINOS Workspace builds one request:

1. **URL.** A `{name}` placeholder in `endpoint` takes the value of the param `name`, encoded as one path segment; the request is not sent while it has no value. Each param with `in: "query"`, or no `in`, is appended to the query.
2. **Headers.** Each param with `in: "header"`, named by its `paramName`. The API adds the backend connection's credentials, `X-Workspace-User`, `X-Workspace-Identity` and, when the deployment turns it on, the identity provider's ID token.
3. **Body.** With `"method": "POST"`, the params with `in: "body"` as one JSON object, `{ "<paramName>": <value> }`, sent as `Content-Type: application/json`.
4. **FINOS Workspace's own query values.** `theme` (`dark` or `light`) for `markdown`, `html`, `iframe` and plugin types, and `raw=true` for the raw view of an `html` widget. They are reserved names for those types.

An empty value is not sent, in any place; `0` and `false` are. How each kind of value is written is in `workspace://specs/widget-parameters`.

The FINOS Workspace API sends the request, whatever the method and the params are, so the backend needs no CORS settings. See `workspace://contract/backend`.

## The MCP tool link

A widget can name the MCP tool of its own backend that the AI Agent uses to query what the widget shows:

```json
"mcp_tool": {
  "mcp_server": "Team data",
  "tool_id": "get_team_report",
  "args": { "team_id": "$team", "period": "$period" }
}
```

- `mcp_server` is the `name` of a server in the `mcpServers` of this backend's `apps.json` (`workspace://specs/apps-json`), compared exactly; never a URL. A widget whose `mcp_server` names no declared server is refused, so a backend with no `apps.json` cannot use the key.
- `tool_id` is the tool's name on that server, compared exactly.
- `args` maps the tool's arguments to the widget's params: `"$<paramName>"` is the param's current value, which must be declared, and anything else is a literal. Without `args`, an argument named like a param takes its value.
- The link enables nothing: the agent is told of it only while the tool is in its tool list (the server connected and enabled, the tool switched on, granted to the user, and MCP tools on for the agent).
- When the agent calls the tool, the result is cited as this widget, with the call's arguments turned back into its params through `args`. Several widgets may name one tool: the one whose literal `args` all equal the call's, with the most literals, is cited.
- A widget with `disableRetrievalForCopilot: true` cannot have `mcp_tool`.
- The server decides what a call may do; make the tool a read-only query.

## Example shape

```json
{
  "weekly_summary": {
    "name": "Weekly Summary",
    "description": "The week's activity for one team, as written commentary",
    "type": "markdown",
    "endpoint": "/summary",
    "gridData": { "w": 20, "h": 12 },
    "params": [
      { "paramName": "team", "type": "endpoint", "label": "Team", "description": "Team to summarize",
        "optionsEndpoint": "/teams" }
    ]
  },
  "team_report": {
    "name": "Team report",
    "description": "Report for one team and period",
    "type": "markdown",
    "method": "POST",
    "endpoint": "/teams/{team}/report",
    "params": [
      { "paramName": "team", "type": "endpoint", "label": "Team", "value": "platform",
        "optionsEndpoint": "/teams/search", "optionsMethod": "POST", "optionsParams": { "active": true } },
      { "paramName": "period", "type": "text", "label": "Period", "value": "month" },
      { "paramName": "X-Region", "type": "text", "label": "Region", "value": "eu", "in": "header" },
      { "paramName": "filters", "type": "text", "label": "Filters", "value": "active", "in": "body" }
    ]
  }
}
```

`team_report` is sent as `POST <backend>/teams/platform/report?period=month&theme=dark`, with the header `X-Region: eu` and the body `{"filters":"active"}`. Its `team` choices come from `POST <backend>/teams/search` with the body `{"active":true}`.

## What this spec does not cover

- Choosing a widget type — see `workspace://specs/widget-types`.
- Authoring params — see `workspace://specs/widget-parameters`.
- Wiring layouts and parameter sync — see `workspace://specs/apps-json` and `workspace://specs/layout-grid`.
- Common validation errors — see `workspace://validation/common-errors`.
