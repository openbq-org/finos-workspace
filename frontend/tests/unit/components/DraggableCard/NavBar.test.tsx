import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NavBar from "~/components/DraggableCard/NavBar";
import { useWidgetContext } from "~/components/Widget.context";
import { useShallowCopilotDataStore } from "~/lib/state/copilotData";
import { useShallowThemeStore } from "~/lib/state/theme";
import { malformed, partial, stubStoreState } from "../../mocks";

vi.mock("~/components/Widget.context", () => ({
  useWidgetContext: vi.fn(),
}));

const dashboard = vi.hoisted(() => ({ locked: false }));

vi.mock("~/lib/state/app", () => ({
  useShallowAppStore: vi.fn(() => ({
    removeWidget: vi.fn(),
    minimizeWidget: vi.fn(),
  })),
  useAppStore: vi.fn(),
  useIsDashboardLocked: () => dashboard.locked,
}));

vi.mock("~/lib/state/theme", () => ({
  useShallowThemeStore: vi.fn((selector) => {
    const state = {
      showWidgetControlsEllipsis: false,
      showMinimizeButton: true,
      isResizingGridElement: undefined,
    };
    return typeof selector === "function" ? selector(state) : state;
  }),
}));

vi.mock("~/lib/state/copilot", () => ({
  useShallowCopilotStore: vi.fn(() => ({
    showCopilotButton: false,
  })),
}));

vi.mock("~/lib/state/copilotData", () => ({
  useShallowCopilotDataStore: vi.fn(() => false),
}));

vi.mock("~/lib/contexts/TabContext", () => ({
  useTabContext: vi.fn(() => ({ isShared: false })),
}));

vi.mock("~/components/Widgets/Helpers/GroupDropdown", () => ({
  default: ({
    children,
    paramDef,
  }: {
    children?: ReactNode;
    paramDef?: { paramName?: string; label?: string };
  }) => (
    <div data-testid="group-dropdown" data-param-name={paramDef?.paramName}>
      {children ?? paramDef?.label ?? paramDef?.paramName}
    </div>
  ),
}));

vi.mock("~/components/MoveToDropDown", () => ({
  MoveToTabsDropdownMenu: () => null,
}));

vi.mock("usehooks-ts", () => ({
  useDebounceValue: vi.fn((value) => [value]),
  useWindowSize: () => ({ width: 1024, height: 768 }),
}));

describe("NavBar - Hidden parameter badges", () => {
  const mockUseWidgetContext = vi.mocked(useWidgetContext);

  beforeEach(() => {
    vi.clearAllMocks();

    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );

    mockUseWidgetContext.mockReturnValue(
      partial({
        widgetRef: {
          current: {
            id: "volume-by-category",
            widgetId: "volume_by_category",
            name: "Volume by Category",
            isMinimized: false,
            paramGroups: { selection: "group-1" },
          },
        },
        updateWidget: vi.fn(),
        widgetFromJSON: {
          external: true,
          params: [
            {
              paramName: "selection",
              type: "endpoint",
              groupById: "selection-options",
              label: "Category / Tag / Event",
              show: false,
            },
          ],
        },
      }),
    );
  });

  it("does not duplicate hidden badges already rendered by shared row params", () => {
    render(
      <NavBar
        title="Volume by Category"
        elementRightNextToTitle={
          <div data-widget-param-row="0">
            <div data-testid="group-dropdown" data-param-name="selection">
              Category / Tag / Event
            </div>
          </div>
        }
      />,
    );

    expect(screen.getAllByTestId("group-dropdown")).toHaveLength(1);
  });

  it("keeps the legacy hidden badge fallback when shared row params are absent", () => {
    render(<NavBar title="Volume by Category" />);

    expect(screen.getAllByTestId("group-dropdown")).toHaveLength(1);
    expect(screen.getByTestId("group-dropdown")).toHaveAttribute(
      "data-param-name",
      "selection",
    );
  });
});

describe("NavBar - Overflow Detection", () => {
  const mockUseWidgetContext = vi.mocked(useWidgetContext);

  let resizeObserverCallback: ResizeObserverCallback | null = null;
  let observeSpy = vi.fn();
  let disconnectSpy = vi.fn();
  let unobserveSpy = vi.fn();
  const constructorSpy = vi.fn();

  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      constructorSpy(callback);
      resizeObserverCallback = callback;
    }
    observe(...args: unknown[]) {
      return observeSpy(...args);
    }
    disconnect(...args: unknown[]) {
      return disconnectSpy(...args);
    }
    unobserve(...args: unknown[]) {
      return unobserveSpy(...args);
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resizeObserverCallback = null;
    observeSpy = vi.fn();
    disconnectSpy = vi.fn();
    unobserveSpy = vi.fn();

    global.ResizeObserver = partial(MockResizeObserver);

    mockUseWidgetContext.mockReturnValue(
      partial({
        widgetRef: {
          current: {
            id: "test-widget",
            widgetId: "test-widget",
            name: "Test Widget",
            isMinimized: false,
          },
        },
        updateWidget: vi.fn(),
        widgetFromJSON: {
          params: [],
        },
      }),
    );
  });

  it("should collapse controls when middle spacer width is <= 20px", async () => {
    const { container } = render(
      <NavBar title="Test Widget" showEllipsisMenu={true} />,
    );

    const middleSpacer = container.querySelector("._middle-navbar") as Element;
    expect(middleSpacer).toBeInTheDocument();

    Object.defineProperty(middleSpacer, "clientWidth", {
      configurable: true,
      value: 15,
    });

    act(() => {
      if (resizeObserverCallback) {
        resizeObserverCallback?.(
          [{ target: middleSpacer } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      }
    });

    await waitFor(() => {
      const controls = container.querySelector(".w-0.overflow-hidden.opacity-0");
      expect(controls).toBeInTheDocument();
    });
  });

  it("should expand controls when middle spacer width is >= 150px", async () => {
    const { container } = render(
      <NavBar title="Test Widget" showEllipsisMenu={true} />,
    );

    const middleSpacer = container.querySelector("._middle-navbar") as Element;

    Object.defineProperty(middleSpacer, "clientWidth", {
      configurable: true,
      value: 15,
    });

    if (resizeObserverCallback) {
      act(() => {
        resizeObserverCallback?.(
          [{ target: middleSpacer } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });
    }

    await waitFor(() => {
      const controls = container.querySelector(".w-0.overflow-hidden.opacity-0");
      expect(controls).toBeInTheDocument();
    });

    Object.defineProperty(middleSpacer, "clientWidth", {
      configurable: true,
      value: 200,
    });

    if (resizeObserverCallback) {
      act(() => {
        resizeObserverCallback?.(
          [{ target: middleSpacer } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });
    }

    await waitFor(() => {
      const controls = container.querySelector(".w-auto.opacity-100");
      expect(controls).toBeInTheDocument();
    });
  });

  it("should use hysteresis to prevent flickering (stay collapsed between thresholds)", async () => {
    const { container } = render(
      <NavBar title="Test Widget" showEllipsisMenu={true} />,
    );

    const middleSpacer = container.querySelector("._middle-navbar") as Element;

    Object.defineProperty(middleSpacer, "clientWidth", {
      configurable: true,
      value: 15,
    });

    if (resizeObserverCallback) {
      act(() => {
        resizeObserverCallback?.(
          [{ target: middleSpacer } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });
    }

    await waitFor(() => {
      const controls = container.querySelector(".w-0.overflow-hidden.opacity-0");
      expect(controls).toBeInTheDocument();
    });

    Object.defineProperty(middleSpacer, "clientWidth", {
      configurable: true,
      value: 100,
    });

    if (resizeObserverCallback) {
      act(() => {
        resizeObserverCallback?.(
          [{ target: middleSpacer } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });
    }

    await waitFor(() => {
      const controls = container.querySelector(".w-0.overflow-hidden.opacity-0");
      expect(controls).toBeInTheDocument();
    });
  });

  it("should use hysteresis to prevent flickering (stay expanded between thresholds)", async () => {
    const { container } = render(
      <NavBar title="Test Widget" showEllipsisMenu={true} />,
    );

    const middleSpacer = container.querySelector("._middle-navbar") as Element;

    Object.defineProperty(middleSpacer, "clientWidth", {
      configurable: true,
      value: 200,
    });

    if (resizeObserverCallback) {
      act(() => {
        resizeObserverCallback?.(
          [{ target: middleSpacer } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });
    }

    await waitFor(() => {
      const controls = container.querySelector(".w-auto.opacity-100");
      expect(controls).toBeInTheDocument();
    });

    Object.defineProperty(middleSpacer, "clientWidth", {
      configurable: true,
      value: 100,
    });

    if (resizeObserverCallback) {
      act(() => {
        resizeObserverCallback?.(
          [{ target: middleSpacer } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });
    }

    await waitFor(() => {
      const controls = container.querySelector(".w-auto.opacity-100");
      expect(controls).toBeInTheDocument();
    });
  });

  it("should not enable overflow detection when showWidgetControlsEllipsis is true", async () => {
    const { useShallowThemeStore } = await import("~/lib/state/theme");

    stubStoreState(useShallowThemeStore, {
      showWidgetControlsEllipsis: true,
      showMinimizeButton: true,
      isResizingGridElement: undefined,
    });

    render(<NavBar title="Test Widget" showEllipsisMenu={true} />);

    expect(observeSpy).not.toHaveBeenCalled();
  });

  it("should cleanup ResizeObserver on unmount", () => {
    const { unmount } = render(<NavBar title="Test Widget" showEllipsisMenu={true} />);

    if (resizeObserverCallback) {
      unmount();
      expect(disconnectSpy).toHaveBeenCalled();
    } else {
      unmount();
      expect(disconnectSpy).not.toHaveBeenCalled();
    }
  });

  it("should handle missing middleSpacer ref gracefully", () => {
    const { container } = render(
      <NavBar title="Test Widget" showEllipsisMenu={true} />,
    );

    expect(container).toBeInTheDocument();
  });
});

describe("NavBar - Auto-locked controls for active widgets", () => {
  const mockUseWidgetContext = vi.mocked(useWidgetContext);

  beforeEach(() => {
    vi.clearAllMocks();

    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );

    mockUseWidgetContext.mockReturnValue(
      partial({
        widgetRef: {
          current: {
            id: "test-widget",
            widgetId: "test-widget",
            name: "Test Widget",
            isMinimized: false,
          },
        },
        updateWidget: vi.fn(),
        widgetFromJSON: { params: [] },
      }),
    );
  });

  function enableCollapse() {
    stubStoreState(useShallowThemeStore, {
      showWidgetControlsEllipsis: true,
      showMinimizeButton: true,
      isResizingGridElement: undefined,
    });
  }

  it("should keep controls visible when widget is selected and collapse is enabled", () => {
    enableCollapse();
    vi.mocked(useShallowCopilotDataStore).mockReturnValue(malformed(true));

    render(<NavBar title="Test Widget" showEllipsisMenu={true} />);

    expect(screen.getByTestId("_navbar-controls-left")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
    expect(screen.getByTestId("_navbar-controls-right")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
  });

  it("should collapse controls when no active control and collapse is enabled", () => {
    enableCollapse();
    vi.mocked(useShallowCopilotDataStore).mockReturnValue(malformed(false));

    render(<NavBar title="Test Widget" showEllipsisMenu={true} />);

    expect(screen.getByTestId("_navbar-controls-left")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(screen.getByTestId("_navbar-controls-right")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
  });

  it("should not collapse controls when shouldCollapse is false regardless of active state", () => {
    vi.mocked(useShallowCopilotDataStore).mockReturnValue(malformed(true));

    render(<NavBar title="Test Widget" showEllipsisMenu={true} />);

    expect(screen.getByTestId("_navbar-controls-left")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
    expect(screen.getByTestId("_navbar-controls-right")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
  });
});

describe("NavBar - Locked dashboard", () => {
  const mockUseWidgetContext = vi.mocked(useWidgetContext);

  beforeEach(() => {
    vi.clearAllMocks();
    dashboard.locked = false;

    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );

    mockUseWidgetContext.mockReturnValue(
      partial({
        widgetRef: {
          current: {
            id: "test-widget",
            widgetId: "test-widget",
            name: "Test Widget",
            isMinimized: false,
          },
        },
        widget: { widgetId: "test-widget" },
        activeDashboardId: "dashboard-1",
        isShared: false,
        updateWidget: vi.fn(),
        widgetFromJSON: { params: [] },
      }),
    );
  });

  afterEach(() => {
    dashboard.locked = false;
  });

  it("lets the widget be removed from an unlocked dashboard", () => {
    render(<NavBar title="Test Widget" />);

    expect(document.getElementById("close-widget-test-widget")).toBeEnabled();
  });

  it("does not let the widget be removed from a locked dashboard", () => {
    dashboard.locked = true;

    render(<NavBar title="Test Widget" />);

    expect(document.getElementById("close-widget-test-widget")).toBeDisabled();
  });

  it("shows the move cursor on the title of a widget that can be moved", () => {
    render(<NavBar title="Test Widget" />);

    expect(document.querySelector(".draggable-handle")).toHaveClass("md:cursor-move");
  });

  it("tells the card when its settings open from the menu and close", async () => {
    const user = userEvent.setup();
    const setOpenSettings = vi.fn();
    render(
      <NavBar
        title="Test Widget"
        settingsModalChildren={<span>Card settings</span>}
        showActionsSettings
        setOpenSettings={setOpenSettings}
      />,
    );
    setOpenSettings.mockClear();

    await user.click(document.querySelector("[aria-haspopup=menu]") as HTMLElement);
    await user.click(await screen.findByText("Settings"));
    await screen.findByText("Card settings");
    expect(setOpenSettings).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(setOpenSettings).toHaveBeenLastCalledWith(false));
  });

  it("does not show the move cursor on the title of a locked widget", () => {
    dashboard.locked = true;

    render(<NavBar title="Test Widget" />);

    expect(document.querySelector(".draggable-handle")).not.toHaveClass(
      "md:cursor-move",
    );
  });
});
