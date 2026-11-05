import type { PluginState, PluginValueType, ProtocolMessage } from "../../data/types";
import { FieldTable, MetricsTable } from "./agent";
import { pluginsData } from "./data";
import { amount, type Unit } from "./format";
import { Chip, ItemList } from "./kit";
import styles from "./styles.module.css";

export function Codes({ items, or }: { items: string[]; or?: boolean }) {
  const last = or ? " or " : " and ";
  return (
    <>
      {items.map((item, index) => (
        <span key={item}>
          {index > 0 ? (index === items.length - 1 ? last : ", ") : ""}
          <code>{item}</code>
        </span>
      ))}
    </>
  );
}

export function FactValue({
  values,
  of,
  unit,
  plain,
  or,
}: {
  values: Record<string, PluginValueType>;
  of: string;
  unit?: Unit;
  plain?: boolean;
  or?: boolean;
}) {
  const value = values[of];
  if (value === undefined) throw new Error(`The reference has no value ${of}`);
  if (Array.isArray(value)) return <Codes items={value} or={or} />;
  if (typeof value === "string") return plain ? <>{value}</> : <code>{value}</code>;
  return <>{amount(value, unit)}</>;
}

export function PluginValue({ of, unit, plain, or }: { of: string; unit?: Unit; plain?: boolean; or?: boolean }) {
  return <FactValue values={pluginsData.values} of={of} unit={unit} plain={plain} or={or} />;
}

export function PluginList({
  of,
  or,
}: {
  of:
    | "permissionsLater"
    | "commandErrors"
    | "exportMembers"
    | "traits"
    | "builtInTypes"
    | "actionIcons"
    | "actionIconTags"
    | "actionIconAttributes";
  or?: boolean;
}) {
  return <Codes items={pluginsData[of]} or={or} />;
}

export function PluginPermissions() {
  return (
    <ItemList
      items={pluginsData.permissions.map((permission) => ({
        key: permission.name,
        title: <code>{permission.name}</code>,
        description: permission.meaning,
      }))}
    />
  );
}

export function PluginStates({ kind }: { kind: "plugin" | "version" }) {
  const states: PluginState[] = pluginsData.states[kind];
  return (
    <ItemList
      items={states.map((state) => ({
        key: state.state,
        title: <code>{state.state}</code>,
        description: state.meaning,
      }))}
    />
  );
}

export function PluginMetrics() {
  return <MetricsTable metrics={pluginsData.metrics} />;
}

export function CspFloor() {
  return (
    <ItemList
      items={pluginsData.cspFloor.map((entry) => ({
        key: entry.directive,
        title: <code>{entry.directive}</code>,
        meta: [["Sources of the floor", <Codes key="sources" items={entry.sources} />]],
      }))}
    />
  );
}

export function MessageTable({ messages }: { messages: ProtocolMessage[] }) {
  return (
    <ItemList
      items={messages.map((message) => ({
        key: message.t,
        title: <code>{message.t}</code>,
        chips: message.fields.length === 0 ? <Chip>no fields</Chip> : undefined,
        description: message.description,
        body: message.fields.length > 0 ? <FieldTable fields={message.fields} depth={1} /> : undefined,
      }))}
    />
  );
}

export function PluginGuestMessages() {
  return <MessageTable messages={pluginsData.guestMessages} />;
}

export function PluginHostMessages() {
  return <MessageTable messages={pluginsData.hostMessages} />;
}

export function PluginExportOption() {
  return <FieldTable fields={pluginsData.exportOption} depth={1} />;
}

export function PluginTraits() {
  return (
    <ItemList
      items={pluginsData.traitTable.map((trait) => ({
        key: trait.name,
        title: <code className={styles.fieldName}>{trait.name}</code>,
        chips: (
          <>
            <Chip>{trait.writableWith === null ? "read only" : "writable"}</Chip>
            {trait.requires === null ? null : <Chip>{`needs ${trait.requires}`}</Chip>}
            {trait.writableWith === null ? null : <Chip>{`writing needs ${trait.writableWith}`}</Chip>}
          </>
        ),
        description: trait.description,
      }))}
    />
  );
}
