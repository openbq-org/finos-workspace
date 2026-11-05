import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { ParamDef, WidgetT } from "~/components/types";
import { WidgetComponentMap } from "~/components/Widgets";
import { resolvePluginWidget, resolveVizHandler } from "~/plugins/registry";
import type { SettingsSchema } from "~/plugins/types";
import { LIMITS } from "../types/widgetsContract";
import { getCleanWidgetId } from "./widget";
import { placeholders } from "./widgetsContractChecks";

type JsonSchema = Record<string, unknown>;

type ParamPlace = "path" | "query" | "header" | "body";

export function paramPlace(param: ParamDef, endpointUrl?: string): ParamPlace | null {
  if (param.type === "form") return null;
  if (endpointUrl && placeholders(endpointUrl).includes(param.paramName)) return "path";
  return param.in ?? "query";
}

const NUMBER = { type: ["number", "string"], pattern: "^-?(\\d+\\.?\\d*|\\.\\d+)$" };
const DATE = {
  type: "string",
  pattern: "^(\\d{4}-\\d{2}-\\d{2}|\\$currentDate([+-]\\d+[bhdwmqyBHDWMQY])?)$",
};
const SCALAR = { type: ["string", "number", "boolean"] };

function itemSchema(param: ParamDef): JsonSchema {
  if (param.type === "boolean") return { enum: [true, false, "true", "false"] };
  const options = (param.options ?? [])
    .map((option) => option?.value)
    .filter((value) => value !== null && value !== undefined);
  if (options.length && param.type !== "endpoint")
    return {
      enum: [
        ...new Set(
          options.flatMap((v) => (typeof v === "string" ? [v] : [v, String(v)])),
        ),
      ],
    };
  switch (param.type) {
    case "number":
      return NUMBER;
    case "date":
      return DATE;
    case "endpoint":
    case "button":
      return SCALAR;
    default:
      return { type: "string" };
  }
}

export function paramValueSchema(param: ParamDef): JsonSchema {
  const item = itemSchema(param);
  const many = param.multiSelect || param.multiple;
  const description = param.description || param.label;
  return {
    ...(many ? { type: ["array", "string"], items: item } : item),
    ...(description ? { description } : {}),
  };
}

export function dataArgsSchema(widget: Pick<WidgetT, "params">): JsonSchema {
  const params = (widget.params ?? []).filter(
    (param) => param.type !== "form" && param.paramName,
  );
  return {
    type: "object",
    additionalProperties: false,
    description:
      "One property for each parameter of the widget, named by its paramName. A form parameter has none",
    properties: Object.fromEntries(
      params.map((param) => [param.paramName, paramValueSchema(param)]),
    ),
  };
}

const GRID_KEYS = ["x", "y", "w", "h", "minW", "minH", "maxW", "maxH"] as const;

function settingsJsonSchema(settings: SettingsSchema): JsonSchema {
  const keep = [
    "type",
    "enum",
    "title",
    "description",
    "minimum",
    "maximum",
    "maxLength",
  ] as const;
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(settings.properties ?? {}).map(([key, prop]) => [
        key,
        Object.fromEntries(
          keep.flatMap((name) =>
            prop[name] === undefined ? [] : [[name, prop[name]]],
          ),
        ),
      ]),
    ),
    ...(settings.description ? { description: settings.description } : {}),
  };
}

export function pluginSettings(
  widget: Pick<WidgetT, "type" | "plugin">,
): SettingsSchema | undefined {
  const resolved = widget.plugin
    ? resolvePluginWidget(widget.plugin)
    : resolveVizHandler(widget.type);
  return resolved?.widget.settings?.schema;
}

type RenderedWidget = Pick<WidgetT, "type" | "plugin" | "widgetId" | "connectionType">;

function renderedAs(widget: RenderedWidget): string | undefined {
  if (widget.plugin) return undefined;
  const byId = widget.widgetId
    ? getCleanWidgetId(widget.widgetId, widget.connectionType)
    : undefined;
  return byId && byId in WidgetComponentMap ? byId : widget.type;
}

export function uiArgsSchema(widget: RenderedWidget): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    name: {
      type: "string",
      minLength: 1,
      maxLength: LIMITS.name,
      description: "The title the widget shows",
    },
    description: {
      type: "string",
      maxLength: LIMITS.description,
      description: "What the widget shows",
    },
    source: {
      type: ["string", "array"],
      items: { type: "string" },
      description: "Where the data comes from: a label, or a list of labels",
    },
    innerTab: {
      type: "string",
      description: "create_widget only: the navigation bar tab, by id or name",
    },
    gridData: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(GRID_KEYS.map((key) => [key, { type: "number" }])),
      description:
        "create_widget only: the position and size; update_widget_layout moves it",
    },
  };
  const component = renderedAs(widget);
  if (component === "markdown")
    properties.text = {
      type: "string",
      description:
        "The text a note shows; a widget with an endpoint shows the endpoint's",
    };
  if (component === "html")
    properties.html = {
      type: "string",
      description: "HTML the widget shows instead of its endpoint's",
    };
  const settings = pluginSettings(widget);
  if (settings) properties.config = settingsJsonSchema(settings);
  return {
    type: "object",
    additionalProperties: false,
    description:
      "The keys that a widget accepts in ui_args, which depend on the component that renders it",
    properties,
  };
}

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strictTypes: false });
const compiled = new Map<string, ValidateFunction>();
const MAX_COMPILED = 256;

function validatorFor(schema: JsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (!validate) {
    if (compiled.size >= MAX_COMPILED) compiled.clear();
    validate = ajv.compile(schema);
    compiled.set(key, validate);
  }
  return validate;
}

function describe(error: ErrorObject, root: string): string {
  const at = `${root}${error.instancePath.replace(/\//g, ".")}`;
  if (error.keyword === "additionalProperties") {
    const key = (error.params as { additionalProperty: string }).additionalProperty;
    return `\`${at}.${key}\` is not a key this widget accepts`;
  }
  if (error.keyword === "pattern") {
    const pattern = (error.params as { pattern: string }).pattern;
    if (pattern === NUMBER.pattern) return `\`${at}\` must be a number`;
    if (pattern === DATE.pattern)
      return `\`${at}\` must be a date (YYYY-MM-DD) or $currentDate, with a modifier such as $currentDate-1M`;
  }
  if (error.keyword === "enum") {
    const allowed = (error.params as { allowedValues: unknown[] }).allowedValues;
    return `\`${at}\` must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  return `\`${at}\` ${error.message}`;
}

export function argsProblems(
  schema: JsonSchema,
  value: unknown,
  root: string,
): string[] {
  const validate = validatorFor(schema);
  if (validate(value)) return [];
  return [...new Set((validate.errors ?? []).map((error) => describe(error, root)))];
}
