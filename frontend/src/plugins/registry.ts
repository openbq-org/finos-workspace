import { useMemo } from "react";
import { createWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/vanilla/shallow";
import type { ParamDef, WidgetT } from "~/components/types";
import type {
  AvailablePlugin,
  PluginListing,
  PluginWidgetDef,
  ResolvedPluginWidget,
} from "./types";

interface PluginRegistryState {
  loaded: boolean;
  enabled: boolean;
  etag: string | null;
  plugins: AvailablePlugin[];
  vizHandlers: PluginListing["vizHandlers"];
  setListing: (listing: PluginListing) => void;
  clear: () => void;
}

const EMPTY: Pick<
  PluginRegistryState,
  "loaded" | "enabled" | "etag" | "plugins" | "vizHandlers"
> = {
  loaded: false,
  enabled: false,
  etag: null,
  plugins: [],
  vizHandlers: {},
};

export const usePluginRegistryStore = createWithEqualityFn<PluginRegistryState>()(
  (set, get) => ({
    ...EMPTY,
    setListing: (listing) => {
      if (get().loaded && get().etag === listing.etag) return;
      set({
        loaded: true,
        enabled: listing.enabled,
        etag: listing.etag,
        plugins: listing.plugins,
        vizHandlers: listing.vizHandlers,
      });
    },
    clear: () => set({ ...EMPTY }),
  }),
  shallow,
);

export function getPluginVizTypes(): Set<string> {
  return new Set(Object.keys(usePluginRegistryStore.getState().vizHandlers));
}

function findWidget(
  plugins: AvailablePlugin[],
  pluginId: string,
  widgetId: string,
): { plugin: AvailablePlugin; widget: PluginWidgetDef } | null {
  const plugin = plugins.find((p) => p.id === pluginId);
  const widget = plugin?.widgets.find((w) => w.id === widgetId);
  return plugin && widget ? { plugin, widget } : null;
}

export function resolveVizHandler(
  vizType: string | null | undefined,
  state: Pick<
    PluginRegistryState,
    "plugins" | "vizHandlers"
  > = usePluginRegistryStore.getState(),
): ResolvedPluginWidget | null {
  if (!vizType) return null;
  const handler = state.vizHandlers[vizType];
  if (!handler) return null;
  const found = findWidget(state.plugins, handler.plugin, handler.widget);
  return found ? { ...found, vizType } : null;
}

export function useRowsPlugin(
  rawType: string | undefined,
): ResolvedPluginWidget | null {
  const { plugins, vizHandlers } = usePluginRegistryStore((state) => ({
    plugins: state.plugins,
    vizHandlers: state.vizHandlers,
  }));
  return useMemo(
    () => resolveVizHandler(rawType, { plugins, vizHandlers }),
    [rawType, plugins, vizHandlers],
  );
}

export function resolvePluginWidget(
  reference: { id: string; widget: string } | null | undefined,
  state: Pick<PluginRegistryState, "plugins"> = usePluginRegistryStore.getState(),
): ResolvedPluginWidget | null {
  if (!reference) return null;
  return findWidget(state.plugins, reference.id, reference.widget);
}

export interface PluginArtifactCatalogEntry {
  plugin: string;
  widget: string;
  name: string;
  description: string;
  data_schema: Record<string, unknown>;
  config_schema?: Record<string, unknown>;
}

export function getPluginArtifactCatalog(): PluginArtifactCatalogEntry[] {
  return usePluginRegistryStore.getState().plugins.flatMap((plugin) =>
    plugin.widgets.flatMap((widget) =>
      widget.artifact
        ? [
            {
              plugin: plugin.id,
              widget: widget.id,
              name: widget.name,
              description: widget.artifact.description,
              data_schema: widget.artifact.data,
              ...(Object.keys(widget.settings?.schema.properties ?? {}).length
                ? { config_schema: widget.settings?.schema }
                : {}),
            },
          ]
        : [],
    ),
  );
}

export function pluginWidgetId(pluginId: string, widgetId: string) {
  return `plugin:${pluginId}:${widgetId}`;
}

export function buildPluginArtifactWidget(
  resolved: ResolvedPluginWidget,
  data: unknown,
  options: {
    id: string;
    name: string;
    description: string;
    innerTab?: string;
    config?: Record<string, unknown>;
    copiedFrom?: { widgetUuid: string; name: string };
    fromArtifact?: { artifactUuid: string; name: string; chatUuid: string };
  },
): WidgetT {
  const { plugin, widget } = resolved;
  const { h, minW, minH } = widget.grid;
  return {
    id: options.id,
    name: options.name,
    description: options.description,
    innerTab: options.innerTab,
    category: "Others",
    subCategory: "",
    source: "",
    external: false,
    widgetId: pluginWidgetId(plugin.id, widget.id),
    type: "custom",
    connectionType: "plugin",
    plugin: { id: plugin.id, widget: widget.id },
    params: widget.params as unknown as ParamDef[],
    gridData: {
      w: 40,
      h: Math.max(h, 12),
      ...(minW ? { minW } : {}),
      ...(minH ? { minH } : {}),
    },
    storage: {
      createdAt: new Date().toISOString(),
      ...(options.copiedFrom ? { copiedFrom: options.copiedFrom } : {}),
      ...(options.fromArtifact ? { fromArtifact: options.fromArtifact } : {}),
      plugin: { data, ...(options.config ? { config: options.config } : {}) },
    },
  } as WidgetT;
}

export function standalonePluginWidgets(plugins: AvailablePlugin[]): WidgetT[] {
  return plugins.flatMap((plugin) =>
    plugin.widgets
      .filter((widget) => widget.standalone)
      .map((widget) => {
        const widgetId = pluginWidgetId(plugin.id, widget.id);
        const { w, h, minW, minH } = widget.grid;
        return {
          id: widgetId,
          widgetId,
          type: "custom",
          name: widget.name,
          description: widget.description,
          category: widget.category ?? plugin.name,
          subCategory: widget.subCategory ?? undefined,
          sourceName: plugin.name,
          connectionType: "plugin",
          plugin: { id: plugin.id, widget: widget.id },
          params: widget.params as unknown as ParamDef[],
          gridData: { w, h, ...(minW ? { minW } : {}), ...(minH ? { minH } : {}) },
        } satisfies WidgetT;
      }),
  );
}
