import { z } from "zod";
import type { IconId } from "~/components/Icon.types";
import type { ParamDef } from "~/components/types";
import ACTION_ICONS from "./action-icons.json";
import { validateDefinition } from "./definition";
import {
  LINK_PROTOCOLS,
  MAX_ADDED_WIDGET_BYTES,
  MAX_EXPORT_OPTIONS,
  MAX_MENU_ACTIONS,
  MAX_NAVBAR_ACTIONS,
  MAX_PRESET_NAME,
} from "./limits";
import { CommandError, type CommandErrorName, MAX_EXPORT_BYTES } from "./protocol";
import {
  MAX_CONFIG_BYTES,
  MAX_SETTING_LENGTH,
  MAX_STATE_BYTES,
  type Permission,
  type PluginAction,
  type PluginWidgetDef,
  type ResolvedPluginWidget,
  type SettingsSchema,
} from "./types";

type BindingSource =
  | "data"
  | "params"
  | "param"
  | "definition"
  | "config"
  | "adminSettings"
  | "state"
  | "theme"
  | "capabilities"
  | "meta";

export interface TraitBinding {
  trait: string;
  source: BindingSource;
  key?: string;
  writable: boolean;
}

export const DEFAULT_SOURCES = [
  "data",
  "definition",
  "params",
  "config",
  "adminSettings",
  "state",
  "theme",
  "capabilities",
  "meta",
] as const satisfies readonly BindingSource[];

export const TRAIT_DESCRIPTIONS: Record<(typeof DEFAULT_SOURCES)[number], string> = {
  data: "The JSON that the widget's backend endpoint returned, taken after `dataKey`, or the widget's rows while the user shows them",
  definition:
    "The `data.<type>` object of the backend widget, which has been checked against the `definition` schema",
  params: "The widget's parameters as an object of `{ name: value }`",
  config: "The settings of this widget instance",
  adminSettings: "The settings that the organization's admin made",
  state: `The module's own instance state, which is saved with the dashboard and may hold at most ${MAX_STATE_BYTES} bytes of JSON`,
  theme:
    "An object of the form `{ mode, tokens, locale, decimals }`. The module should follow it and react to `change:theme`. It is meant for the plugin's own interface, whereas the content that a backend returns is drawn as its author made it",
  capabilities:
    "The module's effective permissions. The module should check them before it calls a command",
  meta: "An object of the form `{ pluginId, version, widgetId, instanceId }`",
};

function parseBinding(bind: string): { source: BindingSource; key?: string } | null {
  const [head, ...rest] = bind.split(":");
  const key = rest.length ? rest.join(":") : undefined;
  if (head === "param" && key) return { source: "param", key };
  if ((head === "config" || head === "adminSettings") && key !== undefined)
    return { source: head, key };
  if (key === undefined && (DEFAULT_SOURCES as readonly string[]).includes(head))
    return { source: head as BindingSource };
  return null;
}

export function traitBindings(
  widget: Pick<PluginWidgetDef, "model">,
  permissions: ReadonlySet<string>,
): TraitBinding[] {
  const canWrite = (source: BindingSource) =>
    ((source === "params" || source === "param") &&
      permissions.has("core:params:write")) ||
    (source === "state" && permissions.has("core:state:write")) ||
    (source === "config" && permissions.has("core:config:write"));
  const declared = widget.model?.traits;

  const bindings: TraitBinding[] = [];
  if (declared && Object.keys(declared).length) {
    for (const [trait, spec] of Object.entries(declared)) {
      const parsed = parseBinding(spec.bind);
      if (!parsed) continue;
      if (parsed.source === "data" && !permissions.has("core:data:read")) continue;
      bindings.push({
        trait,
        ...parsed,
        writable: spec.access === "readwrite" && canWrite(parsed.source),
      });
    }
    return bindings;
  }
  for (const source of DEFAULT_SOURCES) {
    if (source === "data" && !permissions.has("core:data:read")) continue;
    bindings.push({ trait: source, source, writable: canWrite(source) });
  }
  return bindings;
}

const MAX_TEXT_PARAM = 4096;

export function coerceParamValue(param: ParamDef, value: unknown): unknown {
  const multiple =
    ("multiSelect" in param && param.multiSelect) ||
    ("multiple" in param && param.multiple);
  if (multiple) {
    if (!Array.isArray(value) || value.length > 500)
      throw new CommandError(
        "invalid_args",
        `${param.paramName} takes a list of values`,
      );
    return value.map((item) =>
      coerceParamValue(
        { ...param, multiSelect: false, multiple: false } as ParamDef,
        item,
      ),
    );
  }
  switch (param.type) {
    case "number": {
      const number = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(number))
        throw new CommandError("invalid_args", `${param.paramName} takes a number`);
      return number;
    }
    case "boolean":
      if (typeof value !== "boolean")
        throw new CommandError(
          "invalid_args",
          `${param.paramName} takes true or false`,
        );
      return value;
    case "date":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value))
        throw new CommandError(
          "invalid_args",
          `${param.paramName} takes a YYYY-MM-DD date`,
        );
      return value.slice(0, 32);
    default:
      if (typeof value !== "string" && typeof value !== "number")
        throw new CommandError("invalid_args", `${param.paramName} takes text`);
      if (String(value).length > MAX_TEXT_PARAM)
        throw new CommandError("too_large", `${param.paramName} is too long`);
      return String(value);
  }
}

export function jsonSize(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function checkStateWrite(value: unknown) {
  if (jsonSize(value) > MAX_STATE_BYTES)
    throw new CommandError(
      "too_large",
      `state is limited to ${MAX_STATE_BYTES / 1024} KiB`,
    );
  return value;
}

function settingProblem(
  prop: SettingsSchema["properties"][string],
  value: unknown,
): string | null {
  if (Array.isArray(prop.enum))
    return prop.enum.includes(value as never) ? null : "is not one of its values";
  if (prop.type === "boolean")
    return typeof value === "boolean" ? null : "is a boolean";
  if (prop.type === "string") {
    if (typeof value !== "string") return "is a string";
    return value.length > (prop.maxLength ?? MAX_SETTING_LENGTH) ? "is too long" : null;
  }
  if (prop.type === "number" || prop.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "is a number";
    if (prop.type === "integer" && !Number.isInteger(value)) return "is an integer";
    if (prop.minimum !== undefined && value < prop.minimum)
      return `is at least ${prop.minimum}`;
    if (prop.maximum !== undefined && value > prop.maximum)
      return `is at most ${prop.maximum}`;
    return null;
  }
  return "is not a setting the module can write";
}

export function checkConfigWrite(
  schema: SettingsSchema | undefined,
  current: Record<string, unknown>,
  key: string | undefined,
  value: unknown,
): Record<string, unknown> {
  const changes = key === undefined ? value : { [key]: value };
  if (typeof changes !== "object" || changes === null || Array.isArray(changes))
    throw new CommandError("invalid_args", "config is an object");
  const properties = schema?.properties ?? {};
  const next = key === undefined ? {} : { ...current };
  for (const [name, written] of Object.entries(changes)) {
    const prop = properties[name];
    if (!prop)
      throw new CommandError("out_of_scope", `${name} is not a declared setting`);
    const problem = settingProblem(prop, written);
    if (problem) throw new CommandError("invalid_args", `${name} ${problem}`);
    (next as Record<string, unknown>)[name] = written;
  }
  if (jsonSize(next) > MAX_CONFIG_BYTES)
    throw new CommandError(
      "too_large",
      `config is limited to ${MAX_CONFIG_BYTES / 1024} KiB`,
    );
  return next;
}

export const COMMAND_PERMISSIONS: Record<string, Permission> = {
  "core:asset:read": "core:default",
  "core:ui:notify": "core:ui:notify",
  "core:ui:open-link": "core:ui:open-link",
  "core:dashboard:add-widget": "core:dashboard:add-widget",
  "core:clipboard:write": "core:clipboard:write",
  "core:download:save": "core:download:save",
  "core:proxy:call": "core:proxy:call",
  "core:backend:call": "core:backend:call",
  "core:presets:list": "core:presets",
  "core:presets:apply": "core:presets",
  "core:presets:save": "core:presets",
};

const ASSET_PATH = /^assets\/[A-Za-z0-9._-]{1,128}(\/[A-Za-z0-9._-]{1,128})*$/;

export function assetPath(msg: Record<string, unknown>): string {
  const path = msg.path;
  if (
    typeof path !== "string" ||
    path.length > 512 ||
    !ASSET_PATH.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new CommandError("invalid_args", "path names a file under assets/");
  return path;
}

export function commandPermission(name: string, permissions: ReadonlySet<string>) {
  const needed = COMMAND_PERMISSIONS[name];
  if (!needed)
    throw new CommandError("unknown_command", `${name} is not a host command`);
  if (!permissions.has(needed))
    throw new CommandError("not_granted", `${name} needs the permission ${needed}`);
}

const CALL_ERRORS: Record<string, CommandErrorName> = {
  invalid_args: "invalid_args",
  permission_denied: "not_granted",
  unknown_proxy: "out_of_scope",
  unknown_route: "out_of_scope",
  rate_limited: "rate_limited",
  busy: "rate_limited",
  timeout: "timeout",
  response_too_large: "too_large",
};

export function serverCallError(error: unknown): CommandError {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response
    ?.data?.detail;
  const { code, message } =
    detail && typeof detail === "object"
      ? (detail as { code?: unknown; message?: unknown })
      : { code: undefined, message: undefined };
  return new CommandError(
    (typeof code === "string" && CALL_ERRORS[code]) || "unavailable",
    typeof message === "string" ? message.slice(0, 300) : "the call failed",
  );
}

export function serverCallRequest(
  msg: Record<string, unknown>,
  key: "id" | "route",
  declared: string[],
) {
  const name = typeof msg[key] === "string" ? (msg[key] as string) : "";
  if (!declared.includes(name))
    throw new CommandError(
      "out_of_scope",
      `${name || `the ${key === "id" ? "proxy" : "route"}`} is not one this widget declares`,
    );
  const args = msg.args ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args))
    throw new CommandError("invalid_args", "args is an object");
  return { name, args: args as Record<string, unknown> };
}

export function presetName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_PRESET_NAME)
    throw new CommandError(
      "invalid_args",
      `a preset's name has 1 to ${MAX_PRESET_NAME} characters`,
    );
  return name;
}

export function presetError(error: unknown): CommandError {
  const response = (
    error as { response?: { status?: number; data?: { detail?: unknown } } }
  )?.response;
  const detail = response?.data?.detail;
  const status = response?.status;
  return new CommandError(
    status === 409 || status === 413
      ? "too_large"
      : status === 422
        ? "invalid_args"
        : "unavailable",
    typeof detail === "string" ? detail.slice(0, 300) : "the preset call failed",
  );
}

export function defaultPreset<T extends { scope: string; is_default: boolean }>(
  presets: T[],
): T | undefined {
  return (
    presets.find((preset) => preset.scope === "user" && preset.is_default) ??
    presets.find((preset) => preset.scope === "org" && preset.is_default)
  );
}

export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    const now = this.now();
    this.tokens = Math.min(
      this.burst,
      this.tokens + ((now - this.last) / 1000) * this.rate,
    );
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class ViolationCounter {
  private times: number[] = [];

  constructor(
    private readonly limit = 3,
    private readonly windowMs = 10_000,
    private readonly now: () => number = () => performance.now(),
  ) {}

  add(): boolean {
    const now = this.now();
    this.times = [...this.times.filter((t) => now - t < this.windowMs), now];
    return this.times.length >= this.limit;
  }
}

export function safeLink(url: unknown): string {
  if (typeof url !== "string" || url.length > 2048)
    throw new CommandError("invalid_args", "the link is a string");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CommandError("invalid_args", "not a valid link");
  }
  if (!(LINK_PROTOCOLS as readonly string[]).includes(parsed.protocol))
    throw new CommandError("out_of_scope", "only https: and mailto: links open");
  return parsed.toString();
}

export const ExportOptionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
      .describe(
        "The id that the host passes to exportData. It is unique among the options.",
      ),
    label: z.string().min(1).max(60).describe("The text that the Export entry shows."),
    extension: z
      .string()
      .regex(/^[A-Za-z0-9]{1,10}$/)
      .describe("The extension of the file, without a dot."),
    mime: z
      .string()
      .max(192)
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/)
      .describe("The MIME type of the file, in the form type/subtype."),
  })
  .strict();
type ExportOption = z.infer<typeof ExportOptionSchema>;

export function readExportOptions(value: unknown): ExportOption[] {
  const parsed = z
    .array(ExportOptionSchema)
    .max(MAX_EXPORT_OPTIONS)
    .safeParse(value ?? []);
  if (!parsed.success)
    throw new CommandError(
      "invalid_args",
      "exportOptions returns at most 16 of { id, label, extension, mime }",
    );
  const ids = parsed.data.map((option) => option.id);
  if (new Set(ids).size !== ids.length)
    throw new CommandError("invalid_args", "an export id is offered twice");
  return parsed.data;
}

export function exportFile(value: unknown, option: ExportOption): Blob | null {
  if (value === undefined || value === null) return null;
  const type = option.mime;
  let blob: Blob;
  if (typeof value === "string") blob = new Blob([value], { type });
  else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    blob = new Blob([value as BlobPart], { type });
  else if (value instanceof Blob) blob = new Blob([value], { type });
  else
    throw new CommandError(
      "invalid_args",
      "exportData returns a string, an ArrayBuffer, a typed array or a Blob",
    );
  if (blob.size > MAX_EXPORT_BYTES)
    throw new CommandError("too_large", "an export is at most 25 MiB");
  return blob;
}

export function safeFilename(name: unknown): string {
  const base = typeof name === "string" ? name : "download";
  const cleaned = [...base]
    .map((char) =>
      char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? "_" : char,
    )
    .join("")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "download";
}

export const ACTION_ICON_PATH = /^assets\/[A-Za-z0-9._-]{1,100}\.svg$/;

export interface CardAction {
  id: string;
  label: string;
  icon?: IconId;
  iconPath?: string;
  toggles?: string;
}

export function cardActions(
  widget: Pick<PluginWidgetDef, "actions" | "settings">,
  permissions: ReadonlySet<string>,
  files: Readonly<Record<string, unknown>> = {},
): { buttons: CardAction[]; menu: CardAction[] } {
  const properties = widget.settings?.schema?.properties ?? {};
  const resolve = (action: PluginAction): CardAction | null => {
    const icon = Object.hasOwn(ACTION_ICONS, action.icon)
      ? (ACTION_ICONS as Record<string, IconId>)[action.icon]
      : undefined;
    const iconPath =
      !icon && ACTION_ICON_PATH.test(action.icon) && Object.hasOwn(files, action.icon)
        ? action.icon
        : undefined;
    if (!icon && !iconPath) return null;
    const base = {
      id: action.id,
      label: action.label,
      ...(icon ? { icon } : { iconPath }),
    };
    if (!action.toggles) return base;
    if (action.placement !== "navbar" || properties[action.toggles]?.type !== "boolean")
      return null;
    return { ...base, toggles: action.toggles };
  };
  const pick = (
    placement: PluginAction["placement"],
    permission: Permission,
    limit: number,
  ) =>
    permissions.has(permission)
      ? widget.actions
          .filter((action) => action.placement === placement)
          .map(resolve)
          .filter((action): action is CardAction => action !== null)
          .slice(0, limit)
      : [];
  return {
    buttons: pick("navbar", "core:ui:button", MAX_NAVBAR_ACTIONS),
    menu: pick("menu", "core:ui:menu", MAX_MENU_ACTIONS),
  };
}

function plainJson(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new CommandError("invalid_args", "data is nested too deeply");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new CommandError("invalid_args", "data holds a number that is not finite");
    return value;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index))
        throw new CommandError("invalid_args", "data holds a sparse array");
      copy.push(plainJson(value[index], depth + 1));
    }
    return copy;
  }
  const proto = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null)
    throw new CommandError("invalid_args", "data is plain JSON");
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as object))
    Object.defineProperty(copy, key, {
      value: plainJson(item, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return copy;
}

export function readAddedWidget(
  args: Record<string, unknown>,
  resolve: (widgetId: string) => ResolvedPluginWidget | null,
): { target: ResolvedPluginWidget; data: unknown; name?: string } {
  const widgetId = typeof args.widget === "string" ? args.widget : "";
  const target = widgetId ? resolve(widgetId) : null;
  if (!target?.widget.artifact)
    throw new CommandError(
      "out_of_scope",
      `${widgetId || "the widget"} is not a widget of this plugin that takes data`,
    );
  const data = plainJson(args.data);
  const problems = validateDefinition(data, target.widget.artifact.data);
  if (problems.length)
    throw new CommandError(
      "invalid_args",
      problems
        .slice(0, 3)
        .map((e) => `data${e.path}: ${e.message}`)
        .join("; "),
    );
  if (jsonSize(data) > MAX_ADDED_WIDGET_BYTES)
    throw new CommandError(
      "too_large",
      `the data is limited to ${MAX_ADDED_WIDGET_BYTES / 1024} KiB`,
    );
  const name =
    typeof args.name === "string" && args.name.trim()
      ? args.name.trim().slice(0, 80)
      : undefined;
  return { target, data, name };
}
