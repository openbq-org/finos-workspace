import type {
  FormInputParamDef,
  ParamDef,
  ParamDefT,
  StoredParamValue,
  WidgetT,
} from "~/components/types";
import {
  HEADER_VALUE_PATTERN,
  type HttpMethod,
  isAllowedHeaderName,
} from "~/lib/types/widgetsContract";
import { currentDateModifier, dateModRegex } from "./widgetParams";
import { PLACEHOLDER, placeholders } from "./widgetsContractChecks";

export interface BackendRequest {
  url: string;
  method: HttpMethod | "PUT" | "OPTIONS";
  sourceId?: string;
  paramHeaders: Record<string, string>;
  body?: string;
}

export interface RequestProblem {
  paramName: string;
  kind: "missing" | "invalid";
  message: string;
}

export type BuiltRequest =
  | { ok: true; request: BackendRequest }
  | { ok: false; problems: RequestProblem[] };

type WidgetValues = Pick<WidgetT, "endpoint" | "params" | "sourceId"> & {
  storage?: { params?: Record<string, StoredParamValue> };
};

type AnyParam = ParamDef | FormInputParamDef;
type Location = "path" | "query" | "header" | "body";
type JsonScalar = string | number | boolean;

const HEADER_VALUE = new RegExp(HEADER_VALUE_PATTERN);

export class RequestProblemsError extends Error {
  readonly problems: RequestProblem[];

  constructor(problems: RequestProblem[]) {
    super(problems.map((p) => p.message).join("\n"));
    this.name = "RequestProblemsError";
    this.problems = problems;
  }
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

type Serialized =
  | { ok: true; value: string | JsonScalar | JsonScalar[] }
  | { ok: false; message: string };

function scalarFor(
  param: AnyParam | undefined,
  value: unknown,
): { ok: true; value: JsonScalar } | { ok: false; message: string } {
  const name = param?.paramName ?? "";
  if (typeof value === "object" && value !== null)
    return { ok: false, message: `\`${name}\` has a value that is not a single value` };
  if (!param) return { ok: true, value: value as JsonScalar };
  switch (param.type) {
    case "number": {
      const number = typeof value === "number" ? value : Number(String(value).trim());
      return Number.isFinite(number)
        ? { ok: true, value: number }
        : { ok: false, message: `\`${name}\` is not a number` };
    }
    case "boolean":
      if (value === true || value === "true") return { ok: true, value: true };
      if (value === false || value === "false") return { ok: true, value: false };
      return { ok: false, message: `\`${name}\` is not true or false` };
    case "date": {
      const text = String(value);
      return {
        ok: true,
        value: dateModRegex.test(text) ? currentDateModifier(text) : text,
      };
    }
    case "endpoint":
    case "button":
      return { ok: true, value: value as JsonScalar };
    default:
      return { ok: true, value: String(value) };
  }
}

function serialize(
  param: AnyParam | undefined,
  value: unknown,
  at: Location,
): Serialized {
  const many = !!(param?.multiSelect || param?.multiple) || Array.isArray(value);
  if (many) {
    if (at === "path")
      return {
        ok: false,
        message: `\`${param?.paramName}\` fills a path placeholder, which takes one value`,
      };
    const items = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",")
        : [value];
    const scalars: JsonScalar[] = [];
    for (const item of items.filter((item) => !isEmpty(item))) {
      const scalar = scalarFor(param, item);
      if (!scalar.ok) return scalar;
      scalars.push(scalar.value);
    }
    return at === "body"
      ? { ok: true, value: scalars }
      : { ok: true, value: scalars.map(String).join(",") };
  }
  const scalar = scalarFor(param, value);
  if (!scalar.ok) return scalar;
  return at === "body" ? scalar : { ok: true, value: String(scalar.value) };
}

function fillPath(
  template: string,
  resolve: (name: string) => { param?: AnyParam; value: unknown } | null,
  problems: RequestProblem[],
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const found = resolve(name);
    if (!found) {
      problems.push({
        paramName: name,
        kind: "invalid",
        message: `\`{${name}}\` names no param`,
      });
      return "";
    }
    if (isEmpty(found.value)) {
      problems.push({
        paramName: name,
        kind: "missing",
        message: `\`${name}\` needs a value`,
      });
      return "";
    }
    const serialized = serialize(found.param, found.value, "path");
    if (!serialized.ok) {
      problems.push({ paramName: name, kind: "invalid", message: serialized.message });
      return "";
    }
    return encodeURIComponent(String(serialized.value));
  });
}

function startUrl(href: string, problems: RequestProblem[]): URL {
  let url: URL;
  try {
    url = new URL(href, globalThis.location?.href);
  } catch {
    problems.push({
      paramName: "",
      kind: "invalid",
      message: `\`${href}\` is not a URL`,
    });
    return new URL("about:blank");
  }
  return url;
}

function isBodyRoot(param: AnyParam | undefined): boolean {
  return (
    !!param &&
    param.type === "text" &&
    (param as { bodyRoot?: boolean }).bodyRoot === true
  );
}

/** A `bodyRoot` param's value: a JSON object, given as one or as its text. */
function bodyObject(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function place(
  param: AnyParam | undefined,
  name: string,
  value: unknown,
  at: Exclude<Location, "path">,
  target: {
    url: URL;
    method: BackendRequest["method"];
    sourceId: string | undefined;
    paramHeaders: Record<string, string>;
    body: Record<string, unknown>;
  },
  problems: RequestProblem[],
) {
  if (isEmpty(value)) return;
  const invalid = (message: string) =>
    problems.push({ paramName: name, kind: "invalid", message });

  if (at === "header" && !isAllowedHeaderName(name))
    return invalid(`\`${name}\` cannot be sent as a header`);
  if (at === "body" && target.method === "GET")
    return invalid(`\`${name}\` goes in the body, which needs the method POST`);

  if (at === "body" && isBodyRoot(param)) {
    const object = bodyObject(value);
    if (!object)
      return invalid(
        `\`${name}\` must be a JSON object, whose keys go at the top of the body`,
      );
    Object.assign(target.body, object);
    return;
  }
  const serialized = serialize(param, value, at);
  if (!serialized.ok) return invalid(serialized.message);
  if (at === "body") {
    target.body[name] = serialized.value;
    return;
  }
  const text = String(serialized.value);
  if (at === "query") {
    target.url.searchParams.append(name, text);
    return;
  }
  if (!HEADER_VALUE.test(text))
    return invalid(
      `\`${name}\` is sent as a header, so its value must be printable ASCII of at most 1,024 characters`,
    );
  target.paramHeaders[name] = text;
}

function finish(
  target: {
    url: URL;
    method: BackendRequest["method"];
    sourceId: string | undefined;
    paramHeaders: Record<string, string>;
    body: Record<string, unknown>;
  },
  problems: RequestProblem[],
  alwaysBody = false,
): BuiltRequest {
  if (problems.length) return { ok: false, problems };
  const hasBody = alwaysBody || Object.keys(target.body).length > 0;
  return {
    ok: true,
    request: {
      url: target.url.toString(),
      method: target.method,
      ...(target.sourceId ? { sourceId: target.sourceId } : {}),
      paramHeaders: target.paramHeaders,
      ...(hasBody ? { body: JSON.stringify(target.body) } : {}),
    },
  };
}

function requestParams(params: WidgetT["params"]): ParamDef[] {
  return ((params ?? []) as (ParamDef | ParamDef[])[])
    .flat()
    .filter((param) => param && param.type !== "form" && !!param.paramName);
}

function currentValue(
  param: AnyParam,
  values: Record<string, unknown> | undefined,
): unknown {
  return values && param.paramName in values ? values[param.paramName] : param.value;
}

export function buildWidgetRequest(
  widget: WidgetValues,
  hostQuery: Record<string, string> = {},
): BuiltRequest | null {
  const endpoint = widget.endpoint;
  if (!endpoint?.url) return null;
  const method = endpoint.method ?? "GET";
  if (endpoint.url.startsWith("data:"))
    return {
      ok: true,
      request: { url: endpoint.url, method: "GET", paramHeaders: {} },
    };

  const params = requestParams(widget.params);
  const values = widget.storage?.params;
  const byName = new Map(params.map((param) => [param.paramName, param]));
  const problems: RequestProblem[] = [];

  const pathNames = new Set(placeholders(endpoint.url));
  const path = fillPath(
    endpoint.url,
    (name) => {
      const param = byName.get(name);
      return param ? { param, value: currentValue(param, values) } : null;
    },
    problems,
  );
  const target = {
    url: startUrl(path, problems),
    method,
    sourceId: widget.sourceId ?? undefined,
    paramHeaders: {},
    body: {},
  };
  for (const param of params) {
    if (pathNames.has(param.paramName)) continue;
    place(
      param,
      param.paramName,
      currentValue(param, values),
      param.in ?? "query",
      target,
      problems,
    );
  }
  for (const [key, value] of Object.entries(hostQuery))
    target.url.searchParams.set(key, value);
  return finish(target, problems);
}

export function buildOptionsRequest(
  param: ParamDefT<"endpoint"> | Extract<FormInputParamDef, { type: "endpoint" }>,
  scope: { params: AnyParam[]; values?: Record<string, unknown> },
  sourceId: string | null | undefined,
): BuiltRequest | null {
  if (!param.optionsEndpoint) return null;
  const method = param.optionsMethod ?? "GET";
  const optionsParams = param.optionsParams ?? {};
  const byName = new Map(scope.params.map((p) => [p.paramName, p]));
  const problems: RequestProblem[] = [];

  const resolve = (key: string) => {
    if (!(key in optionsParams)) return null;
    const value = optionsParams[key];
    if (typeof value !== "string" || !value.startsWith("$")) return { value };
    const ref = byName.get(value.slice(1));
    return ref
      ? { param: ref, value: currentValue(ref, scope.values) }
      : { value: scope.values?.[value.slice(1)] };
  };

  const pathNames = new Set(placeholders(param.optionsEndpoint));
  const path = fillPath(param.optionsEndpoint, resolve, problems);
  const target = {
    url: startUrl(path, problems),
    method,
    sourceId: sourceId ?? undefined,
    paramHeaders: {},
    body: {},
  };
  for (const key of Object.keys(optionsParams)) {
    if (pathNames.has(key)) continue;
    const found = resolve(key);
    place(
      found?.param,
      key,
      found?.value,
      method === "POST" ? "body" : "query",
      target,
      problems,
    );
  }
  return finish(target, problems);
}

export function formScope(
  form: ParamDefT<"form">,
  inputValues: Record<string, unknown>,
  widget: WidgetValues,
): { params: AnyParam[]; values: Record<string, unknown> } {
  const inputs = form.inputParams ?? [];
  const names = new Set(inputs.map((input) => input.paramName));
  return {
    params: [
      ...inputs,
      ...requestParams(widget.params).filter((param) => !names.has(param.paramName)),
    ],
    values: { ...(widget.storage?.params ?? {}), ...inputValues },
  };
}

export function buildFormRequest(
  form: ParamDefT<"form">,
  inputValues: Record<string, unknown>,
  widget: WidgetValues,
): BuiltRequest {
  const scope = formScope(form, inputValues, widget);
  const byName = new Map(scope.params.map((param) => [param.paramName, param]));
  const problems: RequestProblem[] = [];
  const path = fillPath(
    form.endpoint,
    (name) => {
      const param = byName.get(name);
      return param ? { param, value: currentValue(param, scope.values) } : null;
    },
    problems,
  );
  const target = {
    url: startUrl(path, problems),
    method: form.method ?? "POST",
    sourceId: widget.sourceId ?? undefined,
    paramHeaders: {},
    body: inputValues,
  };
  return finish(target, problems, true);
}

export function plainRequest(url: string, sourceId?: string | null): BuiltRequest {
  const problems: RequestProblem[] = [];
  const target = startUrl(url, problems);
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    request: {
      url: target.toString(),
      method: "GET",
      ...(sourceId ? { sourceId } : {}),
      paramHeaders: {},
    },
  };
}

export function requestInit(
  request: BackendRequest,
  init: RequestInit = {},
): RequestInit {
  return {
    ...init,
    method: request.method,
    headers: {
      ...request.paramHeaders,
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
    ...(request.body === undefined ? {} : { body: request.body }),
  };
}

export function requestKey(built: BuiltRequest): string[] {
  if (!built.ok) return ["problems", JSON.stringify(built.problems)];
  const { method, url, paramHeaders, body, sourceId } = built.request;
  return [method, url, JSON.stringify(paramHeaders), body ?? "", sourceId ?? ""];
}
