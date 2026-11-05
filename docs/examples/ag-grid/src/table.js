import {
  clientExports,
  createGrid,
  createTracker,
  diffRows,
  gridOptionsFor,
  hasIds,
  licenseKeyOf,
  loadEnterprise,
  normalizeData,
  setTheme,
  themeClass,
} from "./grid.js";

let api = null;
let licensePromise = null;

export default {
  initialize({ model }) {
    licensePromise = loadEnterprise(licenseKeyOf(model));
    return clientExports(() => api);
  },

  async render({ model, el, signal }) {
    await licensePromise;

    el.replaceChildren();

    const modeOf = () => model.get("theme")?.mode ?? "light";
    const tracker = createTracker(model);
    let keyed = false;
    let currentRowData = [];
    let currentColumnDefs = [];
    let currentGridOptions = {};
    let detach = () => {};

    const gridEl = document.createElement("div");
    gridEl.className = themeClass(modeOf());
    gridEl.style.height = "100%";
    gridEl.style.width = "100%";
    el.appendChild(gridEl);

    const floatingFilters = () => model.get("config")?.floatingFilters === true;
    const withFloatingFilters = (gridOptions) => ({
      ...gridOptions,
      defaultColDef: { ...(gridOptions.defaultColDef || {}), floatingFilter: floatingFilters() },
    });

    const mount = ({ rowData, columnDefs, gridOptions }) => {
      currentColumnDefs = columnDefs;
      currentRowData = rowData;
      currentGridOptions = gridOptions;
      keyed = hasIds(rowData);
      api = createGrid(
        gridEl,
        gridOptionsFor({ mode: modeOf(), rowData, columnDefs, gridOptions: withFloatingFilters(gridOptions), keyed }),
      );
      detach = tracker.attach(api);
    };

    const applyRows = (next) => {
      if (keyed) {
        const { add, update, remove } = diffRows(currentRowData, next);
        if (add.length > 0 || update.length > 0 || remove.length > 0) api.applyTransaction({ add, update, remove });
      } else {
        api.setGridOption("rowData", next);
      }
      currentRowData = next;
    };

    mount(normalizeData(model.get("data") || {}));

    const onDataChange = () => {
      const next = normalizeData(model.get("data") || {});
      if (hasIds(next.rowData) !== keyed) {
        detach();
        api.destroy();
        mount(next);
        return;
      }
      if (JSON.stringify(next.columnDefs) !== JSON.stringify(currentColumnDefs)) {
        currentColumnDefs = next.columnDefs;
        api.setGridOption("columnDefs", next.columnDefs);
      }
      if (JSON.stringify(next.gridOptions) !== JSON.stringify(currentGridOptions)) {
        currentGridOptions = next.gridOptions;
        for (const [key, value] of Object.entries(next.gridOptions)) api.setGridOption(key, value);
      }
      applyRows(next.rowData);
    };

    const onThemeChange = () => {
      setTheme(gridEl, api, modeOf());
      api.sizeColumnsToFit();
    };

    const onConfigChange = () => {
      api.setGridOption("defaultColDef", { ...api.getGridOption("defaultColDef"), floatingFilter: floatingFilters() });
    };

    const onEvent = (message) => {
      if (message?.kind !== "workspace-event" || message.name !== "action") return;
      if (message.id === "autosize") api.autoSizeAllColumns();
      if (message.id === "clear-filters") {
        api.setFilterModel(null);
        api.applyColumnState({ defaultState: { sort: null } });
      }
    };

    model.on("change:data", onDataChange);
    model.on("change:theme", onThemeChange);
    model.on("change:config", onConfigChange);
    model.on("msg:custom", onEvent);

    const resizeObserver = new ResizeObserver(() => { if (api) api.sizeColumnsToFit(); });
    resizeObserver.observe(el);

    signal.addEventListener("abort", () => {
      model.off("change:data", onDataChange);
      model.off("change:theme", onThemeChange);
      model.off("change:config", onConfigChange);
      model.off("msg:custom", onEvent);
      detach();
      resizeObserver.disconnect();
      api.destroy();
      api = null;
    });
  },
};
