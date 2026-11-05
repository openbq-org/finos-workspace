import DOMPurify from "dompurify";
import { useCallback, useMemo, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import { createMetaDataWidget } from "~/api/auth.api";
import { getConfig } from "~/lib/runtimeConfig";
import { fetchAgent } from "~/lib/state/agentToken";
import { useShallowAppStore } from "~/lib/state/app";
import { useCopilotStore, useShallowCopilotStore } from "~/lib/state/copilot";
import { useShallowCopilotDataStore } from "~/lib/state/copilotData";
import { useShallowThemeStore } from "~/lib/state/theme";
import { generateRandomName } from "~/lib/utils";
import { HTML_SANITIZE_CONFIG } from "~/lib/utils/sanitize";
import { scrollToAndHighlightWidget } from "~/lib/utils/widgetHighlight";
import { buildPluginArtifactWidget, resolvePluginWidget } from "~/plugins/registry";
import type { WidgetJsonT, WidgetT } from "../../types";
import {
  createConversationContextPayload,
  getFallbackName,
  removeCitationsFromText,
} from "./createWidgetUtils";

const aiCopilotAiEnhancementsFF =
  getConfig().copilot.enabled && getConfig().copilot.aiEnhancements;

export type CreateWidgetParams = {
  widgetType: "text" | "html" | "plugin";
  content: string;
  pluginArtifact?: {
    plugin: { id: string; widget: string };
    data: unknown;
    config?: Record<string, unknown>;
  };
  metadata?: {
    uuid?: string;
    name?: string;
    description?: string;
    [key: string]: unknown;
  } | null;
  artifact?: { uuid: string; name: string; chatUuid: string };
};

async function handleCreateMetaDataWidget(widget: WidgetJsonT | WidgetT) {
  const widgetId = await createMetaDataWidget(widget);
  if (widgetId) widget.widgetId = widgetId;
  widget.connectionType = "widgetMetadata";
  return widget;
}

export function useCreateWidgetFromArtifact() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const abortControllerRef = useRef<AbortController | null>(null);

  const { addWidget, addTab } = useShallowAppStore((s) => ({
    addWidget: s.addWidget,
    addTab: s.addTab,
  }));

  const aiEnhancementsEnabled = useShallowThemeStore(
    (state) => state.aiEnhancements && aiCopilotAiEnhancementsFF,
  );

  const {
    getRecentConversationContext,
    getRelatedArtifacts,
    getCurrentChat,
    setCreateWidgetMetadataDialog,
  } = useShallowCopilotStore((s) => ({
    getRecentConversationContext: s.getRecentConversationContext,
    getRelatedArtifacts: s.getRelatedArtifacts,
    getCurrentChat: s.getCurrentChat,
    setCreateWidgetMetadataDialog: s.setCreateWidgetMetadataDialog,
  }));

  const { selectedWidgets } = useShallowCopilotDataStore((s) => ({
    selectedWidgets: s.copilotWidgets.selectedWidgets,
  }));

  const lastInnerTab = useShallowAppStore((state) =>
    id ? state.getLastInnerTab(id) : undefined,
  );
  const innerTab = useMemo(
    () => searchParams.get("tab") || lastInnerTab || "",
    [lastInnerTab, searchParams.get("tab")],
  );

  const getConversationContext = useCallback(() => {
    const currentChat = getCurrentChat();
    const recentMessages = getRecentConversationContext(5);
    const relatedArtifacts = getRelatedArtifacts(3);

    const recentContent = recentMessages
      .slice()
      .reverse()
      .find((msg) => msg.role === "human")?.content;

    const chatContent = currentChat.messages
      .slice()
      .reverse()
      .find((msg) => msg.role === "human")?.content;

    const userPrompt = recentContent || chatContent || "";

    return createConversationContextPayload(
      userPrompt,
      recentMessages,
      selectedWidgets,
      relatedArtifacts,
    );
  }, [
    getCurrentChat,
    getRecentConversationContext,
    getRelatedArtifacts,
    selectedWidgets,
  ]);

  const fetchWidgetInfo = useCallback(
    async (params: CreateWidgetParams, signal?: AbortSignal) => {
      const { widgetType, content, metadata } = params;
      const { uuid: _, name, description, ...rest } = metadata ?? {};

      const conversationContext = getConversationContext();

      const requestPayload = {
        widget_generation_request: {
          name: name,
          description: description,
          widget_data: content,
          metadata: rest ?? undefined,
          conversation_context: conversationContext,
        },
      };

      const response = await fetchAgent(
        `${getConfig().urls.ai}/v1/generate/widget_info`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
          signal,
        },
      );

      if (!response.ok) {
        throw new Error(`API call failed with status ${response.status}`);
      }

      return await response.json();
    },
    [getConversationContext],
  );

  const widgetCreation = useCallback(
    async (widget: WidgetJsonT | WidgetT, { saveMetadata = true } = {}) => {
      const newWidget = saveMetadata
        ? await handleCreateMetaDataWidget(widget)
        : widget;
      if (id) {
        const widgetUuid = await addWidget(id, newWidget);
        return { widgetUuid, widgetId: newWidget.widgetId, dashboardId: id };
      }

      const tabId = uuidv4();
      addTab({
        index: tabId,
        data: {
          name: generateRandomName(),
          type: "custom",
          widgets: [newWidget],
        },
      });
      setTimeout(() => navigate(`/app/${tabId}`));

      return {
        widgetUuid: newWidget.id,
        widgetId: newWidget.widgetId,
        dashboardId: tabId,
      };
    },
    [addWidget, addTab, id, navigate],
  );

  const createWidgetFromParams = useCallback(
    async (
      params: CreateWidgetParams,
      widgetInfo: { name: string; description: string },
    ): Promise<{ widgetUuid?: string; widgetId?: string } | null> => {
      const { widgetType, content, artifact } = params;
      const { name: widgetName, description: widgetDescription } = widgetInfo;
      const createdAt = new Date().toISOString();
      const fromArtifact = artifact && {
        artifactUuid: artifact.uuid,
        name: artifact.name,
        chatUuid: artifact.chatUuid,
      };

      const widgetUuid = uuidv4();
      const widget = {
        id: widgetUuid,
        name: widgetName,
        description: widgetDescription,
        innerTab,
        gridData: { w: 40, h: 12 },
        category: "Others",
        subCategory: "",
        source: "",
        external: false,
      } as WidgetJsonT;

      let built: WidgetJsonT | WidgetT;
      let saveMetadata = false;
      if (widgetType === "text") {
        const contentStr = typeof content === "string" ? content : "";
        widget.widgetId = "markdown";
        widget.type = "custom";
        widget.storage = {
          text: removeCitationsFromText(contentStr),
          createdAt,
          ...(fromArtifact ? { fromArtifact } : {}),
        };
        built = widget;
      } else if (widgetType === "html") {
        const contentStr = typeof content === "string" ? content : "";
        widget.widgetId = `html-${widgetUuid}`;
        widget.storage = {
          html: DOMPurify.sanitize(contentStr, {
            ...HTML_SANITIZE_CONFIG,
            WHOLE_DOCUMENT: true,
          }),
          createdAt,
          ...(fromArtifact ? { fromArtifact } : {}),
        };
        built = widget;
        saveMetadata = true;
      } else if (widgetType === "plugin" && params.pluginArtifact) {
        const { plugin, data, config } = params.pluginArtifact;
        const found = resolvePluginWidget(plugin);
        if (!found) throw new Error("This plugin component is not available to you");
        built = buildPluginArtifactWidget(found, data, {
          id: widgetUuid,
          name: widgetName,
          description: widgetDescription,
          innerTab,
          config,
          fromArtifact,
        });
      } else {
        throw new Error("Invalid widget type");
      }

      const created = await widgetCreation(built, { saveMetadata });
      if (artifact?.chatUuid && created?.widgetUuid)
        useCopilotStore
          .getState()
          .recordArtifactWidget(artifact.chatUuid, artifact.uuid, {
            widgetUuid: created.widgetUuid,
            dashboardId: created.dashboardId,
            name: widgetName,
            createdAt,
          });
      return created;
    },
    [innerTab, widgetCreation],
  );

  const createWidget = useCallback(
    async (params: CreateWidgetParams) => {
      const { widgetType, metadata } = params;
      const fallbackName = getFallbackName(widgetType);
      const existingName =
        typeof metadata?.name === "string" ? metadata.name : undefined;
      const existingDescription =
        typeof metadata?.description === "string" ? metadata.description : undefined;

      abortControllerRef.current = new AbortController();
      const toastId = toast.loading(`Creating ${widgetType} widget...`, {
        style: { pointerEvents: "auto" },
        cancel: {
          label: "Edit metadata",
          onClick: () => {
            abortControllerRef.current?.abort();
            toast.dismiss(toastId);
            setCreateWidgetMetadataDialog({
              mode: "create",
              initialValues: {
                name: existingName || "",
                description: existingDescription || "",
              },
              pendingParams: params as unknown as Record<string, unknown>,
            });
          },
        },
      });

      try {
        let widgetName: string = existingName || fallbackName;
        let widgetDescription: string = existingDescription || fallbackName;

        if (aiEnhancementsEnabled && widgetType !== "plugin") {
          try {
            const aiInfo = await fetchWidgetInfo(
              params,
              abortControllerRef.current.signal,
            );
            if (aiInfo?.title) widgetName = aiInfo.title;
            if (aiInfo?.description) widgetDescription = aiInfo.description;
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              return;
            }
            console.warn("Failed to fetch AI widget info, using fallback:", error);
          }
        }

        const result = await createWidgetFromParams(params, {
          name: widgetName,
          description: widgetDescription,
        });

        const copilotStore = useCopilotStore.getState();
        const isFullscreen = copilotStore.isFullscreen;

        const widgetUuid = result?.widgetUuid;
        const widgetId = result?.widgetId;

        toast.success(widgetName, {
          id: toastId,
          description:
            widgetDescription && widgetDescription !== widgetName ? (
              <div className="mb-2">{widgetDescription}</div>
            ) : undefined,
          style: { pointerEvents: "auto" },
          ...(widgetType === "html" && {
            cancel: {
              label: "Edit metadata",
              onClick: () => {
                if (!(widgetUuid && widgetId)) return;
                setCreateWidgetMetadataDialog({
                  mode: "update",
                  initialValues: {
                    name: widgetName,
                    description: widgetDescription,
                  },
                  widgetId,
                  widgetUuid,
                  dashboardId: id,
                });
              },
            },
          }),
          ...(isFullscreen &&
            widgetUuid && {
              action: {
                label: "Show Widget",
                onClick: async () => {
                  const needsLayoutWait = copilotStore.isFullscreen;
                  if (needsLayoutWait) {
                    copilotStore.toggleFullscreen();
                  }
                  await scrollToAndHighlightWidget(widgetUuid, {
                    waitForLayout: needsLayoutWait,
                  });
                },
              },
            }),
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        const errorMessage = err instanceof Error ? err.message : "An error occurred";
        toast.error("Failed to create widget", {
          id: toastId,
          description: errorMessage,
        });
      }
    },
    [
      aiEnhancementsEnabled,
      fetchWidgetInfo,
      createWidgetFromParams,
      setCreateWidgetMetadataDialog,
      id,
    ],
  );

  const createWidgetWithMetadata = useCallback(
    async (
      params: CreateWidgetParams,
      metadata: { name: string; description: string },
    ) => {
      const toastId = toast.loading("Creating widget...");
      try {
        const result = await createWidgetFromParams(params, metadata);
        const widgetUuid = result?.widgetUuid;
        const widgetId = result?.widgetId;

        toast.success(`Created: ${metadata.name}`, {
          id: toastId,
          description: metadata.description ? (
            <div className="mb-2">{metadata.description}</div>
          ) : undefined,
          style: { pointerEvents: "auto" },
          ...(params.widgetType === "html" && {
            cancel: {
              label: "Edit metadata",
              onClick: () => {
                if (!(widgetUuid && widgetId)) return;
                setCreateWidgetMetadataDialog({
                  mode: "update",
                  initialValues: {
                    name: metadata.name,
                    description: metadata.description,
                  },
                  widgetId,
                  widgetUuid,
                  dashboardId: id,
                });
              },
            },
          }),
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "An error occurred";
        toast.error("Failed to create widget", {
          id: toastId,
          description: errorMessage,
        });
        throw error;
      }
    },
    [createWidgetFromParams, id, setCreateWidgetMetadataDialog],
  );

  return { createWidget, createWidgetWithMetadata };
}
