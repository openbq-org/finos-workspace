import type { MutableRefObject } from "react";
import type { LayoutItem } from "react-grid-layout";
import type { InnerTab } from "~/lib/state/app";
import type { ArtifactT, Citation, QuoteBoundingBox } from "~/lib/state/copilot";
import type { EditorLanguage, WidgetVizType } from "~/lib/types/app";
import type {
  HttpMethod,
  McpToolContractT,
  ParamLocation,
} from "~/lib/types/widgetsContract";
import type { DateModifierValue } from "~/lib/utils/widgetParams";
import type { ConnectionType } from "../lib/state/backendConnector";
import type { WidgetId } from "./Widgets";

export type GridData = Partial<LayoutItem> & {
  i?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  minH?: number;
  minW?: number;
  maxH?: number;
  maxW?: number;
  originalMinH?: number;
  mobileH?: number;
  moved?: boolean;
  static?: boolean;
  isDraggable?: boolean;
};

type GridInnerTab<T = string> = T;

export type GridLayout = {
  [key: GridInnerTab]: GridData[];
};

export type GroupTypes = "endpointParam" | "param";

interface GroupBase<T> {
  type: T;
  id: string;
  name: string;
  color: string;
  groupById: unknown;
}

interface LinkedParamGroup extends GroupBase<"param"> {
  type: "param";
  groupById: string;
  value: StoredParamValue;
}

interface EndpointParamGroup extends GroupBase<"endpointParam"> {
  type: "endpointParam";
  groupById: string;
  value: StoredParamValue;
}

export type Group = EndpointParamGroup | LinkedParamGroup;
export type GroupTypeT<T extends GroupTypes> = Extract<Group, { type: T }>;

export type StoredParamValue =
  | string
  | number
  | boolean
  | null
  | (string | number | boolean | null)[];

export type WidgetStorage = {
  params?: Record<string, StoredParamValue>;
  tabs?: InnerTab[];
  mcpUrl?: string;
  createdAt?: string;
  copiedFrom?: { widgetUuid: string; name: string };
  fromArtifact?: { artifactUuid: string; name: string; chatUuid: string };
  html?: string;
  text?: string;
  scale?: number;
  page?: number;
  citations?: Citation[];
  artifacts?: ArtifactT[];
  quoteBoundingBoxes?: QuoteBoundingBox[][];
  rawDataView?: boolean;
  disableAI?: boolean;
  selectedGroup?: string;
  userAppId?: string;
  iframeParams?: Record<string, StoredParamValue>;
  [key: string]: unknown;
};

export type Widget = {
  id: string;
  name: string;
  type: WidgetVizType;
  widgetId?: WidgetId;
  description?: string;
  category?: string;
  subCategory?: string;
  // biome-ignore format: off
  widgetType?: "backend" | "file" | "html";
  raw?: boolean;
  requires_auth?: boolean;
  mcp_tool?: McpToolContractT;
  imgUrl?: string;
  innerTab?: string;

  gridData?: GridData;
  showTitle?: boolean;
  exportable?: boolean;
  groupById?: string;
  paramGroups?: { [key: string]: string };

  data?: {
    dataKey?: string;
    rawDataKey?: string;
    rawType?: string;
    streamEndpoint?: string;
    [vizType: string]: unknown;
  };

  endpoint?: {
    url: string;
    method: "GET" | "POST";
  };
  params?: ParamDef[];

  external?: boolean;
  connectionType?: ConnectionType;
  source?: string | string[];
  sourceId?: string;
  sourceName?: string;

  storage?: WidgetStorage;

  plugin?: { id: string; widget: string };

  disableRetrievalForCopilot?: boolean;
  metadata?: { [key: string]: unknown };

  readonly dataKey?: string;
  readonly endpointHeaders?: {
    key: string;
    value: string;
    location?: "headers" | "query";
  }[];
  readonly extension?: string;
  isNew?: boolean;
  dataUpdateDisplay?: string;
};

type WidgetT = Widget & {
  disabled?: boolean;
  refreshQuery?: number;
  storage?: Widget["storage"];
  staleTime?: number;
  refetchInterval?: number | false | string;
  dataUpdateDisplay?: string;
  runButton?: boolean;
  originalH?: number;
  isMinimized?: boolean;
  isSharedWidget?: boolean;
  raw?: boolean;
};

export type NewWidgetT = WidgetT | ((prev: WidgetT) => WidgetT);
export type NewWidget = Omit<WidgetT, "id"> & { id?: string };
export type WidgetJsonT = Omit<WidgetT, "id" | "endpoint"> & {
  id?: string;
  endpoint?: string;
};

export type WidgetContextType = {
  widget: WidgetT;
  widgetRef: MutableRefObject<WidgetT>;
  widgetFromJSON: Partial<Widget> | null;
  activeDashboardId: string;
  isShared: boolean;
  isPreview: boolean;
  uuid: string;
  updateWidget: (newWidget: NewWidgetT, forceStoreUpdate?: boolean) => void;
  getWidget: () => WidgetT;
};

export interface WidgetProps {
  uuid?: string;
  isShared?: boolean;
  isPreview?: boolean;
  activeDashboardId?: string;
  contextOverride?: Partial<WidgetContextType>;
}

type ParamType =
  | "date"
  | "text"
  | "number"
  | "boolean"
  | "endpoint"
  | "button"
  | "form"
  | "tabs";
type ParamValue = string | number | boolean | undefined;
type ParamOptionValue = string | number | boolean;

interface BaseParamDef<PT extends ParamType = "text"> {
  type: PT;
  paramName: string;
  value?: ParamValue;
  label?: string;
  show?: boolean;
  description?: string;
  options?: {
    label: string;
    value: ParamOptionValue;
    extraInfo?: { description?: string; rightOfDescription?: string };
  }[];
  multiSelect?: boolean;
  placeholder?: string;
  row?: number;
  style?: { popupWidth?: number };
  roles?: string[];
  multiple?: boolean;
  language?: EditorLanguage;
  hidden?: boolean;
  in?: ParamLocation;
}

interface TextParamDef extends BaseParamDef<"text"> {
  type: "text";
  value?: string;
}

interface DateParamDef extends BaseParamDef<"date"> {
  type: "date";
  value?: DateModifierValue;
}
interface NumberParamDef extends BaseParamDef<"number"> {
  type: "number";
  value?: number;
}

interface BooleanParamDef extends BaseParamDef<"boolean"> {
  type: "boolean";
  value?: boolean;
}

interface EndpointParamDef extends BaseParamDef<"endpoint"> {
  type: "endpoint";
  optionsEndpoint?: string;
  optionsMethod?: HttpMethod;
  optionsParams?: Record<string, string | number | boolean>;
  groupById?: string;
}

interface FormButton extends BaseParamDef<"button"> {
  type: "button";
  label: string;
  value?: string | number | boolean;
}

interface TabsParamDef extends BaseParamDef<"tabs"> {
  type: "tabs";
  value?: string;
  options: { label: string; value: string }[];
}

type FormInputType = "date" | "boolean" | "endpoint" | "number" | "text" | "button";
export type FormInputParamDef = Exclude<ParamDef, { type: "form" | "tabs" }>;

export type FormInputParamDefT<T extends FormInputType = FormInputType> = Extract<
  FormInputParamDef,
  { type: T }
>;

interface FormParamDef extends BaseParamDef<"form"> {
  type: "form";
  endpoint: string;
  method: "POST" | "PUT";
  inputParams: FormInputParamDef[];
}

// biome-ignore format: on
export type ParamDef = TextParamDef | DateParamDef | NumberParamDef | BooleanParamDef | EndpointParamDef | FormParamDef | FormButton | TabsParamDef;
export type ParamDefT<T extends ParamType> = Extract<ParamDef, { type: T }>;

export type {
  GridData as GridDataT,
  GridLayout as GridLayoutT,
  Group as GroupT,
  WidgetT,
};
