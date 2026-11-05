import type { ComposedWidgetsSchema } from "~/lib/utils/widgetsSchemaValidation";
import type { FrameFailure } from "~/plugins/PluginFrame";
import { type PluginListing, PluginListingSchema } from "~/plugins/types";
import { apiClient } from "./api";

export async function getAvailablePlugins(): Promise<PluginListing> {
  const { data } = await apiClient.get("/app/widget-plugins");
  return PluginListingSchema.parse(data);
}

export async function getWidgetsSchema(): Promise<ComposedWidgetsSchema> {
  const { data } = await apiClient.get<ComposedWidgetsSchema>(
    "/app/widget-plugins/widgets-schema",
  );
  if (!data?.$id || !Array.isArray(data["x-types"]) || !data.definitions)
    throw new Error(
      "The API answered with something that is not a widgets.json schema",
    );
  return data;
}

export async function getPluginFile(
  pluginId: string,
  digest: string,
  path: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const { data } = await apiClient.get<ArrayBuffer>(
    `/app/widget-plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(digest)}/files/${encoded}`,
    { responseType: "arraybuffer", signal },
  );
  return data;
}

export async function callPluginProxy(
  pluginId: string,
  proxyId: string,
  body: { widget: string; args: Record<string, unknown> },
  signal?: AbortSignal,
) {
  const { data } = await apiClient.post<{ content_type: string; body: unknown }>(
    `/app/widget-plugins/${encodeURIComponent(pluginId)}/proxy/${encodeURIComponent(proxyId)}`,
    body,
    { signal },
  );
  return data;
}

export async function callPluginBackend(
  pluginId: string,
  routeId: string,
  body: { widget: string; instance: string; args: Record<string, unknown> },
  signal?: AbortSignal,
) {
  const { data } = await apiClient.post<{ body: unknown }>(
    `/app/widget-plugins/${encodeURIComponent(pluginId)}/backend/${encodeURIComponent(routeId)}`,
    body,
    { signal },
  );
  return data;
}

export interface PluginPreset {
  id: string;
  name: string;
  scope: "user" | "org";
  is_default: boolean;
  config: Record<string, unknown> | null;
  state: unknown;
  updated_at: string;
}

export interface PluginPresetChanges {
  name?: string;
  config?: Record<string, unknown> | null;
  state?: unknown;
  is_default?: boolean;
}

const presetsPath = (pluginId: string, widgetId: string) =>
  `/app/widget-plugins/${encodeURIComponent(pluginId)}/widgets/${encodeURIComponent(widgetId)}/presets`;

const orgPresetsPath = (pluginId: string, widgetId: string) =>
  `/admin/plugins/${encodeURIComponent(pluginId)}/widgets/${encodeURIComponent(widgetId)}/presets`;

export async function listPluginPresets(pluginId: string, widgetId: string) {
  const { data } = await apiClient.get<{ presets: PluginPreset[]; limit: number }>(
    presetsPath(pluginId, widgetId),
  );
  return data;
}

export async function createPluginPreset(
  pluginId: string,
  widgetId: string,
  body: PluginPresetChanges & { name: string },
) {
  const { data } = await apiClient.post<PluginPreset>(
    presetsPath(pluginId, widgetId),
    body,
  );
  return data;
}

export async function updatePluginPreset(
  pluginId: string,
  widgetId: string,
  presetId: string,
  body: PluginPresetChanges,
) {
  const { data } = await apiClient.patch<PluginPreset>(
    `${presetsPath(pluginId, widgetId)}/${encodeURIComponent(presetId)}`,
    body,
  );
  return data;
}

export async function deletePluginPreset(
  pluginId: string,
  widgetId: string,
  presetId: string,
) {
  await apiClient.delete(
    `${presetsPath(pluginId, widgetId)}/${encodeURIComponent(presetId)}`,
  );
}

export async function publishOrgPreset(
  pluginId: string,
  widgetId: string,
  body: PluginPresetChanges & { name: string },
) {
  const { data } = await apiClient.post<PluginPreset>(
    orgPresetsPath(pluginId, widgetId),
    body,
  );
  return data;
}

export async function updateOrgPreset(
  pluginId: string,
  widgetId: string,
  presetId: string,
  body: PluginPresetChanges,
) {
  const { data } = await apiClient.patch<PluginPreset>(
    `${orgPresetsPath(pluginId, widgetId)}/${encodeURIComponent(presetId)}`,
    body,
  );
  return data;
}

export async function deleteOrgPreset(
  pluginId: string,
  widgetId: string,
  presetId: string,
) {
  await apiClient.delete(
    `${orgPresetsPath(pluginId, widgetId)}/${encodeURIComponent(presetId)}`,
  );
}

export async function postPluginReports(body: {
  plugin_id: string;
  version: string;
  reports?: { directive: string; origin: string }[];
  failure?: FrameFailure["kind"];
}) {
  await apiClient.post("/app/widget-plugins/report", body);
}

export type VersionState =
  | "discovered"
  | "active"
  | "blocked"
  | "retired"
  | "missing"
  | "development";
export type PluginStatus = "disabled" | "enabled" | "revoked";
export type Risk = "none" | "low" | "medium" | "high" | "critical";

export interface ReviewItem {
  key: string;
  family:
    | "widgets"
    | "permissions"
    | "network"
    | "proxies"
    | "secrets"
    | "backend"
    | "data"
    | "code";
  label: string;
  risk: Risk;
  added: boolean;
  removed?: boolean;
  overridden?: boolean;
}

export interface PlatformVersion {
  version: string;
  state: VersionState;
  blocked_reason: string | null;
  digest: string | null;
  declared_checksum: string | null;
  checksum: string | null;
  pin_status: "pinned" | "unpinned" | "mismatch";
  path: string;
  files: Record<string, { size: number; sha256: string }>;
  findings: { errors: string[]; warnings: string[] };
  discovered_at: string | null;
  approved_at: string | null;
  approved_by_uuid: string | null;
  manifest: Record<string, unknown> & {
    name?: string;
    description?: string;
    publisher?: { name: string; url?: string };
    contributes?: {
      widgets?: {
        id: string;
        name: string;
        description?: string;
        handles?: { type: string }[];
        permissions?: string[];
        standalone?: boolean;
      }[];
    };
  };
  csp: {
    declared: Record<string, string[]>;
    notes: Record<string, string>;
    approved: Record<string, string[]>;
    effective: Record<string, string[]>;
    egress: string[];
    risk: Record<string, Risk>;
  };
  server: {
    network: { declared: string[]; approved: string[] };
    private: boolean;
    proxies: PluginProxy[];
    secrets: { name: string; purpose: string }[];
    backend: { protocol: number; routes: PluginRoute[] } | null;
    data_sources: { id: string; purpose: string }[];
    identity: "none" | "pseudonymous";
  };
  review: ReviewItem[] | null;
}

interface PluginProxy {
  id: string;
  method?: "GET" | "POST";
  url: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  args?: Record<string, { type: string; required?: boolean }>;
  response?: { accepts?: string[]; maxBytes?: number; timeoutMs?: number };
}

interface PluginRoute {
  id: string;
  args?: Record<string, { type: string; required?: boolean }>;
  secrets?: string[];
  response?: { maxBytes?: number; timeoutMs?: number };
}

interface PluginBackendStatus {
  registered: boolean;
  identity: {
    state: "ok" | "mismatch" | "unreachable" | "unregistered";
    detail: string;
    digest: string | null;
    checked_at: number;
  } | null;
  breaker: "open" | "closed";
}

export interface PluginSecretStatus {
  name: string;
  purpose: string;
  declared: boolean;
  set: boolean;
  source: "configuration" | "admin" | null;
  problem: string | null;
  set_by_uuid: string | null;
  set_at: string | null;
}

export interface PlatformPlugin {
  plugin_id: string;
  name: string;
  status: PluginStatus;
  active_version: string | null;
  update_available: string | null;
  overrides: {
    csp?: Record<string, string[]>;
    server_network?: string[];
    confirmations?: string[];
  };
  enabled_entities: number;
  enabled_for: { entity_uuid: string }[];
  versions: PlatformVersion[];
  secrets: PluginSecretStatus[];
  backend: PluginBackendStatus;
}

interface PluginEvent {
  action: string;
  version: string | null;
  entity_uuid: string | null;
  actor_uuid: string | null;
  details: Record<string, unknown>;
  created_date: string;
}

interface CspReport {
  directive: string;
  origin: string;
  count: number;
  version: string;
  entity_uuid: string;
  first_seen: string;
  last_seen: string;
}

interface RescanSummary {
  discovered: string[];
  blocked: string[];
  missing: string[];
  restored: string[];
  rejected: string[];
}

export async function getPlatformPlugins() {
  const { data } = await apiClient.get<{
    enabled: boolean;
    development: boolean;
    plugins: PlatformPlugin[];
  }>("/plugins");
  return data;
}

export type VersionBump = "patch" | "minor" | "major";

export async function developPluginVersion(
  pluginId: string,
  version: string,
  bump: VersionBump,
) {
  const { data } = await apiClient.post<{
    plugin_id: string;
    version: string;
    path: string;
  }>(`/plugins/${pluginId}/versions/${version}/develop`, { bump });
  return data;
}

export async function rescanPlugins() {
  const { data } = await apiClient.post<RescanSummary>("/plugins/rescan");
  return data;
}

export async function approvePluginVersion(
  pluginId: string,
  version: string,
  body: { digest: string; acknowledged: string[] },
) {
  const { data } = await apiClient.post(
    `/plugins/${pluginId}/versions/${version}/approve`,
    body,
  );
  return data;
}

export async function setPluginRevoked(pluginId: string, revoked: boolean) {
  const { data } = await apiClient.post(
    `/plugins/${pluginId}/${revoked ? "revoke" : "restore"}`,
  );
  return data;
}

export async function putPluginOverrides(
  pluginId: string,
  body: {
    csp: Record<string, string[]> | null;
    server_network: string[] | null;
    confirmations: string[];
  },
) {
  const { data } = await apiClient.put(`/plugins/${pluginId}/overrides`, body);
  return data;
}

export async function putPluginSecret(pluginId: string, name: string, value: string) {
  await apiClient.put(`/plugins/${pluginId}/secrets/${name}`, { value });
}

export async function deletePluginSecret(pluginId: string, name: string) {
  await apiClient.delete(`/plugins/${pluginId}/secrets/${name}`);
}

export async function checkPluginBackend(pluginId: string) {
  const { data } = await apiClient.post<PluginBackendStatus>(
    `/plugins/${pluginId}/backend/check`,
  );
  return data;
}

export async function getPluginEvents(pluginId: string, scope: "platform" | "entity") {
  const prefix = scope === "platform" ? "/plugins" : "/admin/plugins";
  const { data } = await apiClient.get<PluginEvent[]>(`${prefix}/${pluginId}/events`);
  return data;
}

export async function getPluginReports(pluginId: string, scope: "platform" | "entity") {
  const prefix = scope === "platform" ? "/plugins" : "/admin/plugins";
  const { data } = await apiClient.get<CspReport[]>(
    `${prefix}/${pluginId}/csp-reports`,
  );
  return data;
}

export async function forgetPlugin(pluginId: string) {
  await apiClient.delete(`/plugins/${pluginId}`);
}

export interface PluginEntityUse {
  entity_uuid: string;
  name: string | null;
  enabled: boolean;
}

export async function getPlatformPlugin(pluginId: string) {
  const { data } = await apiClient.get<
    PlatformPlugin & { entities: PluginEntityUse[]; events: PluginEvent[] }
  >(`/plugins/${pluginId}`);
  return data;
}

export async function putPluginEntity(
  pluginId: string,
  entityUuid: string | null,
  changes: { enabled: boolean },
) {
  const path = entityUuid
    ? `/plugins/${pluginId}/entities/${entityUuid}`
    : `/plugins/${pluginId}/entities`;
  const { data } = await apiClient.put(path, changes);
  return data;
}

export interface EntityPlugin {
  plugin_id: string;
  name: string;
  status: PluginStatus;
  active_version: string;
  available: boolean;
  description: string;
  publisher: { name: string; url?: string } | null;
  widgets: {
    id: string;
    name: string;
    description: string;
    handles: string[];
    standalone: boolean;
    permissions: string[];
  }[];
  admin_settings_schema: Record<string, unknown> | null;
  enabled: boolean;
  settings: Record<string, unknown>;
  narrowed_permissions: string[];
  csp_narrow: Record<string, string[]>;
  csp: {
    approved: Record<string, string[]>;
    effective: Record<string, string[]>;
    egress: string[];
  };
  server_network_narrow: string[];
  data_sources: { id: string; purpose: string; backend_uuid: string | null }[];
  server: {
    network: { approved: string[]; effective: string[] };
    proxies: string[];
  };
  handlers: Record<string, string>;
  role_grants: number;
  preset_limit: number;
}

export interface EntityPluginChanges {
  enabled?: boolean;
  narrowed_permissions?: string[];
  csp_narrow?: Record<string, string[]>;
  server_network_narrow?: string[];
  data_sources?: Record<string, string | null>;
  settings?: Record<string, unknown>;
  handlers?: Record<string, string | null>;
  preset_limit?: number | null;
}

export async function getEntityPlugins() {
  const { data } = await apiClient.get<{
    enabled: boolean;
    plugins: EntityPlugin[];
    backends: { uuid: string; name: string }[];
  }>("/admin/plugins");
  return data;
}

export async function putEntityPlugin(pluginId: string, changes: EntityPluginChanges) {
  const { data } = await apiClient.put(`/admin/plugins/${pluginId}`, changes);
  return data;
}

export interface PluginGrant {
  plugin_id: string;
  widget_id: string;
}

export async function getRolePluginAccess(roleUuid: string) {
  const { data } = await apiClient.get<{ grants: PluginGrant[] }>(
    `/admin/role/${roleUuid}/plugin-access`,
  );
  return data.grants;
}

export async function putRolePluginAccess(roleUuid: string, grants: PluginGrant[]) {
  const { data } = await apiClient.put(`/admin/role/${roleUuid}/plugin-access`, {
    grants,
  });
  return data;
}
