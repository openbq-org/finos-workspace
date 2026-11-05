import type { ExportMember } from "./protocol";

export const PING_INTERVAL_MS = 5000;
export const MISSED_PINGS = 3;
export const MAX_PENDING_COMMANDS = 32;
export const COMMAND_TIMEOUT_MS = 10_000;
export const REPORT_INTERVAL_MS = 5000;
export const MAX_REPORTS_PER_FLUSH = 50;
export const GUEST_MESSAGE_RATE = { perSecond: 100, burst: 200 } as const;
export const VIOLATION_LIMIT = { count: 3, windowMs: 10_000 } as const;
export const NOTIFY_RATE = { perSecond: 0.5, burst: 5 } as const;
export const SERVER_CALL_RATE = { perSecond: 2, burst: 10 } as const;
export const PRESET_SAVE_RATE = { perSecond: 1, burst: 3 } as const;
export const MAX_PRESET_NAME = 80;
export const LOAD_TIMEOUTS_MS = { initialize: 15_000, render: 15_000 } as const;
export const MAX_NOTIFY_LENGTH = 500;
export const NOTIFY_LEVELS = ["info", "success", "warning", "error"] as const;
export const LINK_PROTOCOLS = ["https:", "mailto:"] as const;
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;
export const MAX_COPILOT_CONTEXT_BYTES = 256 * 1024;
export const MAX_EXPORT_OPTIONS = 16;
export const ACTION_GRANT_MS = 10_000;
export const MAX_NAVBAR_ACTIONS = 3;
export const MAX_MENU_ACTIONS = 8;
export const MAX_ADDED_WIDGET_BYTES = 384 * 1024;
export const EXPORT_TIMEOUTS_MS: Record<ExportMember, number> = {
  exportOptions: 10_000,
  exportData: 60_000,
  copilotContext: 10_000,
};
