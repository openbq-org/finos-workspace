import { useAppStore } from "~/lib/state/app";

const NO_TAB_ID = "__no_tab__";

type DashboardLayoutEntryT = {
  widget_uuid: string;
  x: number;
  y: number;
  w: number;
  h: number;
  min_w?: number;
  min_h?: number;
  max_w?: number;
  max_h?: number;
};

type DashboardTabWidgetInfoT = {
  widget_uuid: string;
  name: string | undefined;
  copied_from?: { widget_uuid: string; name: string; created_at?: string };
  from_artifact?: {
    artifact_uuid: string;
    name: string;
    created_at?: string;
    in_current_chat: boolean;
  };
};

type DashboardTabInfoT = {
  tab_id: string;
  tab_name: string;
  widgets: DashboardTabWidgetInfoT[];
  layout: DashboardLayoutEntryT[];
};

type DashboardGroupInfoT = {
  group_id: string;
  name: string;
  type: string;
  group_by_id?: string;
  widget_uuids: string[];
};

export type DashboardInfoT = {
  id: string;
  name: string | undefined;
  current_tab_id: string | undefined;
  current_tab_name: string | undefined;
  tabs: DashboardTabInfoT[];
  groups: DashboardGroupInfoT[];
} | null;

function normalizeStoredTabId(tabId: string | null | undefined) {
  return tabId?.trim() || "";
}

export function serializeDashboardTabId(tabId: string | null | undefined) {
  return normalizeStoredTabId(tabId) || NO_TAB_ID;
}

export function deserializeDashboardTabId(tabId: string | null | undefined) {
  return serializeDashboardTabId(tabId) === NO_TAB_ID
    ? ""
    : normalizeStoredTabId(tabId);
}

function getTabDisplayName(
  serializedTabId: string,
  storedTabId: string,
  slugToName: Record<string, string>,
) {
  if (serializedTabId === NO_TAB_ID) {
    return NO_TAB_ID;
  }

  return slugToName[storedTabId] || storedTabId;
}

function sortLayoutEntries(a: DashboardLayoutEntryT, b: DashboardLayoutEntryT) {
  if (a.y !== b.y) return a.y - b.y;
  if (a.x !== b.x) return a.x - b.x;
  return a.widget_uuid.localeCompare(b.widget_uuid);
}

export function getDashboardInfo(
  dashboardId: string | null | undefined,
  currentTab?: string | null,
  currentChatArtifacts: ReadonlySet<string> = new Set(),
): DashboardInfoT {
  if (!dashboardId) {
    return null;
  }

  const dashboard = useAppStore.getState().items?.[dashboardId];
  if (!dashboard?.data) {
    return null;
  }

  const widgets = dashboard.data.widgets || [];
  const gridLayout = dashboard.data.gridLayout || {};
  const widgetsById = new Map(widgets.map((widget) => [widget.id, widget] as const));
  const navBarWidget = widgets.find((widget) => widget.widgetId === "navigation_bar");
  const navBarTabs = Array.isArray(navBarWidget?.storage?.tabs)
    ? (navBarWidget.storage.tabs as { id: string; name: string }[])
    : [];
  const slugToName = Object.fromEntries(
    navBarTabs.map((tab) => [tab.id, tab.name] as const),
  );
  const tabsById = new Map<string, DashboardTabInfoT>();

  const ensureTab = (tabId: string | null | undefined) => {
    const storedTabId = normalizeStoredTabId(tabId);
    const serializedTabId = serializeDashboardTabId(storedTabId);
    let tab = tabsById.get(serializedTabId);
    if (!tab) {
      tab = {
        tab_id: serializedTabId,
        tab_name: getTabDisplayName(serializedTabId, storedTabId, slugToName),
        widgets: [],
        layout: [],
      };
      tabsById.set(serializedTabId, tab);
    }
    return { storedTabId, serializedTabId, tab };
  };

  for (const tab of navBarTabs) {
    ensureTab(tab.id);
  }

  const normalizedCurrentTab = normalizeStoredTabId(
    currentTab ?? dashboard.data.currentTab,
  );
  ensureTab(normalizedCurrentTab);

  for (const widget of widgets) {
    if (widget.widgetId === "navigation_bar") {
      continue;
    }

    const { tab } = ensureTab(widget.innerTab);
    const copiedFrom = widget.storage?.copiedFrom;
    const fromArtifact = widget.storage?.fromArtifact;
    tab.widgets.push({
      widget_uuid: widget.id,
      name: widget.name,
      ...(copiedFrom
        ? {
            copied_from: {
              widget_uuid: copiedFrom.widgetUuid,
              name: copiedFrom.name,
              ...(widget.storage?.createdAt
                ? { created_at: widget.storage.createdAt }
                : {}),
            },
          }
        : {}),
      ...(fromArtifact
        ? {
            from_artifact: {
              artifact_uuid: fromArtifact.artifactUuid,
              name: fromArtifact.name,
              ...(widget.storage?.createdAt
                ? { created_at: widget.storage.createdAt }
                : {}),
              in_current_chat: currentChatArtifacts.has(fromArtifact.artifactUuid),
            },
          }
        : {}),
    });
  }

  for (const [tabId, entries] of Object.entries(gridLayout)) {
    const { tab } = ensureTab(tabId);
    tab.layout = entries
      .filter(
        (entry): entry is typeof entry & { i: string } =>
          entry.i !== undefined &&
          widgetsById.get(entry.i)?.widgetId !== "navigation_bar",
      )
      .map((entry) => ({
        widget_uuid: entry.i,
        x: entry.x ?? 0,
        y: entry.y ?? 0,
        w: entry.w ?? 0,
        h: entry.h ?? 0,
        ...(entry.minW !== undefined ? { min_w: entry.minW } : {}),
        ...(entry.minH !== undefined ? { min_h: entry.minH } : {}),
        ...(entry.maxW !== undefined ? { max_w: entry.maxW } : {}),
        ...(entry.maxH !== undefined ? { max_h: entry.maxH } : {}),
      }))
      .sort(sortLayoutEntries);
  }

  for (const tab of tabsById.values()) {
    const order = new Map(
      tab.layout.map((entry, index) => [entry.widget_uuid, index] as const),
    );
    tab.widgets.sort((a, b) => {
      const aIndex = order.get(a.widget_uuid) ?? Number.MAX_SAFE_INTEGER;
      const bIndex = order.get(b.widget_uuid) ?? Number.MAX_SAFE_INTEGER;
      if (aIndex !== bIndex) return aIndex - bIndex;
      return a.widget_uuid.localeCompare(b.widget_uuid);
    });
  }

  const groups = (dashboard.data.groups || []).map((g) => ({
    group_id: g.id,
    name: g.name,
    type: g.type,
    ...(g.type === "endpointParam" && g.groupById ? { group_by_id: g.groupById } : {}),
    widget_uuids: widgets
      .filter((widget) => Object.values(widget.paramGroups || {}).includes(g.id))
      .map((widget) => widget.id),
  }));

  return {
    id: dashboardId,
    name: dashboard.data.name,
    current_tab_id: serializeDashboardTabId(normalizedCurrentTab),
    current_tab_name: getTabDisplayName(
      serializeDashboardTabId(normalizedCurrentTab),
      normalizedCurrentTab,
      slugToName,
    ),
    tabs: Array.from(tabsById.values()),
    groups,
  };
}
