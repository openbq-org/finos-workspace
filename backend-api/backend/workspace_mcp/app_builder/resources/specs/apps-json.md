---
title: apps.json Spec
uri: workspace://specs/apps-json
use_when: You are authoring or editing apps.json and need the served shape, tab layout, and parameter group wiring.
language_specific: false
related:
  - workspace://specs/widgets-json
  - workspace://specs/layout-grid
  - workspace://validation/common-errors
---

# `apps.json` Spec

`apps.json` is the **app templates** contract. It declares one or more dashboards: the tabs they contain, the widgets placed on each tab, and the parameter groups that synchronize widgets.

## Top-level shape

The `/apps.json` endpoint MUST return a JSON **array** of app objects:

```json
[ { "...app object..." }, { "...app object..." } ]
```

Serve an array even for one app. FINOS Workspace reads a single object as an array of one app, but the contract is an array.

> **Schema vs served format.** Some validators describe a schema for *one* app object. The `/apps.json` endpoint serves an **array** of these objects. Validate each array element against the per-app schema individually.

## Per-app fields

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | App display name. |
| `tabs` | Yes | Object keyed by tab id; each value has `id`, `name`, `layout`. |
| `description` | Recommended | Shown in the app gallery. |
| `img`, `img_dark`, `img_light` | Recommended | App gallery image URLs. Prefer populated values: a stable hosted image URL or a backend-served `/thumbnails/{name}` SVG/PNG. Empty string `""` is acceptable only as a fallback. |
| `allowCustomization` | Optional | Boolean. `false` locks the dashboards that FINOS Workspace creates from the app: users cannot add, remove, duplicate or move their widgets or edit their tabs, but can still change parameters and resize widgets. `true`, or no value, lets users change the dashboard freely. |
| `groups` | Optional | Array of parameter sync groups. Leave it out when none are needed. |
| `prompts` | Optional | Array of suggested prompts for the agent. Leave it out when none are needed. |
| `id` | Optional | If set, must match `^custom-.+`. Plain strings are rejected. |
| `mcpServers` | Optional | MCP servers of this backend: see "MCP servers" below. |

`allowCustomization`, `groups` and `prompts` are all optional: FINOS Workspace accepts an app that leaves them out.

## Tab shape

`tabs` is an object keyed by tab id. The most common case is a single, unnamed tab — use empty strings for `id` and `name`:

```json
"tabs": {
  "": {
    "id": "",
    "name": "",
    "layout": [ /* layout items */ ]
  }
}
```

Named tabs:

```json
"tabs": {
  "overview": { "id": "overview", "name": "Overview", "layout": [ ... ] },
  "details":  { "id": "details",  "name": "Details",  "layout": [ ... ] }
}
```

Each tab value requires `id`, `name`, and `layout`.

## Layout item shape

Each entry in `layout` is an object:

| Field | Required | Notes |
|-------|----------|-------|
| `i` | Yes | Widget id. MUST match a key in `widgets.json`. **Not `id`.** |
| `x` | Yes | Column origin (0–39). |
| `y` | Yes | Row origin. |
| `w` | Yes | Width in columns (typically 10–40). |
| `h` | Yes | Height in rows (typically 4+). |
| `groups` | Optional | Array of group names this widget participates in, e.g. `["Group 1"]`. |
| `state` | Optional | Pre-configures display: `params`, `paramOrder`, `storage`. |

Coordinates are on a 40-column grid — see `workspace://specs/layout-grid`.

## Parameter groups

`groups` synchronizes a parameter across multiple widgets. The runtime is strict about three things:

1. **A widget joins a group by its `name`.** The `name` in `groups` and the name in the layout item's `groups` must be the same text, and any text works. `Group 1` is only the name that the UI gives a new group. A group has no `description` or `category`: its keys are `name`, `type`, `paramName`, `widgetIds` and `defaultValue`.
2. **Group `type` must match how the underlying widget's param is defined in `widgets.json`.** It is one of two values:

   | `groups[].type` | Use when widget param is | `paramName` |
   |---|---|---|
   | `"param"` | static dropdown — `type: "text"` with inline `options` | required |
   | `"endpointParam"` | dynamic dropdown — `type: "endpoint"` with `optionsEndpoint` | required |

3. **Three places must agree:** the group's `widgetIds`, every participating widget's layout `groups: [...]`, and the widget's own param config (matching `paramName` and option source).

Group object shape:

```json
{
  "name": "Group 1",
  "type": "endpointParam",
  "paramName": "team",
  "widgetIds": ["team_summary", "team_report"],
  "defaultValue": "platform"
}
```

> **Implicit auto-sync.** FINOS Workspace also auto-links widgets that share an identical `paramName` plus matching `options`/`optionsEndpoint`, even with no entry in `groups`. The explicit `groups` entry layers a named, user-toggleable group on top — useful when you want users to see and disable the linkage from the UI. If you don't need that affordance, matching `paramName` + `optionsEndpoint` is enough.

## Layout item `state`

Optional. Pre-configures how a widget displays inside this app template. Common keys:

- `params` — pre-set parameter values for this widget.
- `paramOrder` — render order for the widget's parameter panel.
- `storage.text` and `storage.html` — the text of a note, the HTML of an HTML widget.
- `storage.plugin.config` — the configuration of a widget whose type a widget plugin renders. It is checked against that plugin's settings when the backend loads: a key the settings do not define, a value they refuse, or a configuration for a widget no plugin renders leaves the app out, with the path of each problem.

`state` is an open object, so a key that this list does not name is kept in the file, but nothing reads it. Render the app in FINOS Workspace and confirm that a default takes effect before you rely on it.

## MCP servers

An app can declare MCP servers that belong to this backend. When the backend is connected, FINOS Workspace registers each one for the user, and a server whose `authType` is `token` is switched on only when the backend connection has an `Authorization` header. The backend's credentials are not sent to the server: the user connects it with headers of their own, or with an OAuth sign-in that asks for consent first. Whoever can use the backend may use every tool of its servers.

```json
"mcpServers": [
  { "name": "Team data", "url": "https://<mcp-host>/mcp", "authType": "token",
    "description": "Queries over the team reports" }
]
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | The server's name in this backend. A widget's `mcp_tool` names it. Two apps of one backend may declare the same server, but one name cannot name two servers. |
| `url` | Yes | The server's URL. |
| `authType` | Optional | `token` for a static token, which the user enters (the server stays off until then); OAuth otherwise. |
| `description` | Optional | Shown with the server. |

A widget opts in to one tool of these servers with `mcp_tool` (`workspace://specs/widgets-json`).

## Minimal example

```json
[
  {
    "name": "My Dashboard",
    "description": "Weekly summary and report for a team",
    "img": "http://localhost:7779/thumbnails/my_dashboard",
    "img_dark": "http://localhost:7779/thumbnails/my_dashboard",
    "img_light": "http://localhost:7779/thumbnails/my_dashboard",
    "allowCustomization": true,
    "tabs": {
      "": {
        "id": "", "name": "",
        "layout": [
          { "i": "team_summary", "x": 0,  "y": 0, "w": 20, "h": 12, "groups": ["Group 1"] },
          { "i": "team_report",  "x": 20, "y": 0, "w": 20, "h": 12, "groups": ["Group 1"] }
        ]
      }
    },
    "groups": [
      {
        "name": "Group 1",
        "type": "endpointParam",
        "paramName": "team",
        "widgetIds": ["team_summary", "team_report"],
        "defaultValue": "platform"
      }
    ],
    "prompts": []
  }
]
```

## What this spec does not cover

- Layout grid math — see `workspace://specs/layout-grid`.
- Widget metadata that supplies the widgets referenced here — see `workspace://specs/widgets-json`.
- Common validation errors — see `workspace://validation/common-errors`.
