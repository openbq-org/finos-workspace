import { beforeEach, describe, expect, it, vi } from "vitest";
import { autoRegisterMcpForSource, type Source } from "~/lib/state/backendConnector";
import { useMcpToolsStore } from "~/lib/state/mcpTools";

vi.mock("~/api/auth.api", () => ({
  postMCPServers: vi.fn().mockResolvedValue({}),
  fetchCopilotAccess: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  useMcpToolsStore.setState({ servers: [], mcpConnectionRegistry: {} });
});

describe("autoRegisterMcpForSource authType propagation", () => {
  it("marks the auto-registered server with the template's mcpServers authType", () => {
    const source = {
      id: "source-1",
      name: "Custom Backend",
      url: "https://custom.example.com",
      uuid: "u-1",
      endpointHeaders: null,
      templates: [
        {
          name: "Tpl",
          tabs: {},
          mcpServers: [
            {
              name: "Custom MCP",
              url: "https://custom.example.com/mcp",
              authType: "token" as const,
            },
          ],
        },
      ],
    } as unknown as Source;

    autoRegisterMcpForSource(source);

    const servers = useMcpToolsStore.getState().servers;
    expect(servers).toHaveLength(1);
    expect(servers[0].authType).toBe("token");
    expect(servers[0].sourceId).toBe("source-1");
  });

  it("registers every declared server once, under the name a widget's mcp_tool names", () => {
    const source = {
      id: "source-1",
      name: "Custom Backend",
      url: "https://custom.example.com",
      uuid: "u-1",
      endpointHeaders: null,
      templates: [
        {
          name: "One",
          tabs: {},
          mcpServers: [
            { name: "Reports", url: "https://custom.example.com/mcp" },
            { name: "Admin", url: "https://custom.example.com/mcp" },
          ],
        },
        {
          name: "Two",
          tabs: {},
          mcpServers: [{ name: "Reports", url: "https://custom.example.com/mcp" }],
        },
      ],
    } as unknown as Source;

    autoRegisterMcpForSource(source);
    autoRegisterMcpForSource(source);

    const servers = useMcpToolsStore.getState().servers;
    expect(servers.map((s) => [s.declaredName, s.sourceId])).toEqual([
      ["Reports", "source-1"],
      ["Admin", "source-1"],
    ]);
  });
});

describe("token-auth servers are not auto-connected without a token", () => {
  function makeSource(
    authType: "oauth" | "token" | undefined,
    endpointHeaders: unknown = null,
  ) {
    return {
      id: "source-1",
      name: "Custom Backend",
      url: "https://custom.example.com",
      uuid: "u-1",
      endpointHeaders,
      templates: [
        {
          name: "Tpl",
          tabs: {},
          mcpServers: [
            {
              name: "Custom MCP",
              url: "https://custom.example.com/mcp",
              ...(authType && { authType }),
            },
          ],
        },
      ],
    } as unknown as Source;
  }

  it("registers a custom-backend token-auth server disabled", () => {
    autoRegisterMcpForSource(makeSource("token"));
    expect(useMcpToolsStore.getState().servers[0].enabled).toBe(false);
  });

  it("still auto-connects a custom-backend OAuth server", () => {
    autoRegisterMcpForSource(makeSource(undefined));
    expect(useMcpToolsStore.getState().servers[0].enabled).toBe(true);
  });

  it("auto-connects a token-auth server when the source already supplies an Authorization header", () => {
    autoRegisterMcpForSource(
      makeSource("token", [
        { key: "Authorization", value: "Bearer abc", location: "headers" },
      ]),
    );
    const server = useMcpToolsStore.getState().servers[0];
    expect(server.customHeaders).toBeUndefined();
    expect(server.enabled).toBe(true);
  });
});
