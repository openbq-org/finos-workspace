import DOMPurify from "dompurify";
import Markdown from "markdown-to-jsx";
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type FC,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "~/components/ds/atoms/Button";
import { BaseDialog } from "~/components/ds/dialogs/BaseDialog";
import { DialogTitle } from "~/components/ds/dialogs/Dialog";
import {
  ARTIFACT_SANDBOX_ATTRIBUTES,
  ARTIFACT_SANDBOX_ATTRIBUTES_NO_SCRIPTS,
} from "~/lib/constants";
import { getConfig } from "~/lib/runtimeConfig";
import { useShallowAppStore } from "~/lib/state/app";
import {
  type BackendTemplate,
  useShallowBackendConnectorStore,
} from "~/lib/state/backendConnector";
import {
  type ArtifactT,
  type ArtifactType,
  type ArtifactWidgetLink,
  useCopilotStore,
  useShallowCopilotStore,
} from "~/lib/state/copilot";
import { createCustomTemplateTab } from "~/lib/utils/createTemplates";
import { HTML_SANITIZE_CONFIG } from "~/lib/utils/sanitize";
import { scrollToAndHighlightWidget } from "~/lib/utils/widgetHighlight";
import { PluginArtifactFrame } from "~/plugins/PluginArtifactFrame";
import { ConfirmDialog } from "../ds/dialogs/ConfirmDialog";
import { cn } from "../ds/utils";
import Icon from "../Icon";
import Tooltip from "../Tooltip";
import { buildAppArtifactSource, buildWidgetSourceResolver } from "./appArtifactUtils";
import {
  ARTIFACT_BASE_STYLE,
  artifactContentSecurityPolicy,
  artifactNonce,
  withArtifactPolicy,
} from "./artifactPolicy";
import type { CreateWidgetParams } from "./hooks/useCreateWidgetFromArtifact";
import { dispatchCreate } from "./hooks/utils";
import {
  CodeComponent,
  hasObjectChild,
  inertImageOverride,
  PreCodeComponent,
  renderRule,
} from "./MarkdownOverrides";

export type ArtifactProps<
  T extends ArtifactT["type"] = ArtifactT["type"],
  R extends ArtifactType<T> = ArtifactType<T>,
> = {
  artifact: R;
  inAiMessage?: boolean;
};

type ArtifactActionsProps = {
  onCopy: () => void;
  createWidgetParams: CreateWidgetParams;
  copyTooltip: string;
  createTooltip: string;
  copyClassName?: string;
  copyTestId?: string;
  createTestId?: string;
  onFullscreen?: () => void;
};

function ArtifactWidgetLinks({ artifactUuid }: { artifactUuid?: string }) {
  const links = useShallowCopilotStore((state) =>
    artifactUuid
      ? state.chats
          ?.find((chat) => chat.createdAt === state.currentChat)
          ?.artifacts?.find((artifact) => artifact.uuid === artifactUuid)?.widgets
      : undefined,
  );
  return links?.length ? <ArtifactWidgetLinkList links={links} /> : null;
}

function ArtifactWidgetLinkList({ links }: { links: ArtifactWidgetLink[] }) {
  const navigate = useNavigate();
  const items = useShallowAppStore((state) => state.items);
  return (
    <div
      className="mr-auto flex min-w-0 flex-wrap items-center gap-x-1.5 body-xs-regular text-ds-text-caption"
      data-testid="artifact-widget-links"
    >
      <span>Added to</span>
      {links.map((link) => {
        const dashboard = items?.[link.dashboardId];
        const widget = dashboard?.data?.widgets?.find((w) => w.id === link.widgetUuid);
        const label = `${widget?.name ?? link.name}${dashboard?.data?.name ? ` · ${dashboard.data.name}` : ""}`;
        return (
          <button
            key={link.widgetUuid}
            type="button"
            className="ws-hyper-link truncate disabled:no-underline disabled:opacity-60"
            disabled={!widget}
            onClick={async () => {
              const copilot = useCopilotStore.getState();
              if (copilot.isFullscreen) copilot.toggleFullscreen();
              navigate(
                `/app/${link.dashboardId}${widget?.innerTab ? `?tab=${widget.innerTab}` : ""}`,
              );
              await scrollToAndHighlightWidget(link.widgetUuid, {
                waitForLayout: true,
              });
            }}
          >
            {label}
            {widget ? "" : " (removed)"}
          </button>
        );
      })}
    </div>
  );
}

const ArtifactActions: FC<ArtifactActionsProps> = ({
  onCopy,
  createWidgetParams,
  copyTooltip,
  createTooltip,
  copyClassName = "",
  copyTestId = "copy-artifact-button",
  createTestId = "create-widget-from-artifact-button",
  onFullscreen,
}) => {
  const artifactUuid = createWidgetParams.metadata?.uuid;
  const create = () =>
    dispatchCreate(
      artifactUuid
        ? {
            ...createWidgetParams,
            artifact: {
              uuid: artifactUuid,
              name: createWidgetParams.metadata?.name ?? "",
              chatUuid: useCopilotStore.getState().getCurrentChat()?.uuid ?? "",
            },
          }
        : createWidgetParams,
    );
  return (
    <div className="flex items-center justify-end gap-1 pt-1.5 pb-0.5 pr-0.5">
      <ArtifactWidgetLinks artifactUuid={artifactUuid} />
      {onFullscreen && (
        <Tooltip message="View report full screen">
          <button
            data-testid="view-fullscreen-html-button"
            onClick={onFullscreen}
            className="ws-small-navbar-btn"
          >
            <Icon id="maximize-01" className="size-3.5" />
          </button>
        </Tooltip>
      )}
      <Tooltip message={copyTooltip}>
        <button
          data-testid={copyTestId}
          onClick={onCopy}
          className={cn(
            "ws-small-navbar-btn flex items-center justify-center",
            copyClassName,
          )}
        >
          <Icon id="clipboard-icon" className="size-3.5" />
        </button>
      </Tooltip>
      <Tooltip message={createTooltip}>
        <button
          data-testid={createTestId}
          onClick={create}
          className="ws-small-navbar-btn flex items-center justify-center"
        >
          <Icon id="solar-widget-add-outline" className="size-3.5" />
        </button>
      </Tooltip>
    </div>
  );
};

const maxHeight = 600;

const HTMLArtifact = memo<ArtifactProps<"html">>(({ artifact, inAiMessage }) => {
  const allowJsExecution = getConfig().data.allowHtmlJsExecution;
  const isHighlighted = useShallowCopilotStore(
    (s) => s.hoveredCitationWidgetId === artifact.name,
  );

  const [iframeHeight, setIframeHeight] = useState<number | null>(null);
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const sanitizedContent = useMemo(() => {
    const clean = DOMPurify.sanitize(artifact.content, {
      ...HTML_SANITIZE_CONFIG,
      WHOLE_DOCUMENT: true,
    });

    const injectedStyle = ARTIFACT_BASE_STYLE;

    const nonce = allowJsExecution ? artifactNonce() : undefined;
    const injectedScript = nonce
      ? `<script nonce="${nonce}">
(function(){
  function postHeight(){
    var h=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);
    parent.postMessage({type:"artifactHeight",height:h},"*");
  }
  postHeight();
  if(typeof ResizeObserver!=="undefined"){
    new ResizeObserver(postHeight).observe(document.body);
  }
})();
</script>`
      : "";

    return withArtifactPolicy(
      clean,
      artifactContentSecurityPolicy(nonce),
      `${injectedStyle}${injectedScript}`,
    );
  }, [artifact.content, allowJsExecution]);

  const handleIframeLoad = useCallback(() => {
    if (allowJsExecution) return;

    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!doc?.body) return;

    const measureHeight = () => {
      const body = iframe?.contentDocument?.body;
      if (body) {
        const docHeight = iframe?.contentDocument?.documentElement?.scrollHeight ?? 0;
        const bodyHeight = body.scrollHeight;
        const newHeight = Math.max(docHeight, bodyHeight);
        setIframeHeight((prev) => (prev === newHeight ? prev : newHeight));
      }
    };

    requestAnimationFrame(() => {
      measureHeight();

      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = new ResizeObserver(() => {
        requestAnimationFrame(measureHeight);
      });
      resizeObserverRef.current.observe(doc.body);
    });
  }, [allowJsExecution]);

  useEffect(() => {
    if (!allowJsExecution) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === "artifactHeight") {
        const h = Number(event.data.height);
        if (Number.isFinite(h) && h > 0) {
          setIframeHeight((prev) => (prev === h ? prev : h));
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [allowJsExecution]);

  useEffect(() => () => resizeObserverRef.current?.disconnect(), []);

  const iframeStyle = useMemo<CSSProperties>(
    () =>
      iframeHeight !== null
        ? { height: Math.min(iframeHeight, maxHeight) }
        : { minHeight: 50 },
    [iframeHeight],
  );

  return (
    <div
      id={artifact.name}
      className={cn("relative mx-1", {
        "outline-2 outline-brand-main": isHighlighted,
        "dark:bg-dark-400 rounded p-2 bg-light-100": inAiMessage,
        "dark:bg-dark-800 bg-light-50 rounded p-2": !inAiMessage,
      })}
    >
      <iframe
        ref={iframeRef}
        srcDoc={sanitizedContent}
        className="w-full border-0"
        style={iframeStyle}
        sandbox={
          allowJsExecution
            ? ARTIFACT_SANDBOX_ATTRIBUTES
            : ARTIFACT_SANDBOX_ATTRIBUTES_NO_SCRIPTS
        }
        title={artifact.name}
        onLoad={handleIframeLoad}
      />
      <ArtifactActions
        copyTooltip="Copy HTML to clipboard"
        createTooltip="Create widget from HTML"
        copyTestId="copy-html-button"
        createTestId="create-widget-from-html-button"
        onFullscreen={() => setIsFullscreenOpen(true)}
        onCopy={() => {
          navigator.clipboard
            .writeText(artifact.content)
            .then(() => toast.success("HTML copied to clipboard"))
            .catch((err) =>
              toast.error("Failed to copy HTML to clipboard", {
                description: err.message,
              }),
            );
        }}
        createWidgetParams={{
          widgetType: "html",
          content: artifact.content,
          metadata: {
            uuid: artifact.uuid,
            name: artifact.name,
            description: artifact.description,
          },
        }}
      />
      <BaseDialog
        open={isFullscreenOpen}
        onClose={() => setIsFullscreenOpen(false)}
        className="!w-[92vw] !max-w-[92vw] !h-[90vh] !max-h-[90vh] !p-0 !gap-0 flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-general-border-secondary shrink-0">
          <DialogTitle>{artifact.name}</DialogTitle>
        </div>
        <iframe
          srcDoc={sanitizedContent}
          className="w-full flex-1 border-0 min-h-0"
          sandbox={
            allowJsExecution
              ? ARTIFACT_SANDBOX_ATTRIBUTES
              : ARTIFACT_SANDBOX_ATTRIBUTES_NO_SCRIPTS
          }
          title={`${artifact.name} — full screen`}
        />
      </BaseDialog>
    </div>
  );
});

const TextArtifact = memo<ArtifactProps<"text">>(({ artifact, inAiMessage }) => {
  const isHighlighted = useShallowCopilotStore(
    (s) => s.hoveredCitationWidgetId === artifact.name,
  );

  const content = useMemo(
    () => artifact.content.replace(/\n/g, "  \n"),
    [artifact.content],
  );

  const markdownOptions = useMemo(
    () => ({
      disableParsingRawHTML: true,
      renderRule,
      overrides: {
        ...inertImageOverride,
        a: (props: ComponentPropsWithoutRef<"a">) => {
          return (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {props.children}
            </a>
          );
        },
        p: (props: ComponentPropsWithoutRef<"p">) => {
          if (hasObjectChild(props.children)) {
            return <div {...props} />;
          }
          return <p {...props} />;
        },
        code: { component: CodeComponent },
        pre: { component: PreCodeComponent },
      },
    }),
    [],
  );

  return (
    <div
      id={artifact.name}
      className={cn({
        "max-h-[200px] overflow-auto relative flex flex-col items-start py-1 rounded min-w-10 max-w-full mx-1":
          !inAiMessage,
        "outline-2 outline-brand-main": !inAiMessage && isHighlighted,
        "dark:bg-dark-400 rounded p-[3px] bg-light-100": inAiMessage,
        "dark:bg-dark-800 bg-light-50": !inAiMessage,
      })}
    >
      <div
        className={cn({
          "px-2.5 prose-sm !text-xs text-justify": !inAiMessage,
        })}
      >
        <Markdown options={markdownOptions}>{content}</Markdown>
      </div>
      {!inAiMessage && (
        <ArtifactActions
          copyTooltip="Copy text to clipboard"
          createTooltip="Create widget from text"
          copyTestId="copy-text-button"
          createTestId="create-widget-from-text-button"
          onCopy={() => {
            navigator.clipboard
              .writeText(content)
              .then(() => toast.success("Text copied to clipboard"))
              .catch((err) =>
                toast.error("Failed to copy text to clipboard", {
                  description: err.message,
                }),
              );
          }}
          createWidgetParams={{
            widgetType: "text",
            content: content,
            metadata: {
              uuid: artifact.uuid,
              name: artifact.name,
              description: artifact.description,
            },
          }}
        />
      )}
    </div>
  );
});

const AppArtifact = memo<ArtifactProps<"app">>(({ artifact, inAiMessage }) => {
  const navigate = useNavigate();
  const { id: currentDashboard } = useParams();
  const { addTab, items } = useShallowAppStore((state) => ({
    addTab: state.addTab,
    items: state.items,
  }));
  const apiSources = useShallowBackendConnectorStore((state) => state.apiSources);

  const appArtifactSource = useMemo(() => buildAppArtifactSource(artifact), [artifact]);
  const [confirmDialog, setConfirmDialog] = useState(false);
  const currentDashboardItem = currentDashboard ? items?.[currentDashboard] : undefined;
  const isInDashboard = !!currentDashboardItem?.data && !currentDashboardItem.isFolder;
  const { app } = artifact;
  const tabs = useMemo(() => Object.values(app.tabs ?? {}), [app.tabs]);
  const widgetCount = useMemo(
    () => tabs.reduce((total, tab) => total + (tab.layout?.length ?? 0), 0),
    [tabs],
  );

  const handleOpen = useCallback(
    async (action: "open" | "update") => {
      if (!isInDashboard && action === "update") {
        toast.warning("No active dashboard to update", {
          description: "Please open a dashboard first",
        });
        return;
      }
      try {
        if (action === "open") {
          const {
            isFullscreen,
            setIsFullscreen,
            setIsIntentionallyCollapsed,
            setLastPanelState,
          } = useCopilotStore.getState();

          if (isFullscreen) {
            setIsIntentionallyCollapsed(false);
            setLastPanelState("open");
            setIsFullscreen(false);
          }
        }

        await createCustomTemplateTab({
          addTab,
          navigate,
          items,
          template: app as unknown as BackendTemplate,
          source: appArtifactSource,
          currentDashboard,
          dashboardBehavior: action === "open" ? "new" : "current",
          resolveWidgetSource: buildWidgetSourceResolver(
            artifact.widget_refs ?? [],
            apiSources,
          ),
        });
      } catch (error) {
        toast.error("Failed to open app", {
          description: error instanceof Error ? error.message : "Unexpected error",
        });
      }
    },
    [
      addTab,
      navigate,
      items,
      app,
      appArtifactSource,
      artifact,
      currentDashboard,
      apiSources,
      isInDashboard,
    ],
  );

  return (
    <div
      id={artifact.name}
      data-testid="app-artifact"
      className={cn(
        "@container/app-artifact flex min-w-0 flex-col gap-3 overflow-hidden rounded-md bg-components-chat-copilot-cards-bg p-3 mx-1",
        { "my-1": inAiMessage },
      )}
    >
      <ConfirmDialog
        title="Do you want to update this dashboard?"
        description="This will update the current dashboard with the changes from the app artifact."
        open={confirmDialog}
        confirmButton={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              handleOpen("update");
              setConfirmDialog(false);
            }}
          >
            Yes, update
          </Button>
        }
        onClose={() => {
          setConfirmDialog(false);
        }}
      />
      <div className="flex items-start gap-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="body-sm-medium text-ds-text-heading truncate">
            {app.name}
          </span>
          {app.description && (
            <span className="body-xs-regular text-ds-text-body line-clamp-2">
              {app.description}
            </span>
          )}
          <span className="body-xs-regular text-ds-text-caption pt-0.5">
            {tabs.length} {tabs.length === 1 ? "tab" : "tabs"} · {widgetCount}{" "}
            {widgetCount === 1 ? "widget" : "widgets"}
          </span>
        </div>
      </div>

      {tabs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tabs.map((tab) => (
            <span
              key={tab.id}
              className="inline-flex items-center gap-1 rounded-sm border border-general-border-secondary bg-general-bg-primary px-2 py-0.5 body-xs-regular text-ds-text-body"
            >
              {tab.name}
              <span className="text-ds-text-caption">{tab.layout?.length ?? 0}</span>
            </span>
          ))}
        </div>
      )}

      <div className="flex w-full min-w-0 flex-col items-stretch gap-2 @min-[360px]/app-artifact:flex-row @min-[360px]/app-artifact:flex-wrap @min-[360px]/app-artifact:items-center @min-[360px]/app-artifact:justify-end">
        <Tooltip message="Create a new dashboard with this app.">
          <span className="inline-flex w-full min-w-0 @min-[360px]/app-artifact:w-auto">
            <Button
              size="xs"
              variant="primary"
              className="w-full min-w-0 whitespace-normal @min-[360px]/app-artifact:w-auto"
              onClick={() => handleOpen("open")}
              data-testid="open-app-artifact-button"
            >
              <span className="inline-flex min-w-0 items-center justify-center gap-1.5">
                <Icon id="dashboard-icon" className="size-3.5 shrink-0" />
                <span className="hidden @min-[280px]/app-artifact:inline">
                  Open in new dashboard
                </span>
                <span className="@min-[280px]/app-artifact:hidden">Open</span>
              </span>
            </Button>
          </span>
        </Tooltip>
        <Tooltip
          message={
            "Update current dashboard with changes from the app artifact. This will overwrite any existing widgets in the current dashboard."
          }
        >
          <span className="inline-flex w-full min-w-0 @min-[360px]/app-artifact:w-auto">
            <Button
              size="xs"
              variant="secondary"
              className="w-full min-w-0 whitespace-normal @min-[360px]/app-artifact:w-auto"
              disabled={!isInDashboard}
              onClick={() => setConfirmDialog(true)}
              data-testid="update-current-dashboard-app-artifact-button"
            >
              <span className="inline-flex min-w-0 items-center justify-center gap-1.5">
                <Icon id="edit-03" className="size-3.5 shrink-0" />
                <span className="hidden @min-[280px]/app-artifact:inline">
                  Update current dashboard
                </span>
                <span className="@min-[280px]/app-artifact:hidden">Update</span>
              </span>
            </Button>
          </span>
        </Tooltip>
      </div>
    </div>
  );
});

const PluginArtifact = memo<ArtifactProps<"plugin">>(({ artifact, inAiMessage }) => (
  <div
    id={artifact.name}
    className={cn("relative mx-1 rounded p-2", {
      "dark:bg-dark-400 bg-light-100": inAiMessage,
      "dark:bg-dark-800 bg-light-50": !inAiMessage,
    })}
  >
    <PluginArtifactFrame artifact={artifact} />
    <ArtifactActions
      copyTooltip="Copy data to clipboard"
      createTooltip="Add to a dashboard as a widget"
      copyTestId="copy-plugin-artifact-button"
      createTestId="create-widget-from-plugin-artifact-button"
      onCopy={() => {
        navigator.clipboard
          .writeText(JSON.stringify(artifact.data, null, 2))
          .then(() => toast.success("Data copied to clipboard"))
          .catch((err) =>
            toast.error("Failed to copy data to clipboard", {
              description: err.message,
            }),
          );
      }}
      createWidgetParams={{
        widgetType: "plugin",
        content: "",
        pluginArtifact: {
          plugin: artifact.plugin,
          data: artifact.data,
          config: artifact.config,
        },
        metadata: {
          uuid: artifact.uuid,
          name: artifact.name,
          description: artifact.description,
        },
      }}
    />
  </div>
));

TextArtifact.displayName = "TextArtifact";
PluginArtifact.displayName = "PluginArtifact";
AppArtifact.displayName = "AppArtifact";
type ComponentMapT = { [K in ArtifactT["type"]]: FC<ArtifactProps<K>> };
const ComponentMap: ComponentMapT = {
  html: HTMLArtifact,
  text: TextArtifact,
  app: AppArtifact,
  plugin: PluginArtifact,
};

function getArtifactComponent<T extends ArtifactT["type"]>(props: ArtifactProps<T>) {
  if (props.artifact.type in ComponentMap) {
    const Component = ComponentMap[props.artifact.type] as FC<ArtifactProps<T>>;
    return <Component {...props} key={`artifact-${props.artifact.uuid}-root`} />;
  }
  return null;
}

export const Artifact = memo<ArtifactProps>((props) => getArtifactComponent(props));

Artifact.displayName = "Artifact";

export default Artifact;
