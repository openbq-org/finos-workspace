import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "~/api/api";
import {
  type CreateWidgetParams,
  useCreateWidgetFromArtifact,
} from "~/components/AI/hooks/useCreateWidgetFromArtifact";
import { useCopilotStore } from "~/lib/state/copilot";
import { usePluginRegistryStore } from "~/plugins/registry";
import { PluginListingSchema } from "~/plugins/types";
import { required } from "../../../mocks";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    dismiss: vi.fn(),
  },
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useParams: () => ({ id: "dashboard-123" }),
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams()],
}));

const mockCreateMetaDataWidget = vi.fn();
vi.mock("~/api/auth.api", () => ({
  createMetaDataWidget: (...args: unknown[]) => mockCreateMetaDataWidget(...args),
}));

const mockAddWidget = vi.fn();
const mockAddTab = vi.fn();
const mockGetLastInnerTab = vi.fn().mockReturnValue("");
vi.mock("~/lib/state/app", () => ({
  useShallowAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      addWidget: mockAddWidget,
      addTab: mockAddTab,
      getLastInnerTab: mockGetLastInnerTab,
    }),
}));

vi.mock("~/lib/state/theme", () => ({
  useShallowThemeStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ aiEnhancements: true }),
}));

vi.mock("~/lib/state/copilotData", () => ({
  useShallowCopilotDataStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      copilotWidgets: { selectedWidgets: [] },
    }),
}));

global.fetch = vi.fn();

describe("useCreateWidgetFromArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { token: "agent-token", expires_in: 1800 },
    });
    mockCreateMetaDataWidget.mockResolvedValue("new-widget-id");
    mockAddWidget.mockResolvedValue(undefined);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ title: "AI Title", description: "AI Description" }),
    });
    useCopilotStore.setState({ createWidgetMetadataDialog: null });
  });

  describe("createWidget", () => {
    it("shows loading toast when creating widget", async () => {
      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        result.current.createWidget({
          widgetType: "html",
          content: "<p>data</p>",
          metadata: null,
        });
      });

      expect(toast.loading).toHaveBeenCalledWith(
        "Creating html widget...",
        expect.objectContaining({
          cancel: expect.objectContaining({
            label: "Edit metadata",
          }),
        }),
      );
    });

    it("shows success toast with Edit metadata button after creation", async () => {
      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidget({
          widgetType: "html",
          content: "<p>data</p>",
          metadata: null,
        });
      });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            cancel: expect.objectContaining({
              label: "Edit metadata",
            }),
          }),
        );
      });
    });

    it("adds a plugin artifact as a full-width plugin widget that holds its data, without asking the agent for a name", async () => {
      usePluginRegistryStore.getState().setListing(
        PluginListingSchema.parse({
          enabled: true,
          etag: "1",
          plugins: [
            {
              id: "chart-kit",
              version: "1.0.0",
              name: "Chart kit",
              digest: `sha256-${"A".repeat(43)}`,
              entry: { module: "entry.js", styles: [] },
              files: { "entry.js": { size: 10, sha256: "a".repeat(64) } },
              csp: {},
              widgets: [
                {
                  id: "bars",
                  name: "Bars",
                  permissions: ["core:data:read"],
                  grid: { w: 20, h: 10 },
                  artifact: { description: "Bars", data: { type: "object" } },
                },
              ],
            },
          ],
        }),
      );
      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidget({
          widgetType: "plugin",
          content: "",
          pluginArtifact: {
            plugin: { id: "chart-kit", widget: "bars" },
            data: { rows: [{ x: "a", y: 1 }] },
            config: { color: "red" },
          },
          metadata: { name: "Sales bars", description: "Sales by month" },
        });
      });

      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockAddWidget).toHaveBeenCalledWith(
        "dashboard-123",
        expect.objectContaining({
          name: "Sales bars",
          description: "Sales by month",
          widgetId: "plugin:chart-kit:bars",
          connectionType: "plugin",
          plugin: { id: "chart-kit", widget: "bars" },
          gridData: { w: 40, h: 12 },
          storage: {
            createdAt: expect.any(String),
            plugin: { data: { rows: [{ x: "a", y: 1 }] }, config: { color: "red" } },
          },
        }),
      );
    });

    it("records the chat artifact a widget was made from, and the widget on that artifact", async () => {
      usePluginRegistryStore.getState().setListing(
        PluginListingSchema.parse({
          enabled: true,
          etag: "1",
          plugins: [
            {
              id: "chart-kit",
              version: "1.0.0",
              name: "Chart kit",
              digest: `sha256-${"A".repeat(43)}`,
              entry: { module: "entry.js", styles: [] },
              files: { "entry.js": { size: 10, sha256: "a".repeat(64) } },
              csp: {},
              widgets: [
                {
                  id: "bars",
                  name: "Bars",
                  permissions: ["core:data:read"],
                  artifact: { description: "Bars", data: { type: "object" } },
                },
              ],
            },
          ],
        }),
      );
      const artifact = {
        uuid: "artifact-1",
        type: "plugin" as const,
        name: "Sales bars",
        plugin: { id: "chart-kit", widget: "bars" },
        data: { rows: [] },
      };
      useCopilotStore.setState({
        currentChat: 1,
        chats: [
          {
            uuid: "chat-1",
            createdAt: 1,
            label: "",
            messages: [],
            artifacts: [artifact],
          },
        ],
      } as never);
      mockAddWidget.mockResolvedValue("widget-new");
      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidget({
          widgetType: "plugin",
          content: "",
          pluginArtifact: { plugin: artifact.plugin, data: artifact.data },
          metadata: { uuid: "artifact-1", name: "Sales bars", description: "Sales" },
          artifact: { uuid: "artifact-1", name: "Sales bars", chatUuid: "chat-1" },
        });
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        "dashboard-123",
        expect.objectContaining({
          storage: expect.objectContaining({
            fromArtifact: {
              artifactUuid: "artifact-1",
              name: "Sales bars",
              chatUuid: "chat-1",
            },
          }),
        }),
      );
      expect(useCopilotStore.getState().chats[0].artifacts?.[0].widgets).toEqual([
        {
          widgetUuid: "widget-new",
          dashboardId: "dashboard-123",
          name: "Sales bars",
          createdAt: expect.any(String),
        },
      ]);
    });

    it("shows error toast when creation fails", async () => {
      mockAddWidget.mockRejectedValue(new Error("Failed to add widget"));

      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidget({
          widgetType: "html",
          content: "<p>data</p>",
          metadata: null,
        });
      });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          "Failed to create widget",
          expect.objectContaining({
            description: "Failed to add widget",
          }),
        );
      });
    });

    it("uses fallback name when AI fetch fails", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network error"),
      );

      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidget({
          widgetType: "html",
          content: "<p>data</p>",
          metadata: null,
        });
      });

      await waitFor(() => {
        expect(mockAddWidget).toHaveBeenCalled();
      });
    });

    it("uses existing metadata name when provided", async () => {
      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidget({
          widgetType: "text",
          content: "Test content",
          metadata: {
            name: "Custom Name",
            description: "Custom Description",
          },
        });
      });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalled();
      });
    });
  });

  describe("a text artifact", () => {
    it("is added as a markdown widget holding the text, without saving metadata", async () => {
      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidget({
          widgetType: "text",
          content: "# Title\n\nSome text. <citation>ref</citation>",
          metadata: null,
        });
      });

      expect(mockCreateMetaDataWidget).not.toHaveBeenCalled();
      expect(mockAddWidget).toHaveBeenCalledTimes(1);
      const [dashboardId, widget] = mockAddWidget.mock.calls[0];
      expect(dashboardId).toBe("dashboard-123");
      expect(widget).toEqual(
        expect.objectContaining({
          widgetId: "markdown",
          type: "custom",
          name: "AI Title",
          description: "AI Description",
          storage: { text: "# Title\n\nSome text", createdAt: expect.any(String) },
        }),
      );
      expect(widget.connectionType).toBeUndefined();
    });

    it("has no metadata to edit afterwards", async () => {
      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidget({
          widgetType: "text",
          content: "Test content",
          metadata: { name: "Summary", description: "A summary" },
        });
      });

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      const options = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(options.cancel).toBeUndefined();
    });

    it("has no metadata to edit when created with metadata from the dialog", async () => {
      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidgetWithMetadata(
          { widgetType: "text", content: "Test content" },
          { name: "Summary", description: "A summary" },
        );
      });

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      const options = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(options.cancel).toBeUndefined();
    });
  });

  describe("Edit metadata button on loading toast", () => {
    it("opens dialog when Edit metadata is clicked on loading toast", async () => {
      let cancelCallback: (() => void) | undefined;

      (toast.loading as ReturnType<typeof vi.fn>).mockImplementation(
        (_message, options) => {
          cancelCallback = options?.cancel?.onClick;
          return "toast-id";
        },
      );

      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      const params: CreateWidgetParams = {
        widgetType: "html",
        content: "<p>data</p>",
        metadata: null,
      };

      act(() => {
        result.current.createWidget(params);
      });

      if (cancelCallback) {
        act(() => {
          required(cancelCallback)();
        });
      }

      await waitFor(() => {
        const dialogState = useCopilotStore.getState().createWidgetMetadataDialog;
        expect(dialogState).not.toBeNull();
        expect(dialogState?.mode).toBe("create");
        expect(dialogState?.pendingParams).toBeDefined();
      });

      expect(toast.dismiss).toHaveBeenCalledWith("toast-id");
    });
  });

  describe("Edit metadata button on success toast", () => {
    it("opens dialog when Edit metadata is clicked on success toast", async () => {
      mockAddWidget.mockImplementation(() => {
        return new Promise((resolve) => resolve("widget-uuid"));
      });
      let cancelCallback: (() => void) | undefined;

      (toast.success as ReturnType<typeof vi.fn>).mockImplementation(
        (_message, options) => {
          cancelCallback = options?.cancel?.onClick;
          return "toast-id";
        },
      );

      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidget({
          widgetType: "html",
          content: "<p>data</p>",
          metadata: null,
        });
      });

      if (cancelCallback) {
        act(() => {
          required(cancelCallback)();
        });
      }

      await waitFor(() => {
        const dialogState = useCopilotStore.getState().createWidgetMetadataDialog;
        expect(dialogState).not.toBeNull();
        expect(dialogState?.mode).toBe("update");
        expect(dialogState?.widgetUuid).toBeDefined();
        expect(dialogState?.widgetId).toBeDefined();
      });
    });
  });

  describe("createWidgetWithMetadata", () => {
    it("creates widget with provided metadata and shows Edit metadata button", async () => {
      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidgetWithMetadata(
          {
            widgetType: "html",
            content: "<p>data</p>",
            metadata: null,
          },
          {
            name: "Manual Name",
            description: "Manual Description",
          },
        );
      });

      expect(mockAddWidget).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith(
        "Created: Manual Name",
        expect.objectContaining({
          cancel: expect.objectContaining({
            label: "Edit metadata",
          }),
        }),
      );
    });

    it("opens dialog when Edit metadata is clicked on success toast", async () => {
      mockAddWidget.mockImplementation(() => {
        return new Promise((resolve) => resolve("widget-uuid"));
      });
      let cancelCallback: (() => void) | undefined;

      (toast.success as ReturnType<typeof vi.fn>).mockImplementation(
        (_message, options) => {
          cancelCallback = options?.cancel?.onClick;
          return "toast-id";
        },
      );

      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidgetWithMetadata(
          {
            widgetType: "html",
            content: "<p>data</p>",
            metadata: null,
          },
          {
            name: "Manual Name",
            description: "Manual Description",
          },
        );
      });

      if (cancelCallback) {
        act(() => {
          required(cancelCallback)();
        });
      }

      await waitFor(() => {
        const dialogState = useCopilotStore.getState().createWidgetMetadataDialog;
        expect(dialogState).not.toBeNull();
        expect(dialogState?.mode).toBe("update");
        expect(dialogState?.initialValues.name).toBe("Manual Name");
        expect(dialogState?.initialValues.description).toBe("Manual Description");
      });
    });

    it("shows loading toast during creation", async () => {
      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      await act(async () => {
        await result.current.createWidgetWithMetadata(
          {
            widgetType: "html",
            content: "<p>data</p>",
            metadata: null,
          },
          { name: "Test", description: "Test" },
        );
      });

      expect(toast.loading).toHaveBeenCalledWith("Creating widget...");
    });

    it("shows error toast on failure", async () => {
      mockAddWidget.mockRejectedValue(new Error("Creation failed"));

      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      let thrownError: Error | null = null;
      await act(async () => {
        try {
          await result.current.createWidgetWithMetadata(
            {
              widgetType: "html",
              content: "<p>data</p>",
              metadata: null,
            },
            { name: "Test", description: "Test" },
          );
        } catch (error) {
          thrownError = error as Error;
        }
      });

      expect((thrownError as Error | null)?.message).toBe("Creation failed");
      expect(toast.error).toHaveBeenCalledWith(
        "Failed to create widget",
        expect.objectContaining({
          description: "Creation failed",
        }),
      );
    });
  });

  describe("AbortController behavior", () => {
    it("does not show error toast when request is aborted", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new DOMException("Aborted", "AbortError")), 100);
          }),
      );

      let cancelCallback: (() => void) | undefined;

      (toast.loading as ReturnType<typeof vi.fn>).mockImplementation(
        (_message, options) => {
          cancelCallback = options?.cancel?.onClick;
          return "toast-id";
        },
      );

      const { result } = renderHook(() => useCreateWidgetFromArtifact());

      act(() => {
        result.current.createWidget({
          widgetType: "html",
          content: "<p>data</p>",
          metadata: null,
        });
      });

      if (cancelCallback) {
        act(() => {
          required(cancelCallback)();
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(toast.error).not.toHaveBeenCalled();
    });
  });
});
