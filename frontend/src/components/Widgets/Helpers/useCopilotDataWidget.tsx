import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import type { Widget, WidgetT } from "~/components/types";
import { useWidgetContext } from "~/components/Widget.context";
import { useShallowCopilotDataStore } from "~/lib/state/copilotData";
import { extractColumns, getJsonWidget, useWidgetDataSource } from "~/lib/utils";
import { handleWidgetMetadata } from "~/utils/dataConnectorsHelpers";

export function createCopilotDataWidget(params: {
  title?: string;
  widget: WidgetT | null | undefined;
  widgetFromJSON?: Partial<Widget> | null;
  widgetSource?: string[];
  additionalMetadata?: Record<string, unknown>;
}) {
  const { title, widget, widgetSource, additionalMetadata } = params;
  const widgetFromJSON =
    params.widgetFromJSON ?? (widget ? getJsonWidget(widget) : undefined);

  const widgetMetadata = widget ? handleWidgetMetadata(widget) : undefined;

  const name = title || widget?.name || widgetFromJSON?.name;
  const description = widget?.description || widgetFromJSON?.description;
  const source = widgetSource || widgetFromJSON?.source || widget?.source;
  const metadata = {
    ...(additionalMetadata || {}),
    ...(widgetMetadata || {}),
    ...(widget?.metadata || {}),
    ...{ params: widget?.storage?.params || {} },
    ...(widget?.storage?.createdAt ? { createdAt: widget.storage.createdAt } : {}),
    ...(widget?.storage?.copiedFrom ? { copiedFrom: widget.storage.copiedFrom } : {}),
    ...(widget?.storage?.fromArtifact
      ? {
          fromArtifact: {
            artifactUuid: widget.storage.fromArtifact.artifactUuid,
            name: widget.storage.fromArtifact.name,
          },
        }
      : {}),
  };

  return {
    name,
    description,
    source: Array.isArray(source) ? source[0] : source || "",
    metadata,
  };
}

function useCopilotDataWidget({
  aiData: data,
  title,
  aiEnabled,
  additionalMetadata,
  captureExecutedParams = true,
}: {
  aiData: unknown;
  title?: string;
  aiEnabled: boolean;
  lastUpdated?: number | null;
  additionalMetadata?: Record<string, unknown>;
  captureExecutedParams?: boolean;
}) {
  const { id: currentDashboardId = "" } = useParams();
  const { widget, widgetFromJSON } = useWidgetContext(true);
  const widgetSource = useWidgetDataSource();
  const filtered = typeof data === "boolean";

  const { name, description, source, metadata } = useMemo(() => {
    return createCopilotDataWidget({
      title,
      widget,
      widgetFromJSON,
      widgetSource,
      additionalMetadata,
    });
  }, [
    title,
    widgetSource,
    widget?.name,
    widget?.description,
    widget?.widgetId,
    widget?.metadata,
    widgetFromJSON,
    additionalMetadata,
  ]);

  const executedParamsSnapshot = useMemo(
    () => ({ ...(widget?.storage?.params || {}) }),
    [data, widget?.id],
  );
  const lastUpdated = useMemo(() => Date.now(), [data]);

  const addDataOnDashboardWidget = useShallowCopilotDataStore(
    (state) => state?.addDataOnDashboardWidget,
  );

  useEffect(() => {
    if (!(aiEnabled && widget?.id) || filtered) return;
    const fileType =
      widget?.connectionType === "file" && widget?.endpoint?.url?.split(".")?.pop();
    const columns = extractColumns(data);

    addDataOnDashboardWidget(widget.id, {
      data,
      captureExecutedParams,
      innerTab: widget.innerTab,
      title: name,
      description: description || "",
      endpointUrl: widget.endpoint?.url || "",
      metadata: {
        ...(metadata || {}),
        params: executedParamsSnapshot,
        ...(lastUpdated ? { lastUpdated } : {}),
        ...(fileType ? { fileType } : {}),
        ...(columns ? { columns } : {}),
      },
      dashboardId: currentDashboardId,
    });
  }, [
    aiEnabled,
    widget?.id,
    data,
    name,
    description,
    source,
    metadata,
    lastUpdated,
    executedParamsSnapshot,
    captureExecutedParams,
  ]);
}

export default useCopilotDataWidget;
