import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpToolSuggestions } from "~/components/AI/hooks/useMcpToolSuggestions";
import { useCopilotAccessStore } from "~/lib/state/copilotAccess";
import { type McpConnection, useMcpToolsStore } from "~/lib/state/mcpTools";

vi.mock("~/api/auth.api", () => ({
  postMCPServers: vi.fn().mockResolvedValue({}),
  fetchCopilotAccess: vi.fn().mockResolvedValue(null),
}));
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const conn = (state: McpConnection["state"]): McpConnection => ({
  callTool: undefined,
  state,
  tools: [],
  error: undefined,
  disconnect: () => {},
  clearStorage: () => {},
  retry: () => {},
});

beforeEach(() => {
  useMcpToolsStore.setState({ servers: [], mcpConnectionRegistry: {} });
  useCopilotAccessStore.getState().setAccess({
    models: [],
    mcp: [{ server_url: "https://w.example/mcp", tool_name: "*" }],
  });
});

describe("iframe MCP tools in slash suggestions (real store)", () => {
  it("happy path: iframe tools appear when server enabled + connection ready", () => {
    const store = useMcpToolsStore.getState();
    act(() => {
      store.addServer({
        id: "iframe-mcp-w1",
        name: "Portfolio Widget",
        url: "https://w.example/mcp",
        enabled: true,
        tools: [],
        iframeWidgetId: "w1",
      });
      store.addToolsToServer("iframe-mcp-w1", [
        { id: "rebalance", name: "rebalance", description: "Rebalance", enabled: true },
      ]);
      store.updateMCPConnectionRegistry("iframe-mcp-w1", conn("ready"));
    });

    const { result } = renderHook(() => useMcpToolSuggestions());
    expect(result.current.mcpToolOptions.map((t) => t.toolName)).toContain("rebalance");
  });

  it("does not show unselected iframe tools", () => {
    const store = useMcpToolsStore.getState();
    act(() => {
      store.addServer({
        id: "iframe-mcp-w1",
        name: "Portfolio Widget",
        url: "https://w.example/mcp",
        enabled: true,
        tools: [],
        iframeWidgetId: "w1",
      });
      store.addToolsToServer("iframe-mcp-w1", [
        { id: "rebalance", name: "rebalance", description: "Rebalance", enabled: true },
        {
          id: "disabled_tool",
          name: "disabled_tool",
          description: "Disabled",
          enabled: true,
        },
      ]);
      store.toggleTool("iframe-mcp-w1", "disabled_tool", false);
      store.updateMCPConnectionRegistry("iframe-mcp-w1", conn("ready"));
    });

    const { result } = renderHook(() => useMcpToolSuggestions());
    const toolNames = result.current.mcpToolOptions.map((t) => t.toolName);

    expect(toolNames).toContain("rebalance");
    expect(toolNames).not.toContain("disabled_tool");
  });

  it("recomputes when connection flips to ready with no servers change", () => {
    const store = useMcpToolsStore.getState();
    act(() => {
      store.addServer({
        id: "iframe-mcp-w1",
        name: "Portfolio Widget",
        url: "https://w.example/mcp",
        enabled: true,
        tools: [],
        iframeWidgetId: "w1",
      });
      store.addToolsToServer("iframe-mcp-w1", [
        { id: "rebalance", name: "rebalance", description: "Rebalance", enabled: true },
      ]);
      store.updateMCPConnectionRegistry("iframe-mcp-w1", conn("connecting"));
    });

    const { result } = renderHook(() => useMcpToolSuggestions());
    expect(result.current.mcpToolOptions).toHaveLength(0);

    act(() => {
      store.updateMCPConnectionRegistry("iframe-mcp-w1", conn("ready"));
    });

    expect(result.current.mcpToolOptions.map((t) => t.toolName)).toContain("rebalance");
  });
});
