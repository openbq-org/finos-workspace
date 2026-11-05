import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeWidgetParamUpdates,
  computeWidgetUiUpdates,
  createWidget,
  deleteWidget,
  readWidget,
  updateDashboardLayout,
  updateWidget,
} from "~/api/workspace.api";
import type { WidgetT } from "~/components/types";
import { usePluginRegistryStore } from "~/plugins/registry";
import type { AvailablePlugin } from "~/plugins/types";

const mockGetAppWidget = vi.fn();
const mockAddWidget = vi.fn();
const mockGetTabWidgetById = vi.fn();
const mockGetWidgetGridData = vi.fn();
const mockUpdateTabWidgetsLayout = vi.fn();
const mockUpdateWidgetInStore = vi.fn();
const mockRemoveWidget = vi.fn();
const mockIsDashboardLocked = vi.fn((_dashboardId: string) => false);
const mockGetDashboardWidgetData = vi.fn();
const mockTriggerCustomEvent = vi.fn();
const mockGetDashboardInfo = vi.fn();
const mockDeserializeDashboardTabId = vi.fn((...args: unknown[]) => args[0]);

vi.mock("~/components/AI/hooks/useGetAppWidgets", () => ({
  useGetWidgetsStore: {
    getState: () => ({
      getAppWidget: mockGetAppWidget,
    }),
  },
}));

vi.mock("~/lib/state/app", () => ({
  DASHBOARD_LOCKED_MESSAGE: "Locked.",
  useAppStore: {
    getState: () => ({
      addWidget: mockAddWidget,
      getWidgetById: vi.fn(),
      getTabWidgetById: mockGetTabWidgetById,
      getWidgetGridData: mockGetWidgetGridData,
      updateTabWidgetsLayout: mockUpdateTabWidgetsLayout,
      updateWidget: mockUpdateWidgetInStore,
      removeWidget: mockRemoveWidget,
      isDashboardLocked: (dashboardId: string) => mockIsDashboardLocked(dashboardId),
      items: {
        "dashboard-123": {
          data: {
            name: "Dashboard",
            widgets: [],
            groups: [],
            gridLayout: {
              "": [{ i: "widget-uuid-456", x: 0, y: 0, w: 20, h: 10 }],
              charts: [],
            },
          },
        },
      },
    }),
  },
}));

vi.mock("~/lib/state/copilotData", () => ({
  useCopilotDataStore: {
    getState: () => ({
      getDashboardWidgetData: mockGetDashboardWidgetData,
    }),
  },
}));

vi.mock("~/lib/utils", () => ({
  triggerCustomEvent: (...args: unknown[]) => mockTriggerCustomEvent(...args),
}));

vi.mock("~/lib/utils/workspaceDashboard", () => ({
  getDashboardInfo: (...args: unknown[]) => mockGetDashboardInfo(...args),
  deserializeDashboardTabId: (...args: unknown[]) =>
    mockDeserializeDashboardTabId(...args),
}));

const createMockWidget = (overrides: Partial<WidgetT> = {}): WidgetT =>
  ({
    widgetId: "test-widget",
    name: "Test Widget",
    description: "A test widget",
    type: "html",
    params: [],
    storage: {},
    data: {},
    ...overrides,
  }) as WidgetT;

const dashboardWidget = createMockWidget({
  id: "widget-uuid-456",
  widgetId: "test-widget",
  innerTab: "",
  params: [{ paramName: "symbol", type: "text" }],
});

describe("FINOS Workspace API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDashboardLocked.mockReturnValue(false);
    mockTriggerCustomEvent.mockReturnValue(true);
    mockGetTabWidgetById.mockImplementation(
      (_dashboardId: string, widgetUuid: string) =>
        widgetUuid === dashboardWidget.id ? dashboardWidget : undefined,
    );
  });

  describe("createWidget", () => {
    const dashboardId = "dashboard-123";
    const backendName = "workspace";
    const widgetId = "stock-chart";
    const config = {
      dataArgs: { symbol: "AAPL" },
      uiArgs: { name: "Apple Stock" },
    };

    it("should create a widget and return its ID", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "stock-chart",
        params: [{ paramName: "symbol", type: "text" }],
      });
      const expectedWidgetId = "new-widget-uuid-123";

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue(expectedWidgetId);

      const result = await createWidget(dashboardId, backendName, widgetId, config);

      expect(mockGetAppWidget).toHaveBeenCalledWith("stock-chart", "workspace");
      expect(mockAddWidget).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          widgetId: "stock-chart",
          name: "Apple Stock",
          storage: expect.objectContaining({
            params: { symbol: "AAPL" },
          }),
        }),
      );
      expect(result).toBe(expectedWidgetId);
    });

    it("should throw error when widget definition not found", async () => {
      mockGetAppWidget.mockReturnValue(undefined);

      await expect(
        createWidget(dashboardId, backendName, "nonexistent-widget", config),
      ).rejects.toThrow(
        "Widget 'nonexistent-widget' not found in 'workspace'. Call list_available_widgets to get valid origin/widget_id pairs.",
      );
    });

    it("should handle widget with no params", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "static-widget",
        params: [],
      });
      const expectedWidgetId = "widget-no-params";

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue(expectedWidgetId);

      const result = await createWidget(dashboardId, backendName, "static-widget", {});

      expect(result).toBe(expectedWidgetId);
      expect(mockAddWidget).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          storage: expect.objectContaining({ params: {} }),
        }),
      );
    });

    it("should apply falsy param values (false, 0, empty string)", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "stock-chart",
        params: [
          { paramName: "raw", type: "boolean" },
          { paramName: "limit", type: "number" },
          { paramName: "query", type: "text" },
        ],
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget(dashboardId, backendName, widgetId, {
        dataArgs: { raw: false, limit: 0, query: "" },
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          storage: expect.objectContaining({
            params: { raw: false, limit: 0, query: "" },
          }),
        }),
      );
    });

    it("should ignore null values in dataArgs", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "stock-chart",
        params: [
          { paramName: "symbol", type: "text" },
          { paramName: "period", type: "text" },
          { paramName: "interval", type: "text" },
          { paramName: "provider", type: "text" },
        ],
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget(dashboardId, backendName, widgetId, {
        dataArgs: {
          symbol: "AAPL",
          period: "null",
          interval: null,
          provider: undefined,
        },
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          storage: expect.objectContaining({
            params: { symbol: "AAPL" },
          }),
        }),
      );
    });

    it("should update widget name and description from uiArgs", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "stock-chart",
        name: "Original Name",
        description: "Original Description",
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget(dashboardId, backendName, widgetId, {
        uiArgs: { name: "New Name", description: "New Description" },
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          name: "New Name",
          description: "New Description",
        }),
      );
    });

    it("stores the keys the widget's component reads", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "rich-note",
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget(dashboardId, backendName, "rich-note", {
        uiArgs: { html: "<p>Note content</p>" },
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          storage: expect.objectContaining({ html: "<p>Note content</p>" }),
        }),
      );
    });
  });

  describe("readWidget", () => {
    const dashboardId = "dashboard-123";
    const widgetUuid = "widget-uuid-456";

    it("should return widget data when found", () => {
      mockGetDashboardWidgetData.mockReturnValue({
        data: { value: 100 },
      });

      const result = readWidget(dashboardId, widgetUuid);

      expect(mockGetDashboardWidgetData).toHaveBeenCalledWith(widgetUuid);
      expect(result).toEqual(
        expect.objectContaining({
          widget_id: "test-widget",
          name: "Test Widget",
          inner_tab: "",
          data: { value: 100 },
        }),
      );
    });

    it("should throw error when widget not found", () => {
      mockGetTabWidgetById.mockReturnValue(undefined);

      expect(() => readWidget(dashboardId, widgetUuid)).toThrow(
        `Widget with UUID '${widgetUuid}' not found in dashboard '${dashboardId}'`,
      );
    });

    it("should still return widget metadata when rendered data is undefined", () => {
      mockGetDashboardWidgetData.mockReturnValue(undefined);

      const result = readWidget(dashboardId, widgetUuid);

      expect(result).toEqual(
        expect.objectContaining({
          widget_id: "test-widget",
          name: "Test Widget",
        }),
      );
      expect(result).not.toHaveProperty("data");
    });

    it("returns the stored note text as data when the copilot store has none", () => {
      const noteWidget = createMockWidget({
        id: widgetUuid,
        widgetId: "markdown",
        name: "Summary",
        type: "custom",
        params: [],
        storage: { text: "# Heading\n\nSome **text**" },
      });
      mockGetTabWidgetById.mockReturnValue(noteWidget);
      mockGetDashboardWidgetData.mockReturnValue(undefined);

      const result = readWidget(dashboardId, widgetUuid);

      expect(result?.data).toBe("# Heading\n\nSome **text**");
    });

    it("returns the stored html as data for a generative html widget", () => {
      const htmlWidget = createMockWidget({
        id: widgetUuid,
        widgetId: `html-${widgetUuid}`,
        name: "XSS Probe",
        type: "custom",
        params: [],
        storage: { html: '<h1>Hi <img src="x" /></h1>' },
      });
      mockGetTabWidgetById.mockReturnValue(htmlWidget);
      mockGetDashboardWidgetData.mockReturnValue(undefined);

      const result = readWidget(dashboardId, widgetUuid);

      expect(result?.data).toBe('<h1>Hi <img src="x" /></h1>');
    });

    it("says a static copy is one, of which widget and from when, and returns its stored rows", () => {
      const rows = { rowData: [{ region: "North", units: 120 }] };
      const copy = createMockWidget({
        id: widgetUuid,
        widgetId: "plugin:ag-grid:table",
        name: "Trades at close",
        type: "custom",
        params: [],
        storage: {
          createdAt: "2026-11-05T14:05:00.000Z",
          copiedFrom: { widgetUuid: "source-uuid", name: "Trades SQL" },
          plugin: { data: rows },
        },
      });
      mockGetTabWidgetById.mockReturnValue(copy);
      mockGetDashboardWidgetData.mockReturnValue(undefined);

      const result = readWidget(dashboardId, widgetUuid);

      expect(result).toEqual(
        expect.objectContaining({
          name: "Trades at close",
          created_at: "2026-11-05T14:05:00.000Z",
          copied_from: { widget_uuid: "source-uuid", name: "Trades SQL" },
          data: rows,
        }),
      );
    });

    it("says which chat artifact a widget was made from", () => {
      mockGetTabWidgetById.mockReturnValue(
        createMockWidget({
          id: widgetUuid,
          storage: {
            fromArtifact: { artifactUuid: "a-1", name: "Sales bars", chatUuid: "c-1" },
          },
        }),
      );
      mockGetDashboardWidgetData.mockReturnValue(undefined);
      const result = readWidget(dashboardId, widgetUuid);
      expect(result?.from_artifact).toEqual({
        artifact_uuid: "a-1",
        name: "Sales bars",
      });
      expect(JSON.stringify(result)).not.toContain("c-1");
    });

    it("leaves out copy fields for a widget that is not a copy", () => {
      mockGetDashboardWidgetData.mockReturnValue(undefined);
      const result = readWidget(dashboardId, widgetUuid);
      expect(result).not.toHaveProperty("copied_from");
      expect(result).not.toHaveProperty("created_at");
    });

    it("prefers rendered copilot data over the stored note text", () => {
      const noteWidget = createMockWidget({
        id: widgetUuid,
        widgetId: "markdown",
        type: "custom",
        storage: { text: "stored" },
      });
      mockGetTabWidgetById.mockReturnValue(noteWidget);
      mockGetDashboardWidgetData.mockReturnValue({ data: "rendered" });

      const result = readWidget(dashboardId, widgetUuid);

      expect(result?.data).toBe("rendered");
    });

    it("gives a plugin widget's settings as ui_args.config, as they are now", () => {
      usePluginRegistryStore.setState({
        plugins: [
          {
            id: "map-widget",
            widgets: [
              {
                id: "map",
                settings: {
                  schema: {
                    properties: {
                      zoom: { type: "number", minimum: 0, maximum: 19 },
                      latitude: { type: "number", minimum: -90, maximum: 90 },
                    },
                  },
                  defaults: {},
                },
              },
            ],
          } as unknown as AvailablePlugin,
        ],
      });
      mockGetTabWidgetById.mockReturnValue(
        createMockWidget({
          id: widgetUuid,
          plugin: { id: "map-widget", widget: "map" },
          storage: { plugin: { config: { zoom: 12, latitude: 48.85, stray: 1 } } },
        }),
      );

      expect(readWidget(dashboardId, widgetUuid)?.ui_args).toEqual({
        config: { zoom: 12, latitude: 48.85 },
      });
      usePluginRegistryStore.getState().clear();
    });
  });

  describe("dashboard-not-found recovery hints", () => {
    it("updateDashboardLayout includes a snapshot hint when the dashboard is missing", () => {
      expect(() =>
        updateDashboardLayout("missing-dashboard", "widget-uuid-456", {
          x: 0,
          y: 0,
          w: 20,
          h: 10,
        }),
      ).toThrow(
        "Dashboard 'missing-dashboard' not found. Call get_workspace_snapshot to list dashboard_ids.",
      );
    });
  });

  describe("updateDashboardLayout", () => {
    const dashboardId = "dashboard-123";
    const widgetUuid = "widget-uuid-456";

    beforeEach(() => {
      mockGetDashboardInfo.mockReturnValue({
        id: dashboardId,
        tabs: [
          { tab_id: "__no_tab__", tab_name: "__no_tab__", widgets: [], layout: [] },
          { tab_id: "charts", tab_name: "Charts", widgets: [], layout: [] },
        ],
      });
      mockGetTabWidgetById.mockReturnValue(
        createMockWidget({
          id: widgetUuid,
          gridData: { x: 0, y: 0, w: 20, h: 10, minW: 12, minH: 4 },
        }),
      );
      mockGetWidgetGridData.mockReturnValue({
        i: widgetUuid,
        x: 0,
        y: 0,
        w: 20,
        h: 10,
        minW: 12,
        minH: 4,
      });
    });

    it("rejects widths below the widget minimum", () => {
      expect(() =>
        updateDashboardLayout(dashboardId, widgetUuid, {
          x: 0,
          y: 2,
          w: 10,
          h: 10,
        }),
      ).toThrow("Widget width 10 is below the minimum width 12.");
    });

    it("rejects placements outside the 40-column grid", () => {
      expect(() =>
        updateDashboardLayout(dashboardId, widgetUuid, {
          x: 25,
          y: 2,
          w: 20,
          h: 10,
        }),
      ).toThrow(
        "Widget layout must fit inside the 40-column grid: x + w must be <= 40.",
      );
    });

    it("updates layout when the placement is valid", () => {
      updateDashboardLayout(dashboardId, widgetUuid, {
        tabId: "charts",
        x: 0,
        y: 2,
        w: 20,
        h: 10,
      });

      expect(mockUpdateTabWidgetsLayout).toHaveBeenCalledTimes(2);
      expect(mockUpdateWidgetInStore).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          id: widgetUuid,
          innerTab: "charts",
        }),
      );
    });
  });

  describe("a locked dashboard", () => {
    const dashboardId = "dashboard-123";
    const widgetUuid = "widget-uuid-456";
    const lockedError = `Dashboard '${dashboardId}' is locked. Locked.`;

    beforeEach(() => {
      mockIsDashboardLocked.mockReturnValue(true);
      mockGetDashboardInfo.mockReturnValue({
        id: dashboardId,
        tabs: [
          { tab_id: "__no_tab__", tab_name: "__no_tab__", widgets: [], layout: [] },
          { tab_id: "charts", tab_name: "Charts", widgets: [], layout: [] },
        ],
      });
      mockGetTabWidgetById.mockReturnValue(
        createMockWidget({ id: widgetUuid, gridData: { x: 0, y: 0, w: 20, h: 10 } }),
      );
      mockGetWidgetGridData.mockReturnValue({
        i: widgetUuid,
        x: 0,
        y: 0,
        w: 20,
        h: 10,
      });
    });

    it("does not get a widget created in it", async () => {
      mockGetAppWidget.mockReturnValue(createMockWidget());

      await expect(createWidget(dashboardId, "workspace", "chart", {})).rejects.toThrow(
        lockedError,
      );
      expect(mockAddWidget).not.toHaveBeenCalled();
    });

    it("does not lose a widget", async () => {
      await expect(deleteWidget(dashboardId, widgetUuid)).rejects.toThrow(lockedError);
      expect(mockRemoveWidget).not.toHaveBeenCalled();
    });

    it("does not let a widget be moved to another place", () => {
      expect(() =>
        updateDashboardLayout(dashboardId, widgetUuid, { x: 0, y: 4, w: 20, h: 10 }),
      ).toThrow(`${lockedError} Only the width and height of its widgets can change.`);
      expect(mockUpdateTabWidgetsLayout).not.toHaveBeenCalled();
    });

    it("does not let a widget be moved to another tab", () => {
      expect(() =>
        updateDashboardLayout(dashboardId, widgetUuid, {
          tabId: "charts",
          x: 0,
          y: 0,
          w: 20,
          h: 10,
        }),
      ).toThrow(lockedError);
      expect(mockUpdateTabWidgetsLayout).not.toHaveBeenCalled();
    });

    it("lets a widget be resized where it is", () => {
      updateDashboardLayout(dashboardId, widgetUuid, { x: 0, y: 0, w: 30, h: 12 });

      expect(mockUpdateTabWidgetsLayout).toHaveBeenCalledWith(
        dashboardId,
        [expect.objectContaining({ i: widgetUuid, x: 0, y: 0, w: 30, h: 12 })],
        "",
      );
    });
  });

  describe("updateWidget", () => {
    const dashboardId = "dashboard-123";
    const widgetUuid = "widget-uuid-789";

    it("should update widget and trigger custom event", async () => {
      const mockWidget = createMockWidget({
        id: widgetUuid,
        params: [{ paramName: "symbol", type: "text" }],
      });

      mockGetTabWidgetById.mockReturnValue(mockWidget);
      mockTriggerCustomEvent.mockReturnValue(true);

      await updateWidget(dashboardId, widgetUuid, {
        dataArgs: { symbol: "MSFT" },
      });

      expect(mockGetTabWidgetById).toHaveBeenCalledWith(dashboardId, widgetUuid);
      expect(mockTriggerCustomEvent).toHaveBeenCalledWith(
        `updateWidget-${widgetUuid}`,
        expect.any(Function),
      );
    });

    it("should throw error when widget not found", async () => {
      mockGetTabWidgetById.mockReturnValue(null);

      await expect(
        updateWidget(dashboardId, widgetUuid, { dataArgs: { symbol: "AAPL" } }),
      ).rejects.toThrow(
        `Widget with UUID '${widgetUuid}' not found in dashboard '${dashboardId}'`,
      );
    });

    it("should throw error when widget is undefined", async () => {
      mockGetTabWidgetById.mockReturnValue(undefined);

      await expect(updateWidget(dashboardId, widgetUuid, {})).rejects.toThrow(
        `Widget with UUID '${widgetUuid}' not found in dashboard '${dashboardId}'`,
      );
    });

    it("should persist to the store even when no widget is listening (event returns false)", async () => {
      const mockWidget = createMockWidget({
        id: widgetUuid,
        params: [{ paramName: "symbol", type: "text" }],
      });

      mockGetTabWidgetById.mockReturnValue(mockWidget);
      mockTriggerCustomEvent.mockReturnValue(false);

      await expect(
        updateWidget(dashboardId, widgetUuid, { dataArgs: { symbol: "AAPL" } }),
      ).resolves.toBeUndefined();

      expect(mockUpdateWidgetInStore).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          id: widgetUuid,
          storage: expect.objectContaining({
            params: expect.objectContaining({ symbol: "AAPL" }),
          }),
        }),
      );
    });

    it("should update the text of a markdown note", async () => {
      const mockWidget = createMockWidget({
        id: widgetUuid,
        widgetId: "markdown",
        type: "custom",
        params: [],
        storage: { text: "old" },
      });

      mockGetTabWidgetById.mockReturnValue(mockWidget);
      mockTriggerCustomEvent.mockReturnValue(true);

      await updateWidget(dashboardId, widgetUuid, {
        uiArgs: { text: "new" },
      });

      expect(mockUpdateWidgetInStore.mock.calls[0][1].storage?.text).toBe("new");
      expect(mockTriggerCustomEvent).toHaveBeenCalledWith(
        `updateWidget-${widgetUuid}`,
        expect.any(Function),
      );
    });

    it("should trigger updateQueryParams event", async () => {
      const mockWidget = createMockWidget({
        id: widgetUuid,
        type: "html",
        params: [{ paramName: "symbol", type: "text" }],
      });

      mockGetTabWidgetById.mockReturnValue(mockWidget);
      mockTriggerCustomEvent.mockReturnValue(true);

      await updateWidget(dashboardId, widgetUuid, {
        dataArgs: { symbol: "GOOGL" },
      });

      const updateFnCall = mockTriggerCustomEvent.mock.calls.find(
        (call) => call[0] === `updateWidget-${widgetUuid}`,
      );

      expect(updateFnCall).toBeDefined();

      if (typeof updateFnCall?.[1] === "function") {
        const updateFn = updateFnCall[1];
        updateFn(mockWidget);

        expect(mockTriggerCustomEvent).toHaveBeenCalledWith(
          `updateQueryParams-${widgetUuid}`,
          expect.objectContaining({ symbol: "GOOGL" }),
        );
      }
    });

    it("should persist the updated params to the store", async () => {
      const mockWidget = createMockWidget({
        id: widgetUuid,
        params: [{ paramName: "region", type: "text" }],
      });

      mockGetTabWidgetById.mockReturnValue(mockWidget);
      mockTriggerCustomEvent.mockReturnValue(true);

      await updateWidget(dashboardId, widgetUuid, {
        dataArgs: { region: "north" },
      });

      expect(mockUpdateWidgetInStore).toHaveBeenCalledTimes(1);
      expect(mockUpdateWidgetInStore).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          id: widgetUuid,
          storage: expect.objectContaining({
            params: expect.objectContaining({ region: "north" }),
          }),
        }),
      );
    });
  });

  describe("deleteWidget", () => {
    const dashboardId = "dashboard-123";
    const widgetUuid = "widget-to-delete";

    it("should call removeWidget with correct parameters", async () => {
      mockGetTabWidgetById
        .mockReturnValueOnce(createMockWidget({ id: widgetUuid }))
        .mockReturnValueOnce(undefined);

      await deleteWidget(dashboardId, widgetUuid);

      expect(mockRemoveWidget).toHaveBeenCalledWith(dashboardId, widgetUuid);
      expect(mockRemoveWidget).toHaveBeenCalledTimes(1);
    });

    it("should throw when the widget does not belong to the dashboard", async () => {
      mockGetTabWidgetById.mockReturnValue(undefined);

      await expect(deleteWidget(dashboardId, widgetUuid)).rejects.toThrow(
        `Widget with UUID '${widgetUuid}' not found in dashboard '${dashboardId}'`,
      );
    });

    it("should handle multiple delete calls", async () => {
      mockGetTabWidgetById
        .mockReturnValueOnce(createMockWidget({ id: "widget-1" }))
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(createMockWidget({ id: "widget-2" }))
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(createMockWidget({ id: "widget-3" }))
        .mockReturnValueOnce(undefined);

      await deleteWidget(dashboardId, "widget-1");
      await deleteWidget(dashboardId, "widget-2");
      await deleteWidget(dashboardId, "widget-3");

      expect(mockRemoveWidget).toHaveBeenCalledTimes(3);
      expect(mockRemoveWidget).toHaveBeenNthCalledWith(1, dashboardId, "widget-1");
      expect(mockRemoveWidget).toHaveBeenNthCalledWith(2, dashboardId, "widget-2");
      expect(mockRemoveWidget).toHaveBeenNthCalledWith(3, dashboardId, "widget-3");
    });
  });

  describe("updateWidgetState (internal helper via createWidget)", () => {
    const dashboardId = "dashboard-123";
    const backendName = "workspace";

    it("should preserve existing storage when updating", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "test-widget",
        storage: {
          existingProp: "existing-value",
          params: { oldParam: "old" },
        },
        params: [{ paramName: "newParam", type: "text" }],
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget(dashboardId, backendName, "test-widget", {
        dataArgs: { newParam: "new" },
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          storage: expect.objectContaining({
            existingProp: "existing-value",
            params: expect.objectContaining({
              oldParam: "old",
              newParam: "new",
            }),
          }),
        }),
      );
    });

    it("should not overwrite uiArgs with null values", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "test-widget",
        name: "Original Name",
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget(dashboardId, backendName, "test-widget", {
        uiArgs: { name: null, customProp: null },
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          name: "Original Name",
        }),
      );
    });

    it("should handle empty config object", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "test-widget",
        params: [{ paramName: "symbol", type: "text" }],
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget(dashboardId, backendName, "test-widget", {});

      expect(mockAddWidget).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          storage: expect.objectContaining({ params: {} }),
        }),
      );
    });

    it("should handle widget with undefined storage", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "test-widget",
        storage: undefined,
        params: [{ paramName: "param1", type: "text" }],
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget(dashboardId, backendName, "test-widget", {
        dataArgs: { param1: "value1" },
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        dashboardId,
        expect.objectContaining({
          storage: expect.objectContaining({
            params: { param1: "value1" },
          }),
        }),
      );
    });

    it("should extract gridData from uiArgs and merge onto widget.gridData", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "test-widget",
        gridData: { x: 0, y: 0, w: 20, h: 10 },
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget("dashboard-123", "workspace", "test-widget", {
        uiArgs: { gridData: { w: 40, h: 12 } },
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        "dashboard-123",
        expect.objectContaining({ gridData: { x: 0, y: 0, w: 40, h: 12 } }),
      );
      const widget = mockAddWidget.mock.calls[0][1];
      expect(widget.storage.gridData).toBeUndefined();
    });

    it("refuses gridData that is not an object of numbers, and creates nothing", async () => {
      mockGetAppWidget.mockReturnValue(
        createMockWidget({ gridData: { x: 0, y: 0, w: 20, h: 10 } }),
      );
      mockAddWidget.mockResolvedValue("widget-id");

      await expect(
        createWidget("dashboard-123", "workspace", "test-widget", {
          uiArgs: { gridData: [1, 2, 3] },
        }),
      ).rejects.toThrow("`ui_args.gridData` must be object");
      await expect(
        createWidget("dashboard-123", "workspace", "test-widget", {
          uiArgs: { gridData: { w: "not-a-number", h: 12 } },
        }),
      ).rejects.toThrow("`ui_args.gridData.w` must be number");
      await expect(
        createWidget("dashboard-123", "workspace", "test-widget", {
          uiArgs: { gridData: { depth: 3 } },
        }),
      ).rejects.toThrow("`ui_args.gridData.depth` is not a key this widget accepts");
      expect(mockAddWidget).not.toHaveBeenCalled();
    });

    it("refuses a ui_args key the widget's type does not read", async () => {
      mockGetAppWidget.mockReturnValue(createMockWidget({ type: "markdown" }));
      mockAddWidget.mockResolvedValue("widget-id");

      await expect(
        createWidget("dashboard-123", "workspace", "test-widget", {
          uiArgs: { html: "<p>x</p>", customProp: "value" },
        }),
      ).rejects.toThrow(
        "ui_args were not applied: `ui_args.html` is not a key this widget accepts; `ui_args.customProp` is not a key this widget accepts",
      );
      expect(mockAddWidget).not.toHaveBeenCalled();
    });

    it("should not apply gridData when it is null", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "test-widget",
        gridData: { x: 0, y: 0, w: 20, h: 10 },
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget("dashboard-123", "workspace", "test-widget", {
        uiArgs: { gridData: null },
      });

      const widget = mockAddWidget.mock.calls[0][1];
      expect(widget.gridData).toEqual({ x: 0, y: 0, w: 20, h: 10 });
    });

    it("should extract innerTab from uiArgs and set on widget", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "test-widget",
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget("dashboard-123", "workspace", "test-widget", {
        uiArgs: { innerTab: "overview" },
      });

      const widget = mockAddWidget.mock.calls[0][1];
      expect(widget.innerTab).toBe("overview");
      expect(widget.storage.innerTab).toBeUndefined();
    });

    it("refuses an innerTab that is not a string", async () => {
      mockGetAppWidget.mockReturnValue(createMockWidget());
      mockAddWidget.mockResolvedValue("widget-id");

      await expect(
        createWidget("dashboard-123", "workspace", "test-widget", {
          uiArgs: { innerTab: 123 },
        }),
      ).rejects.toThrow("`ui_args.innerTab` must be string");
      expect(mockAddWidget).not.toHaveBeenCalled();
    });

    it("should handle gridData and innerTab together", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "test-widget",
        gridData: { x: 0, y: 0, w: 20, h: 10 },
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget("dashboard-123", "workspace", "test-widget", {
        uiArgs: {
          gridData: { w: 40, h: 12 },
          innerTab: "charts",
          html: "<p>content</p>",
        },
      });

      const widget = mockAddWidget.mock.calls[0][1];
      expect(widget.gridData).toEqual({ x: 0, y: 0, w: 40, h: 12 });
      expect(widget.innerTab).toBe("charts");
      expect(widget.storage.html).toBe("<p>content</p>");
      expect(widget.storage.gridData).toBeUndefined();
      expect(widget.storage.innerTab).toBeUndefined();
    });
  });

  describe("computeWidgetParamUpdates", () => {
    const paramsDef = [
      { paramName: "symbol", type: "text" },
      { paramName: "raw", type: "boolean" },
      { paramName: "limit", type: "number" },
      { paramName: "query", type: "text" },
    ] as WidgetT["params"];

    it("copies declared dataArgs values, preserving false, 0, and empty string", () => {
      const result = computeWidgetParamUpdates(paramsDef, {
        symbol: "AAPL",
        raw: false,
        limit: 0,
        query: "",
      });

      expect(result.params).toEqual({
        symbol: "AAPL",
        raw: false,
        limit: 0,
        query: "",
      });
      expect(result.droppedKeys).toEqual([]);
    });

    it("skips undefined, null, and 'null' sentinel values", () => {
      const result = computeWidgetParamUpdates(paramsDef, {
        symbol: "AAPL",
        raw: undefined,
        limit: null,
        query: "null",
      });

      expect(result.params).toEqual({ symbol: "AAPL" });
      expect(result.droppedKeys).toEqual([]);
    });

    it("collects dataArgs keys the widget does not declare as droppedKeys", () => {
      const result = computeWidgetParamUpdates(paramsDef, {
        symbol: "AAPL",
        bogus_param: "x",
        another: 1,
      });

      expect(result.params).toEqual({ symbol: "AAPL" });
      expect(result.droppedKeys).toEqual(["bogus_param", "another"]);
    });

    it("collects values their param's schema does not accept as invalidKeys", () => {
      const result = computeWidgetParamUpdates(
        [
          ...(paramsDef ?? []),
          {
            paramName: "period",
            type: "text",
            options: [
              { label: "Annual", value: "annual" },
              { label: "Quarter", value: "quarter" },
            ],
          },
          { paramName: "start", type: "date" },
        ] as WidgetT["params"],
        {
          limit: "ten",
          raw: "maybe",
          period: "weekly",
          start: "yesterday",
          symbol: "AAPL",
        },
      );

      expect(result.params).toEqual({ symbol: "AAPL" });
      expect(result.invalidKeys).toEqual(["raw", "limit", "period", "start"]);
    });

    it("accepts what the widget's request accepts: numeric strings, $currentDate, lists", () => {
      const result = computeWidgetParamUpdates(
        [
          { paramName: "limit", type: "number" },
          { paramName: "start", type: "date" },
          { paramName: "tags", type: "endpoint", multiSelect: true },
        ] as WidgetT["params"],
        { limit: "10", start: "$currentDate-1M", tags: ["a", "b"] },
      );

      expect(result.invalidKeys).toEqual([]);
      expect(result.params).toEqual({
        limit: "10",
        start: "$currentDate-1M",
        tags: ["a", "b"],
      });
    });

    it("returns empty params and drops every key when the widget declares no params", () => {
      const result = computeWidgetParamUpdates(undefined, { someArg: "value" });

      expect(result.params).toEqual({});
      expect(result.droppedKeys).toEqual(["someArg"]);
    });

    it("handles missing dataArgs", () => {
      const result = computeWidgetParamUpdates(paramsDef, undefined);

      expect(result.params).toEqual({});
      expect(result.droppedKeys).toEqual([]);
    });
  });

  describe("computeWidgetUiUpdates", () => {
    it("routes name/description/source onto widget props and the type's keys to storage", () => {
      const result = computeWidgetUiUpdates(
        { type: "html" },
        {
          name: "New Name",
          description: "New Description",
          source: ["a", "b"],
          html: "<p>content</p>",
        },
      );

      expect(result).toMatchObject({
        name: "New Name",
        description: "New Description",
        source: ["a", "b"],
        storage: { html: "<p>content</p>" },
        problems: [],
      });
    });

    it("reports a key the widget's type does not read, and applies nothing", () => {
      const result = computeWidgetUiUpdates(
        { type: "html" },
        { name: "New Name", text: "a note", customProp: "value" },
      );

      expect(result.problems).toEqual([
        "`ui_args.text` is not a key this widget accepts",
        "`ui_args.customProp` is not a key this widget accepts",
      ]);
      expect(result.name).toBeUndefined();
      expect(result.storage).toEqual({});
    });

    it("skips undefined, null, and 'null' values", () => {
      const result = computeWidgetUiUpdates(
        { type: "html" },
        {
          name: "null",
          description: null,
          source: undefined,
          customProp: null,
        },
      );

      expect(result).toMatchObject({ storage: {}, problems: [] });
      expect(result.name).toBeUndefined();
      expect(result.description).toBeUndefined();
      expect(result.source).toBeUndefined();
    });

    it("handles missing uiArgs", () => {
      expect(computeWidgetUiUpdates({ type: "markdown" }, undefined)).toMatchObject({
        storage: {},
        problems: [],
      });
    });
  });

  describe("edge cases", () => {
    it("should handle special characters in dashboard and widget IDs", async () => {
      const specialWidgetUuid = "widget-uuid_with.special-chars";

      mockGetTabWidgetById.mockReturnValue(createMockWidget({ id: specialWidgetUuid }));
      mockTriggerCustomEvent.mockReturnValue(true);

      await updateWidget("dashboard-123", specialWidgetUuid, {});

      expect(mockGetTabWidgetById).toHaveBeenCalledWith(
        "dashboard-123",
        specialWidgetUuid,
      );
    });

    it("should handle concurrent widget operations", async () => {
      const mockWidget = createMockWidget({
        params: [{ paramName: "value", type: "text" }],
      });

      mockGetTabWidgetById.mockReturnValue(mockWidget);
      mockTriggerCustomEvent.mockReturnValue(true);

      const updates = [
        updateWidget("dashboard-123", "widget-1", { dataArgs: { value: "a" } }),
        updateWidget("dashboard-123", "widget-2", { dataArgs: { value: "b" } }),
        updateWidget("dashboard-123", "widget-3", { dataArgs: { value: "c" } }),
      ];

      await expect(Promise.all(updates)).resolves.toBeDefined();
      expect(mockTriggerCustomEvent).toHaveBeenCalledTimes(3);
    });

    it("should propagate error when addWidget fails", async () => {
      const mockWidgetDef = createMockWidget({ widgetId: "test-widget" });
      const addWidgetError = new Error("Failed to add widget to dashboard");

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockRejectedValue(addWidgetError);

      await expect(
        createWidget("dashboard-123", "workspace", "test-widget", {}),
      ).rejects.toThrow("Failed to add widget to dashboard");
    });

    it("should handle widget with undefined params array", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "no-params-widget",
        params: undefined,
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget("dashboard-123", "workspace", "no-params-widget", {
        dataArgs: { someArg: "value" },
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        "dashboard-123",
        expect.objectContaining({
          storage: expect.objectContaining({ params: {} }),
        }),
      );
    });

    it("should handle uiArgs with undefined values", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "test-widget",
        name: "Original",
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget("dashboard-123", "workspace", "test-widget", {
        uiArgs: { name: undefined, description: undefined, customProp: undefined },
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        "dashboard-123",
        expect.objectContaining({
          name: "Original",
        }),
      );
    });

    it("should handle uiArgs with 'null' string values", async () => {
      const mockWidgetDef = createMockWidget({
        widgetId: "test-widget",
        name: "Original",
        description: "Original Description",
      });

      mockGetAppWidget.mockReturnValue(mockWidgetDef);
      mockAddWidget.mockResolvedValue("widget-id");

      await createWidget("dashboard-123", "workspace", "test-widget", {
        uiArgs: { name: "null", description: "null" },
      });

      expect(mockAddWidget).toHaveBeenCalledWith(
        "dashboard-123",
        expect.objectContaining({
          name: "Original",
          description: "Original Description",
        }),
      );
    });

    it("should handle removeWidget throwing an error", async () => {
      mockGetTabWidgetById.mockReturnValue(createMockWidget({ id: "widget-123" }));
      mockRemoveWidget.mockImplementation(() => {
        throw new Error("Remove failed");
      });

      await expect(deleteWidget("dashboard-123", "widget-123")).rejects.toThrow(
        "Remove failed",
      );
    });

    it("should persist empty string param values instead of dropping them", async () => {
      const mockWidget = createMockWidget({
        params: [{ paramName: "value", type: "text" }],
        storage: { existingProp: "" },
      });

      mockGetTabWidgetById.mockReturnValue(mockWidget);
      mockTriggerCustomEvent.mockReturnValue(true);

      await updateWidget("dashboard-123", "widget", {
        dataArgs: { value: "" },
      });

      const updateFnCall = mockTriggerCustomEvent.mock.calls.find(
        (call) => call[0] === "updateWidget-widget",
      );

      expect(updateFnCall?.[1]).toBeTypeOf("function");
      if (typeof updateFnCall?.[1] === "function") {
        const result = updateFnCall[1](mockWidget);
        expect(result.storage.params.value).toBe("");
      }
    });

    it("should persist false and 0 param values on update", async () => {
      const mockWidget = createMockWidget({
        params: [
          { paramName: "raw", type: "boolean" },
          { paramName: "limit", type: "number" },
        ],
      });

      mockGetTabWidgetById.mockReturnValue(mockWidget);
      mockTriggerCustomEvent.mockReturnValue(true);

      await updateWidget("dashboard-123", "widget", {
        dataArgs: { raw: false, limit: 0 },
      });

      expect(mockUpdateWidgetInStore).toHaveBeenCalledWith(
        "dashboard-123",
        expect.objectContaining({
          storage: expect.objectContaining({
            params: expect.objectContaining({ raw: false, limit: 0 }),
          }),
        }),
      );
    });

    it("should fallback to empty object when storage.params is undefined", async () => {
      const mockWidget = createMockWidget({
        type: "html",
        params: [],
        storage: undefined,
      }) as WidgetT;

      mockGetTabWidgetById.mockReturnValue(mockWidget);
      mockTriggerCustomEvent.mockReturnValue(true);

      await updateWidget("dashboard-123", "widget", {});

      const updateFnCall = mockTriggerCustomEvent.mock.calls.find(
        (call) => call[0] === "updateWidget-widget",
      );

      expect(updateFnCall).toBeDefined();

      if (typeof updateFnCall?.[1] === "function") {
        const updateFn = updateFnCall[1];
        updateFn(mockWidget);

        const updateQueryParamsCall = mockTriggerCustomEvent.mock.calls.find(
          (call) => call[0] === "updateQueryParams-widget",
        );
        expect(updateQueryParamsCall).toBeDefined();
        expect(updateQueryParamsCall?.[1]).toEqual({});
      }
    });
  });
});
