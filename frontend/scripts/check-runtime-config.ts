import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ENV_NAMES, RuntimeConfigSchema } from "../src/lib/runtimeConfigSchema.ts";

type Config = Record<string, Record<string, unknown>>;
type AppConfig = {
  FIELDS: [string, string, string, string][];
  HEADER_FIELDS: [string, string][];
  render(env: Record<string, string>): string;
  policy(env: Record<string, string>): string;
};

const appConfig: AppConfig = (await import(resolve(process.cwd(), "app-config.js"))).default;
const rows = appConfig.FIELDS.map(([group, field, variable, type]) => ({
  path: `${group}.${field}`,
  group,
  field,
  variable,
  type,
}));

const samples: Record<string, [string, unknown]> = {
  string: ['a "quoted" \\ value', 'a "quoted" \\ value'],
  bool: ["false", false],
  list: [" One,two ,,", ["one", "two"]],
  theme: ["light", "light"],
};

function render(env: Record<string, string>): Config {
  const sandbox: { window: { __APP_CONFIG__?: unknown } } = { window: {} };
  runInNewContext(appConfig.render(env), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.__APP_CONFIG__));
}

const errors: string[] = [];

const schemaPaths = Object.entries(RuntimeConfigSchema.shape).flatMap(
  ([group, groupSchema]) =>
    Object.keys((groupSchema as unknown as { shape: object }).shape).map(
      (field) => `${group}.${field}`,
    ),
);
const undescribed = Object.entries(RuntimeConfigSchema.shape).flatMap(([group, groupSchema]) =>
  Object.entries((groupSchema as unknown as { shape: Record<string, { description?: string }> }).shape)
    .filter(([, node]) => !node.description?.trim())
    .map(([field]) => `${group}.${field}`),
);
for (const path of undescribed) errors.push(`${path} has no description`);
const tablePaths = rows.map((row) => row.path);
for (const path of schemaPaths) {
  if (!tablePaths.includes(path)) errors.push(`${path} is missing from FIELDS`);
}
for (const path of new Set(tablePaths)) {
  if (!schemaPaths.includes(path)) errors.push(`${path} is not in the schema`);
  if (tablePaths.indexOf(path) !== tablePaths.lastIndexOf(path)) {
    errors.push(`${path} is in FIELDS more than once`);
  }
}
for (const row of rows) {
  if (!(row.type in samples)) errors.push(`${row.path} has unknown type ${row.type}`);
}
for (const row of rows) {
  const name = (ENV_NAMES as Record<string, Record<string, string>>)[row.group]?.[row.field];
  if (name?.replace(/^VITE_/, "") !== row.variable) {
    errors.push(`${row.path}: ${row.variable} is not ${name} without VITE_`);
  }
}

const nginxConf = readFileSync(resolve(process.cwd(), "nginx.conf"), "utf8");
const passed = [...nginxConf.matchAll(/^env ([A-Z0-9_]+);$/gm)].map((match) => match[1]);
const headerVariables = appConfig.HEADER_FIELDS.map(([variable]) => variable);
for (const variable of [...rows.map((row) => row.variable), ...headerVariables]) {
  if (!passed.includes(variable)) errors.push(`nginx.conf has no env ${variable};`);
}
for (const name of passed) {
  if (!rows.some((row) => row.variable === name) && !headerVariables.includes(name)) {
    errors.push(`nginx.conf passes ${name}, which no field reads`);
  }
}
for (const [variable, description] of appConfig.HEADER_FIELDS) {
  if (!description.trim()) errors.push(`${variable} has no description`);
}
for (const [variable, value] of [
  ["CSP_EXTRA_SOURCES", "script-src 'none'"],
  ["CSP_EXTRA_SOURCES", "sandbox allow-scripts"],
  ["CSP_REPORT_ONLY", "yes"],
]) {
  try {
    appConfig.policy({ [variable]: value });
    errors.push(`app-config.js accepted ${variable}=${value}`);
  } catch {
  }
}

if (!RuntimeConfigSchema.safeParse(render({})).success) {
  errors.push("config.js rendered with no variables set fails the schema");
}

const written = render(
  Object.fromEntries(rows.map((row) => [row.variable, samples[row.type]?.[0] ?? ""])),
);
const parsed = RuntimeConfigSchema.safeParse(written);
if (!parsed.success) {
  errors.push(
    `config.js rendered with every variable set fails the schema: ${parsed.error.message}`,
  );
} else {
  const data = parsed.data as Config;
  for (const row of rows) {
    const expected = JSON.stringify(samples[row.type]?.[1]);
    if (JSON.stringify(written[row.group]?.[row.field]) !== expected) {
      errors.push(`${row.path}: ${row.variable} is not written as ${expected}`);
    } else if (JSON.stringify(data[row.group]?.[row.field]) !== expected) {
      errors.push(`${row.path}: the schema changes the written value`);
    }
  }
}

for (const [variable, value, what] of [
  ["AUTHENTICATION_ALLOW_EMAIL_LOGIN", "yes", "boolean"],
  ["UI_DEFAULT_THEME", "blue", "theme"],
]) {
  try {
    render({ [variable]: value });
    errors.push(`app-config.js accepted an invalid ${what}`);
  } catch {
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`app-config.js covers all ${schemaPaths.length} RuntimeConfigSchema fields`);
