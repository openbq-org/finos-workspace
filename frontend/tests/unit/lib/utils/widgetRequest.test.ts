import { describe, expect, it } from "vitest";
import type { ParamDef, ParamDefT, WidgetT } from "~/components/types";
import { createParamDefs, currentDateModifier } from "~/lib/utils/widgetParams";
import {
  type BuiltRequest,
  buildFormRequest,
  buildOptionsRequest,
  buildWidgetRequest,
  requestInit,
  requestKey,
} from "~/lib/utils/widgetRequest";
import "../../../mocks/runtimeConfig";

const BACKEND = "https://backend.example";

type Endpoint = NonNullable<WidgetT["endpoint"]>;

function widget(
  url: string,
  params: Partial<ParamDef>[],
  values: Record<string, unknown> = {},
  endpoint: Partial<Endpoint> = {},
) {
  return {
    endpoint: { url: `${BACKEND}${url}`, method: "GET", ...endpoint } as Endpoint,
    params: params as ParamDef[],
    storage: { params: values as Record<string, string> },
  };
}

function sent(built: BuiltRequest | null) {
  if (!built?.ok) throw new Error(`not sent: ${JSON.stringify(built)}`);
  return built.request;
}

function problems(built: BuiltRequest | null) {
  if (!built || built.ok) throw new Error("sent");
  return built.problems;
}

describe("the widget request (WIDGETS-JSON 4.1)", () => {
  const teamReport = widget(
    "/teams/{team}/report",
    [
      {
        paramName: "team",
        type: "endpoint",
        optionsEndpoint: `${BACKEND}/teams/search`,
        optionsMethod: "POST",
        optionsParams: { active: true },
      },
      { paramName: "period", type: "text", value: "month" },
      { paramName: "X-Region", type: "text", value: "eu", in: "header" },
      { paramName: "filters", type: "text", value: "active", in: "body" },
    ],
    { team: "platform" },
    { method: "POST" },
  );

  it("builds the request of the design's example", () => {
    const request = sent(buildWidgetRequest(teamReport, { theme: "dark" }));
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      `${BACKEND}/teams/platform/report?period=month&theme=dark`,
    );
    expect(request.paramHeaders).toEqual({ "X-Region": "eu" });
    expect(request.body).toBe('{"filters":"active"}');

    const init = requestInit(request);
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"filters":"active"}');
    expect(init.headers).toMatchObject({
      "X-Region": "eu",
      "Content-Type": "application/json",
    });
  });

  it("builds the option lookup of the design's example", () => {
    const team = teamReport.params[0] as ParamDefT<"endpoint">;
    const request = sent(
      buildOptionsRequest(team, { params: teamReport.params }, undefined),
    );
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${BACKEND}/teams/search`);
    expect(request.body).toBe('{"active":true}');
  });

  it("sends no body without body params, and a GET without a method", () => {
    const request = sent(
      buildWidgetRequest(
        widget("/data", [{ paramName: "q", type: "text" }], { q: "x" }),
        undefined,
      ),
    );
    expect(request.method).toBe("GET");
    expect(request.body).toBeUndefined();
    expect(requestInit(request).headers).not.toHaveProperty("Content-Type");
  });

  it("is nothing without an endpoint, and a data URI as it is", () => {
    expect(
      buildWidgetRequest({ endpoint: undefined, params: [] }, undefined),
    ).toBeNull();
    const data = "data:text/markdown,%23%20Hi";
    expect(
      sent(buildWidgetRequest({ endpoint: { url: data, method: "GET" } }, undefined))
        .url,
    ).toBe(data);
  });
});

describe("path params (4.2)", () => {
  const params = [{ paramName: "id", type: "text" }] as const;

  it("encodes the value as one path segment", () => {
    const request = sent(
      buildWidgetRequest(
        widget("/items/{id}", [...params], { id: "a/b?c#d" }),
        undefined,
      ),
    );
    expect(request.url).toBe(`${BACKEND}/items/a%2Fb%3Fc%23d`);
  });

  it("sends a path param nowhere else", () => {
    const request = sent(
      buildWidgetRequest(widget("/items/{id}", [...params], { id: 7 }), undefined),
    );
    expect(request.url).toBe(`${BACKEND}/items/7`);
  });

  it("does not send the request when the value is empty", () => {
    for (const value of ["", null, undefined])
      expect(
        problems(
          buildWidgetRequest(
            widget("/items/{id}", [...params], { id: value }),
            undefined,
          ),
        ),
      ).toEqual([{ paramName: "id", kind: "missing", message: "`id` needs a value" }]);
  });

  it("sends 0 and false", () => {
    const zero = widget("/items/{id}", [{ paramName: "id", type: "number" }], {
      id: 0,
    });
    expect(sent(buildWidgetRequest(zero, undefined)).url).toBe(`${BACKEND}/items/0`);
    const no = widget("/flags/{on}", [{ paramName: "on", type: "boolean" }], {
      on: false,
    });
    expect(sent(buildWidgetRequest(no, undefined)).url).toBe(`${BACKEND}/flags/false`);
  });

  it("refuses a placeholder that names no param, and a list", () => {
    expect(
      problems(buildWidgetRequest(widget("/items/{nope}", []), undefined))[0],
    ).toMatchObject({
      paramName: "nope",
      kind: "invalid",
    });
    expect(
      problems(
        buildWidgetRequest(
          widget("/items/{id}", [...params], { id: ["a", "b"] }),
          undefined,
        ),
      )[0].kind,
    ).toBe("invalid");
  });

  it("takes the default when nothing is stored", () => {
    const request = sent(
      buildWidgetRequest(
        widget("/items/{id}", [{ paramName: "id", type: "text", value: "d" }]),
        undefined,
      ),
    );
    expect(request.url).toBe(`${BACKEND}/items/d`);
  });
});

describe("values (4.3)", () => {
  const post = (params: Partial<ParamDef>[], values: Record<string, unknown>) =>
    sent(
      buildWidgetRequest(widget("/x", params, values, { method: "POST" }), undefined),
    );

  it("joins many values with commas in the query and sends an array in the body", () => {
    const params: Partial<ParamDef>[] = [
      { paramName: "q", type: "endpoint", multiSelect: true },
      { paramName: "b", type: "endpoint", multiSelect: true, in: "body" },
      { paramName: "s", type: "text", multiple: true, in: "body" },
    ];
    const request = post(params, { q: ["a", "b"], b: ["c", 1], s: "x,y" });
    expect(new URL(request.url).searchParams.get("q")).toBe("a,b");
    expect(JSON.parse(request.body ?? "")).toEqual({ b: ["c", 1], s: ["x", "y"] });
  });

  it("sends JSON numbers and booleans in the body, strings in the query", () => {
    const params: Partial<ParamDef>[] = [
      { paramName: "n", type: "number", in: "body" },
      { paramName: "t", type: "boolean", in: "body" },
      { paramName: "s", type: "text", in: "body" },
      { paramName: "qn", type: "number" },
    ];
    const request = post(params, { n: "2.5", t: "true", s: 3, qn: 4 });
    expect(JSON.parse(request.body ?? "")).toEqual({ n: 2.5, t: true, s: "3" });
    expect(new URL(request.url).searchParams.get("qn")).toBe("4");
  });

  it("puts a bodyRoot param's JSON object at the top of the body, next to the other body params", () => {
    const params = [
      { paramName: "gridState", type: "text", in: "body", bodyRoot: true },
      { paramName: "desk", type: "text", in: "body" },
    ] as Partial<ParamDef>[];
    const request = post(params, {
      gridState: JSON.stringify({
        startRow: 0,
        endRow: 100,
        sortModel: [{ colId: "qty", sort: "desc" }],
        filterModel: { desk: { type: "equals" } },
      }),
      desk: "FX",
    });
    expect(JSON.parse(request.body ?? "")).toEqual({
      startRow: 0,
      endRow: 100,
      sortModel: [{ colId: "qty", sort: "desc" }],
      filterModel: { desk: { type: "equals" } },
      desk: "FX",
    });
    // An empty value adds nothing.
    expect(JSON.parse(post(params, { gridState: "" }).body ?? "{}")).toEqual({});
  });

  it("refuses a bodyRoot value that is not a JSON object", () => {
    const params = [
      { paramName: "gridState", type: "text", in: "body", bodyRoot: true },
    ] as Partial<ParamDef>[];
    for (const value of ["not json", "[1, 2]", "42"])
      expect(
        problems(
          buildWidgetRequest(
            widget("/x", params, { gridState: value }, { method: "POST" }),
          ),
        )[0].message,
      ).toMatch(/must be a JSON object/);
  });

  it("resolves $currentDate modifiers", () => {
    const request = sent(
      buildWidgetRequest(
        widget("/x", [{ paramName: "d", type: "date" }], { d: "$currentDate-1d" }),
        undefined,
      ),
    );
    expect(new URL(request.url).searchParams.get("d")).toBe(
      currentDateModifier("$currentDate-1d"),
    );
  });

  it("does not send an empty value, and sends 0 and false", () => {
    const request = sent(
      buildWidgetRequest(
        widget(
          "/x",
          [
            { paramName: "a", type: "text" },
            { paramName: "b", type: "number" },
            { paramName: "c", type: "boolean" },
            { paramName: "d", type: "endpoint", multiSelect: true },
          ],
          { a: "", b: 0, c: false, d: [] },
        ),
        undefined,
      ),
    );
    expect(request.url).toBe(`${BACKEND}/x?b=0&c=false`);
  });

  it("refuses a value that is not of the param's type", () => {
    expect(
      problems(
        buildWidgetRequest(
          widget("/x", [{ paramName: "n", type: "number" }], { n: "x" }),
          undefined,
        ),
      ),
    ).toEqual([{ paramName: "n", kind: "invalid", message: "`n` is not a number" }]);
  });

  it("sends only declared params", () => {
    const request = sent(
      buildWidgetRequest(
        widget("/x", [{ paramName: "a", type: "text" }], { a: "1", z: "2" }),
        undefined,
      ),
    );
    expect(request.url).toBe(`${BACKEND}/x?a=1`);
  });
});

describe("rules (4.4)", () => {
  it("refuses a body param without POST", () => {
    expect(
      problems(
        buildWidgetRequest(
          widget("/x", [{ paramName: "b", type: "text", in: "body" }], { b: "v" }),
          undefined,
        ),
      )[0].message,
    ).toBe("`b` goes in the body, which needs the method POST");
  });

  it("refuses header names a browser drops or the host sets", () => {
    for (const name of ["Cookie", "sec-fetch-mode", "Authorization", "bad name"])
      expect(
        problems(
          buildWidgetRequest(
            widget("/x", [{ paramName: name, type: "text", in: "header" }], {
              [name]: "v",
            }),
            undefined,
          ),
        )[0].message,
      ).toBe(`\`${name}\` cannot be sent as a header`);
  });

  it("does not send a header value that is not printable ASCII", () => {
    const params: Partial<ParamDef>[] = [
      { paramName: "X-Name", type: "text", in: "header" },
    ];
    for (const value of ["café", "a\nb", "x".repeat(1025)])
      expect(
        problems(
          buildWidgetRequest(widget("/x", params, { "X-Name": value }), undefined),
        )[0].kind,
      ).toBe("invalid");
  });

  it("names the data backend and carries no credentials", () => {
    const request = sent(
      buildWidgetRequest(
        {
          ...widget("/x", [{ paramName: "a", type: "text" }], { a: "1" }),
          sourceId: "src-1",
        },
        {},
      ),
    );
    expect(request.url).toBe(`${BACKEND}/x?a=1`);
    expect(request.sourceId).toBe("src-1");
    expect(Object.keys(request).sort()).toEqual([
      "method",
      "paramHeaders",
      "sourceId",
      "url",
    ]);
  });
});

describe("the cache key (4.6)", () => {
  const key = (value: string, sourceId?: string) => {
    const built = buildWidgetRequest({
      ...widget("/x", [{ paramName: "X-Region", type: "text", in: "header" }], {
        "X-Region": value,
      }),
      sourceId,
    });
    sent(built);
    return requestKey(built as BuiltRequest);
  };

  it("changes with a header param's value", () => {
    expect(key("eu", "s")).not.toEqual(key("us", "s"));
  });

  it("changes with the data backend", () => {
    expect(key("eu", "one")).not.toEqual(key("eu", "two"));
  });

  it("changes with the body", () => {
    const body = (v: string) =>
      requestKey(
        buildWidgetRequest(
          widget(
            "/x",
            [{ paramName: "b", type: "text", in: "body" }],
            { b: v },
            {
              method: "POST",
            },
          ),
        ) as BuiltRequest,
      );
    expect(body("1")).not.toEqual(body("2"));
  });
});

describe("option lookups (4.7)", () => {
  const params = [
    { paramName: "region", type: "text", value: "eu" },
    { paramName: "tags", type: "endpoint", multiSelect: true },
  ] as ParamDef[];
  const lookup = (extra: Partial<ParamDefT<"endpoint">>) =>
    ({
      paramName: "team",
      type: "endpoint",
      optionsEndpoint: `${BACKEND}/regions/{region}/teams`,
      optionsParams: { region: "$region", tags: "$tags", limit: 10, all: false },
      ...extra,
    }) as ParamDefT<"endpoint">;

  it("fills placeholders from optionsParams and puts the rest in the query for GET", () => {
    const request = sent(
      buildOptionsRequest(
        lookup({}),
        { params, values: { tags: ["a", "b"] } },
        undefined,
      ),
    );
    expect(request.method).toBe("GET");
    expect(request.url).toBe(
      `${BACKEND}/regions/eu/teams?tags=a%2Cb&limit=10&all=false`,
    );
  });

  it("sends the rest as a JSON body for POST, keeping literal types", () => {
    const request = sent(
      buildOptionsRequest(
        lookup({ optionsMethod: "POST" }),
        { params, values: { tags: ["a"] } },
        undefined,
      ),
    );
    expect(request.url).toBe(`${BACKEND}/regions/eu/teams`);
    expect(JSON.parse(request.body ?? "")).toEqual({
      tags: ["a"],
      limit: 10,
      all: false,
    });
  });

  it("does not send an empty value, and needs a placeholder's", () => {
    const request = sent(
      buildOptionsRequest(lookup({}), { params, values: {} }, undefined),
    );
    expect(request.url).toBe(`${BACKEND}/regions/eu/teams?limit=10&all=false`);
    expect(
      problems(
        buildOptionsRequest(lookup({}), { params, values: { region: "" } }, undefined),
      ),
    ).toEqual([
      { paramName: "region", kind: "missing", message: "`region` needs a value" },
    ]);
  });

  it("names the data backend and carries no credentials", () => {
    const request = sent(buildOptionsRequest(lookup({}), { params }, "src-1"));
    expect(request.sourceId).toBe("src-1");
    expect(Object.keys(request).sort()).toEqual([
      "method",
      "paramHeaders",
      "sourceId",
      "url",
    ]);
  });

  it("is nothing without an optionsEndpoint", () => {
    expect(
      buildOptionsRequest(
        lookup({ optionsEndpoint: undefined }),
        { params },
        undefined,
      ),
    ).toBeNull();
  });
});

describe("a form's submission", () => {
  const form = {
    type: "form",
    paramName: "edit",
    endpoint: `${BACKEND}/accounts/{account}/notes/{note}`,
    method: "PUT",
    inputParams: [
      { paramName: "note", type: "text" },
      { paramName: "body", type: "text" },
    ],
  } as ParamDefT<"form">;
  const owner = widget("/x", [{ paramName: "account", type: "text" }], {
    account: "a 1",
  });

  it("fills the endpoint from the inputs and the widget's params, and posts every input", () => {
    const request = sent(buildFormRequest(form, { note: "n1", body: "hi" }, owner));
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(`${BACKEND}/accounts/a%201/notes/n1`);
    expect(JSON.parse(request.body ?? "")).toEqual({ note: "n1", body: "hi" });
  });

  it("is not sent while a placeholder has no value", () => {
    expect(problems(buildFormRequest(form, { body: "hi" }, owner))[0]).toMatchObject({
      paramName: "note",
      kind: "missing",
    });
  });
});

describe("a default of false or 0", () => {
  const params = createParamDefs({
    params: [
      { paramName: "active", type: "boolean", value: false },
      { paramName: "offset", type: "number", value: 0 },
    ],
  } as Parameters<typeof createParamDefs>[0]);

  it("is sent until the user changes it", () => {
    const request = sent(buildWidgetRequest(widget("/rows", params), undefined));
    expect(request.url).toBe(`${BACKEND}/rows?active=false&offset=0`);
  });

  it("is sent in the body of a POST", () => {
    const inBody = params.map((param) => ({ ...param, in: "body" as const }));
    const request = sent(
      buildWidgetRequest(widget("/rows", inBody, {}, { method: "POST" }), undefined),
    );
    expect(JSON.parse(request.body ?? "")).toEqual({ active: false, offset: 0 });
  });
});
