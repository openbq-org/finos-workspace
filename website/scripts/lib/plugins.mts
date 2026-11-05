import { jsonSchemaFields } from "../../../agent/scripts/reference/json-schema.ts";
import type { ProtocolMessage, PluginsData, PluginValueType } from "../../src/data/types.ts";
import { readReference, referencePath } from "./reference.mts";

type Json = Record<string, any>;

const VALUE_GROUPS = ["backend", "csp", "host", "package", "patterns", "proxy", "reports", "schemaLint", "secrets"];

function flatten(prefix: string, node: unknown, out: Record<string, PluginValueType>): void {
  if (typeof node === "number" || typeof node === "string") {
    out[prefix] = node;
  } else if (Array.isArray(node) && node.every((item) => typeof item === "string")) {
    out[prefix] = node as string[];
  } else if (typeof node === "object" && node !== null && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) flatten(`${prefix}.${key}`, value, out);
  }
}

function messages(schema: Json, source: string): ProtocolMessage[] {
  return (schema.oneOf as Json[]).map((variant) => {
    const t = variant.properties.t.const as string;
    const description = ((variant.description as string | undefined) ?? "").trim();
    if (description === "") throw new Error(`The message ${t} in ${source} has no description`);
    return { t, description, fields: jsonSchemaFields(variant).filter((field) => field.path !== "t") };
  });
}

export function collectPlugins(): PluginsData {
  const backend = readReference("backend", "widget_plugins.json");
  const frontend = readReference("frontend", "plugin-reference.json");
  const commandPermissions = frontend.commandPermissions as Record<string, string>;
  const commandOf = new Map(Object.entries(commandPermissions).map(([command, permission]) => [permission, command]));
  const values: Record<string, PluginValueType> = {};
  for (const group of VALUE_GROUPS) flatten(group, backend[group], values);
  for (const group of ["versions", "shell", "limits"]) flatten(group, frontend[group], values);
  for (const permission of backend.permissions as Json[]) {
    if ((permission.meaning as string).trim() === "") throw new Error(`The permission ${permission.name} has no meaning`);
  }
  return {
    permissions: (backend.permissions as Json[]).map((permission) => ({
      name: permission.name as string,
      meaning: permission.meaning as string,
      command: commandOf.get(permission.name as string) ?? null,
    })),
    permissionsLater: backend.permissionsLater as string[],
    commandErrors: frontend.commandErrors as string[],
    exportMembers: frontend.exportMembers as string[],
    exportOption: jsonSchemaFields(frontend.exportOption as Json),
    traits: backend.traits as string[],
    traitTable: frontend.traitTable as PluginsData["traitTable"],
    builtInTypes: backend.builtInTypes as string[],
    actionIcons: backend.actionIcons as string[],
    actionIconTags: backend.actionIconTags as string[],
    actionIconAttributes: backend.actionIconAttributes as string[],
    guestMessages: messages(frontend.guestMessages as Json, referencePath("frontend", "plugin-reference.json")),
    hostMessages: messages(frontend.hostMessages as Json, referencePath("frontend", "plugin-reference.json")),
    states: backend.states as PluginsData["states"],
    metrics: backend.metrics as PluginsData["metrics"],
    cspFloor: Object.entries(backend.csp.floor as Record<string, string[]>).map(([directive, sources]) => ({ directive, sources })),
    values,
  };
}
