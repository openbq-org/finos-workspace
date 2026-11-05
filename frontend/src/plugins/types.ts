import { z } from "zod";
import { VIZ_TYPE_PATTERN } from "~/lib/types/widgetsContract";

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,47}$/;
const DIGEST_PATTERN = /^sha256-[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export const PERMISSIONS = [
  "core:default",
  "core:data:read",
  "core:data:stream",
  "core:params:write",
  "core:state:write",
  "core:config:write",
  "core:copilot:context",
  "core:export:provide",
  "core:ui:notify",
  "core:ui:open-link",
  "core:ui:button",
  "core:ui:menu",
  "core:dashboard:add-widget",
  "core:clipboard:write",
  "core:download:save",
  "core:proxy:call",
  "core:backend:call",
  "core:presets",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const TraitBindingSchema = z.object({
  bind: z.string().max(80),
  access: z.enum(["read", "readwrite"]).default("read"),
});

const SettingsPropertySchema = z.looseObject({
  type: z.enum(["string", "number", "integer", "boolean"]).optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  default: z.unknown().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  maxLength: z.number().optional(),
});

export const SettingsSchemaSchema = z.object({
  type: z.literal("object").optional(),
  properties: z.record(z.string(), SettingsPropertySchema).default({}),
  required: z.array(z.string()).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});
export type SettingsSchema = z.infer<typeof SettingsSchemaSchema>;

const HandleSchema = z.object({
  type: z.string().regex(VIZ_TYPE_PATTERN),
  definition: z.record(z.string(), z.unknown()).nullish(),
  response: z
    .object({
      accepts: z.literal("json").default("json"),
      description: z.string().default(""),
      schema: z.record(z.string(), z.unknown()).nullish(),
    })
    .default({ accepts: "json", description: "" }),
});

const ActionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  label: z.string().min(1).max(40),
  icon: z.string(),
  placement: z.enum(["navbar", "menu"]),
  toggles: z.string().nullish(),
});
export type PluginAction = z.infer<typeof ActionSchema>;

const PluginWidgetSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
  name: z.string(),
  description: z.string().default(""),
  category: z.string().nullish(),
  subCategory: z.string().nullish(),
  handles: z.array(HandleSchema).default([]),
  standalone: z.boolean().default(false),
  artifact: z
    .object({
      description: z.string(),
      data: z.record(z.string(), z.unknown()),
    })
    .nullish(),
  permissions: z.array(z.enum(PERMISSIONS)),
  proxies: z.array(z.string()).default([]),
  routes: z.array(z.string()).default([]),
  model: z
    .object({ traits: z.record(z.string(), TraitBindingSchema).default({}) })
    .nullish(),
  params: z.array(z.record(z.string(), z.unknown())).default([]),
  settings: z
    .object({
      schema: SettingsSchemaSchema.default({ properties: {} }),
      defaults: z.record(z.string(), z.unknown()).default({}),
    })
    .nullish(),
  grid: z
    .object({
      w: z.number(),
      h: z.number(),
      minW: z.number().nullish(),
      minH: z.number().nullish(),
    })
    .default({ w: 20, h: 12 }),
  actions: z.array(ActionSchema).default([]),
});
export type PluginWidgetDef = z.infer<typeof PluginWidgetSchema>;

const FileInfoSchema = z.object({
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(SHA256_HEX),
});

const AvailablePluginSchema = z.object({
  id: z.string().regex(PLUGIN_ID_PATTERN),
  version: z.string(),
  name: z.string(),
  description: z.string().default(""),
  publisher: z.object({ name: z.string(), url: z.string().nullish() }).nullish(),
  digest: z.string().regex(DIGEST_PATTERN),
  entry: z.object({
    module: z.string(),
    styles: z.array(z.string()).default([]),
  }),
  files: z.record(z.string(), FileInfoSchema),
  csp: z.record(z.string(), z.array(z.string())),
  adminSettings: z.record(z.string(), z.unknown()).default({}),
  widgets: z.array(PluginWidgetSchema),
});
export type AvailablePlugin = z.infer<typeof AvailablePluginSchema>;

export const PluginListingSchema = z.object({
  enabled: z.boolean(),
  etag: z.string(),
  plugins: z.array(AvailablePluginSchema),
  vizHandlers: z
    .record(z.string(), z.object({ plugin: z.string(), widget: z.string() }))
    .default({}),
});
export type PluginListing = z.infer<typeof PluginListingSchema>;

export interface ResolvedPluginWidget {
  plugin: AvailablePlugin;
  widget: PluginWidgetDef;
  vizType?: string;
}

export interface PluginInstanceStorage {
  data?: unknown;
  state?: unknown;
  config?: Record<string, unknown>;
  presetChecked?: boolean;
}

export const MAX_STATE_BYTES = 64 * 1024;
export const MAX_CONFIG_BYTES = 32 * 1024;
export const MAX_SETTING_LENGTH = 1000;
