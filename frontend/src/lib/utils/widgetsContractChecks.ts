import { isValidCronExpression } from "./cronSchedule";
import type { SchemaProblem } from "./widgetsSchemaValidation";

type Param = Record<string, unknown> & { paramName?: string; type?: string };

export const PLACEHOLDER = /\{([^{}]+)\}/g;

export function placeholders(endpoint: string): string[] {
  return [...endpoint.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

function flatParams(params: unknown): { param: Param; pointer: string }[] {
  if (!Array.isArray(params)) return [];
  return params.flatMap((item, i) =>
    Array.isArray(item)
      ? item.map((param, j) => ({
          param: param as Param,
          pointer: `/params/${i}/${j}`,
        }))
      : [{ param: item as Param, pointer: `/params/${i}` }],
  );
}

function referenceProblems(
  optionsParams: unknown,
  declared: Set<string>,
  pointer: string,
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  for (const [key, value] of Object.entries(
    (optionsParams as Record<string, unknown>) ?? {},
  ))
    if (
      typeof value === "string" &&
      value.startsWith("$") &&
      !declared.has(value.slice(1))
    )
      problems.push({
        pointer: `${pointer}/optionsParams/${key}`,
        message: `\`${value}\` names no param of this widget`,
      });
  return problems;
}

function optionsEndpointProblems(param: Param, pointer: string): SchemaProblem[] {
  if (typeof param.optionsEndpoint !== "string") return [];
  const keys = new Set(
    Object.keys((param.optionsParams as Record<string, unknown>) ?? {}),
  );
  return placeholders(param.optionsEndpoint)
    .filter((name) => !keys.has(name))
    .map((name) => ({
      pointer: `${pointer}/optionsEndpoint`,
      message: `\`{${name}}\` is filled from optionsParams, which has no \`${name}\``,
    }));
}

export function contractProblems(
  widget: Record<string, unknown>,
  context: { credentialHeaders?: string[]; credentialQuery?: string[] } = {},
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const params = flatParams(widget.params);
  const requestParams = params.filter(({ param }) => param.type !== "form");
  const declared = new Set(requestParams.map(({ param }) => String(param.paramName)));

  const seen = new Set<string>();
  for (const { param, pointer } of requestParams) {
    const name = String(param.paramName);
    if (seen.has(name))
      problems.push({
        pointer: `${pointer}/paramName`,
        message: `\`${name}\` is declared twice`,
      });
    seen.add(name);
  }

  const pathNames = new Set(placeholders(String(widget.endpoint ?? "")));
  for (const name of pathNames) {
    const found = requestParams.find(({ param }) => param.paramName === name);
    if (!found) {
      problems.push({
        pointer: "/endpoint",
        message: `\`{${name}}\` names no param of this widget`,
      });
      continue;
    }
    if (found.param.in !== undefined)
      problems.push({
        pointer: `${found.pointer}/in`,
        message: `\`${name}\` fills a path placeholder, so it is sent nowhere else and declares no \`in\``,
      });
    if (found.param.multiSelect || found.param.multiple)
      problems.push({
        pointer: found.pointer,
        message: `\`${name}\` fills a path placeholder, which takes one value`,
      });
  }

  for (const { param, pointer } of params) {
    if (param.type === "form") {
      const inputs = Array.isArray(param.inputParams)
        ? (param.inputParams as Param[])
        : [];
      const inputNames = new Set(inputs.map((input) => String(input.paramName)));
      const known = new Set([...declared, ...inputNames]);
      if (inputNames.size !== inputs.length)
        problems.push({
          pointer: `${pointer}/inputParams`,
          message: "an input is declared twice",
        });
      for (const name of placeholders(String(param.endpoint ?? "")))
        if (!known.has(name))
          problems.push({
            pointer: `${pointer}/endpoint`,
            message: `\`{${name}}\` names no input of this form and no param of this widget`,
          });
      inputs.forEach((input, k) => {
        problems.push(...optionsEndpointProblems(input, `${pointer}/inputParams/${k}`));
        problems.push(
          ...referenceProblems(
            input.optionsParams,
            known,
            `${pointer}/inputParams/${k}`,
          ),
        );
      });
      continue;
    }
    problems.push(...optionsEndpointProblems(param, pointer));
    problems.push(...referenceProblems(param.optionsParams, declared, pointer));
  }

  const bodyRoots = requestParams.filter(({ param }) => param.bodyRoot === true);
  for (const { param, pointer } of bodyRoots) {
    if (param.in !== "body")
      problems.push({
        pointer: `${pointer}/bodyRoot`,
        message: `\`${String(param.paramName)}\` puts its keys at the top of the body, so it needs \`in: "body"\``,
      });
    if (param.multiSelect || param.multiple)
      problems.push({
        pointer: `${pointer}/bodyRoot`,
        message: `\`${String(param.paramName)}\` fills the body with one JSON object, so it takes one value`,
      });
  }
  if (bodyRoots.length > 1)
    problems.push({
      pointer: `${bodyRoots[1].pointer}/bodyRoot`,
      message: "only one param can fill the top of the body (`bodyRoot`)",
    });

  const fileSelectors = params.filter(({ param }) =>
    (param.roles as string[] | undefined)?.includes("fileSelector"),
  );
  if (fileSelectors.length > 1)
    problems.push({
      pointer: fileSelectors[1].pointer,
      message: "only one param can have the role `fileSelector`",
    });

  for (const key of ["refetchInterval", "dataUpdateDisplay"] as const) {
    const value = widget[key];
    if (typeof value === "string" && !isValidCronExpression(value))
      problems.push({
        pointer: `/${key}`,
        message: `\`${value}\` is not a cron expression`,
      });
  }

  const link = widget.mcp_tool as { args?: Record<string, unknown> } | undefined;
  for (const [arg, value] of Object.entries(link?.args ?? {}))
    if (
      typeof value === "string" &&
      value.startsWith("$") &&
      !declared.has(value.slice(1))
    )
      problems.push({
        pointer: `/mcp_tool/args/${arg}`,
        message: `\`${value}\` names no param of this widget`,
      });

  const credentialHeaders = new Set(
    (context.credentialHeaders ?? []).map((h) => h.toLowerCase()),
  );
  const credentialQuery = new Set(
    (context.credentialQuery ?? []).map((q) => q.toLowerCase()),
  );
  for (const { param, pointer } of requestParams) {
    const name = String(param.paramName);
    if (pathNames.has(name)) continue;
    if (param.in === "header" && credentialHeaders.has(name.toLowerCase()))
      problems.push({
        pointer: `${pointer}/paramName`,
        message: `\`${name}\` is a header the backend connection sets for its credentials`,
      });
    if ((param.in ?? "query") === "query" && credentialQuery.has(name.toLowerCase()))
      problems.push({
        pointer: `${pointer}/paramName`,
        message: `\`${name}\` is a query value the backend connection sets for its credentials`,
      });
  }

  return problems;
}
