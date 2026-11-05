import { createWidget, isNumeric } from "../../sql-explorer/src/widget.js";
import { createGrid, formatNumber, gridOptionsFor, licenseKeyOf, loadEnterprise, setTheme, themeClass } from "./grid.js";

export function formatCell(params) {
  const { value } = params;
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return formatNumber(params);
}

export function gridColumns(result) {
  const first = result.rows[0] ?? [];
  return result.columns.map((column, i) => ({
    field: String(i),
    headerName: column.name,
    headerTooltip: column.type,
    valueFormatter: formatCell,
    ...(isNumeric(column, first[i]) ? { type: "numericColumn" } : {}),
  }));
}

export function gridRows(result) {
  return result.rows.map((row) => Object.fromEntries(row.map((value, i) => [String(i), value])));
}

const MAX_STATIC_ROWS = 1000;
const MAX_STATIC_COLUMNS = 60;
const MAX_STATIC_TEXT = 500;
const MAX_STATIC_BYTES = 380_000;

const byteSize = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function staticValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.slice(0, MAX_STATIC_TEXT);
}

export function staticTableData(result) {
  const columnDefs = gridColumns(result)
    .slice(0, MAX_STATIC_COLUMNS)
    .map(({ field, headerName, type }) => ({
      field,
      headerName: String(headerName).slice(0, 100),
      ...(type ? { type } : {}),
    }));
  const fields = columnDefs.map((column) => column.field);
  let budget = MAX_STATIC_BYTES - byteSize({ columnDefs, rowData: [] });
  const rowData = [];
  for (const row of gridRows(result).slice(0, MAX_STATIC_ROWS)) {
    const copy = Object.fromEntries(fields.map((field) => [field, staticValue(row[field])]));
    budget -= byteSize(copy) + 1;
    if (budget < 0) break;
    rowData.push(copy);
  }
  return { columnDefs, rowData };
}

async function onAction(message, { lastRun, invoke, signal }) {
  if (message.id !== "freeze") return;
  if (!lastRun?.result) throw new Error("Run a query first, then create a static widget of its result.");
  await invoke("core:dashboard:add-widget", { widget: "table", data: staticTableData(lastRun.result) }, { signal });
}

let ready = Promise.resolve();

async function showGrid(host, result, mode) {
  await ready;
  host.classList.add(themeClass(mode));
  const api = createGrid(
    host,
    gridOptionsFor({ mode, rowData: gridRows(result), columnDefs: gridColumns(result) }),
  );
  return {
    setMode: (next) => setTheme(host, api, next),
    destroy: () => api.destroy(),
  };
}

const widget = createWidget({ showGrid, onAction });

export default {
  initialize({ model }) {
    ready = loadEnterprise(licenseKeyOf(model));
    return widget.initialize();
  },
  render: widget.render,
};
