import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { type DebouncedFunc, debounce } from "lodash";
import isEqual from "lodash.isequal";
import { toast } from "sonner";
import { subscribeWithSelector } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { createWithEqualityFn } from "zustand/traditional";
import { fetchCopilotAccess, postMCPServers } from "~/api/auth.api";
import {
  deleteMcpOAuthGrant,
  sameMcpServerUrl,
} from "~/components/AI/hooks/mcp/mcpServerAuth";
import type { UseMcpResult } from "~/components/AI/hooks/mcp/useMcp";
import { isRecord } from "~/components/AI/utils/mcpToolSchema";
import type { Selector } from "./app";
import {
  getCopilotAccess,
  isMcpToolAllowed,
  useCopilotAccessStore,
} from "./copilotAccess";
import { getWorkspaceAgentTools } from "./workspaceTools";

export const PENDING_CONNECTION_STATES = [
  "loading",
  "connecting",
  "discovering",
  "authenticating",
] as const;

export type McpInputSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export interface AgentToolConfig {
  server_id: string;
  name: string;
  tool_name: string;
  description?: string;
  url: string;
  input_schema?: McpInputSchema;
}

export interface McpTool {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  inputSchema?: McpInputSchema;
  annotations?: ToolAnnotations;
  lastExecuted?: number;
  executionCount?: number;
  lastError?: string;
}

export interface McpServer {
  id: string;
  name: string;
  clientName?: string;
  url: string;
  enabled: boolean;
  toolsEnabled?: boolean;
  tools: McpTool[];
  connected?: boolean;
  autoReconnect?: boolean;
  customHeaders?: Record<string, string | null>;
  customHeaderNames?: string[];
  hasToken?: boolean;
  iframeWidgetId?: string;
  iframeParams?: Record<string, string>;
  sourceId?: string;
  declaredName?: string;
  authType?: "oauth" | "token";
}

export interface McpConnection {
  callTool: UseMcpResult["callTool"] | undefined;
  error: UseMcpResult["error"];
  state: UseMcpResult["state"] | "disconnected";
  tools: UseMcpResult["tools"];
  disconnect: UseMcpResult["disconnect"];
  retry: UseMcpResult["retry"];
  clearStorage: UseMcpResult["clearStorage"];
}

interface McpToolsState {
  servers: McpServer[];
  mcpConnectionRegistry: Record<string, McpConnection>;
  getMCPConnection: (serverId: string) => McpConnection | undefined;
  updateMCPConnectionRegistry: (
    serverId: string,
    connection: McpConnection | undefined,
    remove?: boolean,
  ) => void;
  getServerById: (serverId: string) => McpServer | undefined;
  addServer: (server: McpServer) => void;
  removeServer: (serverId: string, options?: { clearStorage?: boolean }) => void;
  updateServer: (
    serverId: string,
    updates: Partial<McpServer>,
    refresh?: boolean,
  ) => void;
  disableServerAfterAuthCancel: (serverId: string) => void;
  toggleServerTools: (serverId: string, enableAll?: boolean) => void;
  toggleTool: (serverId: string, toolId: string | string[], enable?: boolean) => void;
  addToolsToServer: (serverId: string, tools: McpTool[]) => void;
  getEnabledToolCount: () => number;
  getEnabledToolsForAgent: () => Promise<AgentToolConfig[]>;
  saveMCPServers: () => Promise<void>;
  debouncedSaveServers: DebouncedFunc<() => Promise<void>>;
  updateServers: (servers: McpServer[]) => void;
  removeSourceServer: (sourceId: string) => void;
  clearAllStorage: () => void;
}

let serversSaved: Promise<void> = Promise.resolve();

export function mcpServersSaved() {
  return serversSaved;
}

function withHeadersSaved(server: McpServer, written: Record<string, string | null>) {
  let names = server.customHeaderNames ?? [];
  for (const [name, value] of Object.entries(written)) {
    names = names.filter((stored) => stored.toLowerCase() !== name.toLowerCase());
    if (value !== null) names.push(name);
  }
  const { customHeaders: _, ...saved } = server;
  return {
    ...saved,
    customHeaderNames: names.sort(),
    hasToken: names.some((name) => name.toLowerCase() === "authorization"),
  };
}

export const dedupeIframeServersByUrl = <T extends McpServer>(servers: T[]): T[] => {
  const seenUrls = new Set<string>();
  return servers.filter((server) => {
    if (!server.iframeWidgetId) return true;
    if (seenUrls.has(server.url)) return false;
    seenUrls.add(server.url);
    return true;
  });
};

const shouldMergeServers = (a: McpServer, b: McpServer) => {
  if (a.id === b.id) return true;
  if (a.iframeWidgetId && b.iframeWidgetId) {
    return a.iframeWidgetId === b.iframeWidgetId;
  }
  return false;
};

const upsertServer = (servers: McpServer[], server: McpServer) => {
  const index = servers.findIndex((existing) => shouldMergeServers(existing, server));
  if (index === -1) return [...servers, server];

  const next = [...servers];
  next[index] = {
    ...next[index],
    ...server,
    id: next[index].iframeWidgetId ? next[index].id : server.id,
    tools: server.tools.length > 0 ? server.tools : next[index].tools,
    toolsEnabled: next[index].iframeWidgetId
      ? (next[index].toolsEnabled ?? server.toolsEnabled ?? true)
      : (server.toolsEnabled ?? next[index].toolsEnabled ?? true),
  };
  return next;
};

const checkToolCountWarning = (previousCount: number, newCount: number) => {
  if (previousCount < 100 && newCount >= 100) {
    toast.warning("Too many MCP tools available", {
      description:
        "For best results, we recommend keeping the number of active MCP server tools under 100, ideally closer to 50, since accuracy and reliability of integrations degrade as more tools are added.",
    });
  }
};

export const useMcpToolsStore = createWithEqualityFn<McpToolsState>()(
  subscribeWithSelector((set, get) => ({
    servers: [],
    mcpConnectionRegistry: {},
    clearAllStorage: () => {
      const { mcpConnectionRegistry, debouncedSaveServers } = get();
      debouncedSaveServers.cancel();
      for (const serverId in mcpConnectionRegistry) {
        mcpConnectionRegistry[serverId].disconnect?.();
      }
      set({ servers: [], mcpConnectionRegistry: {} });
    },
    updateServers: (servers) => {
      const mcpConnectionRegistry = { ...get().mcpConnectionRegistry };
      const iframeServers = get().servers.filter((server) => server.iframeWidgetId);
      const nextServers = servers
        .filter((server) => !server.iframeWidgetId)
        .map(({ customHeaders: _, ...server }) => server);

      for (const iframeServer of iframeServers) {
        if (!nextServers.some((server) => shouldMergeServers(server, iframeServer))) {
          nextServers.push(iframeServer);
        }
      }

      for (const server of nextServers) {
        if (!mcpConnectionRegistry[server.id]) {
          mcpConnectionRegistry[server.id] = {
            callTool: undefined,
            state: "disconnected",
            tools: [],
            error: undefined,
            disconnect: () => {},
            clearStorage: () => {
              deleteMcpOAuthGrant(server.url).catch((error) =>
                console.error("Failed to forget the MCP sign-in:", error),
              );
            },
            retry: () => {},
          };
        }
      }

      set({ servers: nextServers, mcpConnectionRegistry });
    },
    saveMCPServers: () => {
      const sent = get().servers.filter((server) => !server.iframeWidgetId);
      const save = async () => {
        const { status } = await postMCPServers(sent);
        if (status >= 400) throw new Error(`status ${status}`);
        set((state) => ({
          servers: state.servers.map((server) => {
            const written = sent.find((s) => s.id === server.id)?.customHeaders;
            return written && server.customHeaders === written
              ? withHeadersSaved(server, written)
              : server;
          }),
        }));
        const access = await fetchCopilotAccess();
        if (access) useCopilotAccessStore.getState().setAccess(access);
      };
      serversSaved = serversSaved
        .then(save)
        .catch((error) => console.error("Failed to save MCP servers:", error));
      return serversSaved;
    },
    debouncedSaveServers: debounce(() => get().saveMCPServers(), 2000),
    getMCPConnection: (serverId) => get().mcpConnectionRegistry?.[serverId],
    updateMCPConnectionRegistry: (serverId, connection, remove = false) =>
      set((state) => {
        const newRegistry = { ...state.mcpConnectionRegistry };
        if (remove) delete newRegistry[serverId];
        else if (connection) newRegistry[serverId] = connection;

        return { mcpConnectionRegistry: newRegistry };
      }),
    getServerById: (serverId) => {
      const server = get().servers.find((s) => s.id === serverId);
      if (server) {
        const connection = get().getMCPConnection(serverId);
        return {
          ...server,
          connected: connection?.state === "ready" && server.enabled,
        };
      }
    },
    addServer: (server) => {
      set((state) => ({
        servers: upsertServer(state.servers, {
          ...server,
          toolsEnabled: server.iframeWidgetId ? true : undefined,
        }),
      }));
      if (server.iframeWidgetId) return;
      if (server.customHeaders) get().saveMCPServers();
      else get().debouncedSaveServers();
    },

    removeServer: (serverId, options) => {
      const shouldSave = !get().servers.find((s) => s.id === serverId)?.iframeWidgetId;
      const shouldClearStorage = options?.clearStorage ?? true;

      set((state) => {
        const serverToRemove = state.servers.find((s) => s.id === serverId);
        if (serverToRemove) {
          const connection = get().getMCPConnection(serverToRemove.id);
          connection?.disconnect?.();
          if (shouldClearStorage) connection?.clearStorage?.();
          get().updateMCPConnectionRegistry(serverId, connection, true);
        }

        return {
          servers: state.servers.filter((s) => s.id !== serverId),
        };
      });

      if (shouldSave) get().debouncedSaveServers();
    },

    updateServer: (serverId, updates, refresh = false) => {
      const connection = get().getMCPConnection(serverId);
      if (connection?.state === "failed" && updates.enabled) connection?.retry?.();

      set((state) => {
        const servers = state.servers.map((s) => {
          if (s.id !== serverId) return s;
          const moved =
            updates.url !== undefined && !sameMcpServerUrl(updates.url, s.url);
          return {
            ...s,
            ...(moved && { customHeaderNames: [], hasToken: false }),
            ...updates,
          };
        });

        if (updates.enabled !== undefined) {
          const connection = get().getMCPConnection(serverId);
          if (connection && !updates.enabled) {
            const state = connection.state;
            connection.disconnect?.();
            connection.state = state === "failed" ? "failed" : "disconnected";
            get().updateMCPConnectionRegistry(serverId, connection);
          }
        }

        const serverToUpdate = servers.find((s) => s.id === serverId);
        if (refresh && serverToUpdate?.enabled) {
          queueMicrotask(() => {
            const connection = get().getMCPConnection(serverId);
            connection?.retry?.();
          });
        }

        return { servers };
      });

      const server = get().servers.find((server) => server.id === serverId);
      if (server?.iframeWidgetId) return;
      if (updates.customHeaders) get().saveMCPServers();
      else get().debouncedSaveServers();
    },

    disableServerAfterAuthCancel: (serverId) => {
      const server = get().getServerById(serverId);
      if (!server?.enabled) return;
      get().updateServer(serverId, { enabled: false });

      toast.error(`${server.name} authentication cancelled`, {
        description: "Reconnect from MCP settings to try again.",
        action: {
          label: "Open MCP settings",
          onClick: () => {
            const url = new URL(window.location.href);
            url.pathname = "/app/ai";
            url.searchParams.set("tab", "mcp-servers");
            url.searchParams.set("serverId", serverId);
            window.history.replaceState({}, "", url.toString());
            window.dispatchEvent(new PopStateEvent("popstate"));
          },
        },
      });
    },

    toggleServerTools: (serverId, enableAll) => {
      const previousEnabledCount = get().getEnabledToolCount();

      set((state) => ({
        servers: state.servers.map((s) => {
          if (s.id !== serverId) return s;

          if (enableAll !== undefined) {
            return {
              ...s,
              toolsEnabled: enableAll,
              tools: s.tools.map((t) => ({ ...t, enabled: enableAll })),
            };
          }

          return { ...s, toolsEnabled: !s.toolsEnabled };
        }),
      }));

      const newEnabledCount = get().getEnabledToolCount();
      checkToolCountWarning(previousEnabledCount, newEnabledCount);

      const server = get().servers.find((server) => server.id === serverId);
      if (enableAll !== undefined && !server?.iframeWidgetId) {
        get().debouncedSaveServers();
      }
    },

    toggleTool: (serverId, toolId, enable) => {
      const previousEnabledCount = get().getEnabledToolCount();
      const toolIds = Array.isArray(toolId) ? toolId : [toolId];

      set((state) => ({
        servers: state.servers.map((s) => {
          if (s.id !== serverId) return s;

          const tools = s.tools.map((t) =>
            toolIds.includes(t.id) ? { ...t, enabled: enable ?? !t.enabled } : t,
          );

          return {
            ...s,
            tools,
            toolsEnabled: tools.some((tool) => tool.enabled),
          };
        }),
      }));

      const newEnabledCount = get().getEnabledToolCount();
      checkToolCountWarning(previousEnabledCount, newEnabledCount);

      const server = get().servers.find((server) => server.id === serverId);
      if (!server?.iframeWidgetId) get().debouncedSaveServers();
    },

    addToolsToServer: (serverId, tools) =>
      set((state) => {
        const { serverChanged, servers } = state.servers.reduce(
          (acc, server) => {
            if (server.id === serverId) {
              const newToolsMap = new Map(tools.map((tool) => [tool.id, tool]));

              const updatedExistingTools: McpTool[] = [];
              const actuallyNewTools: McpTool[] = [];

              for (const existingTool of server.tools) {
                const newTool = newToolsMap.get(existingTool.id);
                if (newTool) {
                  updatedExistingTools.push({
                    ...existingTool,
                    ...newTool,
                    enabled: existingTool.enabled,
                  });
                  newToolsMap.delete(existingTool.id);
                }
              }

              actuallyNewTools.push(...Array.from(newToolsMap.values()));

              acc.serverChanged = true;
              acc.servers.push({
                ...server,
                tools: [...updatedExistingTools, ...actuallyNewTools],
                toolsEnabled: server.toolsEnabled ?? true,
              });
              return acc;
            }

            acc.servers.push(server);
            return acc;
          },
          {
            serverChanged: false,
            servers: [] as McpServer[],
          },
        );

        return serverChanged ? { servers } : state;
      }),

    getEnabledToolCount: () => {
      const { servers, getMCPConnection } = get();
      const access = getCopilotAccess();
      const seenIframeUrls = new Set<string>();
      return servers.reduce((count, server) => {
        const connection = getMCPConnection(server.id);
        const isConnected = connection?.state === "ready" && server.enabled;

        if (server.iframeWidgetId) {
          if (!isConnected || seenIframeUrls.has(server.url)) return count;
          seenIframeUrls.add(server.url);
        }

        if (!(isConnected && server.toolsEnabled)) return count;
        for (const tool of server.tools) {
          if (tool.enabled && isMcpToolAllowed(access, server.url, tool.id)) count += 1;
        }
        return count;
      }, 0);
    },

    getEnabledToolsForAgent: async () => {
      const { servers, getMCPConnection } = get();
      const enabledTools: AgentToolConfig[] = [];
      const seenToolKeys = new Set<string>();
      const pushEnabledTool = (tool: AgentToolConfig) => {
        const key = `${tool.server_id}:${tool.name}`;
        if (seenToolKeys.has(key)) return;
        seenToolKeys.add(key);
        enabledTools.push(tool);
      };

      const iframeParamValues = new Map<string, Map<string, string[]>>();
      for (const server of servers) {
        if (!server.iframeWidgetId) continue;
        if (!server.enabled || getMCPConnection(server.id)?.state !== "ready") {
          continue;
        }
        let byKey = iframeParamValues.get(server.url);
        if (!byKey) {
          byKey = new Map();
          iframeParamValues.set(server.url, byKey);
        }
        for (const [key, val] of Object.entries(server.iframeParams ?? {})) {
          const values = byKey.get(key);
          if (!values) byKey.set(key, [val]);
          else if (!values.includes(val)) values.push(val);
        }
      }

      const seenIframeUrls = new Set<string>();
      for await (const server of servers) {
        let connection = getMCPConnection(server.id);

        if (server.iframeWidgetId) {
          if (
            server.enabled &&
            connection?.state === "ready" &&
            !seenIframeUrls.has(server.url)
          ) {
            seenIframeUrls.add(server.url);
            if (!server.toolsEnabled) continue;
            const agreedParams: [string, string][] = [];
            const divergedParams: [string, string[]][] = [];
            for (const [key, values] of iframeParamValues.get(server.url) ?? []) {
              if (values.length === 1) agreedParams.push([key, values[0]]);
              else divergedParams.push([key, values]);
            }

            const agreedText = agreedParams.map(([k, v]) => `${k}=${v}`).join(", ");
            const divergedText = divergedParams
              .map(([k, values]) => `${k}=${values.join(" / ")}`)
              .join(", ");

            let paramSuffix = "";
            if (divergedText) {
              paramSuffix =
                `\n\nIMPORTANT: The user has multiple copies of this widget open with different parameter values (${divergedText}).` +
                (agreedText ? ` All copies share: ${agreedText}.` : "") +
                " Ask or infer from context which copy the user means, and always pass these parameter values explicitly when calling this tool.";
            } else if (agreedText) {
              paramSuffix = `\n\nIMPORTANT: The user is currently viewing this data on their workspace widget with these parameters: ${agreedText}. Always pass these parameter values when calling this tool to match what the user sees, unless the user explicitly asks for different values.`;
            }

            for (const tool of server.tools) {
              if (!tool.enabled) continue;
              let schema = tool.inputSchema;
              if (agreedParams.length > 0 && schema?.properties) {
                const properties = structuredClone(schema.properties);
                for (const [key, val] of agreedParams) {
                  const property = properties[key];
                  if (isRecord(property))
                    properties[key] = { ...property, default: val };
                }
                schema = { ...schema, properties };
              }

              pushEnabledTool({
                server_id: server.id,
                name: `${server.name}_${tool.id}`,
                tool_name: tool.id,
                description: (tool.description || "") + paramSuffix,
                url: server.url,
                input_schema: schema,
              });
            }
          }
          continue;
        }

        if (!(server.enabled && server.toolsEnabled)) continue;
        connection?.retry?.();

        while (connection?.state === "connecting" || connection?.state === "loading") {
          connection = getMCPConnection(server.id);

          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        for (const tool of server.tools) {
          if (tool.enabled) {
            pushEnabledTool({
              server_id: server.id,
              name: `${server.name}_${tool.id}`,
              tool_name: tool.id,
              description: tool.description,
              url: server.url,
              input_schema: tool.inputSchema,
            });
          }
        }
      }

      for (const tool of await getWorkspaceAgentTools()) pushEnabledTool(tool);

      const access = getCopilotAccess();
      return enabledTools.filter((tool) =>
        isMcpToolAllowed(access, tool.url, tool.tool_name),
      );
    },
    removeSourceServer: (sourceId) => {
      removeServersBy(get, set, (s) => s.sourceId === sourceId);
    },
  })),
);

function removeServersBy(
  get: () => McpToolsState,
  set: (partial: Partial<McpToolsState>) => void,
  predicate: (s: McpServer) => boolean,
) {
  const state = get();
  const serversToRemove = state.servers.filter(predicate);
  if (serversToRemove.length === 0) return;

  const newRegistry = { ...state.mcpConnectionRegistry };
  for (const server of serversToRemove) {
    const connection = state.getMCPConnection(server.id);
    connection?.disconnect?.();
    connection?.clearStorage?.();
    delete newRegistry[server.id];
  }

  const removedIds = new Set(serversToRemove.map((s) => s.id));
  set({
    servers: state.servers.filter((s) => !removedIds.has(s.id)),
    mcpConnectionRegistry: newRegistry,
  });

  get().debouncedSaveServers();
}

export function useShallowMcpToolsStore<T>(selector: Selector<McpToolsState, T>): T {
  return useMcpToolsStore(useShallow(selector), (prev, next) => isEqual(prev, next));
}
