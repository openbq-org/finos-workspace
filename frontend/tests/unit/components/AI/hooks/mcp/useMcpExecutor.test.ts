import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CopilotDataT, CopilotErrorType } from "~/lib/state/copilot";
import type { McpConnection, McpServer } from "~/lib/state/mcpTools";
import { useMcpToolsStore } from "~/lib/state/mcpTools";

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("~/lib/utils/widget", () => ({
  getAllWidgets: vi.fn().mockReturnValue([]),
}));

vi.mock("~/api/auth.api", () => ({
  postMCPServers: vi.fn().mockResolvedValue({}),
  fetchCopilotAccess: vi.fn().mockResolvedValue(null),
}));

const createMockServer = (overrides: Partial<McpServer> = {}): McpServer => ({
  id: "server-1",
  name: "Test Server",
  url: "https://test.example.com",
  enabled: true,
  toolsEnabled: true,
  tools: [],
  connected: true,
  ...overrides,
});

const createMockConnection = (
  overrides: Partial<McpConnection> = {},
): McpConnection => ({
  callTool: vi.fn().mockResolvedValue({ content: [{ text: "ok" }] }),
  error: undefined,
  state: "ready",
  tools: [],
  disconnect: vi.fn(),
  retry: vi.fn(),
  clearStorage: vi.fn(),
  ...overrides,
});

function setupStore(server: McpServer, connection?: McpConnection) {
  act(() => {
    useMcpToolsStore.setState({
      servers: [server],
      mcpConnectionRegistry: connection ? { [server.id]: connection } : {},
    });
  });
}

function parseErrorPayload(result: CopilotDataT[]) {
  expect(result).toHaveLength(1);
  const data = result[0];
  expect(data.items).toHaveLength(1);
  const [item] = data.items;
  if (!("content" in item)) throw new Error("The result has no content");
  return JSON.parse(item.content);
}

describe("useMcpExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useMcpToolsStore.setState({
        servers: [],
        mcpConnectionRegistry: {},
      });
    });
  });

  async function getExecutor() {
    const { useMcpExecutor } = await import("~/components/AI/hooks/mcp/useMcpExecutor");
    const { result } = renderHook(() => useMcpExecutor());
    return result.current;
  }

  describe("error emission format", () => {
    it("should emit error with CopilotErrorType.UNEXPECTED when server is not found", async () => {
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {
        query: "test",
      });

      const errorPayload = parseErrorPayload(result);
      expect(errorPayload.error_type).toBe(CopilotErrorType.UNEXPECTED);
      expect(errorPayload.content).toContain("Server not found");
    });

    it("should emit error when server is disabled (not connected via config)", async () => {
      setupStore(createMockServer({ enabled: false }));
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      const errorPayload = parseErrorPayload(result);
      expect(errorPayload.error_type).toBe(CopilotErrorType.UNEXPECTED);
      expect(errorPayload.content).toContain("disconnected");
    });

    it("should emit error when server tools are disabled", async () => {
      setupStore(createMockServer({ toolsEnabled: false }));
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      const errorPayload = parseErrorPayload(result);
      expect(errorPayload.error_type).toBe(CopilotErrorType.UNEXPECTED);
      expect(errorPayload.content).toContain("tools are disabled");
    });

    it("should emit error when server is not connected", async () => {
      setupStore(createMockServer({ connected: false }));
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      const errorPayload = parseErrorPayload(result);
      expect(errorPayload.error_type).toBe(CopilotErrorType.UNEXPECTED);
      expect(errorPayload.content).toContain("not connected");
    });

    it("should emit error when no MCP connection exists for server", async () => {
      setupStore(createMockServer());
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      const errorPayload = parseErrorPayload(result);
      expect(errorPayload.error_type).toBe(CopilotErrorType.UNEXPECTED);
      expect(errorPayload.content).toContain("not connected");
    });

    it("should emit error when MCP connection is not in ready state", async () => {
      const connection = createMockConnection({ state: "connecting" });
      setupStore(createMockServer(), connection);
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      const errorPayload = parseErrorPayload(result);
      expect(errorPayload.error_type).toBe(CopilotErrorType.UNEXPECTED);
      expect(errorPayload.content).toContain("not connected");
    });

    it("should emit error when callTool throws", async () => {
      const connection = createMockConnection({
        callTool: vi.fn().mockRejectedValue(new Error("Tool execution failed")),
      });
      setupStore(createMockServer(), connection);
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {
        param: "value",
      });

      const errorPayload = parseErrorPayload(result);
      expect(errorPayload.error_type).toBe(CopilotErrorType.UNEXPECTED);
      expect(errorPayload.content).toContain("Tool execution failed");
    });

    it("should include tool name in error content", async () => {
      const connection = createMockConnection({
        callTool: vi.fn().mockRejectedValue(new Error("something broke")),
      });
      setupStore(createMockServer(), connection);
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_my_tool", {});

      const errorPayload = parseErrorPayload(result);
      expect(errorPayload.content).toContain("TestServer_my_tool");
    });

    it("should emit error when an individual MCP tool is disabled", async () => {
      const connection = createMockConnection();
      setupStore(
        createMockServer({
          tools: [{ id: "some_tool", name: "Some Tool", enabled: false }],
        }),
        connection,
      );
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      const errorPayload = parseErrorPayload(result);
      expect(errorPayload.error_type).toBe(CopilotErrorType.UNEXPECTED);
      expect(errorPayload.content).toContain("Tool some_tool is disabled");
    });

    it("should return items array with JSON-stringified error content", async () => {
      setupStore(createMockServer({ enabled: false }));
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty("items");
      expect(result[0].items).toHaveLength(1);
      expect(result[0].items[0]).toHaveProperty("content");

      const parsed = JSON.parse((result[0].items[0] as { content: string }).content);
      expect(parsed).toHaveProperty("error_type");
      expect(parsed).toHaveProperty("content");
    });
  });

  describe("invalid tool name format", () => {
    it("should throw when tool name has no underscore separator", async () => {
      const executeAgentTool = await getExecutor();

      await expect(executeAgentTool("server-1", "invalidtoolname", {})).rejects.toThrow(
        "Invalid tool name format",
      );
    });
  });

  describe("retry logic on not-ready errors", () => {
    it("should retry up to 3 times when callTool throws a 'not ready' error", async () => {
      const callTool = vi
        .fn()
        .mockRejectedValueOnce(new Error("Client is not ready"))
        .mockRejectedValueOnce(new Error("Client is not ready"))
        .mockResolvedValueOnce({ content: [{ text: "success" }] });

      const connection = createMockConnection({ callTool });
      setupStore(createMockServer(), connection);
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      expect((result[0].items[0] as { content: string }).content).toContain("success");
      expect(callTool).toHaveBeenCalledTimes(3);
    });

    it("should emit error after exhausting retries on 'not ready' errors", async () => {
      const callTool = vi.fn().mockRejectedValue(new Error("Client is not ready"));

      const connection = createMockConnection({ callTool });
      setupStore(createMockServer(), connection);
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      const errorPayload = parseErrorPayload(result);
      expect(errorPayload.error_type).toBe(CopilotErrorType.UNEXPECTED);
      expect(errorPayload.content).toContain("not ready");
      expect(callTool).toHaveBeenCalledTimes(3);
    });
  });

  describe("MCP-spec isError handling", () => {
    it("should preserve raw MCP error payload with isError: true", async () => {
      const mcpErrorResult = {
        isError: true,
        content: [{ type: "text", text: "Invalid ticker symbol" }],
      };
      const connection = createMockConnection({
        callTool: vi.fn().mockResolvedValue(mcpErrorResult),
      });
      setupStore(createMockServer(), connection);
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {
        ticker: "INVALID",
      });

      const content = (result[0].items[0] as { content: string }).content;
      const parsed = JSON.parse(content);
      expect(parsed.isError).toBe(true);
      expect(parsed.content).toEqual(mcpErrorResult.content);
    });

    it("should preserve isError payload with multiple content items", async () => {
      const mcpErrorResult = {
        isError: true,
        content: [
          { type: "text", text: "Validation failed" },
          { type: "text", text: "Field 'date' is required" },
        ],
      };
      const connection = createMockConnection({
        callTool: vi.fn().mockResolvedValue(mcpErrorResult),
      });
      setupStore(createMockServer(), connection);
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      const content = (result[0].items[0] as { content: string }).content;
      const parsed = JSON.parse(content);
      expect(parsed.isError).toBe(true);
      expect(parsed.content).toHaveLength(2);
      expect(parsed.content[0].text).toBe("Validation failed");
      expect(parsed.content[1].text).toBe("Field 'date' is required");
    });

    it("should preserve isError payload even with empty content array", async () => {
      const mcpErrorResult = { isError: true, content: [] };
      const connection = createMockConnection({
        callTool: vi.fn().mockResolvedValue(mcpErrorResult),
      });
      setupStore(createMockServer(), connection);
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      const content = (result[0].items[0] as { content: string }).content;
      const parsed = JSON.parse(content);
      expect(parsed.isError).toBe(true);
      expect(parsed.content).toEqual([]);
    });

    it("should not treat isError: false as an error", async () => {
      const connection = createMockConnection({
        callTool: vi.fn().mockResolvedValue({
          isError: false,
          content: [{ type: "text", text: "success data" }],
        }),
      });
      setupStore(createMockServer(), connection);
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      const content = (result[0].items[0] as { content: string }).content;
      expect(content).toContain("success data");
      expect(content).not.toContain("isError");
    });

    it("should not skip content processing for results without isError", async () => {
      const connection = createMockConnection({
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "normal tool output" }],
        }),
      });
      setupStore(createMockServer(), connection);
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      const content = (result[0].items[0] as { content: string }).content;
      expect(content).toContain("normal tool output");
      expect(content).not.toContain("isError");
    });
  });

  describe("successful tool execution", () => {
    it("should return content from callTool response", async () => {
      const connection = createMockConnection({
        callTool: vi.fn().mockResolvedValue({
          content: [{ text: "tool result data" }],
        }),
      });
      setupStore(createMockServer(), connection);
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "TestServer_some_tool", {});

      expect((result[0].items[0] as { content: string }).content).toContain(
        "tool result data",
      );
    });

    it("should include an iframe widget citation for iframe-bound MCP tools", async () => {
      const connection = createMockConnection({
        callTool: vi.fn().mockResolvedValue({
          content: [{ text: "iframe tool result" }],
        }),
      });
      setupStore(
        createMockServer({
          name: "Portfolio Iframe",
          clientName: "Portfolio MCP",
          iframeWidgetId: "iframe-widget-1",
          iframeParams: { symbol: "AAPL" },
          toolsEnabled: true,
          tools: [
            {
              id: "holdings",
              name: "Holdings",
              description: "Returns current holdings",
              enabled: true,
            },
          ],
        }),
        connection,
      );
      const executeAgentTool = await getExecutor();

      const result = await executeAgentTool("server-1", "Portfolio_holdings", {
        account_id: "demo-account",
      });

      expect((result[0].items[0] as { content: string }).content).toContain(
        "iframe tool result",
      );
      expect(result[0].extra_citations).toEqual([
        expect.objectContaining({
          source_info: expect.objectContaining({
            type: "widget",
            name: "Portfolio Iframe",
            origin: "Workspace",
            uuid: "iframe-widget-1",
            widget_id: "iframe-widget-1",
            description: "Returns current holdings",
            citable: true,
            metadata: expect.objectContaining({
              iframe_mcp: true,
              server_id: "server-1",
              server_name: "Portfolio MCP",
              tool_name: "holdings",
              widget_uuid: "iframe-widget-1",
              matching: true,
              input_args: { symbol: "AAPL" },
              mcp_tool_args: { account_id: "demo-account" },
            }),
          }),
          details: [{ "Account Id": "demo-account" }],
        }),
      ]);
    });
  });
});
