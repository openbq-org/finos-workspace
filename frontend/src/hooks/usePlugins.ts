import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getAvailablePlugins, getWidgetsSchema } from "~/api/plugins.api";
import { useShallowAuthStore } from "~/lib/state/auth";
import { useBackendConnectorStore } from "~/lib/state/backendConnector";
import {
  failWidgetsSchema,
  setDefaultPluginVizTypes,
  setDefaultWidgetsSchema,
} from "~/lib/utils/validateBackend";
import { usePluginRegistryStore } from "~/plugins/registry";

export const pluginKeys = {
  available: (userUuid?: string) => ["widget-plugins", "available", userUuid] as const,
  widgetsSchema: (userUuid?: string) =>
    ["widget-plugins", "widgets-schema", userUuid] as const,
  platform: ["widget-plugins", "platform"] as const,
  detail: (pluginId: string) => ["widget-plugins", "detail", pluginId] as const,
  entity: ["widget-plugins", "entity"] as const,
  events: (pluginId: string, scope: string) =>
    ["widget-plugins", "events", pluginId, scope] as const,
  reports: (pluginId: string, scope: string) =>
    ["widget-plugins", "reports", pluginId, scope] as const,
  role: (roleUuid: string) => ["widget-plugins", "role", roleUuid] as const,
  presets: (pluginId: string, widgetId: string) =>
    ["widget-plugins", "presets", pluginId, widgetId] as const,
};

const REFRESH = {
  staleTime: 30_000,
  refetchInterval: 60_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
} as const;

export function usePluginRegistrySync() {
  const userUuid = useShallowAuthStore((state) => state.user?.uuid);
  const setListing = usePluginRegistryStore((state) => state.setListing);

  const { data } = useQuery({
    queryKey: pluginKeys.available(userUuid),
    queryFn: getAvailablePlugins,
    enabled: !!userUuid,
    retry: 1,
    ...REFRESH,
  });
  const { data: schema, error: schemaError } = useQuery({
    queryKey: pluginKeys.widgetsSchema(userUuid),
    queryFn: getWidgetsSchema,
    enabled: !!userUuid,
    retry: 2,
    ...REFRESH,
  });

  useEffect(() => {
    if (!data) return;
    setListing(data);
    setDefaultPluginVizTypes(Object.keys(data.vizHandlers));
  }, [data, setListing]);

  const schemaId = useRef<string | null>(null);
  useEffect(() => {
    if (!schema) return;
    const previous = schemaId.current;
    schemaId.current = schema.$id;
    setDefaultWidgetsSchema(schema);
    if (previous && previous !== schema.$id) {
      const store = useBackendConnectorStore.getState();
      if (store.apiSources.length) store.updateApiSources(store.apiSources);
    }
  }, [schema]);

  useEffect(() => {
    if (schemaError && !schema)
      failWidgetsSchema(
        schemaError instanceof Error ? schemaError : new Error(String(schemaError)),
      );
  }, [schemaError, schema]);

  useEffect(() => {
    if (userUuid) return;
    usePluginRegistryStore.getState().clear();
    setDefaultPluginVizTypes([]);
    setDefaultWidgetsSchema(undefined);
    schemaId.current = null;
  }, [userUuid]);
}
