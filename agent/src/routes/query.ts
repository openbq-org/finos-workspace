import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AgentTool, QueryRequest, SSEEvent, ToolMessage, WorkspaceState } from "../protocol/types.ts";
import { sseResponse } from "../protocol/stream.ts";
import { messageChunk, reasoningStep } from "../protocol/events.ts";
import { getTieredWidgets } from "../widgets/tiers.ts";
import { resolveModel } from "../lib/providers.ts";
import { getLogger, withContext } from "../lib/logger.ts";
import { bodyBudget } from "../lib/body-budget.ts";
import { metrics } from "../lib/metrics.ts";
import {
  bodyTooLarge,
  busy,
  defineRoute,
  invalidRequest,
  named,
  tooManyRequests,
  unauthorized,
} from "../lib/openapi.ts";
import { scopeKey } from "../lib/scope.ts";
import type { UsageCounts } from "../lib/token-usage.ts";
import { ANONYMOUS, type AppEnv, type Principal, type Services } from "../auth/middleware.ts";
import type { Capability, Failure, ToolRef } from "../auth/workspace-client.ts";
import { runAgentLoop, cacheWidgetItemsFromReboot } from "../agent/loop.ts";
import { WORKSPACE_BRIDGE_COMMAND_NAMES } from "../protocol/bridge-commands.ts";
import { AGENT_ID } from "./agents.ts";

const logger = getLogger(["app", "routes", "query"]);
const audit = getLogger(["audit"]);

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const LIMITS = { messages: 20_000, widgets: 20_000, tools: 500, skills: 500, pluginArtifacts: 100, documents: 50, context: 500, options: 100 } as const;

const MessageSchema = z
  .object({
    role: z
      .enum(["human", "ai", "tool"])
      .describe("Who wrote the message: the user, the agent, or the browser's result for a request of the agent."),
  })
  .passthrough();
export const WidgetSchema = z
  .object({
    uuid: z
      .string()
      .max(500)
      .optional()
      .describe(
        "The widget's identifier on the dashboard. A widget of the catalog that is not on the dashboard has none, and the agent identifies it by its widget_id.",
      ),
    origin: z.string().max(500).optional().describe("The name of the backend that serves the widget."),
    widget_id: z.string().max(500).optional().describe("The widget's id in its backend."),
    name: z.string().max(2_000).optional().describe("What the model reads to choose a widget."),
    description: z.string().max(50_000).optional().describe("What the model reads to choose a widget."),
    widget_type: z.string().nullish().describe("The kind of widget, for example markdown, html or iframe."),
    params: z
      .array(z.object({}).passthrough())
      .max(1_000)
      .optional()
      .describe(
        "The widget's parameters. Each has a name, a type, a description, a default_value, a current_value, a list of options and multi_select.",
      ),
    columns: z
      .array(z.string())
      .nullish()
      .describe("The column names of the rows that a widget on the dashboard has loaded."),
    category: z.string().max(500).optional().describe("What the model reads to choose a widget."),
    sub_category: z.string().max(500).optional().describe("What the model reads to choose a widget."),
    source: z.string().max(500).nullish().describe("Free-form details about the widget."),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Free-form details about the widget. For a widget on the dashboard, it holds lastUpdated, the time of its last update in milliseconds since 1970.",
      ),
    mcp_tool: z
      .object({
        server_id: z.string().max(500).describe("The id of the MCP server that has the tool."),
        tool_name: z.string().max(500).describe("The name of the tool on that server."),
        args: z
          .record(z.string().max(200), z.union([z.string().max(256), z.number(), z.boolean()]))
          .refine((args) => Object.keys(args).length <= 32, "Too many arguments")
          .optional()
          .describe("The arguments that the tool receives, by name."),
      })
      .optional()
      .describe("A link from the widget to an MCP tool."),
  })
  .passthrough();

export const QueryRequestSchema = z.object({
  messages: z
    .array(MessageSchema)
    .min(1)
    .max(LIMITS.messages)
    .describe("The conversation, oldest first. A message has the role human, ai or tool."),
  model: z.string().max(200).optional().describe("Accepted but not used. The agent reads the model from workspace_options.model."),
  widgets: z
    .object({
      primary: z.array(WidgetSchema).max(LIMITS.widgets).optional().describe("The widgets that the user selected or mentioned."),
      secondary: z.array(WidgetSchema).max(LIMITS.widgets).optional().describe("The other widgets of the dashboard."),
      extra: z.array(WidgetSchema).max(LIMITS.widgets).optional().describe("The rest of the catalog."),
    })
    .optional()
    .describe("The widgets that the agent may read, sorted into three tiers: primary, secondary and extra."),
  context: z
    .unknown()
    .refine((v) => !Array.isArray(v) || v.length <= LIMITS.context, "Too many context items")
    .optional()
    .describe(`Items that the user attached, such as artifacts of earlier answers. A list has at most ${LIMITS.context} items.`),
  urls: z
    .array(z.string().max(4_000))
    .max(8)
    .optional()
    .describe("Web addresses that appeared in the user's message. The agent fetches them for the model unless an administrator turned the web tools off."),
  timezone: z.string().max(100).optional().describe("The user's time zone, such as Europe/Paris."),
  workspace_state: z
    .unknown()
    .optional()
    .describe("Where the user is: the current page, dashboard and tab, and the recent actions. The agent ignores a value that does not have this shape."),
  workspace_options: z
    .record(z.string().max(100), z.union([z.boolean(), z.string().max(500)]))
    .refine((o) => Object.keys(o).length <= LIMITS.options, "Too many options")
    .optional()
    .describe(
      `The settings that the user picked from the features of the descriptor, as an object of names to booleans or strings. At most ${LIMITS.options} keys.`,
    ),
  skills_catalog: z
    .array(
      z.object({
        slug: z.string().max(200).describe("The slug of the skill."),
        description: z.string().max(4_000).describe("What the skill is for."),
        updatedAt: z.string().max(100).optional().describe("When the skill was last changed."),
      }),
    )
    .max(LIMITS.skills)
    .optional()
    .describe("The skills in the user's library."),
  plugin_artifacts: z
    .array(
      z.object({
        plugin: z.string().max(100).describe("The id of the plugin that offers the artifact."),
        widget: z.string().max(100).describe("The id of the widget the artifact is."),
        name: z.string().max(500).describe("The name the artifact is shown under."),
        description: z.string().max(4_000).describe("What the artifact holds and when it is useful."),
        data_schema: z.record(z.string(), z.unknown()).describe("The JSON Schema of the data the artifact holds."),
        config_schema: z.record(z.string(), z.unknown()).optional().describe("The JSON Schema of the settings the user picks for the artifact, when it has any."),
      }),
    )
    .max(LIMITS.pluginArtifacts)
    .optional()
    .describe("The artifacts that the plugins of the organization offer the agent, each with the data it may fill in."),
  selected_skills: z
    .array(z.object({
      slug: z.string().max(200).describe("The slug of the skill."),
      description: z.string().max(4_000).describe("What the skill is for."),
      contentMarkdown: z.string().max(500_000).optional().describe("The text of the skill. The user's own skills carry it."),
      source: z.enum(["forced_slash", "model_selected"]).describe("Whether the user forced the skill with a slash command or the model selected it."),
    }))
    .max(20)
    .optional()
    .describe("Skills that the user forced with a slash command, or that the model selected. The user's own skills carry contentMarkdown."),
  tools: z
    .array(z.object({
      name: z.string().max(500).describe("The name that the agent uses for the tool, which joins the server's name and the tool's name."),
      tool_name: z.string().max(500).optional().describe("The name that the server knows."),
      server_id: z.string().max(500).describe("The id of the MCP server."),
      url: z.string().max(4_000).describe("The address of the MCP server."),
      description: z.string().max(20_000).optional().describe("What the tool does."),
      input_schema: z.object({
        properties: z
          .record(z.string(), z.record(z.string(), z.unknown()))
          .refine((p) => Object.keys(p).length <= 200, "Too many properties")
          .optional()
          .describe("The schema of each argument, by name."),
        required: z.array(z.string().max(200)).max(200).optional().describe("The names of the arguments that a call must have."),
      }).optional().describe("The JSON Schema of the tool's arguments."),
    }))
    .max(LIMITS.tools)
    .optional()
    .describe("The tools of the MCP servers that the user connected, which the agent may ask the browser to run."),
  documents: z
    .array(
      z.object({
        id: z.string().max(200).describe("The id of the document."),
        name: z.string().max(500).describe("The file name."),
        format: z.enum(["pdf", "docx", "txt", "md", "html"]).describe("The format of the file."),
        content_b64: z.string().max(35_000_000).optional().describe("The content of the file, in base64. A document has this or url."),
        url: z.string().max(4_000).optional().describe("The link of the file. A document has this or content_b64."),
      }).refine((d) => !!d.content_b64 || !!d.url, {
        message: "Document must have either content_b64 or url",
      }),
    )
    .max(LIMITS.documents)
    .optional()
    .describe(
      "Files sent inline. The agent accepts them but treats the field as deprecated, because the web app sends a file as a widget in widgets.primary instead. Each needs content_b64 or url.",
    ),
});

export const queryRoute = defineRoute({
  method: "POST",
  path: "/v1/query",
  tag: "query",
  summary: "Asks a question.",
  description:
    "Asks the agent a question. The answer is a stream of events, as the agent query protocol describes. The request holds the conversation, the widgets of the dashboard, the tools that the workspace offers, the documents that the user sends and the state of the workspace.",
  request: { contentType: "application/json", required: true, schema: named("QueryRequest", QueryRequestSchema) },
  responses: [
    { code: "200", description: "The stream of events that answers the question.", contentType: "text/event-stream" },
    invalidRequest(),
    unauthorized(),
    bodyTooLarge(),
    tooManyRequests(),
    busy(),
  ],
  secured: true,
});

const WorkspaceStateSchema = z.object({
  current_page_context: z.string(),
  current_dashboard_uuid: z.string().optional(),
  current_dashboard_info: z.object({
    id: z.string(),
    name: z.string().optional(),
    current_tab_id: z.string(),
    tabs: z.array(z.object({
      tab_id: z.string(),
      widgets: z.array(z.object({
        widget_uuid: z.string(),
        name: z.string().optional(),
        copied_from: z.object({
          widget_uuid: z.string(),
          name: z.string(),
          created_at: z.string().optional(),
        }).optional(),
        from_artifact: z.object({
          artifact_uuid: z.string(),
          name: z.string(),
          created_at: z.string().optional(),
          in_current_chat: z.boolean().optional(),
        }).optional(),
      })).optional(),
    })).optional(),
  }).nullish(),
  action_history: z.array(z.string()).optional(),
}).passthrough();

function parseWorkspaceState(raw: unknown): WorkspaceState | null {
  const result = WorkspaceStateSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function modelFailure(message: string): Response {
  logger.error("No usable model for this request", { message });
  return sseResponse(
    (async function* () {
      yield reasoningStep(message, "ERROR");
      yield messageChunk(message);
    })(),
  );
}

function chatNotice(message: string): Response {
  return sseResponse(
    (async function* () {
      yield messageChunk(message);
    })(),
  );
}

function toolRef(tool: AgentTool): ToolRef {
  return { url: tool.url, toolName: tool.tool_name ?? tool.name.split("_").slice(1).join("_") };
}

function refusal(c: Context<AppEnv>, failure: Failure): Response {
  if (failure.reason === "limit") {
    metrics.queries.inc({ outcome: "limit" });
    audit.info("Refused a query: the usage limit is reached");
    return chatNotice(failure.message);
  }
  if (failure.reason === "rejected") return c.json({ error: "Not signed in" }, 401);
  return c.json({ error: "The FINOS Workspace API is not available" }, 503);
}

interface QueryRun {
  context: Record<string, unknown>;
  chatKey: string;
  services: Services | undefined;
  release: () => void;
  tokens: () => number;
}

function trackQuery(run: QueryRun) {
  const started = performance.now();
  metrics.activeQueries.inc();
  let outcome: string | null = null;
  let sawFunctionCall = false;
  let ended = false;

  function end(fallback: string): void {
    if (ended) return;
    ended = true;
    const result = outcome ?? fallback;
    if (result !== "continued" && run.chatKey) void run.services?.limits.endTurn(run.chatKey);
    const seconds = (performance.now() - started) / 1000;
    metrics.activeQueries.dec();
    metrics.queries.inc({ outcome: result });
    metrics.queryDuration.observe(seconds, { outcome: result });
    run.release();
    withContext(run.context, () =>
      audit.info("Query {outcome}", { outcome: result, tokens: run.tokens(), durationMs: Math.round(seconds * 1000) }),
    );
  }

  async function* events(inner: AsyncGenerator<SSEEvent>): AsyncGenerator<SSEEvent> {
    try {
      while (true) {
        const step = await withContext(run.context, () => inner.next());
        if (step.done) break;
        if (step.value.event === "copilotFunctionCall") sawFunctionCall = true;
        yield step.value;
      }
      outcome = sawFunctionCall ? "continued" : "completed";
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      await withContext(run.context, () => inner.return(undefined)).catch(() => undefined);
      end("aborted");
    }
  }

  return { events, end };
}

export const queryRouter = new Hono<AppEnv>();

function declaredBodyBytes(c: Context<AppEnv>, services: Services | undefined): number {
  const header = c.req.header("content-length") ?? "";
  return /^\d+$/.test(header) ? Number(header) : (services?.config.maxBodyBytes ?? MAX_BODY_BYTES);
}

queryRouter.post(queryRoute.path, async (c) => {
  const services = c.get("services") as Services | undefined;
  const principal = c.get("principal") ?? ANONYMOUS;

  if (services && (await services.limits.struck(principal.userId))) {
    metrics.queries.inc({ outcome: "limit" });
    audit.info("Refused a query unread: the user has sent too many requests that were not questions");
    return c.json({ error: "Too many invalid requests. Try again in a minute." }, 429, { "Retry-After": "60" });
  }

  const admission = services ? await services.limits.admit(principal.userId) : ({ ok: true, release: () => undefined } as const);
  if (!admission.ok) {
    metrics.queries.inc({ outcome: "busy" });
    if (admission.reason === "server") {
      audit.info("Refused a query: the agent is running as many as it can");
      c.header("Retry-After", "5");
      return c.json({ error: "The agent is busy. Try again in a moment." }, 503);
    }
    audit.info("Refused a query: the user has too many running");
    return c.json({ error: "Too many of your queries are running. Wait for one to finish." }, 429);
  }

  const reservation = bodyBudget.reserve(declaredBodyBytes(c, services));
  if (!reservation) {
    admission.release();
    metrics.queries.inc({ outcome: "busy" });
    audit.info("Refused a query: the requests being held in memory leave no room for this one");
    c.header("Retry-After", "5");
    return c.json({ error: "The agent is busy. Try again in a moment." }, 503);
  }
  const release = () => {
    admission.release();
    reservation();
  };

  let streaming = false;
  try {
    return await answerQuery(c, { services, principal, release, handOver: () => void (streaming = true) });
  } finally {
    if (!streaming) release();
  }
});

async function answerQuery(
  c: Context<AppEnv>,
  { services, principal, release, handOver }: { services: Services | undefined; principal: Principal; release: () => void; handOver: () => void },
): Promise<Response> {
  let raw: Record<string, unknown>;
  try {
    raw = await c.req.json();
  } catch {
    void services?.limits.strike(principal.userId);
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = QueryRequestSchema.safeParse(raw);
  if (!parsed.success) {
    void services?.limits.strike(principal.userId);
    logger.error("Invalid request", { issues: parsed.error.issues });
    metrics.queries.inc({ outcome: "invalid" });
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const body = raw as unknown as QueryRequest;

  const workspace = services?.workspace ?? null;

  const lastMessage = body.messages.at(-1);
  const opts = (raw.workspace_options ?? {}) as Record<string, boolean | string>;
  const hasOption = (key: string): boolean => Boolean(opts[key]);
  const getOption = (key: string): string | undefined => {
    const v = opts[key];
    return typeof v === "string" ? v : undefined;
  };

  const rawModelId = getOption("model") || process.env.DEFAULT_MODEL;
  if (!rawModelId) {
    return modelFailure("No model is configured. Set DEFAULT_MODEL on the agent (for example <provider>:<model>) or pick a model in the FINOS Workspace.");
  }
  if (services && !services.config.models.includes(rawModelId)) {
    metrics.queries.inc({ outcome: "denied" });
    audit.info("Refused the model {model}: this deployment does not offer it", { model: rawModelId });
    return chatNotice(`The model ${rawModelId} is not available here.`);
  }
  let model: ReturnType<typeof resolveModel>;
  try {
    model = resolveModel(rawModelId);
  } catch (err) {
    return modelFailure(err instanceof Error ? err.message : String(err));
  }
  const workspaceState = parseWorkspaceState(body.workspace_state);

  const chatId = c.req.header("X-Trace-Id") ?? c.req.header("x-trace-id") ?? "";
  const conversationId = workspace ? scopeKey(principal.userId, chatId) : chatId;

  let disabledCapabilities: Capability[] = [];
  if (workspace && services) {
    try {
      const authorization = await workspace.authorize(principal.token, {
        agentId: AGENT_ID,
        model: rawModelId,
        tools: (body.tools ?? []).map(toolRef),
      });
      if (!authorization.ok) {
        release();
        return refusal(c, authorization);
      }
      if (authorization.value.deniedModel) {
        release();
        metrics.queries.inc({ outcome: "denied" });
        audit.info("Refused the model {model}: the user's roles do not allow it", { model: rawModelId });
        return chatNotice(`Your role does not allow the model ${rawModelId}.`);
      }
      disabledCapabilities = authorization.value.disabledCapabilities;
      if (authorization.value.deniedTools.length > 0 && body.tools) {
        const denied = new Set(authorization.value.deniedTools.map((t) => `${t.url}\u0000${t.toolName}`));
        body.tools = body.tools.filter((t) => !denied.has(`${t.url}\u0000${toolRef(t).toolName}`));
        audit.info("Left out {count} tools the user's roles do not allow", { count: denied.size });
      }

      const continuing = lastMessage?.role === "tool" && !!conversationId && (await services.limits.inTurn(conversationId));
      if (continuing && !(await services.limits.noteRequest(conversationId))) {
        release();
        metrics.queries.inc({ outcome: "limit" });
        audit.info("Refused a continuation: the turn has used all the requests it may");
        return chatNotice("This question needed more steps than one question may take, so it was stopped. Ask for less at a time.");
      }
      if (!continuing) {
        const counted = await workspace.recordQuery(principal.token);
        if (!counted.ok) {
          release();
          return refusal(c, counted);
        }
        if (conversationId) await services.limits.startTurn(conversationId);
      }
    } catch (error) {
      release();
      throw error;
    }
  }

  const tieredWidgets = getTieredWidgets(body);
  const allWidgets = tieredWidgets.map((t) => t.widget);

  if (lastMessage?.role === "tool") {
    const toolMsg = lastMessage as ToolMessage;
    if (
      toolMsg.function !== "get_skill_content" &&
      toolMsg.function !== "execute_agent_tool" &&
      toolMsg.function !== "get_params_options" &&
      !WORKSPACE_BRIDGE_COMMAND_NAMES.has(toolMsg.function)
    ) {
      try {
        await cacheWidgetItemsFromReboot(toolMsg, allWidgets, conversationId);
      } catch (error) {
        release();
        throw error;
      }
    }
  }

  const roles = body.messages.map((m) => m.role);
  const optionsModel = getOption("model");
  const modelSource = optionsModel ? "workspace_options.model" : "env.DEFAULT_MODEL";
  const context = {
    user: principal.userId,
    conversationId: conversationId || "(missing)",
    model: rawModelId,
  };
  withContext(context, () =>
    logger.info(
      "Query received: model {model} (via {modelSource}), {widgetCount} widgets, {mcpToolCount} tools",
      {
        model: rawModelId,
        modelSource,
        roles,
        widgetCount: allWidgets.length,
        mcpToolCount: (body.tools ?? []).length,
      },
    ),
  );

  const promptSuggestionsEnabled = hasOption("prompt-suggestions");

  let tokens = 0;
  const onUsage = (usage: UsageCounts) => {
    tokens = usage.totalTokens;
    metrics.modelTokens.inc({ direction: "input" }, usage.inputTokens);
    metrics.modelTokens.inc({ direction: "output" }, usage.outputTokens);
    if (workspace) void workspace.recordTokens(principal.token, usage.totalTokens);
  };

  const query = trackQuery({ context, chatKey: conversationId, services, release, tokens: () => tokens });
  handOver();
  const clientGone = new AbortController();
  return sseResponse(
    query.events(
      runAgentLoop({
        request: body,
        rawModelId,
        model,
        allWidgets,
        tieredWidgets,
        workspaceState,
        promptSuggestionsEnabled,
        conversationId,
        scopeSecret: services?.config.scopeSecret ?? null,
        disabledCapabilities,
        onUsage,
        signal: clientGone.signal,
      }),
    ),
    () => query.end("aborted"),
    () => clientGone.abort(),
  );
}
