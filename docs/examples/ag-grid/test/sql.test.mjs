import assert from "node:assert/strict";
import { test } from "node:test";

import "./dom.mjs";
import { formatCell, gridColumns, gridRows, staticTableData } from "../src/sql.js";

const result = {
  columns: [{ name: "site", type: "VARCHAR" }, { name: "n", type: "BIGINT" }, { name: "n", type: "BIGINT" }, { name: "a.b", type: "VARCHAR" }],
  rows: [["north", 1234567, 2, null], ["south", 3, 4, "x"]],
  truncated: false,
};

test("a result as AgGrid columns and rows, addressed by position", () => {
  const columns = gridColumns(result);
  assert.deepEqual(columns.map((c) => [c.field, c.headerName]), [["0", "site"], ["1", "n"], ["2", "n"], ["3", "a.b"]]);
  assert.equal(columns[0].type, undefined);
  assert.equal(columns[1].type, "numericColumn");
  assert.deepEqual(gridRows(result)[0], { 0: "north", 1: 1234567, 2: 2, 3: null });
});

test("a cell shows NULL, grouped numbers and JSON", () => {
  assert.equal(formatCell({ value: null }), "NULL");
  assert.equal(formatCell({ value: 1234567.5 }), new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(1234567.5));
  assert.equal(formatCell({ value: "12345678901234567890" }), "12345678901234567890");
  assert.equal(formatCell({ value: { a: 1 } }), '{"a":1}');
});

test("a static copy keeps the columns and rows the table widget's artifact takes", () => {
  const long = "x".repeat(600);
  const many = { ...result, rows: [...Array(1200)].map((_, i) => ["s", i, i, { at: i }]).concat([["s", 0, 0, long]]) };
  const data = staticTableData(many);
  assert.deepEqual(data.columnDefs, [
    { field: "0", headerName: "site" },
    { field: "1", headerName: "n", type: "numericColumn" },
    { field: "2", headerName: "n", type: "numericColumn" },
    { field: "3", headerName: "a.b" },
  ]);
  assert.equal(data.rowData.length, 1000);
  assert.deepEqual(data.rowData[7], { 0: "s", 1: 7, 2: 7, 3: '{"at":7}' });
  assert.equal(staticTableData({ ...result, rows: [["s", 0, 0, long]] }).rowData[0][3].length, 500);
});

test("a static copy keeps the first 60 columns and stays under 380,000 bytes", () => {
  const wide = {
    columns: [...Array(80)].map((_, i) => ({ name: `c${i}`, type: "VARCHAR" })),
    rows: [...Array(1000)].map(() => [...Array(80)].map(() => "y".repeat(200))),
    truncated: false,
  };
  const data = staticTableData(wide);
  assert.equal(data.columnDefs.length, 60);
  assert.deepEqual(Object.keys(data.rowData[0]), data.columnDefs.map((c) => c.field));
  const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
  assert.ok(bytes <= 380_000, `${bytes} bytes`);
  assert.ok(data.rowData.length > 0 && data.rowData.length < 1000);
});
