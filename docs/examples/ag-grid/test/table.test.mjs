import assert from "node:assert/strict";
import { test } from "node:test";

import { makeModel, mount, settle } from "./dom.mjs";
import plugin from "../src/table.js";

const columnDefs = [
  { field: "id", headerName: "ID" },
  { field: "name", headerName: "Name" },
  { field: "sales", headerName: "Sales", type: "numericColumn" },
];
const rows = [
  { id: 1, name: "Alice", sales: 100 },
  { id: 2, name: "Bob", sales: 250 },
  { id: 3, name: "Carol", sales: 175 },
];

test("the grid renders, exports CSV text and tells the Copilot what it holds", async () => {
  const model = makeModel({ data: { columnDefs, rowData: rows } });
  const { el, abort } = mount();
  const exposed = plugin.initialize({ model });
  await plugin.render({ model, signal: abort.signal, el });
  await settle();

  assert.ok(el.querySelector(".ag-theme-quartz .ag-root-wrapper"));
  assert.equal(el.querySelectorAll(".ag-column-drop-horizontal:not(.ag-hidden)").length, 1);
  assert.ok(el.querySelector(".ag-side-bar"));

  const csv = exposed.exportData("csv");
  assert.match(csv, /Alice/);
  assert.equal(csv.trim().split("\n").length, 4);
  assert.equal(exposed.exportData("pdf"), null);

  const ctx = exposed.copilotContext();
  assert.equal(ctx.rowCount, 3);
  assert.deepEqual(ctx.columns, ["id", "name", "sales"]);
  assert.deepEqual(ctx.stats.sales, { count: 3, min: 100, max: 250, sum: 525, avg: 175 });
  assert.deepEqual(ctx.sortModel, []);
  assert.deepEqual(ctx.grouping, { rowGroups: [], pivots: [], values: [], pivotMode: false });
  assert.equal(model.get("state").rowCount, 3);

  abort.abort();
});

test("rows with ids stream in as a transaction, rows without ids replace the data", async () => {
  const model = makeModel({ data: { columnDefs, rowData: rows } });
  const { el, abort } = mount();
  const exposed = plugin.initialize({ model });
  await plugin.render({ model, signal: abort.signal, el });
  await settle();

  model.values.data = { columnDefs, rowData: [...rows.slice(1), { id: 4, name: "Dave", sales: 300 }] };
  model.emit("change:data");
  await settle();
  assert.equal(exposed.copilotContext().rowCount, 3);
  assert.equal(exposed.copilotContext().stats.sales.sum, 250 + 175 + 300);

  model.values.data = [{ name: "x", sales: 1 }, { name: "y", sales: 2 }];
  model.emit("change:data");
  await settle();
  const ctx = exposed.copilotContext();
  assert.equal(ctx.rowCount, 2);
  assert.deepEqual(ctx.columns, ["name", "sales"]);

  abort.abort();
});

test("the light and dark theme follow the model, and abort cleans up", async () => {
  const model = makeModel({ data: { columnDefs, rowData: rows } });
  const { el, abort } = mount();
  plugin.initialize({ model });
  await plugin.render({ model, signal: abort.signal, el });
  await settle();

  model.values.theme = { mode: "dark" };
  model.emit("change:theme");
  assert.ok(el.querySelector(".ag-theme-quartz-dark"));
  assert.equal(el.querySelector(".ag-theme-quartz"), null);

  abort.abort();
  assert.equal(model.listenerCount("change:data"), 0);
  assert.equal(model.listenerCount("change:theme"), 0);
});

test("the card's actions clear the filters and sort, and the toggle shows floating filters", async () => {
  const model = makeModel({ data: { columnDefs, rowData: rows }, config: {} });
  const { el, abort } = mount();
  const exposed = plugin.initialize({ model });
  await plugin.render({ model, signal: abort.signal, el });
  await settle();
  assert.equal(el.querySelector(".ag-floating-filter"), null);

  model.values.config = { floatingFilters: true };
  model.emit("change:config");
  await settle();
  assert.ok(el.querySelector(".ag-floating-filter"));

  const api = exposed.copilotContext;
  model.emit("msg:custom", { kind: "workspace-event", name: "action", id: "clear-filters" });
  await settle();
  assert.deepEqual(api().sortModel, []);

  model.emit("msg:custom", { kind: "workspace-event", name: "action", id: "autosize" });
  model.emit("msg:custom", { kind: "workspace-event", name: "refresh" });
  await settle();

  abort.abort();
});
