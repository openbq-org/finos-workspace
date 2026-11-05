import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  type EntityPlugin,
  type EntityPluginChanges,
  getEntityPlugins,
  putEntityPlugin,
} from "~/api/plugins.api";
import { Button } from "~/components/ds/atoms/Button";
import { Checkbox } from "~/components/ds/atoms/Checkbox";
import { Switch } from "~/components/ds/atoms/Switch";
import { Notice } from "~/components/ds/molecules/Notice";
import { pluginKeys } from "~/hooks/usePlugins";
import { SettingsForm } from "~/plugins/SettingsForm";
import { SettingsSchemaSchema } from "~/plugins/types";
import { RenderNoData } from "~/routes/admin";
import { errorText, Section, StateTag } from "./common";
import { BlockedRequests, PluginEvents } from "./PluginActivity";

export function EntityPluginsTab() {
  const { data, isLoading, isError } = useQuery({
    queryKey: pluginKeys.entity,
    queryFn: getEntityPlugins,
  });

  if (isLoading || isError || !data)
    return (
      <RenderNoData isLoading={isLoading} isError={isError || !data} children={null} />
    );
  if (!data.enabled)
    return (
      <Notice variant="info" title="Widget plugins are off">
        This FINOS Workspace has no plugins directory, so there are no plugin widgets to
        enable.
      </Notice>
    );
  if (!data.plugins.length)
    return (
      <Notice variant="info" title="No widget plugin is approved yet">
        A superuser approves plugins that the deployer placed on the server.
      </Notice>
    );

  return (
    <div className="flex flex-col gap-4">
      <p className="body-xs-regular text-ds-text-caption">
        Every plugin is off until you enable it. Enabled, its widgets are available to
        the roles you give them in{" "}
        <Link to="/admin/roles" className="ws-hyper-link">
          Roles and Access
        </Link>
        .
      </p>
      {data.plugins.map((plugin) => (
        <EntityPluginCard
          key={plugin.plugin_id}
          plugin={plugin}
          backends={data.backends}
        />
      ))}
    </div>
  );
}

function EntityPluginCard({
  plugin,
  backends,
}: {
  plugin: EntityPlugin;
  backends: { uuid: string; name: string }[];
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [narrowed, setNarrowed] = useState<Set<string>>(
    new Set(plugin.narrowed_permissions),
  );
  const [kept, setKept] = useState<Record<string, Set<string>>>({});
  const [removedHosts, setRemovedHosts] = useState<Set<string>>(
    new Set(plugin.server_network_narrow),
  );
  const [settings, setSettings] = useState<Record<string, unknown>>(plugin.settings);
  const [presetLimit, setPresetLimit] = useState(String(plugin.preset_limit));

  useEffect(() => {
    setNarrowed(new Set(plugin.narrowed_permissions));
    setRemovedHosts(new Set(plugin.server_network_narrow));
    setSettings(plugin.settings);
    setPresetLimit(String(plugin.preset_limit));
    setKept(
      Object.fromEntries(
        Object.entries(plugin.csp.approved).map(([directive, sources]) => [
          directive,
          new Set(plugin.csp_narrow[directive] ?? sources),
        ]),
      ),
    );
  }, [plugin]);

  const { mutate: update, isPending } = useMutation({
    mutationFn: (changes: EntityPluginChanges) =>
      putEntityPlugin(plugin.plugin_id, changes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["widget-plugins"] });
      toast.success(`${plugin.name} updated`);
    },
    onError: (error) => toast.error(errorText(error)),
  });

  const settingsSchema = SettingsSchemaSchema.safeParse(
    plugin.admin_settings_schema ?? {},
  );
  const permissions = [...new Set(plugin.widgets.flatMap((w) => w.permissions))].sort();
  const handled = plugin.widgets.flatMap((w) =>
    w.handles.map((type) => ({ type, widget: w.id })),
  );

  const saveNarrowing = () =>
    update({
      narrowed_permissions: [...narrowed],
      csp_narrow: Object.fromEntries(
        Object.entries(kept)
          .filter(
            ([directive, sources]) =>
              sources.size !== (plugin.csp.approved[directive] ?? []).length,
          )
          .map(([directive, sources]) => [directive, [...sources]]),
      ),
      server_network_narrow: [...removedHosts],
      settings,
      preset_limit: presetLimit.trim() ? Number(presetLimit) : null,
    });

  return (
    <div
      className="flex flex-col gap-3 rounded border border-general-border-secondary p-4"
      data-testid={`entity-plugin-${plugin.plugin_id}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="body-sm-bold">{plugin.name}</span>
        <span className="body-xs-regular text-ds-text-caption">
          {plugin.plugin_id} {plugin.active_version}
        </span>
        {plugin.status !== "enabled" && <StateTag state={plugin.status} />}
        <div className="ml-auto flex items-center gap-4">
          <Switch
            label="Enabled"
            checked={plugin.enabled}
            disabled={isPending}
            onCheckedChange={(on) => update({ enabled: on })}
          />
          <span className="body-xs-regular text-ds-text-caption">
            Role grants: {plugin.role_grants}
          </span>
          <Button size="xs" variant="secondary" onClick={() => setOpen(!open)}>
            {open ? "Less" : "More"}
          </Button>
        </div>
      </div>
      <p className="body-xs-regular">{plugin.description}</p>
      <p className="body-xs-regular text-ds-text-caption">
        Widgets:{" "}
        {plugin.widgets
          .map(
            (w) =>
              `${w.name}${w.handles.length ? ` (renders ${w.handles.join(", ")})` : ""}`,
          )
          .join("; ")}
        . Network: {plugin.csp.egress.length ? plugin.csp.egress.join(", ") : "none"}.
        {plugin.server.network.effective.length > 0 &&
          ` The server calls ${plugin.server.network.effective.join(", ")} for it.`}
      </p>

      {open && (
        <div className="flex flex-col gap-4">
          {handled.length > 0 && (
            <Section
              title="Widget types"
              hint="When several plugins render the same type, choose which one your organization uses."
            >
              {handled.map(({ type, widget }) => (
                <Checkbox
                  key={type}
                  label={`Render ${type} widgets with this plugin`}
                  checked={plugin.handlers[type] === widget}
                  onCheckedChange={(on) =>
                    update({ handlers: { [type]: on === true ? widget : null } })
                  }
                />
              ))}
            </Section>
          )}

          <Section
            title="Narrow"
            hint="Remove permissions or network sources for your organization. You can only remove what the superuser approved."
          >
            {permissions.map((permission) => (
              <Checkbox
                key={permission}
                label={`Allow ${permission}`}
                checked={!narrowed.has(permission)}
                onCheckedChange={(on) => {
                  const next = new Set(narrowed);
                  if (on === true) next.delete(permission);
                  else next.add(permission);
                  setNarrowed(next);
                }}
              />
            ))}
            {Object.entries(plugin.csp.approved).map(([directive, sources]) =>
              sources
                .filter((source) => source !== "'none'")
                .map((source) => (
                  <Checkbox
                    key={`${directive}-${source}`}
                    label={`${directive} ${source}`}
                    checked={kept[directive]?.has(source) ?? true}
                    onCheckedChange={(on) => {
                      const next = new Set(kept[directive] ?? sources);
                      if (on === true) next.add(source);
                      else next.delete(source);
                      setKept({ ...kept, [directive]: next });
                    }}
                  />
                )),
            )}
            {plugin.server.network.approved.map((host) => (
              <Checkbox
                key={`server-${host}`}
                label={`Let the server call ${host} for this plugin`}
                checked={!removedHosts.has(host)}
                onCheckedChange={(on) => {
                  const next = new Set(removedHosts);
                  if (on === true) next.delete(host);
                  else next.add(host);
                  setRemovedHosts(next);
                }}
              />
            ))}
          </Section>

          {plugin.data_sources.length > 0 && (
            <Section
              title="Data sources"
              hint="The plugin's backend reads these for each user, with that user's access. Choose which of your organization's backends serves each one."
            >
              {plugin.data_sources.map((source) => (
                <label
                  key={source.id}
                  className="flex flex-wrap items-center gap-2 body-xs-regular"
                >
                  <span className="body-xs-medium font-mono">{source.id}</span>
                  <span className="text-ds-text-caption">{source.purpose}</span>
                  <select
                    aria-label={`Backend that serves ${source.id}`}
                    className="rounded border border-general-border-secondary bg-transparent p-1 body-xs-regular"
                    value={source.backend_uuid ?? ""}
                    disabled={isPending}
                    onChange={(e) =>
                      update({ data_sources: { [source.id]: e.target.value || null } })
                    }
                  >
                    <option value="">Not served</option>
                    {backends.map((backend) => (
                      <option key={backend.uuid} value={backend.uuid}>
                        {backend.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </Section>
          )}

          <Section
            title="Presets"
            hint="How many presets each user may keep of each of this plugin's widgets. Leave it empty for the default."
          >
            <label className="flex items-center gap-2 body-xs-regular">
              <span className="body-xs-medium">Presets per user and widget</span>
              <input
                type="number"
                min={1}
                max={100000}
                className="w-24 rounded border border-general-border-secondary bg-transparent p-1 body-xs-regular"
                value={presetLimit}
                disabled={isPending}
                onChange={(e) => setPresetLimit(e.target.value)}
              />
            </label>
          </Section>

          {settingsSchema.success &&
            Object.keys(settingsSchema.data.properties ?? {}).length > 0 && (
              <Section title="Settings">
                <SettingsForm
                  schema={settingsSchema.data}
                  values={settings}
                  onChange={setSettings}
                />
              </Section>
            )}

          <div>
            <Button
              size="sm"
              variant="primary"
              disabled={isPending}
              onClick={saveNarrowing}
            >
              Save
            </Button>
          </div>

          <BlockedRequests pluginId={plugin.plugin_id} scope="entity" />
          <PluginEvents pluginId={plugin.plugin_id} scope="entity" />
        </div>
      )}
    </div>
  );
}
