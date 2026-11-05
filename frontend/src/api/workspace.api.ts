import type { LayoutItem } from "react-grid-layout";
import { useGetWidgetsStore } from "~/components/AI/hooks/useGetAppWidgets";
import { getWidgetOrigin } from "~/components/AI/hooks/utils";
import type { ParamDef, StoredParamValue, WidgetT } from "~/components/types";
import type { WidgetId } from "~/components/Widgets";
import { DASHBOARD_LOCKED_MESSAGE, useAppStore } from "~/lib/state/app";
import { useCopilotDataStore } from "~/lib/state/copilotData";
import { triggerCustomEvent } from "~/lib/utils";
import {
  argsProblems,
  paramValueSchema,
  pluginSettings,
  uiArgsSchema,
} from "~/lib/utils/widgetArgsSchema";
import { isStoredParamValue } from "~/lib/utils/widgetParams";
import {
  deserializeDashboardTabId,
  getDashboardInfo,
} from "~/lib/utils/workspaceDashboard";
import { cleanSettings } from "~/plugins/SettingsForm";
import type { PluginInstanceStorage } from "~/plugins/types";

type WidgetConfig = {
  dataArgs?: Record<string, unknown>;
  uiArgs?: Record<string, unknown>;
};

type DashboardConfig = {
  name: string;
};

type DashboardLayoutConfig = {
  tabId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
};

const GRID_COLUMN_COUNT = 40;

function getNumericConstraint(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function assertGridInteger(name: string, value: number, minimum: number) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
}

function validateDashboardLayout(
  widget: WidgetT,
  existingGridData: Record<string, unknown>,
  config: DashboardLayoutConfig,
) {
  assertGridInteger("x", config.x, 0);
  assertGridInteger("y", config.y, 0);
  assertGridInteger("w", config.w, 1);
  assertGridInteger("h", config.h, 1);

  if (config.x + config.w > GRID_COLUMN_COUNT) {
    throw new Error(
      `Widget layout must fit inside the ${GRID_COLUMN_COUNT}-column grid: x + w must be <= ${GRID_COLUMN_COUNT}.`,
    );
  }

  const minW = getNumericConstraint(existingGridData.minW, widget.gridData?.minW);
  const minH = getNumericConstraint(existingGridData.minH, widget.gridData?.minH);
  const maxW = getNumericConstraint(
    existingGridData.maxW,
    widget.gridData?.maxW,
    GRID_COLUMN_COUNT,
  );
  const maxH = getNumericConstraint(existingGridData.maxH, widget.gridData?.maxH);

  if (minW !== undefined && config.w < minW) {
    throw new Error(`Widget width ${config.w} is below the minimum width ${minW}.`);
  }

  if (minH !== undefined && config.h < minH) {
    throw new Error(`Widget height ${config.h} is below the minimum height ${minH}.`);
  }

  if (maxW !== undefined && config.w > maxW) {
    throw new Error(`Widget width ${config.w} exceeds the maximum width ${maxW}.`);
  }

  if (maxH !== undefined && config.h > maxH) {
    throw new Error(`Widget height ${config.h} exceeds the maximum height ${maxH}.`);
  }
}

function lockedDashboardError(dashboardId: string, detail = "") {
  return new Error(
    `Dashboard '${dashboardId}' is locked. ${DASHBOARD_LOCKED_MESSAGE}${detail}`,
  );
}

function createDashboard(dashboardId: string, config: DashboardConfig): string {
  const appState = useAppStore.getState();
  if (appState.items?.[dashboardId]) {
    throw new Error(`Dashboard '${dashboardId}' already exists`);
  }

  appState.addTab({
    index: dashboardId,
    data: {
      name: config.name,
      type: "custom",
      widgets: [],
      groups: [],
      gridLayout: {},
    },
  });

  if (!useAppStore.getState().items?.[dashboardId]) {
    throw new Error(`Failed to create dashboard '${dashboardId}'`);
  }

  return dashboardId;
}

function updateDashboard(dashboardId: string, config: Partial<DashboardConfig>): void {
  const appState = useAppStore.getState();
  const dashboard = appState.items?.[dashboardId];
  if (!dashboard?.data) {
    throw new Error(
      `Dashboard '${dashboardId}' not found. Call get_workspace_snapshot to list dashboard_ids.`,
    );
  }

  appState.updateTabData(dashboardId, config);
}

function readDashboard(dashboardId: string, currentTab?: string | null) {
  const dashboard = getDashboardInfo(dashboardId, currentTab);
  if (!dashboard) {
    throw new Error(
      `Dashboard '${dashboardId}' not found. Call get_workspace_snapshot to list dashboard_ids.`,
    );
  }

  return dashboard;
}

function getDashboardWidgetOrThrow(dashboardId: string, widgetUuid: string): WidgetT {
  const appState = useAppStore.getState();
  const dashboard = appState.items?.[dashboardId];
  if (!dashboard?.data) {
    throw new Error(
      `Dashboard '${dashboardId}' not found. Call get_workspace_snapshot to list dashboard_ids.`,
    );
  }

  const widget = appState.getTabWidgetById(dashboardId, widgetUuid);
  if (!widget) {
    throw new Error(
      `Widget with UUID '${widgetUuid}' not found in dashboard '${dashboardId}'`,
    );
  }

  return widget;
}

function updateDashboardLayout(
  dashboardId: string,
  widgetUuid: string,
  config: DashboardLayoutConfig,
): void {
  const appState = useAppStore.getState();
  const dashboard = appState.items?.[dashboardId];
  if (!dashboard?.data) {
    throw new Error(
      `Dashboard '${dashboardId}' not found. Call get_workspace_snapshot to list dashboard_ids.`,
    );
  }

  const widget = getDashboardWidgetOrThrow(dashboardId, widgetUuid);

  const dashboardInfo = readDashboard(dashboardId);
  const targetTabId =
    config.tabId !== undefined
      ? deserializeDashboardTabId(config.tabId)
      : widget.innerTab || "";
  const serializedTargetTabId = config.tabId !== undefined ? config.tabId : undefined;
  if (
    serializedTargetTabId !== undefined &&
    !dashboardInfo.tabs.some((tab) => tab.tab_id === serializedTargetTabId)
  ) {
    throw new Error(
      `Tab '${serializedTargetTabId}' was not found on dashboard '${dashboardId}'`,
    );
  }

  const existingGridData = appState.getWidgetGridData(dashboardId, widgetUuid);
  if (!existingGridData) {
    throw new Error(
      `Widget with UUID '${widgetUuid}' has no grid layout on dashboard '${dashboardId}'`,
    );
  }

  validateDashboardLayout(widget, existingGridData as Record<string, unknown>, config);

  const nextGridData = {
    ...existingGridData,
    i: widgetUuid,
    x: config.x,
    y: config.y,
    w: config.w,
    h: config.h,
    ...(config.minW !== undefined ? { minW: config.minW } : {}),
    ...(config.minH !== undefined ? { minH: config.minH } : {}),
    ...(config.maxW !== undefined ? { maxW: config.maxW } : {}),
    ...(config.maxH !== undefined ? { maxH: config.maxH } : {}),
  };
  const { gridLayout } = dashboard.data as {
    gridLayout?: Record<string, LayoutItem[]>;
  };
  const sourceTabId = widget.innerTab || "";
  if (
    appState.isDashboardLocked(dashboardId) &&
    (sourceTabId !== targetTabId ||
      config.x !== existingGridData.x ||
      config.y !== existingGridData.y)
  ) {
    throw lockedDashboardError(
      dashboardId,
      " Only the width and height of its widgets can change.",
    );
  }
  const targetLayout = [...(gridLayout?.[targetTabId] || [])].filter(
    (entry) => entry.i !== widgetUuid,
  );
  targetLayout.push(nextGridData);

  if (sourceTabId !== targetTabId) {
    const sourceLayout = [...(gridLayout?.[sourceTabId] || [])];
    appState.updateTabWidgetsLayout(
      dashboardId,
      sourceLayout.filter((entry) => entry.i !== widgetUuid),
      sourceTabId,
    );
  }

  appState.updateTabWidgetsLayout(dashboardId, targetLayout, targetTabId);
  appState.updateWidget(dashboardId, { ...widget, innerTab: targetTabId });
}

async function createWidget(
  dashboardId: string,
  backendName: string,
  widgetId: string,
  config: WidgetConfig,
): Promise<string> {
  if (useAppStore.getState().isDashboardLocked(dashboardId)) {
    throw lockedDashboardError(dashboardId);
  }
  const widgetDefinition = getWidgetDefinitionOrThrow(backendName, widgetId);
  const widget = updateWidgetState(widgetDefinition, config);
  const { id: _defId, ...rest } = widget;
  const id = await useAppStore.getState().addWidget(dashboardId, rest as WidgetT);
  if (!id) throw new Error("Failed to create widget");
  return id;
}

function readWidget(
  dashboardId: string,
  widgetUuid: string,
): Record<string, unknown> | null {
  const widget = getDashboardWidgetOrThrow(dashboardId, widgetUuid);

  const origin = getWidgetOrigin(widget as WidgetT);
  const storedParams = widget.storage?.params ?? {};
  const resolveParamValue = (param: ParamDef) =>
    storedParams[param.paramName] ?? param.value;

  const dataArgs: Record<string, unknown> = {};
  if (Array.isArray(widget.params)) {
    for (const param of widget.params) {
      const value = resolveParamValue(param);
      if (param.paramName && value !== undefined && value !== null) {
        dataArgs[param.paramName] = value;
      }
    }
  }

  const result: Record<string, unknown> = {
    origin,
    widget_id: widget.widgetId,
    name: widget.name,
    description: widget.description,
    inner_tab: widget.innerTab,
    data_args: dataArgs,
    params: Array.isArray(widget.params)
      ? widget.params.map((p) => ({
          param_name: p.paramName,
          label: p.label ?? p.paramName,
          type: p.type,
          value: resolveParamValue(p) ?? null,
          description: p.description,
        }))
      : [],
  };

  const config = pluginConfig(widget as WidgetT);
  if (config) result.ui_args = { config };
  if (widget.storage?.createdAt) result.created_at = widget.storage.createdAt;
  if (widget.storage?.copiedFrom)
    result.copied_from = {
      widget_uuid: widget.storage.copiedFrom.widgetUuid,
      name: widget.storage.copiedFrom.name,
    };
  if (widget.storage?.fromArtifact)
    result.from_artifact = {
      artifact_uuid: widget.storage.fromArtifact.artifactUuid,
      name: widget.storage.fromArtifact.name,
    };

  const widgetData = useCopilotDataStore.getState().getDashboardWidgetData(widgetUuid);
  if (widgetData?.data) {
    result.data = widgetData.data;
  } else if (typeof widget.storage?.text === "string") {
    result.data = widget.storage.text;
  } else if (typeof widget.storage?.html === "string") {
    result.data = widget.storage.html;
  } else if (
    (widget.storage?.plugin as { data?: unknown } | undefined)?.data !== undefined
  ) {
    result.data = (widget.storage?.plugin as { data?: unknown }).data;
  }

  return result;
}

function pluginConfig(widget: WidgetT): Record<string, unknown> | undefined {
  const settings = pluginSettings(widget);
  return settings
    ? cleanSettings(
        settings,
        (widget.storage?.plugin as PluginInstanceStorage | undefined)?.config,
      )
    : undefined;
}

async function updateWidget(
  dashboardId: string,
  widgetUuid: string,
  config: WidgetConfig,
): Promise<void> {
  const widget = getDashboardWidgetOrThrow(dashboardId, widgetUuid);

  const persistedWidget = updateWidgetState(widget, config);
  useAppStore.getState().updateWidget(dashboardId, persistedWidget);

  const updateFn = (w: WidgetT) => {
    const updatedWidget = updateWidgetState(w, config);
    triggerCustomEvent(
      `updateQueryParams-${widgetUuid}`,
      updatedWidget.storage?.params || {},
    );
    return updatedWidget;
  };
  triggerCustomEvent(`updateWidget-${widgetUuid}`, updateFn);

  if (import.meta.env.DEV) {
    console.debug("[AI updateWidget]", {
      widgetUuid,
      widgetId: widget.widgetId,
      params: persistedWidget.storage?.params,
    });
  }
}

async function deleteWidget(dashboardId: string, widgetUuid: string): Promise<void> {
  const appState = useAppStore.getState();
  getDashboardWidgetOrThrow(dashboardId, widgetUuid);
  if (appState.isDashboardLocked(dashboardId)) throw lockedDashboardError(dashboardId);
  appState.removeWidget(dashboardId, widgetUuid);

  if (useAppStore.getState().getTabWidgetById(dashboardId, widgetUuid)) {
    throw new Error(
      `Failed to delete widget with UUID '${widgetUuid}' from dashboard '${dashboardId}'`,
    );
  }
}

export {
  computeWidgetParamUpdates,
  computeWidgetUiUpdates,
  createDashboard,
  createWidget,
  deleteWidget,
  getWidgetDefinitionOrThrow,
  pluginConfig,
  readDashboard,
  readWidget,
  updateDashboard,
  updateDashboardLayout,
  updateWidget,
};

function getWidgetDefinitionOrThrow(backendName: string, widgetId: string): WidgetT {
  const widgetDefinition = useGetWidgetsStore
    .getState()
    .getAppWidget(widgetId as WidgetId, backendName);
  if (!widgetDefinition)
    throw new Error(
      `Widget '${widgetId}' not found in '${backendName}'. Call list_available_widgets to get valid origin/widget_id pairs.`,
    );
  return widgetDefinition;
}

function computeWidgetParamUpdates(
  paramsDef: WidgetT["params"] | null | undefined,
  dataArgs: Record<string, unknown> | null | undefined,
): {
  params: Record<string, StoredParamValue>;
  droppedKeys: string[];
  invalidKeys: string[];
} {
  const params: Record<string, StoredParamValue> = {};
  const invalidKeys: string[] = [];
  const defs = Array.isArray(paramsDef) ? paramsDef : [];
  const args = dataArgs ?? {};

  const declared = new Set<string>();
  for (const paramDef of defs) {
    const paramName = paramDef.paramName;
    if (paramDef.type === "form" || typeof paramName !== "string" || !paramName)
      continue;
    declared.add(paramName);
    const paramValue = args[paramName];
    if (paramValue !== undefined && paramValue !== null && paramValue !== "null") {
      const valid =
        isStoredParamValue(paramValue) &&
        argsProblems(paramValueSchema(paramDef), paramValue, paramName).length === 0;
      if (valid) params[paramName] = paramValue;
      else invalidKeys.push(paramName);
    }
  }

  const droppedKeys = Object.keys(args).filter((key) => !declared.has(key));
  return { params, droppedKeys, invalidKeys };
}

interface WidgetUiUpdates {
  name?: string;
  description?: string;
  source?: string | string[];
  innerTab?: string;
  gridData?: Record<string, number>;
  storage: Record<string, unknown>;
  config?: Record<string, unknown>;
  problems: string[];
}

function computeWidgetUiUpdates(
  widget: Pick<WidgetT, "type" | "plugin" | "widgetId" | "connectionType">,
  uiArgs: Record<string, unknown> | null | undefined,
): WidgetUiUpdates {
  const given = Object.fromEntries(
    Object.entries(uiArgs ?? {}).filter(
      ([, value]) => value !== undefined && value !== null && value !== "null",
    ),
  );
  const problems = argsProblems(uiArgsSchema(widget), given, "ui_args");
  if (problems.length) return { storage: {}, problems };

  const { name, description, source, innerTab, gridData, config, ...storage } =
    given as {
      name?: string;
      description?: string;
      source?: string | string[];
      innerTab?: string;
      gridData?: Record<string, number>;
      config?: Record<string, unknown>;
    };
  return { name, description, source, innerTab, gridData, config, storage, problems };
}

function updateWidgetState(widget: WidgetT, config: WidgetConfig): WidgetT {
  const { params: newParams } = computeWidgetParamUpdates(
    widget.params,
    config.dataArgs,
  );

  const ui = computeWidgetUiUpdates(widget, config.uiArgs);
  if (ui.problems.length)
    throw new Error(
      `ui_args were not applied: ${ui.problems.join("; ")}. Call get_widget_schema for the widget's ui_args_schema.`,
    );

  return {
    ...widget,
    storage: {
      ...widget.storage,
      ...ui.storage,
      params: {
        ...(widget.storage?.params ?? {}),
        ...newParams,
      },
      ...(ui.config
        ? {
            plugin: {
              ...(widget.storage?.plugin as Record<string, unknown> | undefined),
              config: ui.config,
            },
          }
        : {}),
    },
    ...(ui.gridData && Object.keys(ui.gridData).length > 0
      ? { gridData: { ...widget.gridData, ...ui.gridData } as WidgetT["gridData"] }
      : {}),
    ...(ui.innerTab ? { innerTab: ui.innerTab } : {}),
    name: ui.name ?? widget.name,
    description: ui.description ?? widget.description,
    source: ui.source ?? widget.source,
  };
}
