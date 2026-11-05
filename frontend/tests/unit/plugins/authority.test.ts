import { describe, expect, it } from "vitest";
import type { ParamDef } from "~/components/types";
import {
  assetPath,
  cardActions,
  checkConfigWrite,
  checkStateWrite,
  coerceParamValue,
  commandPermission,
  defaultPreset,
  exportFile,
  presetError,
  presetName,
  RateLimiter,
  readAddedWidget,
  readExportOptions,
  safeFilename,
  safeLink,
  serverCallError,
  serverCallRequest,
  traitBindings,
  ViolationCounter,
} from "~/plugins/authority";
import { CommandError } from "~/plugins/protocol";
import { buildPluginArtifactWidget } from "~/plugins/registry";
import { PluginListingSchema } from "~/plugins/types";

const perms = (...p: string[]) => new Set(["core:default", ...p]);

describe("the runtime authority", () => {
  describe("trait bindings", () => {
    it("binds the default traits, data only with core:data:read", () => {
      const without = traitBindings({ model: null }, perms());
      expect(without.map((b) => b.trait)).not.toContain("data");
      const withData = traitBindings({ model: null }, perms("core:data:read"));
      expect(withData.map((b) => b.trait)).toContain("data");
    });

    it("makes params and state writable only with their permissions", () => {
      const readOnly = traitBindings({ model: null }, perms("core:data:read"));
      expect(readOnly.filter((b) => b.writable)).toEqual([]);
      const writable = traitBindings(
        { model: null },
        perms("core:params:write", "core:state:write"),
      );
      expect(
        writable
          .filter((b) => b.writable)
          .map((b) => b.trait)
          .sort(),
      ).toEqual(["params", "state"]);
    });

    it("maps declared traits and refuses writes the permission does not allow", () => {
      const bindings = traitBindings(
        {
          model: {
            traits: {
              rows: { bind: "data", access: "read" },
              filter: { bind: "param:filter", access: "readwrite" },
              size: { bind: "config:size", access: "read" },
              bogus: { bind: "window", access: "read" },
            },
          },
        },
        perms("core:data:read"),
      );
      expect(bindings.map((b) => [b.trait, b.source, b.key, b.writable])).toEqual([
        ["rows", "data", undefined, false],
        ["filter", "param", "filter", false],
        ["size", "config", "size", false],
      ]);
    });
  });

  it("gives the frame nothing of the widget's MCP link (WIDGETS-JSON 5.3, rule 7)", () => {
    expect(
      traitBindings(
        {
          model: {
            traits: {
              link: { bind: "mcp_tool", access: "read" },
              tool: { bind: "meta:mcp_tool", access: "read" },
            },
          },
        },
        perms("core:data:read"),
      ),
    ).toEqual([]);
    expect(() => commandPermission("core:mcp:call", perms("core:data:read"))).toThrow(
      expect.objectContaining({ name: "unknown_command" }),
    );
  });

  describe("param writes", () => {
    const number = { paramName: "n", type: "number" } as ParamDef;
    const text = { paramName: "t", type: "text" } as ParamDef;
    const multi = { paramName: "m", type: "text", multiSelect: true } as ParamDef;

    it("coerces values to the param's type", () => {
      expect(coerceParamValue(number, "5")).toBe(5);
      expect(coerceParamValue(text, 7)).toBe("7");
      expect(coerceParamValue(multi, ["a", "b"])).toEqual(["a", "b"]);
    });

    it("refuses values of the wrong shape", () => {
      expect(() => coerceParamValue(number, "abc")).toThrow(CommandError);
      expect(() => coerceParamValue(text, { a: 1 })).toThrow(CommandError);
      expect(() => coerceParamValue(multi, "a")).toThrow(CommandError);
      expect(() => coerceParamValue(text, "x".repeat(5000))).toThrow(CommandError);
    });

    it("writes config only with core:config:write", () => {
      const binding = (permissions: Set<string>) =>
        traitBindings(
          { model: { traits: { zoom: { bind: "config:zoom", access: "readwrite" } } } },
          permissions,
        )[0].writable;
      expect(binding(perms())).toBe(false);
      expect(binding(perms("core:config:write"))).toBe(true);
    });

    it("takes a config write only for a declared setting with a valid value", () => {
      const schema = {
        properties: {
          zoom: { type: "number" as const, minimum: 0, maximum: 19 },
          mode: { enum: ["a", "b"] },
          label: { type: "string" as const, maxLength: 4 },
          note: { type: "string" as const },
        },
      };
      expect(checkConfigWrite(schema, {}, "note", "x".repeat(1000))).toEqual({
        note: "x".repeat(1000),
      });
      expect(() => checkConfigWrite(schema, {}, "note", "x".repeat(1001))).toThrow(
        CommandError,
      );
      expect(checkConfigWrite(schema, { mode: "a" }, "zoom", 12)).toEqual({
        mode: "a",
        zoom: 12,
      });
      expect(checkConfigWrite(schema, { mode: "a" }, undefined, { zoom: 3 })).toEqual({
        zoom: 3,
      });
      expect(() => checkConfigWrite(schema, {}, "zoom", 25)).toThrow(CommandError);
      expect(() => checkConfigWrite(schema, {}, "zoom", "12")).toThrow(CommandError);
      expect(() => checkConfigWrite(schema, {}, "mode", "c")).toThrow(CommandError);
      expect(() => checkConfigWrite(schema, {}, "label", "longer")).toThrow(
        CommandError,
      );
      expect(() => checkConfigWrite(schema, {}, "other", 1)).toThrow(
        expect.objectContaining({ name: "out_of_scope" }),
      );
      expect(() => checkConfigWrite(schema, {}, undefined, [1])).toThrow(CommandError);
    });

    it("caps state at 64 KiB", () => {
      expect(checkStateWrite({ a: 1 })).toEqual({ a: 1 });
      expect(() => checkStateWrite({ a: "x".repeat(70 * 1024) })).toThrow(CommandError);
    });
  });

  describe("commands", () => {
    it("needs the command's permission", () => {
      expect(() => commandPermission("core:ui:notify", perms())).toThrow(
        /not_granted|needs/,
      );
      expect(() =>
        commandPermission("core:ui:notify", perms("core:ui:notify")),
      ).not.toThrow();
      expect(() => commandPermission("core:shell:exec", perms())).toThrow(CommandError);
    });

    it("lets every widget read its plugin's own assets, and nothing else", () => {
      expect(() => commandPermission("core:asset:read", perms())).not.toThrow();
      expect(assetPath({ path: "assets/duckdb-eh.wasm" })).toBe(
        "assets/duckdb-eh.wasm",
      );
      expect(assetPath({ path: "assets/fonts/Inter.woff2" })).toBe(
        "assets/fonts/Inter.woff2",
      );
      for (const path of [
        "entry.js",
        "plugin.json",
        "backend/server.py",
        "assets/../plugin.json",
        "assets/./x",
        "/assets/x",
        "assets/",
        "assets/a b",
        42,
        undefined,
      ])
        expect(() => assetPath({ path })).toThrow(
          expect.objectContaining({ name: "invalid_args" }),
        );
    });

    it("opens only https and mailto links", () => {
      expect(safeLink("https://example.com/a")).toBe("https://example.com/a");
      expect(safeLink("mailto:someone@example.com")).toContain("mailto:");
      for (const bad of [
        "javascript:alert(1)",
        "data:text/html,x",
        "http://example.com",
        5,
      ])
        expect(() => safeLink(bad)).toThrow(CommandError);
    });

    it("cleans file names", () => {
      expect(safeFilename("../../etc/passwd")).toBe("_.._etc_passwd");
      expect(safeFilename("")).toBe("download");
      expect(safeFilename("report.csv")).toBe("report.csv");
    });

    it("calls only the proxies and routes the widget declares, with an object of arguments", () => {
      expect(() => commandPermission("core:proxy:call", perms())).toThrow(/needs/);
      expect(() => commandPermission("core:backend:call", perms())).toThrow(/needs/);
      expect(
        serverCallRequest({ id: "quote", args: { symbol: "IBM" } }, "id", ["quote"]),
      ).toEqual({ name: "quote", args: { symbol: "IBM" } });
      expect(serverCallRequest({ id: "quote" }, "id", ["quote"]).args).toEqual({});
      expect(
        serverCallRequest({ route: "forecast", args: { region: "emea" } }, "route", [
          "forecast",
        ]),
      ).toEqual({ name: "forecast", args: { region: "emea" } });
      for (const [msg, key] of [
        [{ id: "other" }, "id"],
        [{ id: "forecast" }, "route"],
        [{ url: "https://169.254.169.254/" }, "id"],
      ] as const)
        expect(() => serverCallRequest(msg, key, ["quote", "forecast"])).toThrow(
          expect.objectContaining({ name: "out_of_scope" }),
        );
      expect(() =>
        serverCallRequest({ id: "quote", args: ["IBM"] }, "id", ["quote"]),
      ).toThrow(expect.objectContaining({ name: "invalid_args" }));
    });

    it("turns the API's refusals into the frame's error names", () => {
      const refusal = (code: string, message = "why") => ({
        response: { data: { detail: { code, message } } },
      });
      expect(serverCallError(refusal("invalid_args"))).toMatchObject({
        name: "invalid_args",
        message: "why",
      });
      expect(serverCallError(refusal("permission_denied")).name).toBe("not_granted");
      expect(serverCallError(refusal("unknown_route")).name).toBe("out_of_scope");
      expect(serverCallError(refusal("busy")).name).toBe("rate_limited");
      expect(serverCallError(refusal("response_too_large")).name).toBe("too_large");
      for (const code of [
        "secret_missing",
        "egress_refused",
        "backend_mismatch",
        "backend_unavailable",
      ])
        expect(serverCallError(refusal(code)).name).toBe("unavailable");
      expect(serverCallError(new Error("Network Error"))).toMatchObject({
        name: "unavailable",
        message: "the call failed",
      });
    });
  });

  describe("budgets", () => {
    it("limits the rate with a burst", () => {
      let now = 0;
      const limiter = new RateLimiter(10, 3, () => now);
      expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([
        true,
        true,
        true,
        false,
      ]);
      now = 200;
      expect(limiter.take()).toBe(true);
    });

    it("ends a frame after three violations in ten seconds", () => {
      let now = 0;
      const counter = new ViolationCounter(3, 10_000, () => now);
      expect(counter.add()).toBe(false);
      now = 5000;
      expect(counter.add()).toBe(false);
      now = 16_000;
      expect(counter.add()).toBe(false);
      now = 17_000;
      expect(counter.add()).toBe(false);
      now = 18_000;
      expect(counter.add()).toBe(true);
    });
  });

  describe("exports, as the plugin's code decides them", () => {
    const geojson = {
      id: "geojson",
      label: "Visible features (GeoJSON)",
      extension: "geojson",
      mime: "application/geo+json",
    };

    it("takes whatever options the plugin offers, and none", () => {
      expect(readExportOptions([geojson])).toEqual([geojson]);
      expect(readExportOptions([])).toEqual([]);
      expect(readExportOptions(undefined)).toEqual([]);
    });

    it("refuses options that do not say what they are", () => {
      for (const bad of [
        "csv",
        [{ id: "rows" }],
        [{ ...geojson, extension: "geo.json" }],
        [{ ...geojson, mime: "text/html; charset=x" }],
        [{ ...geojson, extra: true }],
        [geojson, geojson],
        Array.from({ length: 17 }, (_, i) => ({ ...geojson, id: `o${i}` })),
      ])
        expect(() => readExportOptions(bad)).toThrow(CommandError);
    });

    it("saves what exportData delivers, typed as its option says", async () => {
      const text = exportFile('{"type":"FeatureCollection"}', geojson);
      expect(text?.type).toBe("application/geo+json");
      expect(await text?.text()).toBe('{"type":"FeatureCollection"}');
      const bytes = exportFile(new Uint8Array([1, 2, 3]), geojson);
      expect(bytes?.size).toBe(3);
      expect(exportFile(new Blob(["x"]), geojson)?.type).toBe("application/geo+json");
      expect(exportFile(null, geojson)).toBeNull();
      expect(() => exportFile({ rows: [] }, geojson)).toThrow(CommandError);
    });
  });
});

const ROWS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rowData"],
  properties: {
    rowData: {
      type: "array",
      maxItems: 2,
      items: { type: "object", additionalProperties: { type: ["string", "number"] } },
    },
  },
};

const tablePlugin = PluginListingSchema.parse({
  enabled: true,
  etag: "1",
  plugins: [
    {
      id: "grid-kit",
      version: "1.0.0",
      name: "Grid kit",
      digest: `sha256-${"A".repeat(43)}`,
      entry: { module: "entry.js", styles: [] },
      files: {},
      csp: {},
      widgets: [
        {
          id: "table",
          name: "Table",
          handles: [{ type: "grid-table" }],
          permissions: ["core:data:read"],
          artifact: { description: "Rows", data: ROWS_SCHEMA },
        },
        {
          id: "sql",
          name: "SQL",
          standalone: true,
          permissions: ["core:ui:button", "core:ui:menu", "core:dashboard:add-widget"],
          settings: {
            schema: {
              properties: {
                heatmap: { type: "boolean" },
                title: { type: "string" },
              },
            },
          },
          actions: [
            { id: "freeze", label: "Freeze", icon: "table", placement: "navbar" },
            {
              id: "heat",
              label: "Heatmap",
              icon: "grid",
              placement: "navbar",
              toggles: "heatmap",
            },
            { id: "reset", label: "Reset", icon: "refresh", placement: "menu" },
          ],
        },
      ],
    },
  ],
}).plugins[0];
const [tableWidget, sqlWidget] = tablePlugin.widgets;
const resolveTable = (id: string) => {
  const widget = tablePlugin.widgets.find((w) => w.id === id);
  return widget ? { plugin: tablePlugin, widget } : null;
};

describe("card actions", () => {
  it("draws the buttons and menu items that the permissions allow, with host icons", () => {
    const actions = cardActions(sqlWidget, new Set(sqlWidget.permissions));
    expect(actions.buttons).toEqual([
      { id: "freeze", label: "Freeze", icon: "table-02" },
      { id: "heat", label: "Heatmap", icon: "grid-01", toggles: "heatmap" },
    ]);
    expect(actions.menu).toEqual([
      { id: "reset", label: "Reset", icon: "refresh-icon" },
    ]);
  });

  it("draws an SVG of the package only when the package has the file", () => {
    const widget = {
      ...sqlWidget,
      actions: [
        { id: "a", label: "A", icon: "assets/a.svg", placement: "menu" as const },
        { id: "b", label: "B", icon: "assets/missing.svg", placement: "menu" as const },
        { id: "c", label: "C", icon: "entry.js", placement: "menu" as const },
        { id: "d", label: "D", icon: "constructor", placement: "menu" as const },
      ],
    };
    const files = {
      "assets/a.svg": { size: 1, sha256: "a".repeat(64) },
      "entry.js": {},
    };
    expect(cardActions(widget, new Set(["core:ui:menu"]), files).menu).toEqual([
      { id: "a", label: "A", iconPath: "assets/a.svg" },
    ]);
  });

  it("draws nothing without the permission", () => {
    expect(cardActions(sqlWidget, new Set(["core:ui:menu"])).buttons).toEqual([]);
    expect(cardActions(sqlWidget, new Set(["core:ui:button"])).menu).toEqual([]);
  });

  it("drops an unknown icon, a toggle of a setting that is not boolean, and actions past the limit", () => {
    const widget = {
      ...sqlWidget,
      actions: [
        { id: "a", label: "A", icon: "skull", placement: "navbar" as const },
        {
          id: "b",
          label: "B",
          icon: "eye",
          placement: "navbar" as const,
          toggles: "title",
        },
        ...["c", "d", "e", "f"].map((id) => ({
          id,
          label: id,
          icon: "eye",
          placement: "navbar" as const,
        })),
      ],
    };
    expect(
      cardActions(widget, new Set(["core:ui:button"])).buttons.map((a) => a.id),
    ).toEqual(["c", "d", "e"]);
  });
});

describe("adding a widget of the plugin", () => {
  const rows = { rowData: [{ region: "north", units: 3 }] };

  it("takes data that satisfies the target's artifact", () => {
    const added = readAddedWidget(
      { widget: "table", data: rows, name: "  Units  " },
      resolveTable,
    );
    expect(added.target.widget.id).toBe("table");
    expect(added.data).toEqual(rows);
    expect(added.name).toBe("Units");
  });

  it("refuses a widget that takes no data, or is not the plugin's", () => {
    expect(() => readAddedWidget({ widget: "sql", data: rows }, resolveTable)).toThrow(
      CommandError,
    );
    expect(() =>
      readAddedWidget({ widget: "other", data: rows }, resolveTable),
    ).toThrow(CommandError);
  });

  it("refuses data that does not satisfy the artifact", () => {
    for (const data of [
      {},
      { rowData: [{ a: 1 }, { a: 2 }, { a: 3 }] },
      { rowData: [{ a: { nested: true } }] },
      { rowData: [], extra: 1 },
      { rowData: [{ a: Number.NaN }] },
      { rowData: [{ a: Number.POSITIVE_INFINITY }] },
      { rowData: [{ a: new Date(0) }] },
      { rowData: Object.assign(new Array(2), { 1: { a: 1 } }) },
      { rowData: new Map() },
      { rowData: [{ a: undefined }] },
    ])
      expect(() => readAddedWidget({ widget: "table", data }, resolveTable)).toThrow(
        /data/,
      );
  });

  it("stores a plain JSON copy of the data, not the module's object", () => {
    const data = { rowData: [{ a: "x" }] };
    const added = readAddedWidget({ widget: "table", data }, resolveTable);
    expect(added.data).toEqual(data);
    expect(added.data).not.toBe(data);
    const withProto = structuredClone(JSON.parse('{"rowData":[],"__proto__":{"x":1}}'));
    expect(() =>
      readAddedWidget({ widget: "table", data: withProto }, resolveTable),
    ).toThrow(/data/);
  });

  it("builds the widget as a chat artifact is built, with the target's own parameters", () => {
    const built = buildPluginArtifactWidget(
      { plugin: tablePlugin, widget: tableWidget },
      rows,
      {
        id: "w1",
        name: "Units",
        description: "A static copy of SQL",
        innerTab: "t1",
      },
    );
    expect(built).toMatchObject({
      id: "w1",
      name: "Units",
      widgetId: "plugin:grid-kit:table",
      connectionType: "plugin",
      plugin: { id: "grid-kit", widget: "table" },
      params: [],
      innerTab: "t1",
      storage: { plugin: { data: rows }, createdAt: expect.any(String) },
    });
    expect(built.storage).not.toHaveProperty("copiedFrom");
  });

  it("records which widget a static copy came from, and when", () => {
    const built = buildPluginArtifactWidget(
      { plugin: tablePlugin, widget: tableWidget },
      rows,
      {
        id: "w2",
        name: "SQL (static)",
        description: "A static copy of SQL",
        copiedFrom: { widgetUuid: "sql-1", name: "SQL" },
      },
    );
    expect(built.storage?.copiedFrom).toEqual({ widgetUuid: "sql-1", name: "SQL" });
    expect(Number.isNaN(Date.parse(String(built.storage?.createdAt)))).toBe(false);
  });
});

describe("presets", () => {
  it("needs core:presets for the preset commands", () => {
    for (const name of [
      "core:presets:list",
      "core:presets:apply",
      "core:presets:save",
    ]) {
      expect(() => commandPermission(name, perms())).toThrow(
        expect.objectContaining({ name: "not_granted" }),
      );
      expect(() => commandPermission(name, perms("core:presets"))).not.toThrow();
    }
  });

  it("takes a name of 1 to 80 characters, trimmed", () => {
    expect(presetName("  Weekly  ")).toBe("Weekly");
    expect(presetName("x".repeat(80))).toHaveLength(80);
    for (const bad of ["", "   ", "x".repeat(81), 5, undefined])
      expect(() => presetName(bad)).toThrow(
        expect.objectContaining({ name: "invalid_args" }),
      );
  });

  it("turns the API's refusals into the frame's error names", () => {
    const refusal = (status: number, detail: unknown = "why") => ({
      response: { status, data: { detail } },
    });
    expect(presetError(refusal(409, "You keep 100 presets"))).toMatchObject({
      name: "too_large",
      message: "You keep 100 presets",
    });
    expect(presetError(refusal(413)).name).toBe("too_large");
    expect(presetError(refusal(422, [{ msg: "bad" }]))).toMatchObject({
      name: "invalid_args",
      message: "the preset call failed",
    });
    expect(presetError(refusal(404)).name).toBe("unavailable");
    expect(presetError(new Error("Network Error")).name).toBe("unavailable");
  });

  it("starts a new card from the user's default, else the organization's", () => {
    const preset = (id: string, scope: string, is_default: boolean) => ({
      id,
      scope,
      is_default,
    });
    const orgDefault = preset("o1", "org", true);
    const mine = preset("u1", "user", false);
    const myDefault = preset("u2", "user", true);
    expect(defaultPreset([mine, orgDefault, myDefault])).toBe(myDefault);
    expect(defaultPreset([mine, orgDefault])).toBe(orgDefault);
    expect(defaultPreset([mine, preset("o2", "org", false)])).toBeUndefined();
  });
});
