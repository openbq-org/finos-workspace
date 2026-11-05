import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAuthRequiredError } from "~/components/AI/hooks/mcp/mcpServerAuth";
import { type UseMcpOptionsT, useMcp } from "~/components/AI/hooks/mcp/useMcp";
import { useMcpToolsStore } from "~/lib/state/mcpTools";
import { useThemeStore } from "~/lib/state/theme";

const sdk = vi.hoisted(() => ({
  connect: vi.fn(),
  transportOptions: [] as unknown[],
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = sdk.connect;
    request = vi.fn().mockResolvedValue({ tools: [], resources: [], prompts: [] });
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined);
    constructor(_url: URL, options: unknown) {
      sdk.transportOptions.push(options);
    }
  },
  StreamableHTTPError: class extends Error {
    code?: number;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined);
  },
  SseError: class extends Error {
    code?: number;
  },
}));

const auth = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  startMcpOAuth: vi.fn(),
  createMcpProxyFetch: vi.fn(),
  deleteMcpOAuthGrant: vi.fn(),
}));

vi.mock("~/components/AI/hooks/mcp/mcpServerAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/AI/hooks/mcp/mcpServerAuth")>()),
  startMcpOAuth: auth.startMcpOAuth,
  createMcpProxyFetch: auth.createMcpProxyFetch,
  deleteMcpOAuthGrant: auth.deleteMcpOAuthGrant,
}));

vi.mock("~/api/auth.api", () => ({
  postMCPServers: vi.fn().mockResolvedValue({ status: 200 }),
  fetchCopilotAccess: vi.fn().mockResolvedValue(null),
}));

const tokenOptions: UseMcpOptionsT = {
  url: "https://token-server.example.com/mcp",
  serverName: "Demo Token MCP",
  autoReconnect: false,
  autoRetry: false,
  authType: "token",
};

const oauthOptions: UseMcpOptionsT = {
  url: "https://oauth-server.example.com/mcp",
  serverName: "Demo OAuth MCP",
  autoReconnect: false,
  autoRetry: false,
};

const localOptions: UseMcpOptionsT = {
  url: "http://localhost:8000/mcp",
  serverId: "local-1",
  serverName: "Local MCP",
  autoReconnect: false,
  autoRetry: false,
};

class FakeBroadcastChannel {
  static channels: FakeBroadcastChannel[] = [];
  listeners: ((event: MessageEvent) => void)[] = [];
  constructor(readonly name: string) {
    FakeBroadcastChannel.channels.push(this);
  }
  addEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners.push(listener);
  }
  removeEventListener() {}
  postMessage() {}
  close() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.transportOptions = [];
  sdk.connect.mockResolvedValue(undefined);
  auth.createMcpProxyFetch.mockReturnValue(auth.proxyFetch);
  auth.startMcpOAuth.mockResolvedValue("https://auth.example.com/authorize?state=s1");
  FakeBroadcastChannel.channels = [];
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  useThemeStore.setState({ mcpAuthPopup: null });
  useMcpToolsStore.setState({ servers: [], mcpConnectionRegistry: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMcp", () => {
  it("connects a remote server through the API proxy with no credential of its own", async () => {
    const { result } = renderHook(() => useMcp(oauthOptions));

    await waitFor(() => expect(result.current.state).toBe("ready"));

    expect(auth.createMcpProxyFetch).toHaveBeenCalledWith(oauthOptions.url);
    const options = sdk.transportOptions[0] as Record<string, unknown>;
    expect(options.fetch).toBe(auth.proxyFetch);
    expect(options).not.toHaveProperty("authProvider");
  });

  it("fails with a token error and never starts a sign-in on a 401", async () => {
    sdk.connect.mockRejectedValue(new McpAuthRequiredError(tokenOptions.url));
    const { result } = renderHook(() => useMcp(tokenOptions));

    await waitFor(() => expect(result.current.state).toBe("failed"));

    expect(result.current.error).toMatch(/token/i);
    expect(auth.startMcpOAuth).not.toHaveBeenCalled();
  });

  it("starts the API's sign-in and opens its popup when the proxy asks for it", async () => {
    sdk.connect.mockRejectedValue(new McpAuthRequiredError(oauthOptions.url));
    const { result } = renderHook(() => useMcp(oauthOptions));

    await waitFor(() =>
      expect(auth.startMcpOAuth).toHaveBeenCalledWith(oauthOptions.url),
    );
    await waitFor(() =>
      expect(useThemeStore.getState().mcpAuthPopup).toMatchObject({
        url: oauthOptions.url,
        authUrl: "https://auth.example.com/authorize?state=s1",
      }),
    );
    expect(result.current.state).toBe("authenticating");
  });

  it("reconnects when the callback window reports the sign-in done", async () => {
    sdk.connect.mockRejectedValueOnce(new McpAuthRequiredError(oauthOptions.url));
    const { result } = renderHook(() => useMcp(oauthOptions));
    await waitFor(() => expect(result.current.state).toBe("authenticating"));

    const channel = FakeBroadcastChannel.channels.find((c) => c.name === "mcp-auth");
    act(() => {
      for (const listener of channel?.listeners ?? []) {
        listener(
          new MessageEvent("message", {
            data: {
              type: "mcp_auth_callback",
              success: true,
              serverUrl: oauthOptions.url,
            },
            origin: window.location.origin,
          }),
        );
      }
    });

    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(useThemeStore.getState().mcpAuthPopup).toBeNull();
  });

  it("connects a server on localhost through the API proxy like any other", async () => {
    const { result } = renderHook(() => useMcp(localOptions));

    await waitFor(() => expect(result.current.state).toBe("ready"));

    expect(auth.createMcpProxyFetch).toHaveBeenCalledWith(localOptions.url);
    expect((sdk.transportOptions[0] as Record<string, unknown>).fetch).toBe(
      auth.proxyFetch,
    );
  });

  it("signs in through the API when a server on localhost asks for it", async () => {
    sdk.connect.mockRejectedValue(new McpAuthRequiredError(localOptions.url));
    const { result } = renderHook(() => useMcp(localOptions));

    await waitFor(() =>
      expect(auth.startMcpOAuth).toHaveBeenCalledWith(localOptions.url),
    );
    expect(result.current.state).toBe("authenticating");
  });

  it("forgets the API's sign-in when its storage is cleared", async () => {
    auth.deleteMcpOAuthGrant.mockResolvedValue(undefined);
    const { result } = renderHook(() => useMcp(oauthOptions));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => result.current.clearStorage());

    expect(auth.deleteMcpOAuthGrant).toHaveBeenCalledWith(oauthOptions.url);
  });
});
