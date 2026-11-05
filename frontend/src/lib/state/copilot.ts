import cloneDeep from "lodash/cloneDeep";
import isEqual from "lodash.isequal";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { persist, subscribeWithSelector } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { shallow } from "zustand/shallow";
import { createWithEqualityFn } from "zustand/traditional";
import {
  type CustomCopilot,
  getCopilotChat,
  getExternalCopilotHolders,
} from "~/api/auth.api";
import { getConfig } from "~/lib/runtimeConfig";
import { setAgentHolders } from "~/lib/utils/fetch";
import type { ActiveMcpLink } from "~/lib/utils/mcpLink";
import {
  AI_SUPPORTED_FILE_TYPES,
  getDefaultCopilot,
  UPLOAD_BATCH_BYTES,
} from "../constants";
import { type FunctionCallT, mergeDuplicateChats } from "../utils";
import type { Selector } from "./app";

const featureSettingSchema = z.object({
  label: z.string().describe("The name that the options menu shows"),
  type: z
    .enum(["toggle", "text", "select"])
    .optional()
    .describe(
      "The kind of control: `toggle`, which is the default, `text` or `select`",
    ),
  default: z
    .union([z.boolean(), z.string()])
    .optional()
    .describe(
      "The starting value: a boolean for a toggle and a string for the other types. A `select` without a default starts on its first option",
    ),
  description: z.string().optional().describe("An explanation of the setting"),
  placeholder: z.string().optional().describe("The hint of a `text` setting"),
  options: z
    .array(
      z.object({
        label: z.string().describe("The name that the choice shows"),
        value: z
          .string()
          .describe("The value that the web app sends when the choice is selected"),
      }),
    )
    .optional()
    .describe("The choices of a `select`"),
});

export const agentEntrySchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "The agent's id. It defaults to the key of the object. The web app refuses to add an agent whose id or name matches one that the user already has",
    ),
  name: z.string().describe("The name that the interface shows"),
  description: z.string().describe("A sentence about the agent"),
  image: z
    .url()
    .optional()
    .describe(
      "The agent's avatar. A relative address is resolved against the address of the file",
    ),
  link: z.url().optional().describe("A page about the agent"),
  hasStreaming: z
    .boolean()
    .optional()
    .describe(
      "A shortcut for the feature `streaming`. It replaces the entry of that feature in `features`, whichever value the entry has",
    ),
  hasDocuments: z
    .boolean()
    .optional()
    .describe(
      "A shortcut for the feature `file-upload`. It replaces the entry of that feature in `features`, whichever value the entry has",
    ),
  hasFunctionCalling: z
    .boolean()
    .optional()
    .describe(
      "A shortcut for the features `widget-dashboard-select`, `widget-dashboard-search` and `widget-global-search`. It replaces their entries in `features`, whichever value the entries have",
    ),
  endpoints: z
    .object({
      upload_docs: z
        .url()
        .optional()
        .describe(
          `Where the web app sends documents that the user attaches to a chat with this agent, as a multipart form with the files in the field \`files\`, in batches of at most ${UPLOAD_BATCH_BYTES} bytes. An agent without it does not accept documents`,
        ),
      query: z.url().optional().describe("Where the web app sends questions"),
      feedback: z
        .url()
        .optional()
        .describe(
          "Where the web app posts a thumbs up or down on an answer, when the agent has the feature `feedback`. The body has `vote`, which is `thumbs_up` or `thumbs_down`, `tags`, `user_comment`, `ai_response`, `user_prompt` and `trace_id`",
        ),
    })
    .describe(
      "Where the web app sends requests. Each endpoint is a URL, and a relative address is resolved against the address of `agents.json`",
    ),
  features: z
    .record(z.string(), z.union([z.boolean(), featureSettingSchema]))
    .optional()
    .describe(
      "What the agent can do and which settings it offers. A key is either `true`, which switches a feature on, or an object that describes a setting that the user can change",
    ),
  models: z
    .array(
      z.object({
        id: z.string().describe("The id of the model"),
        name: z.string().describe("The name that the interface shows"),
      }),
    )
    .optional()
    .describe(
      "The models that a user can pick. When the list is empty or missing, the web app uses the options of a `select` setting named `model`",
    ),
  skills: z
    .array(
      z.object({
        slug: z
          .string()
          .describe("The word that the user types after a slash to invoke the skill"),
        description: z
          .string()
          .describe("What the skill does, which the web app sends with the slug"),
      }),
    )
    .optional()
    .describe(
      "Skills that the agent provides. The web app sends the slug and the description of the skill that a user invokes in `selected_skills`",
    ),
});

export const copilotSchema = agentEntrySchema
  .extend({ holderUuid: z.string().optional(), id: z.string() })
  .refine((data) => {
    if (data.hasStreaming !== undefined) {
      data.features = {
        ...data.features,
        streaming: data.hasStreaming,
      };
    }
    if (data.hasFunctionCalling !== undefined) {
      data.features = {
        ...data.features,
        "widget-dashboard-select": data.hasFunctionCalling,
        "widget-dashboard-search": data.hasFunctionCalling,
        "widget-global-search": data.hasFunctionCalling,
      };
    }
    if (data.hasDocuments !== undefined) {
      data.features = {
        ...data.features,
        "file-upload": data.hasDocuments,
      };
    }
    return true;
  });

export type Copilot = z.infer<typeof copilotSchema>;
export type CopilotModel = { id: string; name: string };

export const MODEL_SETTING = "model";

export function modelSettingModels(
  copilot: Copilot | null | undefined,
): CopilotModel[] {
  if (!copilot || copilot.models?.length) return [];
  const setting = copilot.features?.[MODEL_SETTING];
  if (typeof setting !== "object" || setting.type !== "select") return [];
  return (setting.options ?? []).map((option) => ({
    id: option.value,
    name: option.label,
  }));
}

export function copilotModels(copilot: Copilot | null | undefined): CopilotModel[] {
  return copilot?.models?.length ? copilot.models : modelSettingModels(copilot);
}

export interface WidgetSignature {
  origin: string;
  widgetId: string;
  args: Record<string, unknown>;
}

const ParseAsTypes = ["html", "text"] as const;

type ParseAs = (typeof ParseAsTypes)[number];

interface DataFormatBase<P extends ParseAs = ParseAs> {
  data_type: "object" | (typeof AI_SUPPORTED_FILE_TYPES)[number];
  filename?: string;
  parse_as?: P;
}

type DataFormat = DataFormatBase;

export interface DataContent {
  content: string;
  data_format?: DataFormat;
}

export interface DataUrl {
  url: string;
  data_format?: DataFormat;
  expiration?: number;
}

export enum CopilotErrorType {
  NOT_FOUND = "not_found",
  GATEWAY_ERROR = "gateway_error",
  UNEXPECTED = "unexpected_error",
}

export interface CopilotFunctionCallError {
  error_type: CopilotErrorType;
  content: string;
}

export class CopilotError extends Error {
  error_type: string;
  content: string;

  constructor(error_type: CopilotErrorType, content: string) {
    super(content);
    this.name = "CopilotError";
    this.error_type = error_type;
    this.content = content;
  }
}

const SourceInfoSchema = z.object({
  type: z.string(),
  name: z.string(),
  origin: z.string().optional(),
  uuid: z.string().nullish().optional(),
  widget_id: z.string().nullish().optional(),
  description: z.string().nullish().optional(),
  metadata: z.record(z.string(), z.unknown()).nullish().optional(),
  citable: z.boolean().optional(),
});

const ExtraCitationSchema = z.object({
  id: z.string().optional(),
  source_info: SourceInfoSchema,
  details: z.custom<DetailT[]>().optional(),
  artifacts: z.custom<ArtifactT[]>().optional(),
  quote_bounding_boxes: z.custom<QuoteBoundingBox[][]>().optional(),
  signature: z.string().optional(),
});

const DataFormatSchema = z.union([
  z.object({
    data_type: z.enum(AI_SUPPORTED_FILE_TYPES),
    filename: z.string().optional(),
  }),
  z.object({
    data_type: z.literal("object").default("object"),
    parse_as: z.enum(ParseAsTypes).optional(),
  }),
]);

const CurrentCopilotDataItemSchema = z.union([
  z.object({
    error_type: z.string(),
    content: z.string(),
  }),
  z.object({
    content: z.preprocess((input) => {
      if (typeof input === "string") return input;

      return input && JSON.stringify(input);
    }, z.string()),
    data_format: DataFormatSchema,
    citable: z.boolean().optional(),
    extra_citations: z.array(ExtraCitationSchema).optional(),
  }),
  z.object({
    url: z.string(),
    data_format: DataFormatSchema,
    expiration: z.number().int().optional(),
  }),
]);

const InvalidDataItemError = {
  error_type: CopilotErrorType.UNEXPECTED,
  content: "Invalid data item format.",
};

export const CopilotDataItemSchema = z.preprocess(
  (data: z.output<typeof CurrentCopilotDataItemSchema>, ctx) => {
    if (typeof data !== "object" || data === null) {
      ctx.addIssue({
        code: "custom",
        message: "Data item cannot be null or undefined.",
        path: ["object"],
      });
      return InvalidDataItemError;
    }

    if ("file_reference" in data && !("url" in data)) {
      return {
        ...data,
        url: data.file_reference as string,
      };
    }
    return data;
  },
  CurrentCopilotDataItemSchema.transform(
    (data) => data as DataContent | DataUrl | CopilotError,
  ),
);
export const MultipleCopilotDataItemSchema = z.array(CopilotDataItemSchema);

export const CopilotDataSchema = z.object({
  items: z.array(CopilotDataItemSchema).transform((items) => {
    return items.map((item) => {
      if ("extra_citations" in item) {
        const { extra_citations, ...rest } = item;
        return rest;
      }
      return item;
    });
  }),
  extra_citations: z.array(ExtraCitationSchema).optional(),
});

const CopilotCommandResultSchema = z.looseObject({
  status: z.enum(["success", "error"]),
  message: z.string().optional(),
});

export type CopilotDataT = z.infer<typeof CopilotDataSchema>;

export type CopilotCommandResultT = z.infer<typeof CopilotCommandResultSchema>;

export type CopilotFile = {
  name: string;
  description: string;
  status: "pending" | "uploaded" | "failed";
  stored_file_uuid?: string;
  url?: string;
};

export interface CopilotContextItem {
  uuid: string;
  name: string;
  description: string;
  metadata?: Record<string, unknown>;
  data?: CopilotDataT;
}

interface WidgetParam {
  name: string;
  type: "date" | "text" | "number" | "boolean" | "endpoint";
  description: string;
  default_value: string | number | boolean | string[];
  current_value: string | number | boolean | string[];
  executed_value?: string | number | boolean | string[] | null;
  options?: string[];
  get_options?: boolean;
  options_params?: Record<string, string>[];
  multi_select?: boolean;
  split_param_on_citation?: boolean;
  language?: string;
}

export interface CopilotWidget {
  origin?: string;
  widget_id?: string;
  uuid?: string;
  name: string;
  description: string;
  widget_type?: string;
  source?: string;
  category?: string;
  sub_category?: string;
  columns?: string[];
  params: WidgetParam[];
  mcp_tool?: ActiveMcpLink;
  metadata?: Record<string, unknown> & {
    tabWidgets?: CopilotWidget[];
    innerTabId?: string;
    widgetCount?: number;
  };
}

export interface CopilotWidgets {
  primary: CopilotWidget[];
  secondary: CopilotWidget[];
  extra: CopilotWidget[];
}

export interface Mention {
  id: string;
  group: "dashboard" | "all" | "web" | "sec" | "tab";
  trigger: string;
  name: string;
  description: string;
  content?: CopilotWidget;
}

export interface HierarchicalMention extends Mention {
  _isChildWidget?: boolean;
  _parentTabId?: string;
}

export type ExternalCopilotHolder = {
  status?: "success" | "error";
  enabled?: boolean;
  uuid: string;
  url: string;
  headers?: Record<string, string>;
  headerNames?: string[];
  copilots?: Copilot[];
};

export type ArtifactWidgetLink = {
  widgetUuid: string;
  dashboardId: string;
  name: string;
  createdAt: string;
};

type BaseArtifact = {
  uuid: string;
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
  widgets?: ArtifactWidgetLink[];
};
type TextArtifact = BaseArtifact & { type: "text"; content: string };
type HtmlArtifact = BaseArtifact & { type: "html"; content: string };
type AppArtifactLayoutItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  state?: Record<string, unknown>;
  groups?: string[];
};

type AppArtifactGroup = {
  name: string;
  type: "param" | "endpointParam";
  paramName?: string;
  defaultValue: string;
  widgetIds: string[];
};

type AppArtifactDef = {
  name: string;
  description?: string;
  allowCustomization?: boolean;
  tabs: Record<string, { id: string; name: string; layout: AppArtifactLayoutItem[] }>;
  groups?: AppArtifactGroup[];
  prompts?: string[];
};

export type AppArtifactWidgetRef = {
  i: string;
  origin: string;
  widget_id: string;
  uuid?: string;
  name?: string;
};

export type AppArtifactT = BaseArtifact & {
  type: "app";
  app: AppArtifactDef;
  widget_refs: AppArtifactWidgetRef[];
};

export type PluginArtifactT = BaseArtifact & {
  type: "plugin";
  plugin: { id: string; widget: string };
  data: unknown;
  config?: Record<string, unknown>;
};

export type ArtifactT = TextArtifact | HtmlArtifact | AppArtifactT | PluginArtifactT;

export type ArtifactType<T extends ArtifactT["type"]> = Extract<ArtifactT, { type: T }>;

export type DetailT = Record<string, unknown> | null;

interface DatetimeState {
  timestamp: number;
  targetGroupId: string;
}

export interface SystemSSEContent {
  eventType: "INFO" | "WARNING" | "ERROR";
  message: string;
  hidden?: boolean;
  details?: string[] | DetailT[] | null;
  artifacts?: ArtifactT[] | null;
}

type SourceInfo = z.infer<typeof SourceInfoSchema>;
export interface QuoteBoundingBox {
  page: number;
  text: string;
  top: number;
  bottom: number;
  x0: number;
  x1: number;
}
export interface Citation {
  id: string;
  source_info: SourceInfo;
  details?: DetailT[] | null;
  artifacts?: ArtifactT[];
  signature: string;
  quote_bounding_boxes?: QuoteBoundingBox[][];
}

export interface MessageGroup {
  role: "human" | "ai" | "system" | "tool";
  groupTitle?: string;
  parentGroupId?: string;
  messages: Message[];
  senderId: string;
  isError?: boolean;
}

interface BaseMessage {
  copilotId: string;
  uuid?: string;
  timestamp: number;
  isError?: boolean;
  isFC?: boolean;
  isHidden?: boolean;
  usedPersonalOpenAiKey?: boolean;
}

export interface HumanMessage extends BaseMessage {
  role: "human";
  content: string;
  files?: CopilotFile[];
}

export interface AIMessage extends BaseMessage {
  role: "ai";
  content: string;
  citations?: Citation[];
  completionId?: string;
  showCitations?: boolean;
  voteStatus?: "thumbs_up" | "thumbs_down" | null;
  traceId?: string;
  isCancelled?: boolean;
  suggestions?: string[];
}

export interface SystemMessage extends BaseMessage {
  role: "system";
  content: SystemSSEContent;
  orchestrationModeEnabled?: boolean;
}

interface ToolMessageBase extends BaseMessage {
  role: "tool";
  data: CopilotDataT[] | CopilotCommandResultT[];
}

export type ToolMessage = ToolMessageBase & FunctionCallT;

export type Message = HumanMessage | AIMessage | SystemMessage | ToolMessage;

export type Chat<M = Message> = {
  uuid: string;
  createdAt: number;
  label: string;
  messages: M[];
  artifacts?: ArtifactT[];
  titleManuallyUpdated?: boolean;
  titleNeedsUpdate?: boolean;
  lastOpened?: number;
  lastInteraction?: number;
  agentIds?: string[];
};

type CopilotTextSuggestion = {
  question: string;
  matchCount: number;
  idsLength: number;
};

interface MetadataFormValues {
  name: string;
  description?: string;
  category?: string;
  subCategory?: string;
  source?: string;
}

export interface CreateWidgetMetadataDialogState {
  mode: "create" | "update";
  initialValues: MetadataFormValues;
  pendingParams?: Record<string, unknown>;
  widgetId?: string;
  widgetUuid?: string;
  dashboardId?: string;
}

interface CopilotState {
  copilotTextSuggestions: CopilotTextSuggestion[];
  setCopilotTextSuggestions: (suggestions: CopilotTextSuggestion[]) => void;
  actionHistory: string[];
  addAction: (action: string) => void;
  clearActionHistory: () => void;
  addArtifactToCurrentChat: (artifact: ArtifactT) => void;
  recordArtifactWidget: (
    chatUuid: string,
    artifactUuid: string,
    link: ArtifactWidgetLink,
  ) => void;
  getCurrentChatArtifact: (chatArtifactId: string) => ArtifactT | undefined;
  getCurrentChatArtifacts: () => ArtifactT[];
  getMessageByTimestamp: (timestamp: number) => HumanMessage | AIMessage | undefined;
  clearMessagesAfter: (messageTimestamp: number, newMessageContent: string) => void;
  removeUnreachableArtifacts: () => void;
  updateCopilotLabel: (chatId: number, label: string) => void;
  questionsHistory: string[];
  selectedCopilot: Copilot | null;
  setSelectedCopilot: (copilot: Copilot | null) => void;
  orchestrationModeEnabled: boolean;
  setOrchestrationModeEnabled: (enabled: boolean) => void;
  agentOrchestrationMap: Record<string, string[]>;
  clearAgentOrchestrationMap: () => void;
  toggleAgentOrchestration: (holderId: string, copilotId: string) => void;
  enableAgentOrchestration: (holderId: string, copilotId: string) => void;
  disableAgentOrchestration: (holderId: string, copilotId: string) => void;
  setCopilotById: (copilotId: string) => void;
  externalCopilotHolders: ExternalCopilotHolder[];
  setExternalCopilotHolders: (holders: ExternalCopilotHolder[]) => void;
  updateExternalCopilotHolders: (holders: ExternalCopilotHolder[]) => void;
  currentChat: number;
  setCurrentChat: (chatId: number) => void;
  loadChatData: (chatUuid: string) => Promise<void>;
  getCurrentChat: () => Chat;
  chats: Chat[];
  chatsStoredInCloud: Chat[] | null;
  updateChatsStoredInCloud: (chats: Chat[]) => void;
  getChatsData: () => Omit<Chat, "messages" | "artifacts">[];
  updateChats: (
    chats: Chat[] | undefined,
    options?: { customCopilots?: CustomCopilot[]; questionsHistory?: string[] },
  ) => void;
  resetChats: () => void;
  addChat: (chat: Chat) => void;
  removeChat: (chatId: number) => void;
  addMessage: (message: Message) => void;
  removeMessages: (timestamps: number[]) => void;
  resetContent: (copilotId?: string) => void;
  selectedModelByAgent: Record<string, string>;
  setSelectedModelForAgent: (agentId: string, modelId: string) => void;
  getSelectedModelForAgent: (agentId: string) => string | undefined;
  updateLastMessage: (update: Partial<AIMessage>) => void;
  updateAIMessage: (property: string, value: unknown, messageTimestamp: number) => void;
  updateLastMessageError: (isError?: boolean) => void;
  makeLastMessageFC: () => void;
  isTyping: boolean;
  setIsTyping: (typing: boolean) => void;
  toggleTyping: () => void;
  setTitleManuallyUpdated: (chatId: number, titleManuallyUpdated: boolean) => void;
  setTitleNeedsUpdate: (chatId: number, titleNeedsUpdate: boolean) => void;
  updateCopilotLabelAndSetTitleNeedsUpdate: (
    label: string,
    titleNeedsUpdate: boolean,
  ) => void;
  getUserPromptForAIMessage: (aiMessage: AIMessage) => string | undefined;
  getRecentConversationContext: (messageCount?: number) => Message[];
  getSelectedWidgetsMetadata: () => CopilotWidget[];
  getRelatedArtifacts: (maxCount?: number) => ArtifactT[];
  hoveredCitationWidgetId: string | null;
  setHoveredCitationWidgetId: (id: string | null) => void;
  updateCitationsOrigin: (previousOrigin: string, newOrigin: string) => void;
  hoveredTabId: string | null;
  setHoveredTabId: (id: string | null) => void;
  setHovered: (params?: { widgetUuid?: string | null; tabId?: string | null }) => void;
  showWelcome: boolean;
  setShowWelcome: (showWelcome: boolean) => void;
  isFullscreen: boolean;
  setIsFullscreen: (isFullscreen: boolean) => void;
  toggleFullscreen: () => void;
  lastPanelState: "open" | "fullscreen";
  setLastPanelState: (state: "open" | "fullscreen") => void;
  isButtonTriggered: boolean;
  setIsButtonTriggered: (isButtonTriggered: boolean) => void;
  isIntentionallyCollapsed: boolean;
  setIsIntentionallyCollapsed: (isIntentionallyCollapsed: boolean) => void;
  datetimeState: DatetimeState | null;
  showDatetime: (timestamp: number, targetGroupId: string) => void;
  hideDatetime: () => void;

  customFeatureStates: Record<string, boolean | string>;
  initializeCustomFeatures: (features: Copilot["features"]) => void;
  toggleCustomFeature: (key: string) => boolean;
  setCustomFeatureValue: (key: string, value: string) => void;

  createWidgetMetadataDialog: CreateWidgetMetadataDialogState | null;
  setCreateWidgetMetadataDialog: (
    state: CreateWidgetMetadataDialogState | null,
  ) => void;
  closeCreateWidgetMetadataDialog: () => void;
}

const aiCopilotDefaultCopilotFF = getConfig().copilot.defaultCopilot;

const currentDate = Date.now();
const DEFAULT_CHAT = {
  uuid: uuidv4(),
  createdAt: currentDate,
  label: "New chat",
  messages: [],
  titleManuallyUpdated: false,
  titleNeedsUpdate: true,
  lastOpened: currentDate,
  agentIds: ["default-copilot"],
} as Chat;

function getChatLastOpened(chats: Chat[], currentChat?: number | null) {
  const maxLastOpened = Math.max(...chats.map((c) => c.lastOpened || 0));
  return (
    chats.find((c) => c.createdAt === currentChat || c.lastOpened === maxLastOpened) ||
    chats[chats.length - 1]
  );
}

function withoutHeaders<T extends { headers?: unknown }>({ headers: _, ...rest }: T) {
  return rest;
}

function normalizeExternalCopilotHolder(
  holder: ExternalCopilotHolder,
  fallbackEnabled = true,
): ExternalCopilotHolder {
  return {
    ...holder,
    enabled: holder.enabled ?? fallbackEnabled,
  };
}

function removeChatScrollY(chatId: number) {
  try {
    const copilotScroll = JSON.parse(localStorage.getItem("copilotScrollY") || "{}");
    delete copilotScroll[chatId];
    localStorage.setItem("copilotScrollY", JSON.stringify(copilotScroll));
  } catch (_) {}
}

export function getReachableArtifacts(
  messages: Message[],
  artifacts: ArtifactT[] | undefined,
): ArtifactT[] {
  const aiMessages = messages?.filter((message) => message.role === "ai") ?? [];
  if (!artifacts?.length) return artifacts ?? [];

  const reachableArtifacts = artifacts?.filter((artifact) => {
    return aiMessages.some(
      (message) =>
        message.content?.includes(artifact?.uuid) ||
        (artifact?.name ? message.content?.includes(artifact?.name) : false),
    );
  });

  return reachableArtifacts ?? [];
}

function updateAgentIds(chat: Chat, selectedCopilot: Copilot | null, reset = false) {
  if (reset) {
    chat.agentIds = [selectedCopilot?.id || "default-copilot"];
    return chat;
  }
  if (!(chat && selectedCopilot?.id)) return chat;
  chat.agentIds = chat.agentIds || [];
  if (!chat.agentIds.includes(selectedCopilot?.id))
    chat.agentIds.push(selectedCopilot.id);

  return chat;
}

export const useCopilotStore = createWithEqualityFn<CopilotState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        updateCitationsOrigin: (previousOrigin: string, newOrigin: string) => {
          const { chats } = get();

          const updatedChats = chats.map((chat) => {
            const updatedMessages = chat.messages.map((message) => {
              if (!(message.role === "ai" && Array.isArray(message.citations)))
                return message;

              const updatedCitations = message.citations.map((citation) => {
                const sourceInfo = citation.source_info;
                if (sourceInfo?.origin !== previousOrigin) return citation;

                const widget_id = sourceInfo?.widget_id?.replace(
                  previousOrigin,
                  newOrigin,
                );
                return {
                  ...citation,
                  source_info: {
                    ...citation.source_info,
                    origin: newOrigin,
                    widget_id,
                  },
                };
              });
              return { ...message, citations: updatedCitations };
            });

            return { ...chat, messages: updatedMessages };
          });

          set({ chats: updatedChats });
        },
        copilotTextSuggestions: [],
        setCopilotTextSuggestions: (suggestions) =>
          set({ copilotTextSuggestions: suggestions }),
        actionHistory: [],
        addAction: (action) =>
          set((state) => ({
            actionHistory: [...state.actionHistory.slice(-4), action],
          })),
        clearActionHistory: () => set({ actionHistory: [] }),
        getCurrentChatArtifacts: () => {
          const { currentChat, chats } = get();
          const currentChatData = chats.find((c) => c.createdAt === currentChat);
          return currentChatData?.artifacts || [];
        },
        getCurrentChatArtifact: (chatArtifactId: string) => {
          const { currentChat, chats } = get();
          const currentChatData = chats.find((c) => c.createdAt === currentChat);
          return currentChatData?.artifacts?.find(
            (a) => a.name === chatArtifactId || a.uuid === chatArtifactId,
          );
        },
        addArtifactToCurrentChat: (artifact) => {
          const { currentChat, chats } = get();
          const currentChatData = chats.find((c) => c.createdAt === currentChat);
          artifact.timestamp = artifact.timestamp || Date.now();
          if (currentChatData) {
            currentChatData.artifacts = [
              ...(currentChatData.artifacts || []),
              artifact,
            ];
          }
        },
        recordArtifactWidget: (chatUuid, artifactUuid, link) => {
          set({
            chats: get().chats.map((chat) =>
              chat.uuid !== chatUuid ||
              !chat.artifacts?.some((artifact) => artifact.uuid === artifactUuid)
                ? chat
                : {
                    ...chat,
                    artifacts: chat.artifacts.map((artifact) =>
                      artifact.uuid === artifactUuid
                        ? {
                            ...artifact,
                            widgets: [
                              ...(artifact.widgets ?? []).filter(
                                (widget) => widget.widgetUuid !== link.widgetUuid,
                              ),
                              link,
                            ],
                          }
                        : artifact,
                    ),
                  },
            ),
          });
        },
        updateChats: (chats, options = {}) => {
          if (!chats) return;

          const { customCopilots, questionsHistory = get().questionsHistory } = options;

          if (customCopilots) {
            getExternalCopilotHolders(customCopilots, (externalCopilotHolders) =>
              get().setExternalCopilotHolders(externalCopilotHolders),
            );
          }

          const chatsCreatedAt = {} as Record<number, Chat[]>;

          for (const chat of chats) {
            if (chat?.createdAt < 10000000000) {
              chat.createdAt *= 1000;
            }

            const artifactMapping = (chat.artifacts || []).reduce(
              (acc, a) => {
                if (a.name !== undefined) acc[a.name] = a;
                acc[a.uuid] = a;

                return acc;
              },
              {} as Record<string, ArtifactT>,
            );

            const agentIds = chat?.agentIds || [];
            let lastInteraction = chat?.lastInteraction || 0;
            for (const message of chat?.messages || []) {
              if (!message.uuid) message.uuid = uuidv4();
              if (!agentIds.includes(message.copilotId))
                agentIds.push(message.copilotId);

              if (message.role === "ai") {
                if (typeof message.content === "string") {
                  for (const citation of message.citations || []) {
                    citation.id = citation.id || uuidv4();
                    const sourceInfo = citation.source_info;
                    const marker = `<citation className="${citation.id}"/>`;

                    if (
                      sourceInfo?.type === "artifact" &&
                      !artifactMapping?.[sourceInfo?.name]
                    ) {
                      message.content = message.content.replace(marker, "");
                    } else if (!message.content.includes(marker)) {
                      message.content += marker;
                    }
                  }
                }
              }

              lastInteraction = Math.max(lastInteraction || 0, message.timestamp);
            }

            chat.agentIds = agentIds;
            chat.lastInteraction = lastInteraction;
            const chatGroup = chatsCreatedAt[chat.createdAt];
            if (!chatGroup) {
              chatsCreatedAt[chat.createdAt] = [chat];
              continue;
            }

            chatsCreatedAt[chat.createdAt] = mergeDuplicateChats([...chatGroup, chat]);
          }

          const updatedChats = Object.values(chatsCreatedAt).flat();
          updatedChats.sort((a, b) => a.createdAt - b.createdAt);

          if (updatedChats.length > 0) {
            const latestChat = getChatLastOpened(updatedChats);
            set({
              chats: updatedChats,
              currentChat: latestChat.createdAt,
              chatsStoredInCloud: chats,
              questionsHistory,
            });
          }
        },
        resetChats: () =>
          set({ chats: [DEFAULT_CHAT], currentChat: DEFAULT_CHAT.createdAt }),
        getMessageByTimestamp: (timestamp: number) => {
          const { currentChat, chats } = get();
          const currentChatData = chats.find((c) => c.createdAt === currentChat);
          if (currentChatData) {
            return currentChatData.messages.find(
              (message) => message.timestamp === timestamp,
            ) as AIMessage | HumanMessage;
          }
          return undefined;
        },
        clearMessagesAfter: (messageTimestamp: number, newMessageContent: string) => {
          const { currentChat, chats, selectedCopilot } = get();
          const currentChatData = chats.find((c) => c.createdAt === currentChat);
          if (currentChatData) {
            const updatedMessages = currentChatData.messages.filter(
              (message) => message.timestamp <= messageTimestamp,
            );

            const lastMessage = updatedMessages.findLast(
              (message) => message.role === "human",
            ) as HumanMessage;
            lastMessage.content = newMessageContent;
            lastMessage.timestamp = Date.now();
            lastMessage.isError = false;

            const agentIds = Array.from(
              new Set<string>(updatedMessages.map((m) => m.copilotId)),
            );

            set({
              chats: get().chats.map((c) =>
                c.createdAt === currentChat
                  ? { ...c, messages: updatedMessages, agentIds }
                  : c,
              ),
            });
          }
        },
        removeUnreachableArtifacts: () => {
          const { currentChat, chats } = get();
          const currentChatData = chats.find((c) => c.createdAt === currentChat);
          if (currentChatData) {
            const reachableArtifacts = getReachableArtifacts(
              currentChatData.messages,
              currentChatData.artifacts || [],
            );

            set({
              chats: get().chats.map((c) =>
                c.createdAt === currentChat
                  ? { ...c, artifacts: reachableArtifacts }
                  : c,
              ),
            });
          }
        },
        updateCopilotLabel: (chatId, label) => {
          set({
            chats: get().chats.map((c) =>
              c.createdAt === chatId ? { ...c, label } : c,
            ),
          });
        },
        getCurrentChat: () => {
          const { chats, currentChat } = get();

          return getChatLastOpened(chats, currentChat) || DEFAULT_CHAT;
        },
        questionsHistory: [],
        isTyping: false,
        setIsTyping: (typing) => set({ isTyping: typing }),
        toggleTyping: () => set((state) => ({ isTyping: !state.isTyping })),
        selectedModelByAgent: {},
        currentChat: 0,
        setCurrentChat: (chatId) => {
          if (chatId !== get().currentChat) {
            get().clearActionHistory();
          }

          if (chatId === 0) {
            const latestChat = getChatLastOpened(get().chats, chatId);
            return get().loadChatData(latestChat?.uuid);
          }
          set({
            currentChat: chatId,
            chats: get().chats.map((c) =>
              c.createdAt === chatId ? { ...c, lastOpened: Date.now() } : c,
            ),
          });
        },
        loadChatData: async (chatUuid) => {
          const { chats } = get();
          const chatIndex = chats.findIndex((c) => c.uuid === chatUuid);
          if (chatIndex !== -1) {
            const updatedChats = [...chats];
            if (!updatedChats[chatIndex]?.messages) {
              const chat = await getCopilotChat(chatUuid);
              if (chat) {
                updatedChats[chatIndex] = chat;
                return get().updateChats(updatedChats);
              }
            }
            get().setCurrentChat(chats[chatIndex]?.createdAt || 0);
          }
        },
        chats: [],
        chatsStoredInCloud: null,
        updateChatsStoredInCloud: (chats) => set({ chatsStoredInCloud: chats }),
        addChat: (chat) => {
          get().clearActionHistory();
          set({ chats: [...get().chats, updateAgentIds(chat, get().selectedCopilot)] });
        },
        removeChat: (chatId) => {
          removeChatScrollY(chatId);
          set({ chats: get().chats.filter((c) => c.createdAt !== chatId) });
        },
        makeLastMessageFC: () => {
          const { currentChat, chats } = get();
          const messages =
            chats.find((c) => c.createdAt === currentChat)?.messages || [];
          if (messages.length > 0) {
            const updatedMessages = [...messages];
            updatedMessages[updatedMessages.length - 1].isFC = true;
            set({
              chats: chats.map((c) =>
                c.createdAt === currentChat ? { ...c, messages: updatedMessages } : c,
              ),
            });
          }
        },
        updateLastMessage: (update) => {
          const { currentChat, chats } = get();
          const messages =
            chats.find((c) => c.createdAt === currentChat)?.messages || [];
          if (messages.length > 0) {
            const updatedMessages = cloneDeep(messages);
            const lastMessage = updatedMessages[updatedMessages.length - 1];
            if (lastMessage.role === "ai") {
              Object.assign(lastMessage, update || {});

              set({
                chats: chats.map((c) =>
                  c.createdAt === currentChat ? { ...c, messages: updatedMessages } : c,
                ),
              });
            }
          }
        },
        updateAIMessage: (property, value, messageTimestamp) => {
          const { currentChat, chats } = get();
          const messages =
            chats.find((c) => c.createdAt === currentChat)?.messages || [];
          if (messages.length > 0) {
            const updatedMessages = cloneDeep(messages);
            const message = updatedMessages.find(
              (m) => m.timestamp === messageTimestamp,
            );
            if (message && message.role === "ai") {
              Object.assign(message, { [property]: value });
              set({
                chats: chats.map((c) =>
                  c.createdAt === currentChat ? { ...c, messages: updatedMessages } : c,
                ),
              });
            }
          }
        },
        updateLastMessageError: (isError) => {
          const { currentChat, chats } = get();
          const messages =
            chats.find((c) => c.createdAt === currentChat)?.messages || [];
          if (messages.length > 0) {
            const updatedMessages = cloneDeep(messages);
            updatedMessages[updatedMessages.length - 1].isError = isError;
            set({
              chats: chats.map((c) =>
                c.createdAt === currentChat ? { ...c, messages: updatedMessages } : c,
              ),
            });
          }
        },
        setSelectedModelForAgent: (agentId, modelId) =>
          set((state) => ({
            selectedModelByAgent: { ...state.selectedModelByAgent, [agentId]: modelId },
          })),
        getSelectedModelForAgent: (agentId) => get().selectedModelByAgent[agentId],
        selectedCopilot: aiCopilotDefaultCopilotFF ? getDefaultCopilot() : null,
        setSelectedCopilot: (copilot) => set({ selectedCopilot: copilot }),
        orchestrationModeEnabled: false,
        setOrchestrationModeEnabled: (enabled) =>
          set({ orchestrationModeEnabled: enabled }),
        agentOrchestrationMap: {},
        clearAgentOrchestrationMap: () => set({ agentOrchestrationMap: {} }),
        enableAgentOrchestration: (holderId, agentId) => {
          const { agentOrchestrationMap } = get();
          if (agentOrchestrationMap[holderId]?.includes(agentId)) return;
          set({
            agentOrchestrationMap: {
              ...agentOrchestrationMap,
              [holderId]: [...(agentOrchestrationMap[holderId] || []), agentId],
            },
          });
        },
        disableAgentOrchestration: (holderId, agentId) => {
          const { agentOrchestrationMap } = get();
          if (!agentOrchestrationMap[holderId]?.includes(agentId)) return;
          const newEnabledIds = (agentOrchestrationMap[holderId] || []).filter(
            (id) => id !== agentId,
          );
          set({
            agentOrchestrationMap: {
              ...agentOrchestrationMap,
              [holderId]: newEnabledIds,
            },
          });
        },
        toggleAgentOrchestration: (holderId, agentId) => {
          const { agentOrchestrationMap } = get();
          if (agentOrchestrationMap[holderId]?.includes(agentId)) {
            get().disableAgentOrchestration(holderId, agentId);
          } else {
            get().enableAgentOrchestration(holderId, agentId);
          }
        },
        setCopilotById: (copilotId) => {
          const { externalCopilotHolders, setSelectedCopilot } = get();
          if (copilotId === "default-copilot")
            return setSelectedCopilot(getDefaultCopilot());

          const copilot = externalCopilotHolders
            .filter((holder) => holder.enabled !== false)
            .flatMap((holder) => holder.copilots || [])
            .find((c) => c.id === copilotId || c.name === copilotId);

          if (copilot) return setSelectedCopilot(copilot);

          console.warn(`Copilot with ID "${copilotId}" not found.`);
        },
        externalCopilotHolders: [],
        setExternalCopilotHolders: (holders) => {
          const currentHolders = get().externalCopilotHolders;
          const normalizedHolders = holders.map((holder) => {
            const existingHolder = currentHolders.find((h) => h.uuid === holder.uuid);
            return normalizeExternalCopilotHolder(
              holder,
              existingHolder?.enabled ?? true,
            );
          });
          const uniqueCopilots = normalizedHolders.filter(
            (copilot, index) =>
              normalizedHolders.findIndex((c) => c.url === copilot.url) === index,
          );

          const selectedCopilot = get().selectedCopilot;
          const availableCopilots = uniqueCopilots
            .filter((holder) => holder.enabled !== false)
            .flatMap((holder) => holder.copilots || []);
          const selectionStillValid =
            selectedCopilot?.id === "default-copilot" ||
            availableCopilots.some((c) => c.id === selectedCopilot?.id);
          const nextSelectedCopilot = selectionStillValid
            ? selectedCopilot
            : (availableCopilots[0] ?? null);

          set({
            externalCopilotHolders: uniqueCopilots,
            selectedCopilot: nextSelectedCopilot,
          });
        },
        updateExternalCopilotHolders: (holders) => {
          if (!holders || holders?.length === 0) return;
          const externalCopilotHolders = cloneDeep(get().externalCopilotHolders);
          const selectedCopilot = get().selectedCopilot;

          const updatedHolders = holders.reduce((acc, holderToMerge) => {
            const existingHolder = acc.find((h) => h.uuid === holderToMerge.uuid);
            const holder = normalizeExternalCopilotHolder(
              holderToMerge,
              existingHolder?.enabled ?? true,
            );
            holder.copilots = holder.copilots || existingHolder?.copilots || [];

            if (existingHolder) {
              const selectedUpdate = holder.copilots.find(
                (copilot) => copilot.id === selectedCopilot?.id,
              );
              if (selectedUpdate && selectedCopilot)
                Object.assign(selectedCopilot, selectedUpdate);

              Object.assign(existingHolder, holder);
              return acc;
            }

            acc.push(holder);

            return acc;
          }, externalCopilotHolders);

          set({ externalCopilotHolders: updatedHolders, selectedCopilot });
        },
        messages: [],
        addMessage: (message) => {
          if (!message.uuid) message.uuid = uuidv4();

          set((s) => {
            const updatedChats = s.chats.map((chat) =>
              chat.createdAt === s.currentChat
                ? {
                    ...updateAgentIds(chat, s.selectedCopilot),
                    messages: [...chat.messages, message],
                    lastInteraction: message.timestamp,
                  }
                : chat,
            );

            const updates: Partial<CopilotState> = {};

            if (message.role === "human") {
              const questionIndex = s.questionsHistory.indexOf(message.content);
              if (questionIndex === -1) {
                updates.questionsHistory = [...s.questionsHistory, message.content];
              } else {
                const updatedHistory = cloneDeep(s.questionsHistory);
                updatedHistory.splice(questionIndex, 1);
                updatedHistory.push(message.content);
                updates.questionsHistory = updatedHistory;
              }
            }

            return {
              chats: updatedChats,
              ...updates,
            };
          });
        },
        removeMessages: (timestamps) => {
          set((state) => ({
            chats: state.chats.map((chat) => {
              if (chat.createdAt !== state.currentChat) return chat;
              const newMessages = chat.messages.filter(
                (message) => !timestamps.includes(message.timestamp),
              );

              const updatedArtifacts = getReachableArtifacts(
                newMessages,
                chat.artifacts || [],
              );

              return {
                ...chat,
                messages: newMessages,
                artifacts: updatedArtifacts,
              };
            }),
          }));
        },
        resetContent: (copilotId) => {
          removeChatScrollY(get().currentChat);
          get().clearActionHistory();
          if (copilotId) {
            const uuid = uuidv4();

            set((state) => ({
              chats: state.chats.map((chat) => {
                if (chat.createdAt !== state.currentChat) return chat;
                const messages = chat.messages.filter((m) => m.copilotId !== copilotId);
                const artifacts = getReachableArtifacts(messages, chat.artifacts ?? []);
                const agentIds = (chat.agentIds || []).filter((id) => id !== copilotId);
                if (agentIds.length === 0)
                  agentIds.push(copilotId || "default-copilot");

                return { ...chat, uuid, id: uuid, messages, artifacts, agentIds };
              }),
            }));
          } else {
            set((state) => ({
              chats: state.chats.map((chat) =>
                chat.createdAt === state.currentChat
                  ? {
                      ...updateAgentIds(chat, state.selectedCopilot, true),
                      messages: [],
                    }
                  : chat,
              ),
            }));
          }
        },
        setTitleManuallyUpdated: (chatId, titleManuallyUpdated) => {
          set({
            chats: get().chats.map((c) =>
              c.createdAt === chatId ? { ...c, titleManuallyUpdated } : c,
            ),
          });
        },
        setTitleNeedsUpdate: (chatId, titleNeedsUpdate) => {
          set({
            chats: get().chats.map((c) =>
              c.createdAt === chatId ? { ...c, titleNeedsUpdate } : c,
            ),
          });
        },
        updateCopilotLabelAndSetTitleNeedsUpdate: (label, titleNeedsUpdate) => {
          const { currentChat } = get();
          set({
            chats: get().chats.map((c) =>
              c.createdAt === currentChat ? { ...c, label, titleNeedsUpdate } : c,
            ),
          });
        },
        getUserPromptForAIMessage: (aiMessage: AIMessage) => {
          const currentChat = get().getCurrentChat();
          const messageIndex = currentChat.messages.findIndex(
            (msg) => msg.role === "ai" && msg.timestamp === aiMessage.timestamp,
          );

          if (messageIndex === -1) return undefined;

          for (let i = messageIndex - 1; i >= 0; i--) {
            const msg = currentChat.messages[i];
            if (msg.role === "human") {
              return msg.content;
            }
          }

          return undefined;
        },
        getRecentConversationContext: (messageCount = 5) => {
          const currentChat = get().getCurrentChat();
          return currentChat.messages.slice(-messageCount);
        },
        getSelectedWidgetsMetadata: () => {
          const { externalCopilotHolders } = get();
          return [];
        },
        getRelatedArtifacts: (maxCount = 3) => {
          const { currentChat, chats } = get();
          const currentChatData = chats.find((c) => c.createdAt === currentChat);
          return (currentChatData?.artifacts || []).slice(-maxCount);
        },
        hoveredCitationWidgetId: null,
        setHoveredCitationWidgetId: (id) => set({ hoveredCitationWidgetId: id }),
        hoveredTabId: null,
        setHoveredTabId: (id) => set({ hoveredTabId: id }),
        setHovered: (params) => {
          const { widgetUuid = null, tabId = null } = params || {};
          set({
            hoveredCitationWidgetId: widgetUuid,
            hoveredTabId: tabId,
          });
        },
        showWelcome: false,
        setShowWelcome: (showWelcome) => set({ showWelcome }),
        isFullscreen: false,
        setIsFullscreen: (isFullscreen) => set({ isFullscreen }),
        toggleFullscreen: () => set((state) => ({ isFullscreen: !state.isFullscreen })),
        isButtonTriggered: false,
        setIsButtonTriggered: (isButtonTriggered: boolean) =>
          set({ isButtonTriggered }),
        isIntentionallyCollapsed: false,
        setIsIntentionallyCollapsed: (isIntentionallyCollapsed: boolean) =>
          set({ isIntentionallyCollapsed }),
        getChatsData: () => {
          return get().chats.map((chat) => {
            const { messages, artifacts, ...rest } = chat;
            return rest;
          });
        },
        lastPanelState: "open",
        setLastPanelState: (lastPanelState: "open" | "fullscreen") =>
          set({ lastPanelState }),
        datetimeState: null,
        showDatetime: (timestamp, targetGroupId) =>
          set({ datetimeState: { timestamp, targetGroupId } }),
        hideDatetime: () => set({ datetimeState: null }),
        customFeatureStates: {},
        initializeCustomFeatures: (features) => {
          if (!features) return;
          set((state) => {
            const current = state.customFeatureStates || {};
            const updated = { ...current } as Record<string, boolean | string>;
            for (const [key, val] of Object.entries(features)) {
              if (val && typeof val === "object") {
                if (updated[key] === undefined) {
                  const featureType = val.type || "toggle";
                  if (featureType === "text") {
                    updated[key] = typeof val.default === "string" ? val.default : "";
                  } else if (featureType === "select") {
                    updated[key] =
                      typeof val.default === "string"
                        ? val.default
                        : (val.options?.[0]?.value ?? "");
                  } else {
                    updated[key] = Boolean(val.default);
                  }
                }
              }
            }
            return { ...state, customFeatureStates: updated };
          });
        },
        toggleCustomFeature: (key) => {
          let newVal = false;
          set((state) => {
            const current = state.customFeatureStates || {};
            const next = !current[key];
            newVal = next;
            return { ...state, customFeatureStates: { ...current, [key]: next } };
          });
          return newVal;
        },
        setCustomFeatureValue: (key, value) => {
          console.log("[custom-features] set", key, value);
          set((state) => {
            const current = state.customFeatureStates || {};
            return { ...state, customFeatureStates: { ...current, [key]: value } };
          });
        },

        createWidgetMetadataDialog: null,
        setCreateWidgetMetadataDialog: (dialogState) =>
          set({ createWidgetMetadataDialog: dialogState }),
        closeCreateWidgetMetadataDialog: () =>
          set({ createWidgetMetadataDialog: null }),
      }),
      {
        name: "copilot",
        partialize: (state) => {
          if (state?.selectedCopilot?.id === "default-copilot") {
            state.selectedCopilot = getDefaultCopilot();
          }

          return {
            externalCopilotHolders: state.externalCopilotHolders.map(withoutHeaders),
            selectedCopilot: state.selectedCopilot,
            lastPanelState: state.lastPanelState,
            isFullscreen: state.isFullscreen,
            isIntentionallyCollapsed: state.isIntentionallyCollapsed,
            isButtonTriggered: state.isButtonTriggered,
            customFeatureStates: state.customFeatureStates,
            selectedModelByAgent: state.selectedModelByAgent,
            agentOrchestrationMap: state.agentOrchestrationMap,
          };
        },
        onRehydrateStorage: () => (state) => {
          if (state?.selectedCopilot) {
            const result = copilotSchema.safeParse(state.selectedCopilot);
            if (result.success) {
              state?.setSelectedCopilot(result.data);
            }
          }
          if (
            state?.externalCopilotHolders &&
            state.externalCopilotHolders.length > 0
          ) {
            const validatedHolders = state.externalCopilotHolders.map((holder) => ({
              ...holder,
              copilots: (holder.copilots ?? []).map((copilot) => {
                const result = copilotSchema.safeParse(copilot);
                return result.success ? result.data : copilot;
              }),
            }));

            for (const [holderId, agentIds] of Object.entries(
              state.agentOrchestrationMap || {},
            )) {
              const holder = validatedHolders.find((h) => h.uuid === holderId);
              if (holder) {
                const validAgentIds = agentIds.filter((id) =>
                  holder.copilots.some((c) => c.id === id),
                );
                state.agentOrchestrationMap[holderId] = validAgentIds;
              } else {
                delete state.agentOrchestrationMap[holderId];
              }
            }
            state?.setExternalCopilotHolders(validatedHolders);
          }
        },
      },
    ),
  ),
  shallow,
);

setAgentHolders(() => useCopilotStore.getState().externalCopilotHolders);

export function useShallowCopilotStore<T>(selector: Selector<CopilotState, T>): T {
  return useCopilotStore(useShallow(selector), (prev, next) => isEqual(prev, next));
}

export async function refreshExternalCopilotHolders() {
  await getExternalCopilotHolders(undefined, (holders) =>
    useCopilotStore.getState().setExternalCopilotHolders(holders),
  );
}
