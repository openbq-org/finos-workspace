import { useId } from "react";
import { LIMITS } from "~/lib/types/widgetsContract";
import { MAX_SETTING_LENGTH, type SettingsSchema } from "./types";

export function SettingsForm(props: {
  schema: SettingsSchema;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const { schema, values, onChange, disabled } = props;
  const formId = useId();
  const entries = Object.entries(schema.properties ?? {});
  if (!entries.length) return <p className="body-xs-regular">No settings.</p>;

  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });

  return (
    <div className="flex flex-col gap-3">
      {entries.map(([key, prop]) => {
        const id = `${formId}-${key}`;
        const label = prop.title ?? key;
        const value = values[key] ?? prop.default;
        let control: React.ReactNode;
        if (Array.isArray(prop.enum)) {
          control = (
            <select
              id={id}
              className="rounded border border-general-border-secondary bg-transparent p-1"
              value={String(value ?? "")}
              disabled={disabled}
              onChange={(e) => {
                const option = prop.enum?.find((o) => String(o) === e.target.value);
                set(key, option);
              }}
            >
              {prop.enum.map((option) => (
                <option key={String(option)} value={String(option)}>
                  {String(option)}
                </option>
              ))}
            </select>
          );
        } else if (prop.type === "boolean") {
          control = (
            <input
              id={id}
              type="checkbox"
              checked={value === true}
              disabled={disabled}
              onChange={(e) => set(key, e.target.checked)}
            />
          );
        } else if (prop.type === "number" || prop.type === "integer") {
          control = (
            <input
              id={id}
              type="number"
              className="rounded border border-general-border-secondary bg-transparent p-1"
              value={typeof value === "number" ? value : ""}
              min={prop.minimum}
              max={prop.maximum}
              step={prop.type === "integer" ? 1 : "any"}
              disabled={disabled}
              onChange={(e) =>
                set(key, e.target.value === "" ? undefined : Number(e.target.value))
              }
            />
          );
        } else {
          control = (
            <input
              id={id}
              type="text"
              className="rounded border border-general-border-secondary bg-transparent p-1"
              value={typeof value === "string" ? value : ""}
              maxLength={prop.maxLength}
              disabled={disabled}
              onChange={(e) => set(key, e.target.value)}
            />
          );
        }
        return (
          <div key={key} className="flex flex-col gap-1">
            <label htmlFor={id} className="body-xs-medium">
              {label}
            </label>
            {control}
            {prop.description && (
              <span className="body-xs-regular text-ds-text-caption">
                {prop.description}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export type CardDetails = { name: string; description: string };

export function CardDetailsForm({
  values,
  onChange,
  disabled,
}: {
  values: CardDetails;
  onChange: (values: CardDetails) => void;
  disabled?: boolean;
}) {
  const formId = useId();
  return (
    <div className="flex flex-col gap-3 pb-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-name`} className="body-xs-medium">
          Name
        </label>
        <input
          id={`${formId}-name`}
          type="text"
          className="rounded border border-general-border-secondary bg-transparent p-1"
          value={values.name}
          maxLength={LIMITS.name}
          disabled={disabled}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-description`} className="body-xs-medium">
          Description
        </label>
        <textarea
          id={`${formId}-description`}
          className="rounded border border-general-border-secondary bg-transparent p-1"
          rows={2}
          value={values.description}
          maxLength={LIMITS.description}
          disabled={disabled}
          onChange={(e) => onChange({ ...values, description: e.target.value })}
        />
      </div>
    </div>
  );
}

export function cleanSettings(
  schema: SettingsSchema | undefined,
  values: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = schema?.properties ?? {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const prop = properties[key];
    if (!prop || value === undefined) continue;
    if (Array.isArray(prop.enum)) {
      if (prop.enum.includes(value as never)) result[key] = value;
      continue;
    }
    if (prop.type === "boolean" && typeof value === "boolean") result[key] = value;
    else if (
      (prop.type === "number" || prop.type === "integer") &&
      typeof value === "number"
    )
      result[key] = prop.type === "integer" ? Math.trunc(value) : value;
    else if (prop.type === "string" && typeof value === "string")
      result[key] = value.slice(0, prop.maxLength ?? MAX_SETTING_LENGTH);
  }
  return result;
}
