type Schema = Record<string, unknown>;

interface DefinitionError {
  path: string;
  message: string;
}

const KNOWN = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "oneOf",
  "anyOf",
  "$defs",
  "$ref",
  "title",
  "description",
  "default",
  "examples",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pointer(path: string, key: string | number) {
  return `${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

export function validateDefinition(
  value: unknown,
  schema: Schema | null | undefined,
): DefinitionError[] {
  if (!schema)
    return value === undefined ? [] : [{ path: "", message: "not expected" }];
  const defs = isObject(schema.$defs) ? schema.$defs : {};
  const errors: DefinitionError[] = [];

  const check = (data: unknown, node: unknown, path: string, depth: number) => {
    if (errors.length >= 50) return;
    if (depth > 16 || !isObject(node)) {
      errors.push({ path, message: "the definition is not valid" });
      return;
    }
    for (const key of Object.keys(node)) {
      if (!KNOWN.has(key)) {
        errors.push({
          path,
          message: `the definition uses an unsupported keyword: ${key}`,
        });
        return;
      }
    }
    if (typeof node.$ref === "string") {
      const name = node.$ref.replace(/^#\/\$defs\//, "");
      check(data, Object.hasOwn(defs, name) ? defs[name] : undefined, path, depth + 1);
      return;
    }
    if ("const" in node && !equal(data, node.const)) {
      errors.push({ path, message: `must be ${JSON.stringify(node.const)}` });
      return;
    }
    if (Array.isArray(node.enum)) {
      if (!node.enum.some((option) => equal(option, data)))
        errors.push({ path, message: "is not one of the allowed values" });
      return;
    }
    for (const key of ["oneOf", "anyOf"] as const) {
      const options = node[key];
      if (!Array.isArray(options)) continue;
      const passing = options.filter((option) => {
        const before = errors.length;
        check(data, option, path, depth + 1);
        const ok = errors.length === before;
        errors.length = before;
        return ok;
      }).length;
      if (key === "oneOf" ? passing !== 1 : passing === 0)
        errors.push({
          path,
          message:
            key === "oneOf" ? "must match exactly one option" : "matches no option",
        });
      return;
    }

    const types =
      typeof node.type === "string"
        ? [node.type]
        : Array.isArray(node.type)
          ? (node.type as string[])
          : isObject(node.properties) || "additionalProperties" in node
            ? ["object"]
            : [];
    if (types.length && !types.some((type) => matchesType(data, type))) {
      errors.push({ path, message: `must be ${types.join(" or ")}` });
      return;
    }

    if (typeof data === "string") {
      if (typeof node.maxLength === "number" && data.length > node.maxLength)
        errors.push({ path, message: `at most ${node.maxLength} characters` });
      if (typeof node.minLength === "number" && data.length < node.minLength)
        errors.push({ path, message: `at least ${node.minLength} characters` });
      if (typeof node.pattern === "string") {
        try {
          if (!new RegExp(node.pattern, "u").test(data))
            errors.push({ path, message: "does not match the expected pattern" });
        } catch {
          errors.push({ path, message: "the definition's pattern is not valid" });
        }
      }
    }
    if (typeof data === "number") {
      if (typeof node.minimum === "number" && data < node.minimum)
        errors.push({ path, message: `at least ${node.minimum}` });
      if (typeof node.maximum === "number" && data > node.maximum)
        errors.push({ path, message: `at most ${node.maximum}` });
      if (typeof node.exclusiveMinimum === "number" && data <= node.exclusiveMinimum)
        errors.push({ path, message: `more than ${node.exclusiveMinimum}` });
      if (typeof node.exclusiveMaximum === "number" && data >= node.exclusiveMaximum)
        errors.push({ path, message: `less than ${node.exclusiveMaximum}` });
    }
    if (Array.isArray(data)) {
      if (typeof node.maxItems === "number" && data.length > node.maxItems)
        errors.push({ path, message: `at most ${node.maxItems} items` });
      if (typeof node.minItems === "number" && data.length < node.minItems)
        errors.push({ path, message: `at least ${node.minItems} items` });
      if (node.uniqueItems === true) {
        const seen = new Set(data.map((item) => JSON.stringify(item)));
        if (seen.size !== data.length)
          errors.push({ path, message: "items must be unique" });
      }
      if (node.items !== undefined)
        data.forEach((item, index) =>
          check(item, node.items, pointer(path, index), depth + 1),
        );
    }
    if (isObject(data)) {
      const properties = isObject(node.properties) ? node.properties : {};
      for (const required of Array.isArray(node.required) ? node.required : []) {
        if (!Object.hasOwn(data, String(required)))
          errors.push({
            path: pointer(path, String(required)),
            message: "is required",
          });
      }
      for (const [key, item] of Object.entries(data)) {
        if (Object.hasOwn(properties, key)) {
          check(item, properties[key], pointer(path, key), depth + 1);
        } else if (
          node.additionalProperties === false ||
          node.additionalProperties === undefined
        ) {
          errors.push({ path: pointer(path, key), message: "is not a defined key" });
        } else if (isObject(node.additionalProperties)) {
          check(item, node.additionalProperties, pointer(path, key), depth + 1);
        }
      }
    }
  };

  check(value, schema, "", 0);
  return errors;
}
