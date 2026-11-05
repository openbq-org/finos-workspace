---
title: Link a widget to an MCP tool
sidebar_position: 15
---

# Link a widget to an MCP tool

A widget can name one MCP tool of its own backend. The AI agent uses that tool to query the backend for the data that the widget shows. The key is `mcp_tool`, and every widget type accepts it.

## Servers

A backend declares its MCP servers on the templates of its [`apps.json`](../../reference/schemas/apps-json.mdx), in the `mcpServers` list. Each server has a `name`, a `description`, a `url` and an `authType`. When a user connects the backend, FINOS Workspace registers each declared server once, and it records the server's declared name together with the backend's id. A server whose `authType` is `token` is switched on only when the backend connection has an `Authorization` header, and any other server is switched on at once. The backend's credentials are not copied to the server: the API sends a server the headers that the user saved for it, or the user's OAuth sign-in. The declared name cannot be edited, unlike the server's display name.

The agent's tools are the enabled tools of the connected servers that the user may use, and the browser sends them when the agent has MCP tools turned on. A user may use every server that one of the user's roles grants, every server that a backend declares when the user can use that backend, and every server that the user added on the MCP Servers page when the user's type may add connections. A backend declares servers in the `mcpServers` of its `apps.json` and in the `storage.mcpUrl` of its `iframe` widgets. Using the backend is the approval, so no server is granted one by one. The browser makes each call through `/app/mcp-proxy`, which checks the same access again for every `tools/call` request.

## The key

```jsonc
"mcp_tool": {
  "mcp_server": "<name of a server in the same backend's apps.json mcpServers>",
  "tool_id": "<the tool's name on that server>",
  "args": { "<tool argument>": "$<paramName>" }
}
```

| Key | Meaning |
|---|---|
| `mcp_server` | This key is required. It is the `name` of a server that the same backend's `apps.json` declares, and the comparison is exact. It is never a URL. |
| `tool_id` | This key is required. It is the tool's name on that server, and the comparison is exact. |
| `args` | This key is optional. It describes how the widget's parameters fill the tool's arguments. Each key is a tool argument, and each value is either `$<paramName>` or a literal string, number or boolean. Without `args`, every parameter whose name is a property of the tool's input schema fills that argument. With `args`, the mapping contains exactly what is written there. |

## Rules

1. **The link is opt-in.** A widget without `mcp_tool` has no linked tool. The link also adds nothing to the agent's tool list, because the server's tools are already there once the server is registered, enabled and allowed.
2. **The server must belong to the same backend.** When a widget's `mcp_server` names no server in its own backend's `apps.json`, FINOS Workspace reports the widget with `[mcp_tool/mcp_server]` and leaves it out. This check runs only when `apps.json` loaded without an invalid app. A backend that has no `apps.json` declares no server. When two servers with different URLs share one name in a backend, the later app becomes invalid.
3. **A call is attributed by identity.** FINOS Workspace attributes a call to a widget only when the server was registered for the widget's backend, the server's declared name equals `mcp_server`, and the tool equals `tool_id`.
4. **The link is active only when the tool is available.** The link is active when the tool appears in the request's tool list. That requires a connected and enabled server, a tool that is turned on, a server that is allowed to the user, and MCP tools turned on for the agent. In every other case the widget behaves as if it had no link.
5. **Several widgets can share one tool.** FINOS Workspace cites a call to the widget whose literal `args` all equal the call's arguments. When several widgets match, the one with the most literal arguments wins, and then the first one that the backend declares.
6. **It does not combine with `disableRetrievalForCopilot: true`**, because that setting keeps the widget away from the agent.
7. **Only the host uses the link.** A plugin's frame receives no trait for the link, and it has no command or permission to call the tool.
8. **An `iframe` widget has a separate mechanism.** The key `storage.mcpUrl` binds a server of the iframe's own to the instance, without the backend's credentials. It neither uses nor conflicts with `mcp_tool`. The backend that declares the server is the approval: whoever can use the backend can use the server's tools, and a changed address needs no new approval.

## What the web app and the agent do

Four parts of the system use the link:

1. **The agent is told about the link.** The web app assembles the request in `frontend/src/lib/utils/mcpLink.ts`. When the request's tools include the linked tool, the widget's row gains `mcp_tool: { server_id, tool_name, args }`. The values of `server_id` and `tool_name` come from the tool list and never from the strings in the widget.
2. **The agent shows the link to the model.** Its `search_widgets` rows carry `mcp_tool: { tool, args }`, with the tool named as the model calls it, and its prompt tags the widget in its lists with `[query tool: <name>]`. The agent does not route anything by this information, and the model chooses what to call.
3. **A call cites the widget.** The function `citeMcpCall` considers only widgets of the server's own backend that name the server's declared name and the tool. It builds the `input_args` by applying the mapping in reverse, and it puts arguments that map to no parameter into the citation's `details`. An answer cites a widget once, however many calls cited it. FINOS Workspace keeps the first citation of a widget, both for the calls of a linked tool and for those of an `iframe` widget's own server.
4. **The FINOS Workspace MCP returns the link** in the answers of `list_available_widgets` and `get_widget_schema`.

## Security

The web app reports the servers that a backend declares to the API, with `PUT /app/data-connectors/api-source/{source_uuid}/mcp-servers`, each time that it loads the backend. The API accepts the report from the backend's owner, and from a superuser for an organization's backend, and it answers 404 to anyone else. The API grants the reported servers, with every tool, to the users who can read the backend. A user can read the backends that one of the user's roles approves, and the user's own backends when the user's type may add connections. A backend that an admin added for the organization grants no server until a role approves it.

The link grants no access. The call uses the user's own connection to the server, the user's roles, the backends that the user can use and the servers that the user added decide whether the tool is available, and the proxy checks every `tools/call` request. The `args` mapping describes how parameters fill arguments but sets no policy, because the model chooses the arguments and the server decides what a call may do.

A name resolves only against the servers that the same backend declared. A widget therefore cannot have the results of another backend cited as its own, and it cannot point the backend's credentials at a host that the backend did not declare. Validate Widgets never calls a tool.

## Example

A backend's `apps.json` declares the server:

```json
[{ "name": "Teams", "tabs": {}, "mcpServers": [{ "name": "Team data", "url": "https://<mcp-host>/mcp", "authType": "token" }] }]
```

The `team_report` widget from [Widget requests](../../reference/protocols/widget-requests.mdx) opts in to the tool:

```json
"mcp_tool": { "mcp_server": "Team data", "tool_id": "get_team_report", "args": { "team_id": "$team", "period": "$period" } }
```

The agent's row for the widget names `get_team_report` and the mapping. A call with `{ "team_id": "platform", "period": "month" }` is cited as `team_report`, with the `input_args` `{ "team": "platform", "period": "month" }`. The same call on a widget of another backend that also names `Team data` does not match.

[The MCP tool link](../../reference/protocols/mcp-tool-link.md) lists the fields and shows what the code does in each case.
