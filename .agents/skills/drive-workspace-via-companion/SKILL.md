---
name: drive-workspace-via-companion
description: 'Drives a running FINOS Workspace from an external AI tool (Claude Desktop, Claude Code, Cursor, Codex, any MCP streamable-HTTP client) through the MCP Companion: turning the Companion entry on in the stack, connecting the browser tab, minting the ws_mcp_ personal access token, wiring the Authorization and Origin headers, and the eighteen workspace tools with their calling conventions (snake_case payloads, snapshot-first discovery, widget schemas and param options, add_generative_widget for notes and HTML, update_widget_layout on the 40-column grid, manage_navigation_bar for tabs, dashboard targeting through current_dashboard_uuid). Use for requests such as "connect Claude Desktop to FINOS Workspace", "set up the MCP Companion", "create a ws_mcp token", "build a dashboard from Claude Code", "add a widget from an outside AI tool", "why does the Companion say no browser is connected", "revoke a Companion token", "drive the workspace from an AI tool outside the tab". For widget plugin iteration, defer to `.agents/skills/develop-plugins/SKILL.md`.'
---

# Drive FINOS Workspace through the MCP Companion

Operate FINOS Workspace through the MCP Companion, not through browser automation, computer-use, screenshots or a screen-reader loop. The Companion exposes the signed-in browser tab as an MCP server so an AI tool outside FINOS Workspace (Claude Desktop, Claude Code, Cursor, Codex, any streamable-HTTP MCP client) reads and changes the user's dashboards through typed tool calls. Reaching for a browser driver to click the sidebar, drag a widget or read an element is the wrong path: eighteen tools cover snapshot, widget library, create, read, update, delete, layout, navigation, backends, apps and agent handoff, each with a schema and a deterministic result. Use them.

The server at `/mcp` on the FINOS Workspace API forwards each tool call to the connected tab, which runs it with the user's session. No tab connected, no call succeeds. The Agent inside the tab uses the same tools over a shorter in-session path (`copilotFunctionCall`, see `agent/CLAUDE.md`); a skill telling the in-tab Agent to use the Companion is wrong — this skill is for an external AI tool, including a coding agent that is helping the user build or test against a running stack.

Two implementations live in this repository: the production Python server (`backend-api/backend/workspace_mcp/`) that every deployment uses, and the TypeScript twin in the agent sidecar (`agent/mcp-server/src/bridge/`) that the dev stack can expose for parity tests. Both register the same eighteen tools; only the host origin differs.

## 1. Turn the Companion entry on

| Stack | Setting that shows the menu entry | Default |
|---|---|---|
| `docker-compose.yml` (project `workspace`) | `UI_SHOW_COMPANION_MCP_MODE=${UI_SHOW_COMPANION_MCP_MODE:-true}` on the `web` service | on |
| `local/compose.yaml` (project `workspace-local`) | `VITE_UI_SHOW_COMPANION_MCP_MODE: "true"` on `frontend` | on |
| A deployment (`MODE=production`) | `UI_SHOW_COMPANION_MCP_MODE=true` on the web container, then restart | off |
| Agent-side MCP server (`agent-mcp`) | `COMPANION_TOOLS_ENABLED=true` in `agent/.env`, defaults to `false`; registers the eighteen tools, the prompts and the app-builder resources at `/mcp`, and serves its own bridge at `/bridge/session/start`, `/bridge/ws` and `/bridge/health` | off |

- A deployment with the production backend serves `/mcp` from the API; the agent-side `agent-mcp` is only needed for the TypeScript twin, parity tests, or a local stack that runs the sidecar instead of the Python server.
- Confirm the entry: on the main menu of the sidebar, `MCP Companion` is listed.

## 2. Connect the tab

1. Sidebar menu → `MCP Companion`. The `FINOS Workspace MCP Companion` dialog opens.
2. Read the `Endpoint`. It is the API's `/mcp` address, for example `http://localhost:8000/mcp` on the root dev stack or `https://api.workspace.example.com/mcp` on a deployment.
3. Turn the switch on. Confirm the toast `FINOS Workspace MCP companion connected` and that the icon in the sidebar header turns green.
4. One tab at a time: a second tab replaces the first. A sign-out or an expired session closes the bridge.

## 3. Mint a personal access token

1. In the same dialog, section `Active Tokens`, select `Create Token`. Available only while the tab is connected.
2. In `Token name`, type a name (at most 100 characters). Select `Generate Token`.
3. Copy the value now. It starts with `ws_mcp_`. FINOS Workspace stores only a SHA hash, so the value is not shown again.
4. Below the token, four tabs preview the exact settings for `Prompt`, `.mcp.json`, `Claude Code` and `Codex`, with the endpoint and origin filled in.
5. Select `Done`. The token row lists the name, the first characters and the creation date.

Warnings:

- A token does not expire; it works until revoked. A person who has it gets the token owner's access to the dashboards. Treat it as a password.
- A `.mcp.json` file lives in a project folder, which teams commit. Keep token files out of a committed path or add them to `.gitignore`.

## 4. Configure the AI tool

Each client needs three settings:

| Setting | Value |
|---|---|
| Transport | MCP streamable HTTP. `stdio` and server-sent events do not work. |
| Address | The `Endpoint` from the dialog, equal to the API origin plus `/mcp`. |
| `Authorization` header | `Bearer <token>` on every request. |
| `Origin` header | The web app's own origin exactly. The API answers 403 `Requests must come from an allowed origin` otherwise. |

Configurations:

- `.mcp.json`:
  ```json
  {
    "mcpServers": {
      "workspace": {
        "type": "http",
        "url": "<endpoint>",
        "headers": {
          "Authorization": "Bearer <ws_mcp_token>",
          "Origin": "<web-app-origin>"
        }
      }
    }
  }
  ```
- Claude Code: the `claude mcp add` command previewed in the dialog.
- Codex: the `WORKSPACE_MCP_TOKEN` export and the `mcp_servers.workspace` block of `~/.codex/config.toml`, both previewed in the dialog.
- Prompt: text to paste into an AI tool that adds MCP servers itself.

On connect, the server ships `SERVER_INSTRUCTIONS` from `agent/mcp-server/src/bridge/instructions.ts` to the client (workflow, widget shape, layout grid, dashboard targeting). Treat that as authoritative; this skill mirrors the rules for an agent that reads a repository SKILL.md before it connects.

## 5. The eighteen tools

All names are snake_case; so are the JSON payloads. The exact arg lists live in `agent/mcp-server/src/tools/workspace/<name>.ts` and the Python implementations in `backend-api/backend/workspace_mcp/`.

| Tool | Does |
|---|---|
| `get_workspace_snapshot` | Dashboards, current route, composition, available skills. First call of a session, and after a navigation step. |
| `list_available_widgets` | Catalog of widgets, with an `origin` per widget. Pass the `origin` back unchanged on `create_widget`. |
| `get_widget_schema` | Exact contract of one widget: data args, UI args, layout defaults, min and max sizes, and `requires_options_lookup` flags. |
| `get_params_options` | Option values for a param whose schema says `requires_options_lookup=true`. Pass the schema's `paramName` as `param_name` and the `data_args_json` the schema asks for. |
| `create_widget` | Add a catalog widget. Needs `origin`, `widget_id`, and JSON-object strings for `data_args_json` and `ui_args_json`. Not for `rich_note`; see `add_generative_widget`. |
| `add_generative_widget` | Add a note, HTML, table or chart. `note` and `html`: `data_json` is the raw string. `table`: a JSON array of objects. `chart`: array of objects plus `chart_params_json` with `chartType`, `xKey` and a non-empty `yKey`. Response carries `widget_uuid`; use that UUID for later layout changes. |
| `read_widget` | State of one widget on the dashboard. Prefer `widget_uuid`; `widget_id` only when one instance of the id exists on the target. |
| `update_widget` | Change `data_args_json` or `ui_args_json` on an existing widget. Does not move or resize. |
| `delete_widget` | Remove one widget. |
| `update_widget_layout` | Move or resize one widget. The grid is 40 columns wide: full width `w=40`, half `w=20`, quarter `w=10`. Typical minimums `min_w=8`, `min_h=4`. A `navigation_bar` at `y=0 h=2` pushes the first content row to `y=2`. |
| `get_widget_data` | Fetch the current data of a widget. |
| `manage_dashboard` | `operation`: `create` (also activates the new route), `read` (returns tabs and composition) and `rename`. The Companion does not delete dashboards. |
| `manage_navigation_bar` | `operation`: `create` (adds the navigation_bar widget), `read`, `add_tabs`, `rename_tabs`, `remove_tabs`. `tabs_json` is always an array of objects with the single key `name`, for example `[{"name":"Quarterly Review"}]`. Strings and `tab_id` do not work. |
| `navigate_workspace` | Move the browser to a dashboard or a tab. Use the slug the previous tool call returned (for `Quarterly Review`, `quarterly-review`). |
| `manage_apps` | `operation`: `list`, `read`, `instantiate` (opens a new dashboard from the app). The Companion does not save, change or delete apps; the user does that in the web app. |
| `manage_backends` | `operation`: `list`, `add`, `update`, `refresh`, `remove`. |
| `assign_tasks_to_agents` | Hand tasks to the agents the user configured. |
| `get_skill_content` | Read a skill by slug the snapshot or catalog returned. |

## 6. Workflow

1. `get_workspace_snapshot` on the first call, then once per navigation that may have moved the current route.
2. Keep `session_context.current_dashboard_uuid` and `current_tab_id` from every successful result, and reuse them instead of snapshotting again. Never match dashboards by name — duplicates are common.
3. Writing to a new dashboard: `manage_dashboard operation="create"` first. The Companion activates the new route, so follow-up writes land on it.
4. Writing to a tab that does not exist: `manage_navigation_bar operation="add_tabs"` with `tabs_json: [{"name":"<Tab name>"}]`, then `navigate_workspace` to the returned slug, then write to the active tab. Do not pass `inner_tab` on `add_generative_widget` to create a tab; it only places on an existing one.
5. Catalog widget: `list_available_widgets` → `get_widget_schema` → `get_params_options` for any field with `requires_options_lookup=true` → `create_widget` with `origin`, `widget_id`, `data_args_json` and `ui_args_json`.
6. Generated widget (note, HTML, table, chart): `add_generative_widget` with `widget_type` and the payload the table in section 5 names. Response carries `widget_uuid`.
7. Place and size: `update_widget_layout` with `x`, `y`, `w`, `h` and `tab_id`. Read current placement with `manage_dashboard operation="read"` or from `get_workspace_snapshot.dashboard_composition`, not from `read_widget`.
8. Read, update and delete: prefer `widget_uuid` over `widget_id`. Never use a widget title or a generic type such as `rich_note` as a layout identifier.
9. Target another dashboard: pass `dashboard_id` explicitly. Omitting it targets the current route.

## 7. What the Companion cannot do

- Delete a dashboard.
- Save, change or delete an app. The user runs **Save App from Dashboard** in the sidebar; `docs/features/apps/save-a-dashboard-as-an-app.mdx` describes it.
- Act without a connected tab. Every call fails with the message that `constants.noBrowserMessage` holds (visible in `docs/features/mcp-companion/security-and-troubleshooting.md`).
- Exceed the user's own permissions. The token identifies the user; it never grants more.

## 8. If a call fails

| Status or result | Cause | Fix |
|---|---|---|
| `403` `Requests must come from an allowed origin` | `Origin` header missing or not an allowed web-app origin | Set `Origin` to the exact web-app origin from the dialog. |
| `401` with `invalid_token` | `Authorization` header missing, token wrong or revoked | Clear tokens on the AI tool and connect again with a fresh `ws_mcp_` value. |
| Tool result says `constants.noBrowserMessage` ("No FINOS Workspace tab is connected") | No tab is connected or the bridge dropped | Open FINOS Workspace, turn the Companion switch on, confirm the icon is green. |
| Tool result error code `timeout`, `retryable: true` | Tab did not answer in `constants.commandTimeoutSeconds` | Retry the same call. The API deduplicates by the client's request id. |
| 500 or hang on the agent-side sidecar | `COMPANION_TOOLS_ENABLED=false` on `agent-mcp` | Set it to `true` in `agent/.env` and recreate the service. |

Every call is idempotent on the API's request id, so a retry does not run twice.

## 9. Revoke a token

1. Open the `MCP Companion` dialog.
2. In `Active Tokens`, hover the row to show the trash icon at the end.
3. Select it. The next request with the token gets 401.

Revoke when the AI tool is no longer in use, when another person may hold the token, or when the machine is handed over.

## 10. End-to-end test on the dev stack

With the root stack up (or `local/`), the user signed in and the switch on:

1. Mint a token, copy the `.mcp.json` block, point one AI tool at it.
2. Ask it: `Take a snapshot of my FINOS Workspace`. Confirm the response names the current dashboard and lists tabs and widgets.
3. Ask: `List available widgets`. Confirm each entry carries an `origin`.
4. Ask: `Create a dashboard called MCP Companion test`. Confirm the tab switches to the new empty dashboard.
5. Ask: `Add a note called Hello with the text "from the companion"`. Confirm a markdown widget appears.
6. Ask: `Put the note on the left half`. Confirm `update_widget_layout` lands at `x=0 y=2 w=20 h=4` or similar, respecting the 40-column grid and the navigation bar row.
7. Ask: `Read the dashboard layout`. Confirm positions and widget UUIDs come back.
8. Ask the AI tool to repeat step 5 with a different `widget_uuid`; confirm the first call did not move the wrong widget.

## 11. Reference

- Concept: `docs/concepts/mcp-companion.md`
- Feature: `docs/features/mcp-companion/index.mdx`, `docs/features/mcp-companion/security-and-troubleshooting.md`
- Quick start: `docs/quick-start/connect-your-ai-tool.mdx`, `docs/quick-start/build-an-app-with-the-mcp-companion.md`
- MCP server reference: `docs/reference/mcp/workspace-mcp.mdx` (production Python), `docs/reference/mcp/agent-mcp.mdx` (TypeScript sidecar, with `COMPANION_TOOLS_ENABLED`)
- Bridge protocol: `docs/reference/protocols/workspace-bridge.mdx`
- Tool implementations: `agent/mcp-server/src/tools/workspace/*.ts` (eighteen files), `backend-api/backend/workspace_mcp/`
- Server-sent instructions: `agent/mcp-server/src/bridge/instructions.ts` (`SERVER_INSTRUCTIONS`)
- Browser-side handler: `frontend/src/components/AI/hooks/useWorkspaceBridgeCommandHandler.ts`, `frontend/src/components/AI/WorkspaceBridgeConnectionManager.tsx`, `frontend/src/components/AI/workspaceBridgeProtocol.ts`
- Companion dialog: `frontend/src/components/LayoutAuth/McpCompanionModal.tsx`, store at `frontend/src/lib/state/workspaceBridge.ts`
- Agent-side architecture note: `agent/CLAUDE.md` ("workspace owns MCP"; the Agent inside the tab uses `useWorkspaceBridgeCommandHandler` over `copilotFunctionCall`, not the Companion)
