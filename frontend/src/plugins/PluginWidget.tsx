import get from "lodash/get";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  callPluginBackend,
  callPluginProxy,
  createPluginPreset,
  listPluginPresets,
  type PluginPreset,
} from "~/api/plugins.api";
import DraggableCard from "~/components/DraggableCard";
import { ExternalLinkDialog } from "~/components/ExternalLinkDialog";
import SearchResultsNotFound from "~/components/General/SearchResultsNotFound";
import Icon from "~/components/Icon";
import Tooltip from "~/components/Tooltip";
import type { ParamDef, StoredParamValue } from "~/components/types";
import { useWidgetContext } from "~/components/Widget.context";
import { useWidgetParamsPositions } from "~/components/WidgetParams/QueryParams";
import { buildIframeWidget } from "~/components/Widgets/custom/buildIframeWidget";
import {
  RowsToggle,
  useRawRows,
  useRowsView,
} from "~/components/Widgets/Helpers/RawRows";
import { useParamGroupBindings } from "~/components/Widgets/Helpers/useParamGroupBindings";
import { useJsonData } from "~/lib/api";
import { useAppStore, useShallowAppStore } from "~/lib/state/app";
import { useShallowThemeStore } from "~/lib/state/theme";
import { LIMITS } from "~/lib/types/widgetsContract";
import { cn, uuidv4 } from "~/lib/utils";
import { sourceStreamHref } from "~/lib/utils/fetch";
import { buildWidgetRequest } from "~/lib/utils/widgetRequest";
import { useActionIcon } from "./actionIcon";
import {
  assetPath,
  type CardAction,
  cardActions,
  checkConfigWrite,
  checkStateWrite,
  coerceParamValue,
  commandPermission,
  defaultPreset,
  exportFile,
  jsonSize,
  presetError,
  presetName,
  RateLimiter,
  readAddedWidget,
  readExportOptions,
  safeFilename,
  safeLink,
  serverCallError,
  serverCallRequest,
  type TraitBinding,
  traitBindings,
} from "./authority";
import { BundleIntegrityError, loadAsset } from "./bundle";
import { validateDefinition } from "./definition";
import {
  ACTION_GRANT_MS,
  MAX_CLIPBOARD_BYTES,
  MAX_COPILOT_CONTEXT_BYTES,
  MAX_NOTIFY_LENGTH,
  NOTIFY_LEVELS,
  NOTIFY_RATE,
  PRESET_SAVE_RATE,
  SERVER_CALL_RATE,
} from "./limits";
import PluginFrame, { type FrameStatus, type PluginFrameHandle } from "./PluginFrame";
import { PresetsPanel } from "./PresetsPanel";
import { CommandError, MAX_EXPORT_BYTES } from "./protocol";
import {
  buildPluginArtifactWidget,
  resolvePluginWidget,
  resolveVizHandler,
  usePluginRegistryStore,
  useRowsPlugin,
} from "./registry";
import {
  type CardDetails,
  CardDetailsForm,
  cleanSettings,
  SettingsForm,
} from "./SettingsForm";
import { openStream, type Stream, webSocketUrl } from "./stream";
import { readThemeTrait } from "./theme";
import {
  MAX_CONFIG_BYTES,
  type PluginInstanceStorage,
  type ResolvedPluginWidget,
} from "./types";

export function useResolvedPluginWidget(): ResolvedPluginWidget | null {
  const { widget, widgetFromJSON } = useWidgetContext();
  const { plugins, vizHandlers } = usePluginRegistryStore((state) => ({
    plugins: state.plugins,
    vizHandlers: state.vizHandlers,
  }));
  return useMemo(() => {
    if (widget.plugin) return resolvePluginWidget(widget.plugin, { plugins });
    return resolveVizHandler(widgetFromJSON?.type ?? widget.type, {
      plugins,
      vizHandlers,
    });
  }, [widget.plugin, widget.type, widgetFromJSON?.type, plugins, vizHandlers]);
}

function Unavailable(props: { title: string; message: string; detail?: string }) {
  return (
    <DraggableCard title={props.title}>
      <SearchResultsNotFound
        icon={true}
        firstMessage={props.message}
        secondMessage={props.detail ?? ""}
      />
    </DraggableCard>
  );
}

const STATUS_MESSAGES: Partial<Record<FrameStatus["kind"], string>> = {
  "sandbox-failed": "Plugin sandbox unavailable",
  "integrity-failed":
    "Failed to load: the plugin's files do not match the approved version",
  "load-failed": "Failed to load",
  "plugin-error": "Plugin error",
  unresponsive: "Not responding",
  ended: "The widget was stopped",
};

export default function PluginWidget() {
  const resolved = useResolvedPluginWidget();
  const { widget } = useWidgetContext();
  const loaded = usePluginRegistryStore((state) => state.loaded);
  const [showRows] = useRowsView();
  const rowsPlugin = useRowsPlugin(widget.data?.rawType);

  if (!resolved) {
    return (
      <Unavailable
        title={widget.name}
        message={
          loaded ? "This widget type is not available to you" : "Loading widget plugins"
        }
        detail={
          loaded
            ? "An administrator decides which widget plugins your roles may use."
            : undefined
        }
      />
    );
  }
  const shown = showRows && rowsPlugin ? rowsPlugin : resolved;
  return (
    <PluginWidgetBody
      key={`${shown.plugin.id}:${shown.widget.id}:${showRows}`}
      resolved={shown}
      showRows={showRows}
      viewName={resolved.widget.name}
    />
  );
}

export function PluginRowsCard(props: {
  resolved: ResolvedPluginWidget;
  viewName: string;
}) {
  return (
    <PluginWidgetBody
      resolved={props.resolved}
      showRows={true}
      viewName={props.viewName}
    />
  );
}

function PluginWidgetBody({
  resolved,
  showRows,
  viewName,
}: {
  resolved: ResolvedPluginWidget;
  showRows: boolean;
  viewName: string;
}) {
  const { plugin, widget: pluginWidget, vizType } = resolved;
  const { widget, updateWidget, activeDashboardId, isShared, isPreview } =
    useWidgetContext();
  const addWidget = useShallowAppStore((state) => state.addWidget);
  const theme = useShallowThemeStore((state) => state.theme);
  const frameRef = useRef<PluginFrameHandle>(null);
  const [status, setStatus] = useState<FrameStatus>({ kind: "booting" });
  const [link, setLink] = useState<string | null>(null);
  const [copilotContext, setCopilotContext] = useState<unknown>(undefined);
  const actionGrant = useRef(0);
  const notifyLimiter = useRef(
    new RateLimiter(NOTIFY_RATE.perSecond, NOTIFY_RATE.burst),
  );
  const serverLimiter = useRef(
    new RateLimiter(SERVER_CALL_RATE.perSecond, SERVER_CALL_RATE.burst),
  );
  const presetLimiter = useRef(
    new RateLimiter(PRESET_SAVE_RATE.perSecond, PRESET_SAVE_RATE.burst),
  );
  const { updateGroupedParams } = useParamGroupBindings();

  const permissions = useMemo(() => new Set(pluginWidget.permissions), [pluginWidget]);
  const bindings = useMemo(
    () => traitBindings(pluginWidget, permissions),
    [pluginWidget, permissions],
  );
  const storagePlugin = (widget.storage?.plugin ?? {}) as PluginInstanceStorage;
  const paramDefs = (widget.params ?? []) as ParamDef[];
  const paramValues = (widget.storage?.params ?? {}) as Record<
    string,
    StoredParamValue
  >;

  const handle = pluginWidget.handles.find((h) => h.type === vizType);
  const endpointUrl = widget.endpoint?.url ?? "";
  const readsData = permissions.has("core:data:read") && !!endpointUrl;
  const [, setShowRows] = useRowsView();
  const rows = useRawRows(widget);
  const request = useMemo(
    () =>
      buildWidgetRequest(widget, {
        theme: theme === "light" ? "light" : "dark",
      }),
    [widget.endpoint, widget.params, widget.storage?.params, widget.sourceId, theme],
  );
  const dataKey = widget.data?.dataKey;
  const answer = useJsonData(
    {
      request,
      responseCb: async (response, resolve) => {
        const json = await response.json();
        resolve(dataKey ? get(json, dataKey, json) : json);
      },
    },
    { enabled: readsData && !showRows, staleTime: widget.staleTime ?? 1000 * 60 * 15 },
  );
  const { data: fetched, isLoading, error, dataUpdatedAt } = showRows ? rows : answer;
  const data = showRows || endpointUrl ? fetched : storagePlugin.data;

  const streamHref = permissions.has("core:data:stream")
    ? widget.data?.streamEndpoint
    : undefined;
  const streamTarget = useMemo(() => {
    if (!streamHref) return null;
    const built = buildWidgetRequest({
      endpoint: { url: streamHref, method: "GET" },
      params: widget.params,
      storage: widget.storage,
      sourceId: widget.sourceId,
    });
    return built?.ok ? webSocketUrl(sourceStreamHref(built.request)) : null;
  }, [streamHref, widget.params, widget.storage?.params, widget.sourceId]);
  const frameRunning = status.kind === "running";
  const stream = useRef<Stream | null>(null);
  useEffect(() => {
    if (!streamTarget || !frameRunning) return;
    const opened = openStream(streamTarget, {
      onMessages: (messages) =>
        frameRef.current?.sendEvent({
          kind: "workspace-event",
          name: "stream",
          messages,
        }),
      onState: (state, retryIn) =>
        frameRef.current?.sendEvent({
          kind: "workspace-event",
          name: "stream-status",
          state,
          retryIn,
        }),
    });
    stream.current = opened;
    return () => {
      opened.close();
      stream.current = null;
    };
  }, [streamTarget, frameRunning]);

  const refreshed = useRef(widget.refreshQuery);
  useEffect(() => {
    if (widget.refreshQuery === refreshed.current) return;
    refreshed.current = widget.refreshQuery;
    frameRef.current?.sendEvent({ kind: "workspace-event", name: "refresh" });
    stream.current?.reconnect();
  }, [widget.refreshQuery]);

  const definitionValue = vizType ? widget.data?.[vizType] : undefined;
  const definitionErrors = useMemo(
    () =>
      handle?.definition
        ? validateDefinition(definitionValue ?? {}, handle.definition)
        : definitionValue === undefined
          ? []
          : [{ path: "", message: "this plugin takes no configuration for the type" }],
    [handle, definitionValue],
  );

  const config = useMemo(
    () => ({
      ...(pluginWidget.settings?.defaults ?? {}),
      ...cleanSettings(pluginWidget.settings?.schema, storagePlugin.config),
    }),
    [pluginWidget.settings, storagePlugin.config],
  );
  const traits = useMemo(() => {
    const values: Record<string, unknown> = {};
    const declaredParams = Object.fromEntries(
      paramDefs.map((p) => [p.paramName, paramValues[p.paramName] ?? null]),
    );
    for (const binding of bindings) {
      switch (binding.source) {
        case "data":
          values[binding.trait] = data;
          break;
        case "params":
          values[binding.trait] = declaredParams;
          break;
        case "param":
          values[binding.trait] = declaredParams[binding.key ?? ""] ?? null;
          break;
        case "definition":
          values[binding.trait] = definitionValue ?? {};
          break;
        case "config":
          values[binding.trait] =
            binding.key === undefined ? config : config[binding.key];
          break;
        case "adminSettings":
          values[binding.trait] =
            binding.key === undefined
              ? plugin.adminSettings
              : plugin.adminSettings[binding.key];
          break;
        case "state":
          values[binding.trait] = storagePlugin.state ?? null;
          break;
        case "theme":
          values[binding.trait] = readThemeTrait(theme);
          break;
        case "capabilities":
          values[binding.trait] = [...permissions].sort();
          break;
        case "meta":
          values[binding.trait] = {
            pluginId: plugin.id,
            version: plugin.version,
            widgetId: pluginWidget.id,
            instanceId: widget.id,
          };
          break;
      }
    }
    return values;
  }, [
    bindings,
    data,
    paramDefs,
    paramValues,
    definitionValue,
    config,
    plugin,
    storagePlugin.state,
    theme,
    permissions,
    pluginWidget.id,
    widget.id,
  ]);

  const writeParams = useCallback(
    (changes: Record<string, unknown>) => {
      const accepted: Record<string, StoredParamValue> = {};
      for (const [name, value] of Object.entries(changes)) {
        const param = paramDefs.find((p) => p.paramName === name);
        if (!param)
          throw new CommandError("out_of_scope", `${name} is not a declared param`);
        accepted[name] = coerceParamValue(param, value) as StoredParamValue;
      }
      if (isShared)
        throw new CommandError("unavailable", "a shared dashboard is read-only");
      updateWidget((prev) => ({
        ...prev,
        storage: { ...prev.storage, params: { ...prev.storage?.params, ...accepted } },
      }));
      updateGroupedParams(
        Object.fromEntries(
          Object.entries(accepted).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(",") : String(v ?? ""),
          ]),
        ),
      );
      return accepted;
    },
    [paramDefs, updateWidget, updateGroupedParams, isShared],
  );

  const onWrite = useCallback(
    (binding: TraitBinding, value: unknown) => {
      switch (binding.source) {
        case "params": {
          if (typeof value !== "object" || value === null || Array.isArray(value))
            throw new CommandError("invalid_args", "params is an object");
          const changed = Object.fromEntries(
            Object.entries(value).filter(
              ([name, v]) =>
                JSON.stringify(v) !== JSON.stringify(paramValues[name] ?? null),
            ),
          );
          const accepted = writeParams(changed);
          return { ...(traits[binding.trait] as object), ...accepted };
        }
        case "param": {
          const accepted = writeParams({ [binding.key ?? ""]: value });
          return accepted[binding.key ?? ""];
        }
        case "state": {
          const next = checkStateWrite(value);
          if (isShared)
            throw new CommandError("unavailable", "a shared dashboard is read-only");
          updateWidget((prev) => ({
            ...prev,
            storage: {
              ...prev.storage,
              plugin: {
                ...(prev.storage?.plugin as PluginInstanceStorage),
                state: next,
              },
            },
          }));
          return next;
        }
        case "config": {
          const schema = pluginWidget.settings?.schema;
          const merged = (stored: Record<string, unknown> | undefined) =>
            checkConfigWrite(schema, cleanSettings(schema, stored), binding.key, value);
          const next = merged(storagePlugin.config);
          if (isShared)
            throw new CommandError("unavailable", "a shared dashboard is read-only");
          updateWidget((prev) => {
            const plugin = prev.storage?.plugin as PluginInstanceStorage | undefined;
            try {
              return {
                ...prev,
                storage: {
                  ...prev.storage,
                  plugin: { ...plugin, config: merged(plugin?.config) },
                },
              };
            } catch {
              return prev;
            }
          });
          return binding.key === undefined ? next : next[binding.key];
        }
        default:
          throw new CommandError("not_granted", `${binding.trait} is read-only`);
      }
    },
    [
      writeParams,
      paramValues,
      traits,
      updateWidget,
      isShared,
      pluginWidget.settings,
      storagePlugin.config,
    ],
  );

  const presetValues = useCallback(
    (preset: Pick<PluginPreset, "config" | "state">) => {
      const schema = pluginWidget.settings?.schema;
      return {
        config: checkConfigWrite(
          schema,
          {},
          undefined,
          cleanSettings(schema, preset.config ?? {}),
        ),
        state: checkStateWrite(preset.state ?? null),
      };
    },
    [pluginWidget.settings],
  );

  const writePreset = useCallback(
    (preset: Pick<PluginPreset, "config" | "state">) => {
      const next = presetValues(preset);
      updateWidget((prev) => ({
        ...prev,
        storage: {
          ...prev.storage,
          plugin: {
            ...(prev.storage?.plugin as PluginInstanceStorage),
            ...next,
          },
        },
      }));
    },
    [presetValues, updateWidget],
  );

  const presetChecked = useRef(false);
  useEffect(() => {
    if (
      presetChecked.current ||
      isShared ||
      isPreview ||
      showRows ||
      storagePlugin.config ||
      storagePlugin.state !== undefined ||
      storagePlugin.presetChecked
    )
      return;
    presetChecked.current = true;
    listPluginPresets(plugin.id, pluginWidget.id)
      .then(({ presets }) => {
        const preset = defaultPreset(presets);
        return preset ? presetValues(preset) : {};
      })
      .catch(() => ({}))
      .then((values) =>
        updateWidget((prev) => {
          const current = (prev.storage?.plugin ?? {}) as PluginInstanceStorage;
          const untouched = !current.config && current.state === undefined;
          return {
            ...prev,
            storage: {
              ...prev.storage,
              plugin: { ...current, ...(untouched ? values : {}), presetChecked: true },
            },
          };
        }),
      );
  }, [
    isShared,
    isPreview,
    showRows,
    storagePlugin.config,
    storagePlugin.state,
    storagePlugin.presetChecked,
    plugin.id,
    pluginWidget.id,
    presetValues,
    updateWidget,
  ]);

  const onCommand = useCallback(
    async (name: string, msg: unknown, buffers: ArrayBuffer[]) => {
      commandPermission(name, permissions);
      const args = (typeof msg === "object" && msg !== null ? msg : {}) as Record<
        string,
        unknown
      >;
      switch (name) {
        case "core:asset:read": {
          const path = assetPath(args);
          const bytes = await loadAsset(plugin, path).catch((error) => {
            throw error instanceof BundleIntegrityError
              ? new CommandError(
                  "out_of_scope",
                  `${path} is not a file of this version under assets/`,
                )
              : new CommandError("unavailable", `${path} could not be read`);
          });
          return { value: { path, size: bytes.byteLength }, buffers: [bytes] };
        }
        case "core:ui:notify": {
          if (!notifyLimiter.current.take())
            throw new CommandError("rate_limited", "too many notifications");
          const text = String(args.text ?? "").slice(0, MAX_NOTIFY_LENGTH);
          const level = (NOTIFY_LEVELS as readonly string[]).includes(
            String(args.level),
          )
            ? (args.level as (typeof NOTIFY_LEVELS)[number])
            : "info";
          toast[level](text, { description: plugin.name });
          return {};
        }
        case "core:ui:open-link":
          setLink(safeLink(args.url));
          return {};
        case "core:dashboard:add-widget": {
          if (isShared || useAppStore.getState().isDashboardLocked(activeDashboardId))
            throw new CommandError("unavailable", "the dashboard is read-only");
          if (actionGrant.current < Date.now())
            throw new CommandError(
              "out_of_scope",
              "a widget is added only right after the user picks one of the widget's actions",
            );
          const { target, data, name } = readAddedWidget(args, (id) =>
            resolvePluginWidget({ id: plugin.id, widget: id }),
          );
          actionGrant.current = 0;
          const added = await addWidget(
            activeDashboardId,
            buildPluginArtifactWidget(target, data, {
              id: uuidv4(),
              name: name ?? `${widget.name} (static)`.slice(0, LIMITS.name),
              description: `A static copy of ${widget.name}`,
              innerTab: widget.innerTab,
              copiedFrom: { widgetUuid: widget.id, name: widget.name },
            }),
          );
          if (!added)
            throw new CommandError(
              "unavailable",
              "the dashboard did not take the widget",
            );
          return { value: { instanceId: added } };
        }
        case "core:clipboard:write": {
          const text = String(args.text ?? "");
          if (text.length > MAX_CLIPBOARD_BYTES)
            throw new CommandError("too_large", "at most 1 MiB");
          await navigator.clipboard.writeText(text).catch(() => {
            throw new CommandError("unavailable", "the clipboard refused the write");
          });
          return {};
        }
        case "core:download:save": {
          const [bytes] = buffers;
          if (!bytes)
            throw new CommandError("invalid_args", "the file is the first buffer");
          if (bytes.byteLength > MAX_EXPORT_BYTES)
            throw new CommandError("too_large", "at most 25 MiB");
          const mime =
            typeof args.mime === "string"
              ? args.mime.slice(0, 100)
              : "application/octet-stream";
          download(new Blob([bytes], { type: mime }), safeFilename(args.filename));
          return {};
        }
        case "core:proxy:call": {
          const call = serverCallRequest(args, "id", pluginWidget.proxies);
          if (!serverLimiter.current.take())
            throw new CommandError("rate_limited", "too many server calls");
          const answer = await callPluginProxy(plugin.id, call.name, {
            widget: pluginWidget.id,
            args: call.args,
          }).catch((error) => {
            throw serverCallError(error);
          });
          return { value: answer.body };
        }
        case "core:backend:call": {
          const call = serverCallRequest(args, "route", pluginWidget.routes);
          if (!serverLimiter.current.take())
            throw new CommandError("rate_limited", "too many server calls");
          const answer = await callPluginBackend(plugin.id, call.name, {
            widget: pluginWidget.id,
            instance: widget.id,
            args: call.args,
          }).catch((error) => {
            throw serverCallError(error);
          });
          return { value: answer.body };
        }
        case "core:presets:list":
        case "core:presets:apply":
        case "core:presets:save": {
          if (isShared)
            throw new CommandError("unavailable", "a shared dashboard is read-only");
          if (name === "core:presets:save") {
            const presetLabel = presetName(args.name);
            if (!presetLimiter.current.take())
              throw new CommandError("rate_limited", "too many presets saved");
            const saved = await createPluginPreset(plugin.id, pluginWidget.id, {
              name: presetLabel,
              config,
              state: storagePlugin.state ?? null,
              is_default: args.isDefault === true,
            }).catch((error) => {
              throw presetError(error);
            });
            return { value: { id: saved.id } };
          }
          const { presets } = await listPluginPresets(plugin.id, pluginWidget.id).catch(
            (error) => {
              throw presetError(error);
            },
          );
          if (name === "core:presets:list")
            return {
              value: {
                presets: presets.map((preset) => ({
                  id: preset.id,
                  name: preset.name,
                  scope: preset.scope,
                  isDefault: preset.is_default,
                })),
              },
            };
          const preset = presets.find((p) => p.id === args.id);
          if (!preset)
            throw new CommandError(
              "out_of_scope",
              "no preset of this widget has that id",
            );
          writePreset(preset);
          return { value: {} };
        }
        default:
          throw new CommandError("unknown_command", `${name} is not a host command`);
      }
    },
    [
      activeDashboardId,
      addWidget,
      config,
      isShared,
      permissions,
      plugin,
      pluginWidget.id,
      pluginWidget.proxies,
      pluginWidget.routes,
      widget.id,
      widget.innerTab,
      widget.name,
      storagePlugin.state,
      writePreset,
    ],
  );

  const exportsAvailable = status.kind === "running" ? status.exports : [];
  const canExport =
    permissions.has("core:export:provide") &&
    exportsAvailable.includes("exportOptions") &&
    exportsAvailable.includes("exportData");
  const setExportWidgetData = useShallowThemeStore(
    (state) => state.setExportWidgetData,
  );
  const onExport = useCallback(async () => {
    const frame = frameRef.current;
    if (!frame) return;
    try {
      const options = readExportOptions(await frame.callExport("exportOptions", []));
      if (!options.length) {
        toast.info("Nothing to export right now", { description: plugin.name });
        return;
      }
      setExportWidgetData({
        widgetId: widget.id,
        widgetName: widget.name,
        selectedExportFormat: options[0].id,
        possibleExportFormats: options.map((option) => ({
          value: option.id,
          label: option.label,
          fn: (title: string) => {
            frame
              .callExport("exportData", [option.id, { title }])
              .then((value) => {
                const file = exportFile(value, option);
                if (!file) {
                  toast.info("Nothing to export right now", {
                    description: plugin.name,
                  });
                  return;
                }
                download(file, `${safeFilename(title)}.${option.extension}`);
              })
              .catch((error) =>
                toast.error(`Export failed: ${error?.message ?? error}`),
              );
          },
        })),
      });
    } catch (error) {
      toast.error(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [plugin.name, setExportWidgetData, widget.id, widget.name]);

  const wantsCopilotContext =
    !widget.raw &&
    permissions.has("core:copilot:context") &&
    exportsAvailable.includes("copilotContext");
  useEffect(() => {
    if (!wantsCopilotContext) return;
    frameRef.current
      ?.callExport("copilotContext", [])
      .then((value) => {
        if (jsonSize(value) <= MAX_COPILOT_CONTEXT_BYTES) setCopilotContext(value);
      })
      .catch(() => undefined);
  }, [wantsCopilotContext, data]);

  const settingsSchema = pluginWidget.settings?.schema;
  const hasSettings = Object.keys(settingsSchema?.properties ?? {}).length > 0;
  const [draft, setDraft] = useState<Record<string, unknown>>(config);
  const [details, setDetails] = useState<CardDetails>({
    name: widget.name ?? "",
    description: widget.description ?? "",
  });
  const [presetState, setPresetState] = useState<{ state: unknown } | null>(null);
  useEffect(() => setDraft(config), [config]);
  const resetSettings = useCallback(
    (open: boolean) => {
      if (!open) return;
      setDraft(config);
      setPresetState(null);
      setDetails({ name: widget.name ?? "", description: widget.description ?? "" });
    },
    [config, widget.name, widget.description],
  );
  const saveSettings = useCallback(() => {
    const next = cleanSettings(settingsSchema, draft);
    if (jsonSize(next) > MAX_CONFIG_BYTES) {
      toast.error("These settings are too large");
      return;
    }
    let state: { state: unknown } | null = null;
    try {
      if (presetState) state = { state: checkStateWrite(presetState.state ?? null) };
    } catch {
      toast.error("The preset's state is too large");
      return;
    }
    const name = details.name.trim().slice(0, LIMITS.name);
    const description = details.description.trim().slice(0, LIMITS.description);
    updateWidget((prev) => ({
      ...prev,
      name: name || prev.name,
      description,
      storage: {
        ...prev.storage,
        plugin: {
          ...(prev.storage?.plugin as PluginInstanceStorage),
          config: next,
          ...state,
        },
      },
    }));
    setPresetState(null);
  }, [details, draft, presetState, settingsSchema, updateWidget]);
  const applyPreset = useCallback(
    (preset: PluginPreset) => {
      setDraft({
        ...(pluginWidget.settings?.defaults ?? {}),
        ...cleanSettings(settingsSchema, preset.config ?? {}),
      });
      setPresetState({ state: preset.state });
    },
    [pluginWidget.settings, settingsSchema],
  );

  const actions = useMemo(
    () => cardActions(pluginWidget, permissions, plugin.files),
    [pluginWidget, permissions, plugin.files],
  );
  const running = status.kind === "running";
  const onAction = useCallback(
    (action: CardAction) => {
      if (!action.toggles) {
        actionGrant.current = Date.now() + ACTION_GRANT_MS;
        frameRef.current?.sendEvent({
          kind: "workspace-event",
          name: "action",
          id: action.id,
        });
        return;
      }
      if (isShared) return;
      const key = action.toggles;
      const pressed = config[key] !== true;
      updateWidget((prev) => {
        const stored = prev.storage?.plugin as PluginInstanceStorage | undefined;
        try {
          const next = checkConfigWrite(
            settingsSchema,
            cleanSettings(settingsSchema, stored?.config),
            key,
            pressed,
          );
          return {
            ...prev,
            storage: { ...prev.storage, plugin: { ...stored, config: next } },
          };
        } catch {
          return prev;
        }
      });
      frameRef.current?.sendEvent({
        kind: "workspace-event",
        name: "action",
        id: action.id,
        pressed,
      });
    },
    [config, isShared, settingsSchema, updateWidget],
  );
  const menuActions = useMemo(
    () =>
      actions.menu.map((action) => ({
        id: `plugin-action-${action.id}`,
        label: action.label,
        icon: action.icon ?? ("widget" as const),
        iconElement: <PluginActionIcon plugin={plugin} action={action} />,
        hide: !running,
        onClick: () => onAction(action),
      })),
    [actions.menu, onAction, plugin, running],
  );
  const navbarButtons = running
    ? actions.buttons.map((action) => (
        <PluginActionButton
          key={action.id}
          plugin={plugin}
          action={action}
          pressed={action.toggles ? config[action.toggles] === true : undefined}
          disabled={!!action.toggles && isShared}
          onClick={() => onAction(action)}
        />
      ))
    : [];

  const { renderRow0Params, renderBelowNavbarRows } = useWidgetParamsPositions();

  if (definitionErrors.length) {
    return (
      <Unavailable
        title={widget.name}
        message={`This widget's ${vizType} configuration does not match what ${plugin.name} expects`}
        detail={definitionErrors
          .slice(0, 5)
          .map((e) => `data.${vizType}${e.path}: ${e.message}`)
          .join("; ")}
      />
    );
  }

  const failure = STATUS_MESSAGES[status.kind];
  const failureDetail =
    status.kind === "sandbox-failed"
      ? `Checks that failed: ${status.checks.join(", ")}`
      : "detail" in status
        ? status.detail
        : undefined;

  return (
    <>
      <DraggableCard
        title={widget.name}
        elementRightNextToTitle={renderRow0Params}
        elementBelowNavbar={renderBelowNavbarRows}
        aiEnabled={true}
        aiData={
          widget.raw
            ? rows.data
            : copilotContext === undefined
              ? data
              : { data, context: copilotContext }
        }
        extraNavbarElements={
          navbarButtons.length || widget.raw ? (
            <>
              {navbarButtons}
              {widget.raw ? (
                <RowsToggle
                  showRows={showRows}
                  onChange={setShowRows}
                  viewName={viewName}
                />
              ) : null}
            </>
          ) : undefined
        }
        extraSettings={menuActions}
        lastUpdated={readsData ? dataUpdatedAt : undefined}
        loading={readsData && isLoading}
        error={readsData ? error : undefined}
        errorMessage={error?.message}
        settings={{ overrideSettings: false, showExport: canExport }}
        onExport={canExport ? onExport : undefined}
        settingsModalChildren={
          <>
            <PresetsPanel
              pluginId={plugin.id}
              widgetId={pluginWidget.id}
              config={cleanSettings(settingsSchema, draft)}
              state={presetState ? presetState.state : storagePlugin.state}
              onApply={applyPreset}
              disabled={isShared}
            />
            <CardDetailsForm
              values={details}
              onChange={setDetails}
              disabled={isShared}
            />
            {settingsSchema && hasSettings ? (
              <SettingsForm
                schema={settingsSchema}
                values={draft}
                onChange={setDraft}
                disabled={isShared}
              />
            ) : null}
          </>
        }
        showActionsSettings={!isShared}
        setOpenSettings={resetSettings}
        onSaveSettings={saveSettings}
        keepMounted={true}
      >
        <div className="relative h-full w-full" data-plugin={plugin.id}>
          {failure ? (
            <SearchResultsNotFound
              icon={true}
              firstMessage={failure}
              secondMessage={failureDetail ?? ""}
              children={
                <button
                  type="button"
                  className="ws-hyper-link mt-2 body-xs-medium"
                  onClick={() => frameRef.current?.restart()}
                >
                  Retry
                </button>
              }
            />
          ) : null}
          <div className={failure ? "hidden" : "h-full w-full"}>
            <PluginFrame
              plugin={plugin}
              title={`${widget.name} (${plugin.name})`}
              bindings={bindings}
              traits={traits}
              permissions={[...permissions].sort()}
              onWrite={onWrite}
              onCommand={onCommand}
              onStatus={setStatus}
              colorScheme={theme === "light" ? "light" : "dark"}
              handleRef={frameRef}
            />
          </div>
        </div>
      </DraggableCard>
      <ExternalLinkDialog
        open={link !== null}
        url={link ?? ""}
        onClose={() => setLink(null)}
        onOpenInIframe={(url) =>
          addWidget(
            activeDashboardId,
            buildIframeWidget(url, widget.name, widget.innerTab),
          )
        }
        onOpenInNewTab={(url) => window.open(url, "_blank", "noopener,noreferrer")}
      />
    </>
  );
}

function PluginActionIcon({
  plugin,
  action,
}: {
  plugin: ResolvedPluginWidget["plugin"];
  action: CardAction;
}) {
  const svg = useActionIcon(plugin, action.iconPath);
  if (action.icon) return <Icon id={action.icon} className="h-3.5 w-3.5" />;
  return (
    <span
      className="inline-flex h-3.5 w-3.5 [&>svg]:h-full [&>svg]:w-full"
      data-plugin-icon={action.iconPath}
      dangerouslySetInnerHTML={{ __html: svg ?? "" }}
    />
  );
}

function PluginActionButton(props: {
  plugin: ResolvedPluginWidget["plugin"];
  action: CardAction;
  pressed?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const { plugin, action, pressed, disabled, onClick } = props;
  return (
    <Tooltip message={action.label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn("ws-small-navbar-btn", {
          "bg-brand-main! text-white! hover:bg-brand-main!": pressed,
          "opacity-30": disabled,
        })}
        aria-label={action.label}
        aria-pressed={pressed}
        data-plugin-action={action.id}
      >
        <PluginActionIcon plugin={plugin} action={action} />
      </button>
    </Tooltip>
  );
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
