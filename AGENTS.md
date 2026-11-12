# FINOS Workspace

Self-hosted analytics workspace: web app, API, agent, MCP servers, widget plugins, docs site ([workspace.finos.org](https://workspace.finos.org)).

## Layout

| Path | Contents | Stack |
|---|---|---|
| `frontend/` | Web app and admin panel | Vite, React, TypeScript, Biome, Vitest, Playwright, Storybook |
| `backend-api/backend/` | API, worker, migrations (`alembic/`), admin scripts (`scripts/`), Workspace MCP server (`workspace_mcp/`) | Python 3.13, FastAPI, Poetry, Alembic, pytest, Ruff |
| `agent/` | Copilot agent; `mcp-server/` holds its MCP server | Node, TypeScript, Hono, Vercel AI SDK (`ai`), `node --test` |
| `widget-plugins/` | Local plugin install directory that both stacks mount; git-ignored | |
| `docs/` | Documentation source; `docs/examples/` holds example plugins, backends and reference agents | Markdown, MDX |
| `website/` | Docs site | Docusaurus |
| `local/` | Development stack with hot reload (`make up`) | Docker Compose, make |
| `docker-compose.yml` | Stack of the images built from the Dockerfiles (`docker compose up --build`) | Docker Compose |
| `sbom/` | CycloneDX SBOMs, written by `.github/workflows/sbom.yml` | |
| `.github/workflows/` | CI | GitHub Actions |

Read "Agent rules" below before changing `agent/`.

## Skills

Task playbooks live in `.agents/skills/<name>/SKILL.md`. Load the one that matches the task.

| Skill | Use for |
|---|---|
| `install-locally` | Run the development stack or the built-image stack on a workstation |
| `deploy-remotely` | Build the images and deploy to a server with Docker Compose or to Kubernetes |
| `develop-plugins` | Build, validate, approve and try a widget plugin against a local stack |
| `contribute` | Branch, run the checks, sign off, open a pull request |

## Commands

| Task | Directory | Command |
|---|---|---|
| Backend lint | `backend-api` | `ruff check backend` |
| Backend tests | `backend-api/backend` | `poetry install --with dev && poetry run pytest tests -q` |
| Web lint | `frontend` | `npx biome ci .` |
| Web types | `frontend` | `npm run typecheck` |
| Web unit tests | `frontend` | `npm run test:unit` |
| Web e2e tests | `frontend` | `npm run test:e2e` |
| Agent types | `agent` | `npm run typecheck` |
| Agent tests | `agent` | `npm test` |
| Reference data | `website` | `npm run reference` |
| Docs site | `website` | `npm run typecheck && npm test && npm run build` |
| Example plugin | `docs/examples/<name>` | `npm ci --ignore-scripts && npm run build && npm test` |

- Node 26.12.1 for `frontend/`, `agent/` and `website/` (`engines` and CI `node-version`). Python 3.13 for the backend (`python = "~3.13"`).
- Install with `npm ci` in `agent/` and `npm ci --ignore-scripts` in `frontend/`, `website/` and the Node examples (`plotly-charts`, `ag-grid`, `sql-explorer`) in `docs/examples/`.
- CI pins Ruff 0.15.22 and Poetry 2.3.2 (`.github/workflows/backend-checks.yml`).
- Backend tests start MySQL and Valkey containers (testcontainers); Docker must run.
- Move `backend-api/backend/envs/.env` and `backend-api/backend/user_create.json` away before a full backend run and put them back after; the settings read both.
- `npm run test:e2e` needs a running HTTPS stack and `E2E_USER_EMAIL`, `E2E_USER_PASSWORD`: `frontend/TESTING.md`.
- `npm run reference` needs Docker and replaces `node_modules` in `agent/` and `frontend/`. Run it before the docs site checks.
- The `ag-grid` and `sql-explorer` tests also need a `.venv` with the Python test packages and a PostgreSQL: `.github/workflows/examples.yml`.
- Detail per part: `docs/tutorials/contribute/run-the-tests.md`.

## Rules

- Write no comments in code, in any language.
- Do not edit generated reference data by hand; `reference-data/` folders are git-ignored. Regenerate it: `docs/tutorials/contribute/regenerate-reference-data.md`.
- Do not edit `sbom/` by hand. `.github/workflows/sbom.yml` regenerates it on `develop`.
- A new database migration follows `docs/tutorials/contribute/add-a-database-migration.md`.
- A new backend setting is a `Field` with a `description` in `Settings` (`backend-api/backend/utilities/config.py`), which generates the settings reference, and goes in `backend-api/backend/envs/.env.example`.
- A new agent environment variable is described in `agent/src/lib/env-reference.ts`; a test fails without it.
- Never commit `.env` files, `user_create.json`, `backend-api/backend/scripts/cfgs/config.toml`, secrets, `local_storage/` or `widget-plugins/`.
- Keep changes to the files the task needs. No unrelated formatting changes.
- Run the checks for every part you changed before you commit.
- `MODE=local` (both Compose stacks) lets the API accept a private or plain `http` address from any user for a data backend, an agent or an MCP server, and lets a superuser develop a new version of an approved widget plugin in place. Deployments set `MODE=production`.

## Git

`develop` is the integration branch. All work goes through feature branches off `develop` and pull requests into it.

- Check the current branch first. On `main` or `develop`, create a feature branch.
- Branch off the latest `origin/develop`:

```bash
git fetch origin && git switch --no-track -c feature/<short-name> origin/develop
```

- Name branches `feature/<short-name>`: lowercase, hyphenated.
- Never commit to `develop` or `main`. Never branch off or open pull requests into `main`, except for a release someone explicitly asked for.
- Commit with `git commit -s`. The only trailer is the committer's own `Signed-off-by`; the DCO check fails a pull request with an unsigned commit (`CONTRIBUTING.md`).
- Push and open pull requests only when asked:

```bash
gh pr create --base develop
```

- A pull request description must not be empty; `.github/workflows/pr-description.yml` fails on an empty one.

## Agent rules (`agent/`)

Copilot agent for the FINOS Workspace: Hono, Node, Vercel AI SDK, MCP. Node strips the types and runs the TypeScript as it is (`node src/server.ts`): no build step. Paths in this section are relative to `agent/`.

Architecture, tool inventory, file layout, env vars, request flow, the MCP and citation protocols and the test strategy: `agent/README.md`. This section is rules, conventions and gotchas only.

### Commands

| Command | Runs |
|---|---|
| `npm run dev:agent` | Agent on `:7777` (`PORT`) |
| `npm run dev:mcp` | MCP server on `:8787` (`MCP_PORT`) |
| `npm run dev:all` | Both |
| `npm run typecheck` | `tsc --noEmit`; must be zero errors |
| `npm test` | `node --test` over `tests/` and `mcp-server/test/`; must be all green before merge |

### Hard rules: thin harness

The agent owns protocol round-trips, widget tier/parse, citation aggregation, the system prompt and **state-bound capabilities** (SQL family on `pendingTables` + `artifactQueue`, its own bridge ops from the vendored bridge contract). Stateless, heavy or cold-start capabilities live in the MCP server. A new capability that needs in-process state the FINOS Workspace cannot reach is an agent tool; otherwise add it to `mcp-server/`.

- **No content-based routing in the harness.** No `isStructured()`, no `if data looks like X then path A else path B`. Surface tools, let the model pick. Generic dispatch by tool source (in-process, SSE round-trip, MCP) is structural, not content-based.
- **Never open MCP connections from the agent.** The FINOS Workspace owns MCP. The agent emits `executeAgentTool` (`copilotFunctionCall` with `function: "execute_agent_tool"`) for MCP tools (the FINOS Workspace's own among them, server id `workspace`), `workspaceCommand` (`copilotFunctionCall { function: <command> }`) for its own bridge ops (only for a request that does not carry the FINOS Workspace's tools), or runs the tool locally (`search_widgets`, SQL family, native tools).
- **One `streamText` per iteration.** The outer `MAX_LOOPS = 3` (`src/agent/loop.ts`) exists only for what resolves without an HTTP round-trip (cache-resolved widget re-fetches, the agent's own skills in `src/skills/`), not for orchestration. The loop consumes `fullStream` so in-process tool chains stream progress live; `LLM_STREAM_TIMEOUT_MS` bounds a stalled call.
- **Tools have `execute` only when the work is local + cheap, or state-bound to in-process data:** `search_widgets` (closure on `tieredWidgets`, primary/secondary/extra kept for ranking), the SQL family (closure on `pendingTables` + `artifactQueue`) and the native tools in `NATIVE_TOOL_NAMES` (`src/agent/tools/native.ts`). Widget data, skill, bridge ops and MCP-registered tools have no `execute`.
- **Prepare, don't prescribe.** Ship widget rows into `pendingTables`; the model decides whether to call SQL or answer directly.
- The only acceptable harness branching is `lastMessage.role === "tool"` dispatched by `toolMsg.function` (`get_widget_data` default, `get_skill_content`, `execute_agent_tool`).

### Context: serve the current turn, fetch the rest

- **The model is given the current turn only** (`src/agent/messages.ts`, `src/agent/history.ts`): the user's last message, what has happened since, and one small note that earlier messages exist. Never put earlier turns, answers or whole tool results back into the model input: they cost every later request more and count against the user's tokens. A turn that needs them reads them with `recall_conversation`.
- **What the agent needs from an earlier turn is read from `request.messages`** (`earlierEntries(request.messages)` in `src/agent/loop.ts`), not from `ctx.messages`.
- **The note is constant in size**: a count and the last eight questions, cut short (`NOTE_QUESTIONS`, `NOTE_QUESTION_CHARS`). Do not make it grow with the chat.
- **The model is given the tools it uses, and knows the rest exist** (`src/agent/tool-groups.ts`):
  - `CORE_TOOLS` are always there: `search_widgets`, `get_widget_data`, `get_skill_content`, `recall_conversation`, `suggest_followups`, `load_tools`.
  - Tools the FINOS Workspace supplies are given in full, never deferred, so the model reads their descriptions and parameters before it acts. Those of servers the user connected belong to no group; the FINOS Workspace's own are the `always` group `workspace`, matched by server id, never in the catalog, its notes always in the prompt.
  - Every other tool belongs to a group (`sql`, `dashboard`, `apps`, `render`, `components`, `planning`, `documents`, `web`) that the system prompt lists in one line and the model loads with `load_tools`. A group's `notes` are in the prompt only while it is loaded: write them in the group, never in `BASE_PROMPT`.
  - `prepareStep` rebuilds the prompt and the active tools at every step; loaded groups ride in `extra_state.loaded_tool_groups`. A call to a tool of an unloaded group is not refused: it loads the group.
  - The agent loads a group itself only when the state makes it certain (tables loaded: `sql`; a PDF/DOCX widget or upload: `documents`). That decides which definitions are offered, never which path the model takes.
- **Documents are searched, not shown.** A PDF/DOCX (chat attachment or PDF widget) never enters the model input, as bytes or as a `file` part. The round trip leaves a pointer, the agent ships the file's signed link to `query_documents` (`x-agent-documents`, `url`), and the MCP server fetches it with `fetchClientUrl`. `src/protocol/citations.ts` shapes the citations: the MCP server reports every page it returned with its score, and the pages the shown answer names (`sink.text`, never the raw model text) are cited as the file widget at that page (`details: [{ Filename, Page }]`, the shape `frontend/src/components/AI/Citation.tsx` opens). Reported pages ride in `extra_state.document_hits`.

### TypeScript

- `strict: true`, zero errors at all times. CI gates on this.
- Node runs the files with types stripped: a relative import names the file with its extension (`./loop.ts`), a type is imported with `import type` (`verbatimModuleSyntax`), and only erasable syntax is used: no `enum`, no `namespace` with code, no constructor parameter properties (`erasableSyntaxOnly`).
- No `any` unless unavoidable (`src/lib/process-guards.ts` holds the one). Prefer `unknown` + type guards.
- `interface` for object shapes, `type` for unions/intersections.
- Wire types live in `src/protocol/types.ts`, MCP-result types in `src/mcp/results.ts`, `ContentItem` helpers in `mcp-server/src/lib/typed.ts`.

### Zod is the source of truth

- Every tool input is a Zod schema. Validate with `.parse()`, **never `as`**.
- Use `.describe()` on every field; the description is what the model sees.
- The MCP schema layer (`src/mcp/schema.ts`) handles `enum`, `anyOf`, `oneOf`, `null`, nested `object`, `array.items`, `nullable`, `const`. Extend it rather than collapsing into `z.unknown()`.

### Vercel AI SDK patterns

| Tool | Definition |
|---|---|
| Auto-execute: local + cheap, or state-bound to in-process data | `tool({ description, inputSchema, execute })` |
| Round-trip: no `execute`, the loop stops and the harness emits SSE | `tool({ description, inputSchema })` |

`stopWhen` holds one `hasToolCall(name)` per round-trip tool: `get_widget_data`, `get_skill_content`, every name in `SSE_BRIDGE_COMMANDS` (`src/protocol/bridge-emit.ts`, while the agent's own bridge ops are registered), plus `mcpToolsResult.stopCondition` for MCP tools and `stepCountIs(15)`.

Consume `result.fullStream` and emit live as parts arrive (`src/agent/loop.ts`):

- `text-delta`: held for the step (`pendingText`), never sent as it arrives. At the end of the step, or at its first `tool-call`, `showPendingText` decides by the tool calls alone: a step with a tool call is **reasoning** (one `reasoningStep`, sanitized, at least 15 characters, deduped); a step with none is the **answer**, sent whole through the text sink as `messageChunk`s (`mergeMessageChunks` joins the sink's 4 KB slices). The model must never make text appear token by token, and the loop never classifies text by its content.
- **Tool calls written into the text** (`<tool_call>{…}</tool_call>`, `<function=…>`, `[TOOL_CALLS]`) become real `tool-call` parts in `src/lib/inline-tool-calls.ts`, a `LanguageModelV3Middleware` that `resolveModel` (`src/lib/providers.ts`) applies unless `AGENT_INLINE_TOOL_CALLS=off`. An unreadable marker, or one naming a tool that is not offered, is dropped, never shown. A new marker format is a row in `FORMATS`, with a test.
- `tool-call`: one `reasoningStep` per call, carrying `tool_call: { tool_name, input }`, which the eval trace runner reads to attribute in-process calls.
- Drain `artifactQueue` after every part. The SQL family pushes from `execute`; MCP results push from `processMcpResult` on the next re-POST. Message artifacts go out at their `tool-result`; those of `create_artifact` wait for the answer (`deferredAnswerArtifactEvents`).
- `abort`/`error`, or a thrown stream error: ERROR `reasoningStep` + return.
- After the stream drains, `await result.steps`, `result.totalUsage` and `result.text` for the round-trip dispatch (`lastStep`, `finalText`).

Tools never yield SSE directly. `artifactQueue` is the single ordered side-channel.

### Decoration (`x-agent-*`)

Some data rides along with an MCP call without the model seeing it: `x-agent-conversation-id`, `x-agent-scope-sig` and `x-agent-documents` for `query_documents`/`list_documents`; `x-agent-conversation-id`, `x-agent-scope-sig` and `x-agent-url-sig` for `fetch_webpage`/`inspect_webpage`.

1. Inject into the parameters in `src/agent/loop.ts` right before yielding `executeAgentTool`.
2. Read on the MCP side from the tool's args object.
3. **Any new internal-only key starts with `x-agent-`**: `src/mcp/schema.ts` strips that prefix from the model-facing schema. Without it the model sees the field and invents values.

The document tools ship only the delta: `documentsShipped` tracks the documents already sent, persisted as `extra_state.documents_shipped`. Every round-trip emission carries the continuation `extra_state` (`buildContinuationExtraState` in `src/agent/loop.ts`); an emission that drops those keys wipes the delta state mid-turn.

The SQL family lives in-process and reads `pendingTables` directly: no decoration, no wire payload.

### Conventions

- AsyncGenerators for SSE: every response path yields `SSEEvent` objects, never writes directly.
- LogTape: the agent logs under `["app", ...]`, the MCP server under `["mcp", ...]`. A grep on `conversationId` traces a request across both processes.
- No classes except `Error` subclasses. Pure functions and interfaces.
- Request-scoped state goes in tool factories: `makeSearchWidgetsTool(tieredWidgets, linkedTool)`, `makeSqlTools({ pendingTables, artifactQueue })`, `makeNativeTools(ctx)`, `makeMcpTools(agentTools)`, `makeRecallConversationTool(earlierMessages)`. Stateless factories (`makeWidgetDataTool`, `makeGetSkillContentTool`, `makeWorkspaceTools`) follow the same convention.
- MCP server tool files export `<name>Schema`, `<name>Description`, `<name>Handler` and are registered in `TOOLS` in `mcp-server/src/app.ts`.
- Use `singleShotLlm` (`src/lib/llm.ts`) for any new `/v1/generate/*` route; do not hand-roll a `generateText` wrapper.

### Gotchas

- **`X-Trace-Id` is the conversation key.** The FINOS Workspace sets it per chat; `src/routes/query.ts` turns it into `conversationId` (`scopeKey(userId, chatId)` with `AGENT_AUTH=workspace`), which the loop threads into the decoration of the tools that keep state per chat. Per-chat state derives from it; never invent another ID.
- **MCP `content[]` arrives flattened.** The FINOS Workspace's `useMcpExecutor.ts` JSON-stringifies the whole array into one text item. `processMcpResult` recurses into array elements; keep that when adding typed-result kinds.
- **The model must see tool outcomes.** Artifacts ride the SSE side-channel, so `dispatchTyped` (`src/mcp/results.ts`) injects a delivery-ack line into the model message, and `buildMessages` renders every *earlier* `execute_agent_tool` result with `renderToolResultForHistory` (pure: no queue pushes, no `rememberRows`); the last tool message stays with `injectFromReboot`. A new typed-result kind extends BOTH `dispatchTyped` and `renderToolResultForHistory`, or the model forgets that kind and re-runs finished work.
- **The FINOS Workspace's own tools are MCP tools of server `workspace`** (`src/protocol/workspace-server.ts`):
  - `makeMcpTools(agentTools)` registers all of them with their own names, descriptions and schemas, except `get_skill_content` (the agent's own), on every page. They are the `always` group `workspace`.
  - While the request carries any of them (`workspaceToolsOffered`) the agent's own bridge ops are not registered: one surface per capability.
  - Their calls are `execute_agent_tool`, which the browser runs one at a time: the calls of a step after the first wait in `extra_state.pending_workspace_calls`, and the loop makes them one per re-POST before it asks the model again. That queue comes back from the browser, so only a FINOS Workspace tool this request registers is called from it.
  - Never give the model a widget without its `origin` (the prompt lists it); the FINOS Workspace's tools need it.
  - A widget's `current_value` is what it shows now (the web app's `createCopilotWidget` resolves parameter groups). For an `[iframe]` widget (`widget_type`) it is the widget's state: the model reads state from it, changes it with `update_widget` (which delivers the value to the page through the iframe protocol and confirms it), and uses the widget backend's own tools only for what parameters cannot say (the backend sends their event to the page itself; the FINOS Workspace does not deliver it). A result that is not `dispatched`/`confirmed` is not a change.
  - Never call `get_widget_data` for a task that does not need the widget's data, and never read an iframe widget's state from it: that is the page. A widget's text is never shown in the chat as an artifact; only tables are.
- **Bridge ops are round-trips, one per turn.** The agent emits exactly ONE `copilotFunctionCall` per turn, the first bridge call of the step; the browser runs each emission and re-POSTs at once, so a second one would fork the conversation. The rest of the step's bridge calls are QUEUED in `extra_state.pending_bridge_calls` and drained one per re-POST before the model runs again, not re-issued by the model (2026-06-11: 19 calls, 1 executed, the rest dropped, success hallucinated). The queue rides the `extra_state` echo (`functionCallSchema` in `frontend/src/lib/utils/ai.ts` keeps it via `z.unknown()`). `buildMessages` renders EARLIER bridge results into history so the final turn knows every queued change landed. Command names go over the wire verbatim. The browser runs the op through `useWorkspaceBridgeCommandHandler` (shared with the WebSocket companion bridge) and re-POSTs a `{status, message, data}` tool result. Bridge emissions carry `buildContinuationExtraState` like every round-trip. `WORKSPACE_BRIDGE_COMMANDS` in `src/protocol/bridge-commands.ts` declares 16 ops; the agent registers the 6 in `SSE_BRIDGE_COMMANDS`.
- **SQL family runs in-process.** Its tools have `execute` and read `pendingTables` from the factory closure. `create_artifact` pushes the artifact onto `artifactQueue`, and the loop holds it until the answer. No decoration, no wire payload.
- **MCP factory filter.** `src/mcp/factory.ts` drops a tool of any server other than `workspace` whose name, or its `_<name>` suffix, is an agent-owned name: `WORKSPACE_BRIDGE_COMMAND_NAMES`, `BRIDGE_MOUNT_EXTRA_NAMES` (`update_widget_layout`, `update_widget`, `create_widget`, `get_widget_data`, `get_skill_content`), `SQL_TOOL_NAME_SET` and `NATIVE_TOOL_NAME_SET`. Add a new agent-owned tool to `NATIVE_TOOL_NAMES` (`src/agent/tools/native.ts`) or `SQL_TOOL_NAMES` (`src/agent/tools/sql/index.ts`) so a server's tool of the same name does not register twice.
- **A turn spans N POSTs, and telemetry follows it.** `extra_state.traceparent` (span context of the turn's FIRST request, echoed verbatim, never rewritten per hop) and `extra_state.turn_usage` (token total across all requests) ride `buildContinuationExtraState`. Drop them and the turn splits into disconnected traces with lost cost. Both are browser-echoed, so both are parsed defensively (`parseTraceparent`, `readTurnUsage`: null/zero, never throw). The turn span ends in the loop's `finally`. Telemetry is a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_TRACES_CONSOLE=true`) is set; do not add spans inside tool implementations, the AI SDK already emits `ai.toolCall` spans.
- **The prompt advertises only registered tools.** `buildSystemPrompt` lists tools from the `ToolCatalog` that `buildToolCatalog` builds from the registered tool set and `makeMcpTools(...).entries`, never from raw `request.tools`. A mismatch makes the model call ghost tools (a name with no schema, invented args, `NoSuchToolError`, then claimed success).

### Many users: rules that keep one user from another

The agent serves many users (`agent/README.md`, "Running for many users"). A change that breaks one of these rules is a security bug.

- **The user is the principal on the context** (`c.get("principal")`, set by `src/auth/middleware.ts` from the session token the FINOS Workspace API recognised). Never read `X-User-Id` or any other client-set header for an identity.
- **State kept for a chat is filed under the scope key** (`scopeKey(userId, conversationId)` in `src/lib/scope.ts`), which is `conversationId` inside the loop. Never key a cache or a store by the raw `X-Trace-Id`. A call to an MCP tool that keeps state carries that key and its signature (`x-agent-scope-sig`), and the tool checks it (`mcp-server/src/lib/scope-check.ts`).
- **A URL from a client is fetched with `fetchClientUrl`** (`src/lib/safe-fetch.ts`), never `fetch`: it refuses internal addresses and caps the size. The same goes for a new MCP tool that takes a URL.
- **Everything the FINOS Workspace decides is asked of the FINOS Workspace API** (`src/auth/workspace-client.ts`): who the user is, their roles, their limits. Do not copy that state into the agent.
- **Logs name things; they do not carry conversations.** Redaction (`src/lib/redact.ts`) is the last defence: log ids, counts and outcomes, never a request body, a message, a file or a token.
- **No metric label from a user, a chat or model-generated text.** Every distinct label value is a series that Prometheus keeps.
- **Work on a stranger's bytes does not run in the agent's own thread.** SQL, spreadsheets, PDF/Word text and page conversion go through `runInChild` (`src/lib/isolate.ts`): a child process with a minimal env (`PATH`, `NODE_ENV`, `LOG_LEVEL`, `LOG_FORMAT`), a deadline and SIGKILL. A worker thread cannot be stopped inside native SQLite, and an in-process parser on a megabyte of text blocks every query and the health check. Check sizes, and a ZIP's directory (`src/lib/zip-guard.ts`), before reading and before any model or embedding call.
- **Every process-wide cache is bounded and filed under the scope key** (`createBoundedCache` in `src/lib/bounded-cache.ts`: age, entries, weight). A `Map` that only grows, or one keyed without the user, is a bug. The one exception is the tool cache behind `mcpTool` in `src/mcp/schema.ts`: its key is a hash of the tool's own definition, so it holds nothing one user could read through another, and it is bounded by entries, bytes and age.
- **What outlives a request goes in the store, not in a module-level `Map`** (`src/lib/store.ts`). It is shared when `REDIS_URL` is set and per-process when it is not. A chat's tables and widget data are kept in Redis alone (`store.sharedOnly()`), never in a process's memory. The store never throws: an operation Redis cannot answer falls back to this process, so a new one must be a cache or a limit, never a correctness check. The exception is `limits.running()` (`src/auth/limits.ts`), local on purpose because a shutdown waits for this replica's queries.
- **A pattern that meets outside text is tested with hostile text** (`tests/unit/src/lib/redos.test.ts`): nested or adjacent `\s*`, `[^x]*` that restarts at every character, and unbounded alternation take time with the square of the text. Bound the text first (`redactString`) or the gap (`pagesNamedIn`).
- **What the model reads is data, and an address it fetches or shows is a way out.** The agent signs a `fetch_webpage` address only if it was in what the model was given (`src/agent/known-urls.ts`; never a result of a tool that computes or repeats, never the model's own text), and the text sink turns `![](…)` images into links (`neutralizeImages`). A new tool that sends a request where the model says, or a new way for the answer to load a resource, needs the same. **A tool that reads outside content returns only that content, never the caller's own words** (`inspect_webpage` does not repeat its selector, phrase or path), because its results count as given (`READING_TOOLS`). A web page is read in parts through `fetch_webpage` (overview + `page_id`) and `inspect_webpage`, never whole (`src/lib/page-view.ts`, in a child; every view is bounded).
- **A capability an administrator can switch off is asked of the FINOS Workspace, never decided here.** The web tools are `SEARCH_WEB` and `FETCH_FROM_WEB` (role settings, on for a user when any of their roles allows them); the API's authorize answer carries `disabled_capabilities` and the denied tools. The agent's own use of a capability (the eager prefetch of a message's addresses is `FETCH_FROM_WEB`) is skipped when it is off, and the model is told (`describeDisabledCapabilities`). A new switchable tool is a new `CopilotCapability` in `backend-api/backend/api/schemas.py` and the same three steps: role setting, authorize, proxy.
- **A new setting with an open default (no auth, `*`) is a bug.** The secure value is the default; the open one is a named opt-out (`AGENT_AUTH=none`).

### When adding a capability

1. **Stateless, heavy or cold-start (web search, fetch):** write an MCP tool in `mcp-server/src/tools/backend/`. Export `<name>Schema`, `<name>Description`, `<name>Handler`, add it to `TOOLS` in `mcp-server/src/app.ts`, and use the `mcp-server/src/lib/typed.ts` helpers for artifacts, citations and tables.
2. **State-bound (`pendingTables`, `artifactQueue` or other request-scoped state):** add an agent tool under `src/agent/tools/` with an `execute` that closes over the context, in the `make<Name>Tool(ctx)` pattern.
3. **New bridge op:** extend `src/protocol/bridge-commands.ts` (Zod schema, description, name in `WORKSPACE_BRIDGE_COMMANDS`); to emit it from the agent, add the name to `SSE_BRIDGE_COMMANDS` (`src/protocol/bridge-emit.ts`).
4. **Give every new tool a group** in `src/agent/tool-groups.ts` (core only if nearly every question needs it), with its instructions in the group's `notes`, not in `BASE_PROMPT`. An MCP tool no group claims is not deferred. Keep tool descriptions short: they cost every call of every question that loads the group.
5. Update the tool tables in `agent/README.md` when adding or removing a tool.
