import { describe, expect, it } from "vitest";
import { validateDefinition } from "~/plugins/definition";

const definition = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { enum: ["bar", "line"] },
    title: { type: "string", maxLength: 10 },
    stacked: { type: "boolean" },
    opacity: { type: "number", minimum: 0, maximum: 1 },
    series: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { field: { type: "string", maxLength: 20, pattern: "^[a-z_]+$" } },
      },
    },
    colors: { type: "object", additionalProperties: { type: "string", maxLength: 7 } },
    axis: { $ref: "#/$defs/axis" },
  },
  $defs: {
    axis: {
      type: "object",
      additionalProperties: false,
      properties: { log: { type: "boolean" } },
    },
  },
};

describe("a widget's data.<type> against its plugin's definition", () => {
  it("accepts a configuration the definition describes", () => {
    expect(
      validateDefinition(
        {
          kind: "bar",
          title: "Sales",
          stacked: true,
          opacity: 0.5,
          series: [{ field: "revenue" }],
          colors: { revenue: "#ff0000" },
          axis: { log: false },
        },
        definition,
      ),
    ).toEqual([]);
  });

  it.each([
    [{ kind: "bar", extra: 1 }, "/extra", "is not a defined key"],
    [{}, "/kind", "is required"],
    [{ kind: "pie" }, "/kind", "is not one of the allowed values"],
    [{ kind: "bar", title: "a very long title" }, "/title", "at most 10 characters"],
    [{ kind: "bar", opacity: 2 }, "/opacity", "at most 1"],
    [{ kind: "bar", stacked: "yes" }, "/stacked", "must be boolean"],
    [{ kind: "bar", series: [{}, {}, {}] }, "/series", "at most 2 items"],
    [{ kind: "bar", series: [{ field: "Bad-Field" }] }, "/series/0/field", "pattern"],
    [
      { kind: "bar", series: [{ field: "a", other: 1 }] },
      "/series/0/other",
      "not a defined key",
    ],
    [{ kind: "bar", colors: { a: "#ff00000000" } }, "/colors/a", "at most 7"],
    [{ kind: "bar", axis: { log: 1 } }, "/axis/log", "must be boolean"],
  ])("refuses %j at %s", (value, path, message) => {
    const errors = validateDefinition(value, definition);
    expect(errors.some((e) => e.path === path && e.message.includes(message))).toBe(
      true,
    );
  });

  it("matches only the schema's own keys, never inherited names", () => {
    const closed = {
      type: "object",
      additionalProperties: false,
      required: ["constructor"],
      properties: { rows: { type: "array" }, constructor: { type: "string" } },
    };
    const withProto = structuredClone(
      JSON.parse('{"rows":[],"constructor":"x","__proto__":"anything"}'),
    );
    expect(validateDefinition(withProto, closed)).toEqual([
      { path: "/__proto__", message: "is not a defined key" },
    ]);
    expect(validateDefinition({ rows: [] }, closed)).toEqual([
      { path: "/constructor", message: "is required" },
    ]);
    expect(
      validateDefinition("x", { $ref: "#/$defs/__proto__", $defs: {} }).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a configuration when the plugin takes none", () => {
    expect(validateDefinition(undefined, null)).toEqual([]);
    expect(validateDefinition({ a: 1 }, null)).toHaveLength(1);
  });

  it("reports a keyword outside the subset instead of ignoring it", () => {
    const errors = validateDefinition({}, { type: "object", patternProperties: {} });
    expect(errors[0].message).toContain("unsupported keyword");
  });
});
