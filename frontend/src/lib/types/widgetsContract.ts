import { z } from "zod";

export const EditorLanguages = [
  "sql",
  "javascript",
  "python",
  "json",
  "html",
  "css",
  "markdown",
  "xml",
  "text",
] as const;

export const HTTP_METHODS = ["GET", "POST"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const PARAM_LOCATIONS = ["query", "header", "body"] as const;
export type ParamLocation = (typeof PARAM_LOCATIONS)[number];

export const HEADER_NAME_PATTERN = "^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$";

export const FORBIDDEN_HEADER_NAMES = [
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
] as const;
export const FORBIDDEN_HEADER_PREFIXES = ["proxy-", "sec-"] as const;

export const RESERVED_HEADER_NAMES = [
  "authorization",
  "content-type",
  "accept",
  "x-microsoft-id-token",
  "x-okta-id-token",
  "x-workspace-identity",
  "x-workspace-user",
] as const;

export const HEADER_VALUE_PATTERN = "^[\\x20-\\x7E]{0,1024}$";

export function isAllowedHeaderName(name: string): boolean {
  if (!new RegExp(HEADER_NAME_PATTERN).test(name)) return false;
  const lower = name.toLowerCase();
  return !(
    (FORBIDDEN_HEADER_NAMES as readonly string[]).includes(lower) ||
    (RESERVED_HEADER_NAMES as readonly string[]).includes(lower) ||
    FORBIDDEN_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

export const VIZ_TYPE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

export const LIMITS = {
  name: 200,
  description: 4000,
  label: 200,
  category: 100,
  paramName: 128,
  endpoint: 2048,
  textValue: 4096,
  shortValue: 64,
  options: 1000,
  params: 64,
  rowParams: 16,
  optionsParams: 32,
  mcpArgs: 32,
  mcpArgValue: 256,
  cron: 100,
  dataKey: 256,
} as const;

const Endpoint = z
  .string()
  .min(1)
  .max(LIMITS.endpoint)
  .regex(/^[^?#]+$/)
  .meta({
    description:
      "a path or an absolute URL with no `?` and no `#` (a static query value is a param with show: false)",
  });

const Label = z.string().max(LIMITS.label);
const Scalar = z.union([z.string().max(LIMITS.textValue), z.number(), z.boolean()]);
const NullableScalar = z.union([
  z.string().max(LIMITS.textValue),
  z.number(),
  z.boolean(),
  z.null(),
]);

const OptionItem = z.strictObject({
  label: Label,
  value: NullableScalar.optional(),
  extraInfo: z
    .strictObject({
      description: Label.optional(),
      rightOfDescription: Label.optional(),
    })
    .meta({
      description:
        "Two short texts shown at the right of the choice, which the search also matches: `description`, then `rightOfDescription`. A dropdown of several choices shows them, and so does an endpoint param's list",
    })
    .optional(),
});
const Options = z
  .array(OptionItem)
  .max(LIMITS.options)
  .meta({ description: "The choices of a dropdown, as `{ label, value, extraInfo }`" });

const ParamFields = {
  paramName: z.string().min(1).max(LIMITS.paramName).meta({
    description:
      "The name the value is sent under: a query name, a header name or a body key. Unique in the widget; a `{paramName}` placeholder in the endpoint takes the value instead",
  }),
  label: Label.meta({
    description: "The control's label; the paramName by default",
  }).optional(),
  description: z
    .string()
    .max(LIMITS.description)
    .meta({ description: "Help shown on hover, which the AI Agent also reads" })
    .optional(),
  show: z
    .boolean()
    .meta({
      description:
        "false hides the control; the value is still sent, as when a parameter group or another widget supplies it",
    })
    .optional(),
  row: z
    .int()
    .min(0)
    .max(31)
    .meta({ description: "The row of the parameter bar the control is placed in" })
    .optional(),
  roles: z
    .array(z.literal("fileSelector"))
    .max(1)
    .meta({
      description:
        "`fileSelector`: the param picks the file the widget shows, at most one per widget",
    })
    .optional(),
  placeholder: Label.meta({
    description: "Shown in the control while it is empty",
  }).optional(),
  style: z
    .strictObject({ popupWidth: z.number().min(100).max(1000).optional() })
    .meta({ description: "`popupWidth`: the width of a dropdown's list, in pixels" })
    .optional(),
  options: Options.optional(),
  multiSelect: z
    .boolean()
    .meta({
      description:
        "Several values can be chosen; sent joined with commas, or as a list in a body",
    })
    .optional(),
};

const ParamCommon = {
  ...ParamFields,
  in: z
    .enum(PARAM_LOCATIONS)
    .meta({
      description:
        "Where the value goes: `query` (the default), `header` or `body` (which needs the method POST). A param in a path placeholder declares none",
    })
    .optional(),
};

const NumberValue = z.union([
  z.number(),
  z
    .string()
    .max(LIMITS.shortValue)
    .regex(/^-?\d*\.?\d*$/),
]);
const OptionsParams = z.record(z.string().max(LIMITS.paramName), Scalar).meta({
  maxProperties: LIMITS.optionsParams,
  description:
    "Values for the options request: a `{name}` placeholder of optionsEndpoint takes one, the rest go in the query (GET) or a JSON body (POST). `$name` is the current value of the param `name`",
});
const OptionsEndpoint = Endpoint.meta({
  description:
    "a path or an absolute URL with no `?` and no `#`, which answers with the choices as a list of strings or `{ label, value, extraInfo }`",
});
const OptionsMethod = z.enum(HTTP_METHODS).meta({
  description: "How the options are requested: GET (the default) or POST",
});

const TextParam = z.strictObject({
  ...ParamCommon,
  type: z.literal("text"),
  value: z
    .string()
    .max(LIMITS.textValue)
    .meta({ description: "The default value" })
    .nullish(),
  multiple: z
    .boolean()
    .meta({ description: "Several values can be entered, sent like multiSelect" })
    .optional(),
  language: z
    .enum(EditorLanguages)
    .meta({
      description: "The value is code in this language, edited in a code editor",
    })
    .optional(),
  bodyRoot: z
    .boolean()
    .meta({
      description:
        "With `in: \"body\"`: the value is a JSON object whose keys go at the top of the body instead of under the param's name, for a backend that takes a client's request as the whole body",
    })
    .optional(),
});
const TabsParam = z.strictObject({
  ...ParamCommon,
  type: z.literal("tabs"),
  value: z
    .string()
    .max(LIMITS.textValue)
    .meta({ description: "The default value" })
    .nullish(),
});
const DateParam = z.strictObject({
  ...ParamCommon,
  type: z.literal("date"),
  value: z
    .string()
    .max(LIMITS.shortValue)
    .meta({
      description:
        "The default: a date, `YYYY-MM-DD`, or `$currentDate` with a modifier such as `$currentDate-1M`",
    })
    .nullish(),
});
const NumberParam = z.strictObject({
  ...ParamCommon,
  type: z.literal("number"),
  value: NumberValue.meta({
    description: "The default: a number, or a string of digits",
  }).nullish(),
});
const BooleanParam = z.strictObject({
  ...ParamCommon,
  type: z.literal("boolean"),
  value: z.boolean().meta({ description: "The default value" }).nullish(),
});
const ButtonParam = z.strictObject({
  ...ParamCommon,
  type: z.literal("button"),
  value: NullableScalar.meta({ description: "The default value" }).optional(),
});
const EndpointParam = z.strictObject({
  ...ParamCommon,
  type: z.literal("endpoint"),
  value: z
    .union([NullableScalar, z.array(Scalar).max(LIMITS.options)])
    .meta({
      description:
        "The default: an option's value, or a list of them for multiSelect (or a comma-separated string)",
    })
    .optional(),
  optionsEndpoint: OptionsEndpoint.optional(),
  optionsMethod: OptionsMethod.optional(),
  optionsParams: OptionsParams.optional(),
});

const FormInputParam = z.discriminatedUnion("type", [
  z.strictObject({
    ...ParamFields,
    type: z.literal("text"),
    value: z.string().max(LIMITS.textValue).nullish(),
  }),
  z.strictObject({
    ...ParamFields,
    type: z.literal("date"),
    value: z.string().max(LIMITS.shortValue).nullish(),
  }),
  z.strictObject({
    ...ParamFields,
    type: z.literal("number"),
    value: NumberValue.nullish(),
  }),
  z.strictObject({
    ...ParamFields,
    type: z.literal("boolean"),
    value: z.boolean().nullish(),
  }),
  z.strictObject({
    ...ParamFields,
    type: z.literal("button"),
    value: NullableScalar.optional(),
  }),
  z.strictObject({
    ...ParamFields,
    type: z.literal("endpoint"),
    value: NullableScalar.optional(),
    optionsEndpoint: OptionsEndpoint.optional(),
    optionsMethod: OptionsMethod.optional(),
    optionsParams: OptionsParams.optional(),
  }),
]);

const FormParam = z.strictObject({
  type: z.literal("form"),
  paramName: z
    .string()
    .min(1)
    .max(LIMITS.paramName)
    .meta({ description: "A name for the form; it is not sent" })
    .optional(),
  label: ParamFields.label,
  description: ParamFields.description,
  show: ParamFields.show,
  row: ParamFields.row,
  endpoint: Endpoint.meta({
    description:
      "a path or an absolute URL with no `?` and no `#`, which receives the form's inputs as a JSON body; `{name}` takes an input's or a param's value",
  }),
  method: z
    .enum(["POST", "PUT"])
    .meta({ description: "How the form is sent: POST (the default) or PUT" })
    .optional(),
  inputParams: z
    .array(FormInputParam)
    .max(32)
    .meta({ description: "The form's fields, each like a param, with no `in`" }),
});

export const ParamDefContract = z.discriminatedUnion("type", [
  TextParam,
  TabsParam,
  DateParam,
  NumberParam,
  BooleanParam,
  ButtonParam,
  EndpointParam,
  FormParam,
]);

export const McpToolContract = z
  .strictObject({
    mcp_server: z.string().min(1).max(128).meta({
      description: "The name of a server in this backend's apps.json mcpServers",
    }),
    tool_id: z
      .string()
      .min(1)
      .max(128)
      .meta({ description: "The name of the tool on that server" }),
    args: z
      .record(
        z.string().max(LIMITS.paramName),
        z.union([z.string().max(LIMITS.mcpArgValue), z.number(), z.boolean()]),
      )
      .meta({
        maxProperties: LIMITS.mcpArgs,
        description: "The arguments that the AI Agent passes to the tool, by name",
      })
      .optional(),
  })
  .meta({
    description:
      "The MCP tool of this backend the AI Agent uses to query what the widget shows: a server named in this backend's apps.json mcpServers, and the tool",
  });
export type McpToolContractT = z.infer<typeof McpToolContract>;

const Cron = z.string().trim().min(1).max(LIMITS.cron);

export const WidgetBaseContract = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(LIMITS.name)
    .meta({ description: "The title the widget shows" }),
  description: z.string().max(LIMITS.description).meta({
    description:
      "What the widget shows; the catalog shows it, and the AI Agent finds widgets by it",
  }),
  endpoint: Endpoint,
  method: z
    .enum(HTTP_METHODS)
    .meta({
      description:
        "How FINOS Workspace calls the endpoint: GET (the default) or POST, which a param `in: body` needs",
    })
    .optional(),
  category: z
    .string()
    .max(LIMITS.category)
    .meta({ description: "The group the catalog lists the widget under" })
    .optional(),
  subCategory: z
    .string()
    .max(LIMITS.category)
    .meta({ description: "The subgroup within the category" })
    .optional(),
  source: z
    .union([
      z.string().max(LIMITS.category),
      z.array(z.string().max(LIMITS.category)).max(16),
    ])
    .meta({ description: "Where the data comes from: a label, or a list of labels" })
    .optional(),
  showTitle: z
    .boolean()
    .meta({ description: "false leaves the title off the widget" })
    .optional(),
  params: z
    .array(z.union([ParamDefContract, z.array(ParamDefContract).max(LIMITS.rowParams)]))
    .max(LIMITS.params)
    .meta({
      description:
        "The widget's parameters; an item that is a list of params is one row of the parameter bar",
    })
    .optional(),
  gridData: z
    .strictObject({ w: z.int().min(1).max(40), h: z.int().min(1).max(100) })
    .meta({
      description:
        "The default size on a dashboard, in grid units: `w` of 40 columns, and `h` rows",
    })
    .optional(),
  staleTime: z
    .union([z.number().min(1000).max(1e10), z.literal(false)])
    .meta({
      description:
        "Milliseconds a response is reused before it is fetched again; false fetches every time",
    })
    .optional(),
  refetchInterval: z
    .union([z.number().min(1000).max(1e10), z.literal(false), Cron])
    .nullish()
    .meta({
      description:
        "Fetch again every so many milliseconds, or on a 5-field cron schedule; false never",
    }),
  dataUpdateDisplay: Cron.meta({
    description:
      "When the data changes, as a 5-field cron expression shown to the user",
  }).optional(),
  runButton: z
    .boolean()
    .meta({ description: "The widget fetches only when the user clicks Run" })
    .optional(),
  disableRetrievalForCopilot: z
    .boolean()
    .meta({
      description:
        "Keeps the widget's data from the AI Agent; such a widget has no `mcp_tool`",
    })
    .optional(),
  exportable: z
    .boolean()
    .meta({ description: "false removes Export from the widget's menu" })
    .optional(),
  mcp_tool: McpToolContract.optional(),
});
export type WidgetBaseContractT = z.infer<typeof WidgetBaseContract>;

export const DataContract = z
  .strictObject({
    dataKey: z
      .string()
      .max(LIMITS.dataKey)
      .meta({
        description:
          "The path of the widget's data in a JSON response, such as `result.items`",
      })
      .optional(),
  })
  .meta({
    description:
      "`dataKey`, `rawDataKey` and `rawType` where the type has `raw`, and for a plugin's type the configuration its plugin defines",
  });

const Raw = z
  .boolean()
  .meta({
    description:
      "The endpoint also answers `raw=true` with the rows the widget shows, as JSON: the AI Agent and MCP get those rows, and the widget's rows button shows them",
  })
  .optional();

const RAW_DATA_PROPERTIES = {
  rawDataKey: z
    .string()
    .max(LIMITS.dataKey)
    .meta({
      description:
        "The path of the rows in the `raw=true` response, such as `results.records`; without it, `results`, or the whole response",
    })
    .optional(),
  rawType: z
    .string()
    .regex(VIZ_TYPE_PATTERN)
    .meta({
      description:
        "A plugin's type that shows the rows when the user switches the widget to them; without it, or when the user may not use that type, an html widget shows them in a table and a plugin's widget with its own plugin",
    })
    .optional(),
};

const STREAM_DATA_PROPERTIES = {
  streamEndpoint: Endpoint.meta({
    description:
      "The WebSocket the widget's plugin is fed from, as a path or an absolute URL with no `?` and no `#`: `http` and `https` become `ws` and `wss`. The widget's params are query values. The browser opens the socket through the FINOS Workspace API, which adds the backend connection's credentials, and passes the JSON messages it receives to the plugin",
  }).optional(),
};

export interface BuiltInTypeContract {
  summary: string;
  returns: string;
  properties: Record<string, z.ZodType>;
  dataProperties: Record<string, z.ZodType>;
  methods: readonly HttpMethod[];
  locations: readonly ParamLocation[];
  reservedQueryNames: readonly string[];
}

export const BUILT_IN_TYPES = {
  markdown: {
    summary: "Prose, generated commentary, formatted text",
    returns: "A markdown string, as text or as JSON with the string at `data.dataKey`",
    properties: {},
    dataProperties: {},
    methods: HTTP_METHODS,
    locations: PARAM_LOCATIONS,
    reservedQueryNames: ["theme"],
  },
  html: {
    summary: "A report, page or visualization the backend renders itself",
    returns: "An HTML document as text",
    properties: { raw: Raw },
    dataProperties: RAW_DATA_PROPERTIES,
    methods: HTTP_METHODS,
    locations: PARAM_LOCATIONS,
    reservedQueryNames: ["theme", "raw"],
  },
  newsfeed: {
    summary: "Articles and updates, each with a title, an excerpt and a full text",
    returns: "A JSON array of articles, or JSON with the array at `data.dataKey`",
    properties: {},
    dataProperties: {},
    methods: HTTP_METHODS,
    locations: PARAM_LOCATIONS,
    reservedQueryNames: [],
  },
  pdf: {
    summary: "A document the user reads page by page",
    returns:
      "The PDF (`application/pdf`), or JSON with its `data_format` and a base64 `content` or a `url`",
    properties: {},
    dataProperties: {},
    methods: HTTP_METHODS,
    locations: PARAM_LOCATIONS,
    reservedQueryNames: [],
  },
  iframe: {
    summary: "An existing web page",
    returns: "Nothing: the endpoint is the page's URL, which the browser opens",
    properties: {
      requires_auth: z
        .boolean()
        .meta({
          description:
            "The page needs the backend connection's credentials. The browser then opens it through the FINOS Workspace API, which adds them, in a sandbox without storage. For trusted pages only: the API checks this declaration itself",
        })
        .optional(),
      storage: z
        .strictObject({
          mcpUrl: z
            .string()
            .max(LIMITS.endpoint)
            .regex(/^https?:\/\/\S+$/)
            .meta({ description: "an http or https URL" })
            .optional(),
        })
        .meta({
          description:
            "`mcpUrl`: an MCP server of the page's own, connected for the widget without the backend's credentials",
        })
        .optional(),
    },
    dataProperties: {},
    methods: ["GET"],
    locations: ["query"],
    reservedQueryNames: ["theme"],
  },
} as const satisfies Record<string, BuiltInTypeContract>;

export const PLUGIN_TYPE_RULES = {
  properties: { raw: Raw },
  dataProperties: { ...RAW_DATA_PROPERTIES, ...STREAM_DATA_PROPERTIES },
  methods: HTTP_METHODS,
  locations: PARAM_LOCATIONS,
  reservedQueryNames: ["theme", "raw"] as readonly string[],
} as const;
