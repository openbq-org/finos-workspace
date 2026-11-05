import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
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
import { errorText } from "~/components/AdminPlugins/common";
import { pluginKeys } from "~/hooks/usePlugins";
import { useShallowAuthStore } from "~/lib/state/auth";
import { MAX_PRESET_NAME } from "./limits";

export function PresetsPanel(props: {
  pluginId: string;
  widgetId: string;
  config: Record<string, unknown>;
  state: unknown;
  onApply: (preset: PluginPreset) => void;
  disabled?: boolean;
}) {
  const { pluginId, widgetId, config, state, onApply, disabled } = props;
  const formId = useId();
  const queryClient = useQueryClient();
  const queryKey = pluginKeys.presets(pluginId, widgetId);
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => listPluginPresets(pluginId, widgetId),
    staleTime: 0,
  });
  const [name, setName] = useState("");
  const isAdmin = useShallowAuthStore((state) => state.user?.role === "Admin");

  const { mutate, isPending } = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (error) => toast.error(`Preset: ${errorText(error)}`),
  });

  const presets = data?.presets ?? [];
  const busy = disabled || isPending;
  const trimmed = name.trim();

  return (
    <div className="flex flex-col gap-2 pb-3">
      <span className="body-xs-medium">Presets</span>
      {isLoading ? (
        <p className="body-xs-regular">Loading presets</p>
      ) : presets.length ? (
        <ul className="flex flex-col gap-1">
          {presets.map((preset) => (
            <li
              key={preset.id}
              className="flex items-center gap-2 body-xs-regular"
              data-preset={preset.id}
            >
              <span className="flex-1 truncate">{preset.name}</span>
              {preset.scope === "org" ? (
                <span className="text-ds-text-caption">Organization</span>
              ) : null}
              {preset.is_default ? (
                <span className="text-ds-text-caption">Default</span>
              ) : null}
              <button
                type="button"
                className="ws-hyper-link body-xs-medium"
                disabled={disabled}
                onClick={() => onApply(preset)}
              >
                Apply
              </button>
              {preset.scope === "user" || isAdmin ? (
                <>
                  {preset.is_default ? null : (
                    <button
                      type="button"
                      className="ws-hyper-link body-xs-medium"
                      disabled={busy}
                      onClick={() =>
                        mutate(() =>
                          (preset.scope === "user"
                            ? updatePluginPreset
                            : updateOrgPreset)(pluginId, widgetId, preset.id, {
                            is_default: true,
                          }),
                        )
                      }
                    >
                      Set as default
                    </button>
                  )}
                  {preset.scope === "user" && isAdmin ? (
                    <button
                      type="button"
                      className="ws-hyper-link body-xs-medium"
                      disabled={busy}
                      onClick={() =>
                        mutate(() =>
                          publishOrgPreset(pluginId, widgetId, {
                            name: preset.name,
                            config: preset.config,
                            state: preset.state,
                          }),
                        )
                      }
                    >
                      Publish to organization
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ws-hyper-link body-xs-medium"
                    disabled={busy}
                    onClick={() =>
                      mutate(() =>
                        (preset.scope === "user"
                          ? deletePluginPreset
                          : deleteOrgPreset)(pluginId, widgetId, preset.id),
                      )
                    }
                  >
                    Delete
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="body-xs-regular">No presets yet.</p>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-name`} className="body-xs-medium">
          Preset name
        </label>
        <div className="flex items-center gap-2">
          <input
            id={`${formId}-name`}
            type="text"
            className="flex-1 rounded border border-general-border-secondary bg-transparent p-1"
            value={name}
            maxLength={MAX_PRESET_NAME}
            disabled={disabled}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className="ws-hyper-link body-xs-medium"
            disabled={busy || !trimmed}
            onClick={() =>
              mutate(
                () =>
                  createPluginPreset(pluginId, widgetId, {
                    name: trimmed,
                    config,
                    state: state ?? null,
                  }),
                { onSuccess: () => setName("") },
              )
            }
          >
            Save current settings as a preset
          </button>
        </div>
      </div>
    </div>
  );
}
