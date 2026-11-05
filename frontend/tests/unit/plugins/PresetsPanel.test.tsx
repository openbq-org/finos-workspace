import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  createPluginPreset,
  deleteOrgPreset,
  deletePluginPreset,
  listPluginPresets,
  type PluginPreset,
  publishOrgPreset,
  updateOrgPreset,
  updatePluginPreset,
} from "~/api/plugins.api";
import { useAuthStore } from "~/lib/state/auth";
import { PresetsPanel } from "~/plugins/PresetsPanel";
import { makeAuthUser } from "../factories";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

vi.mock("~/api/plugins.api", () => ({
  listPluginPresets: vi.fn(),
  createPluginPreset: vi.fn(),
  updatePluginPreset: vi.fn(),
  deletePluginPreset: vi.fn(),
  publishOrgPreset: vi.fn(),
  updateOrgPreset: vi.fn(),
  deleteOrgPreset: vi.fn(),
}));

const preset = (overrides: Partial<PluginPreset>): PluginPreset => ({
  id: "p1",
  name: "Mine",
  scope: "user",
  is_default: false,
  config: { color: "red" },
  state: { zoom: 2 },
  updated_at: "2026-11-01T10:00:00Z",
  ...overrides,
});

const MINE = preset({});
const ORG = preset({
  id: "o1",
  name: "House style",
  scope: "org",
  is_default: true,
  config: { color: "blue" },
  state: null,
});

function renderPanel(props: { disabled?: boolean; onApply?: Mock } = {}) {
  const onApply = props.onApply ?? vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PresetsPanel
        pluginId="chart"
        widgetId="candles"
        config={{ color: "green" }}
        state={{ zoom: 5 }}
        onApply={onApply}
        disabled={props.disabled}
      />
    </QueryClientProvider>,
  );
  return { onApply };
}

const row = async (name: string) =>
  (await screen.findByText(name)).closest("li") as HTMLElement;

describe("the presets of a plugin card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: null });
    (listPluginPresets as Mock).mockResolvedValue({ presets: [MINE, ORG], limit: 100 });
    (createPluginPreset as Mock).mockResolvedValue(preset({ id: "p2" }));
    (updatePluginPreset as Mock).mockResolvedValue(preset({ is_default: true }));
    (deletePluginPreset as Mock).mockResolvedValue(undefined);
  });

  it("lists the user's presets and the organization's", async () => {
    renderPanel();
    const mine = await row("Mine");
    const org = await row("House style");
    expect(listPluginPresets).toHaveBeenCalledWith("chart", "candles");
    expect(within(org).getByText("Organization")).toBeInTheDocument();
    expect(within(org).getByText("Default")).toBeInTheDocument();
    expect(within(org).queryByText("Delete")).toBeNull();
    expect(within(org).queryByText("Set as default")).toBeNull();
    expect(within(mine).queryByText("Organization")).toBeNull();
    expect(within(mine).getByText("Delete")).toBeInTheDocument();
  });

  it("applies a preset with its config and its state", async () => {
    const { onApply } = renderPanel();
    fireEvent.click(within(await row("Mine")).getByText("Apply"));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ config: { color: "red" }, state: { zoom: 2 } }),
    );
    fireEvent.click(within(await row("House style")).getByText("Apply"));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ config: { color: "blue" }, state: null }),
    );
  });

  it("saves the current settings and state under a name", async () => {
    renderPanel();
    await row("Mine");
    const save = screen.getByText("Save current settings as a preset");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Preset name"), {
      target: { value: "  Weekly  " },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(createPluginPreset).toHaveBeenCalledWith("chart", "candles", {
        name: "Weekly",
        config: { color: "green" },
        state: { zoom: 5 },
      }),
    );
    await waitFor(() => expect(listPluginPresets).toHaveBeenCalledTimes(2));
  });

  it("sets a default and deletes the user's own presets", async () => {
    renderPanel();
    fireEvent.click(within(await row("Mine")).getByText("Set as default"));
    await waitFor(() =>
      expect(updatePluginPreset).toHaveBeenCalledWith("chart", "candles", "p1", {
        is_default: true,
      }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByText("Mine").closest("li") as HTMLElement).getByText(
          "Delete",
        ),
      ).toBeEnabled(),
    );
    fireEvent.click(within(await row("Mine")).getByText("Delete"));
    await waitFor(() =>
      expect(deletePluginPreset).toHaveBeenCalledWith("chart", "candles", "p1"),
    );
  });

  it("leaves the organization's presets to admins", async () => {
    renderPanel();
    const house = await row("House style");
    expect(within(house).queryByText("Delete")).toBeNull();
    expect(within(await row("Mine")).queryByText("Publish to organization")).toBeNull();
  });

  it("lets an admin publish, default and delete the organization's presets", async () => {
    useAuthStore.setState({ user: makeAuthUser({ role: "Admin" }) });
    (listPluginPresets as Mock).mockResolvedValue({
      presets: [MINE, { ...ORG, is_default: false }],
      limit: 100,
    });
    renderPanel();
    fireEvent.click(within(await row("Mine")).getByText("Publish to organization"));
    await waitFor(() =>
      expect(publishOrgPreset).toHaveBeenCalledWith("chart", "candles", {
        name: "Mine",
        config: { color: "red" },
        state: { zoom: 2 },
      }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByText("House style").closest("li") as HTMLElement).getByText(
          "Set as default",
        ),
      ).toBeEnabled(),
    );
    fireEvent.click(within(await row("House style")).getByText("Set as default"));
    await waitFor(() =>
      expect(updateOrgPreset).toHaveBeenCalledWith("chart", "candles", "o1", {
        is_default: true,
      }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByText("House style").closest("li") as HTMLElement).getByText(
          "Delete",
        ),
      ).toBeEnabled(),
    );
    fireEvent.click(within(await row("House style")).getByText("Delete"));
    await waitFor(() =>
      expect(deleteOrgPreset).toHaveBeenCalledWith("chart", "candles", "o1"),
    );
    expect(deletePluginPreset).not.toHaveBeenCalled();
  });

  it("shows each problem of a refused request", async () => {
    (createPluginPreset as Mock).mockRejectedValue({
      response: {
        status: 422,
        data: { detail: [{ msg: "name is too long" }, { msg: "bad state" }] },
      },
    });
    renderPanel();
    await row("Mine");
    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "X" } });
    fireEvent.click(screen.getByText("Save current settings as a preset"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Preset: name is too long; bad state"),
    );
  });

  it("shows the server's refusal", async () => {
    (createPluginPreset as Mock).mockRejectedValue({
      response: { status: 409, data: { detail: "You keep 100 presets already" } },
    });
    renderPanel();
    await row("Mine");
    fireEvent.change(screen.getByLabelText("Preset name"), {
      target: { value: "One more" },
    });
    fireEvent.click(screen.getByText("Save current settings as a preset"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("You keep 100 presets already"),
      ),
    );
  });

  it("is read-only on a shared dashboard", async () => {
    renderPanel({ disabled: true });
    const mine = await row("Mine");
    expect(within(mine).getByText("Apply")).toBeDisabled();
    expect(within(mine).getByText("Set as default")).toBeDisabled();
    expect(within(mine).getByText("Delete")).toBeDisabled();
    expect(within(await row("House style")).getByText("Apply")).toBeDisabled();
    expect(screen.getByLabelText("Preset name")).toBeDisabled();
    expect(screen.getByText("Save current settings as a preset")).toBeDisabled();
  });
});
