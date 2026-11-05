import type { PluginStatus, Risk, VersionState } from "~/api/plugins.api";
import { Tag } from "~/components/ds/atoms/Tag";

const STATE_COLORS: Record<
  VersionState | PluginStatus,
  "grey" | "success" | "warning" | "danger" | "brand" | "yellow"
> = {
  discovered: "brand",
  development: "yellow",
  active: "success",
  blocked: "danger",
  retired: "grey",
  missing: "warning",
  disabled: "grey",
  enabled: "success",
  revoked: "danger",
};

export function StateTag({ state }: { state: VersionState | PluginStatus }) {
  return <Tag color={STATE_COLORS[state] ?? "grey"}>{state}</Tag>;
}

const RISK_COLORS: Record<Risk, "grey" | "success" | "warning" | "danger" | "yellow"> =
  {
    none: "grey",
    low: "success",
    medium: "yellow",
    high: "warning",
    critical: "danger",
  };

export function RiskTag({ risk }: { risk: Risk }) {
  if (risk === "none") return null;
  return <Tag color={RISK_COLORS[risk]}>{risk} risk</Tag>;
}

export function shortDigest(digest: string | null | undefined) {
  if (!digest) return "-";
  return `${digest.slice(0, 15)}…${digest.slice(-6)}`;
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatWhen(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function errorText(error: unknown): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response
    ?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => (item as { msg?: unknown })?.msg)
      .filter((msg) => typeof msg === "string")
      .join("; ");
  }
  if (detail && typeof detail === "object") {
    const { message, errors, missing } = detail as {
      message?: string;
      errors?: string[];
      missing?: string[];
    };
    return [message, ...(errors ?? []), ...(missing ?? [])].filter(Boolean).join("; ");
  }
  return error instanceof Error ? error.message : "Something went wrong";
}

export function Section(props: {
  title: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="body-sm-bold">{props.title}</h3>
      {props.hint && (
        <p className="body-xs-regular text-ds-text-caption">{props.hint}</p>
      )}
      {props.children}
    </section>
  );
}
