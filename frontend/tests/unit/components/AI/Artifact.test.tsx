import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import Artifact from "~/components/AI/Artifact";
import { useCopilotContext } from "~/lib/contexts/CopilotChatContext";
import type { ArtifactT } from "~/lib/state/copilot";
import { malformed } from "../../mocks";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("~/lib/contexts/CopilotChatContext", () => ({
  useCopilotContext: vi.fn(),
}));

const mockCreateWidget = vi.mocked(vi.fn());

vi.mock("~/plugins/PluginArtifactFrame", () => ({
  PluginArtifactFrame: ({ artifact }: { artifact: { plugin: { id: string } } }) => (
    <div data-testid="plugin-frame">{artifact.plugin.id}</div>
  ),
}));

vi.mock("~/components/AI/hooks/utils", async (importActual) => {
  const actual = (await importActual()) as object;
  return {
    ...actual,
    dispatchCreate: (...args: unknown[]) => mockCreateWidget(...args),
  };
});

describe("Artifact Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useCopilotContext as Mock).mockReturnValue({ hoveredCitationElementId: "" });
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders a plugin artifact in its frame and adds it to a dashboard as a plugin widget", () => {
    const artifact: ArtifactT = {
      uuid: "p1",
      type: "plugin",
      name: "Sales bars",
      description: "Sales by month",
      plugin: { id: "chart-kit", widget: "bars" },
      data: { rows: [{ x: "jan", y: 3 }] },
      config: { color: "red" },
    };

    render(<Artifact artifact={artifact} />);

    expect(screen.getByTestId("plugin-frame")).toHaveTextContent("chart-kit");
    fireEvent.click(screen.getByTestId("create-widget-from-plugin-artifact-button"));
    expect(mockCreateWidget).toHaveBeenCalledWith({
      widgetType: "plugin",
      content: "",
      pluginArtifact: {
        plugin: { id: "chart-kit", widget: "bars" },
        data: { rows: [{ x: "jan", y: 3 }] },
        config: { color: "red" },
      },
      metadata: { uuid: "p1", name: "Sales bars", description: "Sales by month" },
      artifact: { uuid: "p1", name: "Sales bars", chatUuid: expect.any(String) },
    });

    fireEvent.click(screen.getByTestId("copy-plugin-artifact-button"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      JSON.stringify(artifact.data, null, 2),
    );
  });

  it("renders text artifact correctly", () => {
    const artifact: ArtifactT = {
      uuid: "123",
      type: "text",
      content: "This is a test\ntext artifact",
      name: "Test Text Artifact",
      description: "This is a test text artifact",
    };

    render(<Artifact artifact={artifact} />);

    expect(screen.getAllByText("This is a testtext artifact")[0]).toBeInTheDocument();

    const createWidgetButton = screen.getByTestId("create-widget-from-text-button");
    fireEvent.click(createWidgetButton);
    expect(mockCreateWidget).toHaveBeenCalledWith({
      widgetType: "text",
      content: "This is a test  \ntext artifact",
      metadata: {
        uuid: "123",
        name: "Test Text Artifact",
        description: "This is a test text artifact",
      },
      artifact: {
        uuid: "123",
        name: "Test Text Artifact",
        chatUuid: expect.any(String),
      },
    });
  });

  it("keeps html artifacts in AI messages on the default height cap", async () => {
    const artifact: ArtifactT = {
      uuid: "html-123",
      type: "html",
      content: "<html><body><h1>Report</h1></body></html>",
      name: "Test HTML Artifact",
      description: "This is a test HTML artifact",
    };

    const { container } = render(<Artifact artifact={artifact} inAiMessage={true} />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const doc = iframe.contentDocument;

    Object.defineProperty(doc?.documentElement, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(doc?.body, "scrollHeight", {
      configurable: true,
      value: 2000,
    });

    fireEvent.load(iframe);

    await waitFor(() => {
      expect(iframe).toHaveStyle({ height: "600px" });
    });
  });

  it("keeps html artifacts outside AI messages on the default height cap", async () => {
    const artifact: ArtifactT = {
      uuid: "html-456",
      type: "html",
      content: "<html><body><h1>Report</h1></body></html>",
      name: "Standalone HTML Artifact",
      description: "This is a standalone HTML artifact",
    };

    const { container } = render(<Artifact artifact={artifact} />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const doc = iframe.contentDocument;

    Object.defineProperty(doc?.documentElement, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(doc?.body, "scrollHeight", {
      configurable: true,
      value: 2000,
    });

    fireEvent.load(iframe);

    await waitFor(() => {
      expect(iframe).toHaveStyle({ height: "600px" });
    });
  });

  it("returns null for unsupported artifact types", async () => {
    const artifact = malformed<ArtifactT>({
      type: "unsupported",
      content: "Some content",
    });

    const { container } = render(<Artifact artifact={artifact} />);
    await expect(container.firstChild).toBeNull();
  });
});
