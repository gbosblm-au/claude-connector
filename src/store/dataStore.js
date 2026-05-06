// store/dataStore.js
// In-memory dataset store for the stats-connector.
//
// Design decisions:
//   - Column-wise storage: each column is a typed Float64Array or string[] for
//     cache-efficient sequential access during statistical computation.
//   - Multiple named datasets can be loaded simultaneously.
//   - Row limit of 2,000,000 rows per dataset (practical memory ceiling on Railway free tier).
//   - Summary metadata cached on load and invalidated on mutation.

import { log } from "../utils/logger.js";

const MAX_ROWS = 2_000_000;
const MAX_DATASETS = 20;

// Registry: datasetName -> DatasetEntry
const registry = new Map();

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

/**
 * @typedef {Object} ColumnMeta
 * @property {string} name
 * @property {"numeric"|"categorical"|"datetime"|"boolean"|"mixed"} type
 * @property {number} nullCount
 * @property {number} uniqueCount
 */

/**
 * @typedef {Object} DatasetEntry
 * @property {string} name
 * @property {Map<string, number[]|string[]>} columns  column name -> values array
 * @property {string[]} columnNames  ordered list of column names
 * @property {ColumnMeta[]} columnMeta
 * @property {number} rowCount
 * @property {string} loadedAt
 * @property {string} source  filename or description
 * @property {number} sizeBytes  approximate memory size
 */

// -----------------------------------------------------------------------
// Store operations
// -----------------------------------------------------------------------

export function storeDataset(name, columnNames, columns, source = "") {
  if (registry.size >= MAX_DATASETS && !registry.has(name)) {
    throw new Error(
      `Dataset limit reached (${MAX_DATASETS}). Drop an existing dataset first with data_drop.`
    );
  }

  const rowCount = columnNames.length > 0
    ? (columns.get(columnNames[0])?.length || 0)
    : 0;

  if (rowCount > MAX_ROWS) {
    throw new Error(
      `Dataset has ${rowCount.toLocaleString()} rows which exceeds the ${MAX_ROWS.toLocaleString()} row limit.`
    );
  }

  const columnMeta = columnNames.map((col) =>
    inferColumnMeta(col, columns.get(col) || [])
  );

  // Approximate size: numeric cols ~8 bytes/value, string cols ~50 bytes avg
  const sizeBytes = columnNames.reduce((total, col) => {
    const meta = columnMeta.find((m) => m.name === col);
    const rows = columns.get(col)?.length || 0;
    return total + rows * (meta?.type === "numeric" ? 8 : 50);
  }, 0);

  registry.set(name, {
    name,
    columns,
    columnNames,
    columnMeta,
    rowCount,
    loadedAt: new Date().toISOString(),
    source,
    sizeBytes,
  });

  log("info", `Dataset stored: "${name}" (${rowCount.toLocaleString()} rows x ${columnNames.length} cols, ~${formatBytes(sizeBytes)})`);
  return registry.get(name);
}

export function getDataset(name) {
  const ds = registry.get(name);
  if (!ds) {
    const available = [...registry.keys()];
    throw new Error(
      `Dataset "${name}" not found.` +
      (available.length > 0
        ? ` Available datasets: ${available.join(", ")}`
        : " No datasets loaded. Use data_load to load data first.")
    );
  }
  return ds;
}

export function listDatasets() {
  return [...registry.values()].map((ds) => ({
    name: ds.name,
    rows: ds.rowCount,
    columns: ds.columnNames.length,
    source: ds.source,
    loadedAt: ds.loadedAt,
    sizeBytes: ds.sizeBytes,
    sizeHuman: formatBytes(ds.sizeBytes),
  }));
}

export function dropDataset(name) {
  const had = registry.delete(name);
  if (had) log("info", `Dataset dropped: "${name}"`);
  return had;
}

export function clearAllDatasets() {
  const count = registry.size;
  registry.clear();
  log("info", `All ${count} datasets cleared`);
  return count;
}

// -----------------------------------------------------------------------
// Column extraction helpers
// -----------------------------------------------------------------------

/**
 * Returns the numeric values of a column, skipping nulls/NaN.
 */
export function getNumericColumn(ds, colName) {
  const col = ds.columns.get(colName);
  if (!col) throw new Error(`Column "${colName}" not found in dataset "${ds.name}".`);
  const meta = ds.columnMeta.find((m) => m.name === colName);
  if (meta && meta.type !== "numeric") {
    throw new Error(
      `Column "${colName}" is type "${meta.type}", not numeric. ` +
      `Numeric columns: ${ds.columnMeta.filter(m => m.type === "numeric").map(m => m.name).join(", ")}`
    );
  }
  return col.filter((v) => v !== null && v !== undefined && !isNaN(v));
}

/**
 * Returns numeric values of multiple columns as a 2D array (rows x cols),
 * only including rows where ALL specified columns have valid numeric values.
 */
export function getNumericMatrix(ds, colNames) {
  const cols = colNames.map((name) => {
    const col = ds.columns.get(name);
    if (!col) throw new Error(`Column "${name}" not found.`);
    return col;
  });

  const rows = [];
  const n = ds.rowCount;
  for (let i = 0; i < n; i++) {
    const row = cols.map((c) => c[i]);
    if (row.every((v) => v !== null && v !== undefined && !isNaN(v))) {
      rows.push(row.map(Number));
    }
  }
  return rows;
}

/**
 * Returns a column's values as strings (for categorical analysis).
 */
export function getCategoricalColumn(ds, colName) {
  const col = ds.columns.get(colName);
  if (!col) throw new Error(`Column "${colName}" not found.`);
  return col.map((v) => (v === null || v === undefined ? null : String(v)));
}

// -----------------------------------------------------------------------
// Type inference
// -----------------------------------------------------------------------

export function inferColumnMeta(name, values) {
  let numericCount = 0;
  let nullCount = 0;
  let dateCount = 0;
  const seen = new Set();

  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T|\s|$)/;
  const NUMERIC_RE = /^-?\d*\.?\d+([eE][+-]?\d+)?$/;

  for (const v of values) {
    if (v === null || v === undefined || v === "" || v === "NA" || v === "N/A" || v === "null" || v === "NaN") {
      nullCount++;
      continue;
    }
    const s = String(v).trim();
    seen.add(s);
    if (NUMERIC_RE.test(s)) numericCount++;
    else if (ISO_DATE_RE.test(s)) dateCount++;
  }

  const nonNull = values.length - nullCount;
  let type = "mixed";

  if (nonNull === 0) {
    type = "mixed";
  } else if (numericCount / nonNull >= 0.95) {
    type = "numeric";
  } else if (dateCount / nonNull >= 0.95) {
    type = "datetime";
  } else if (seen.size <= Math.min(50, nonNull * 0.5)) {
    type = "categorical";
  } else {
    type = "categorical";
  }

  return { name, type, nullCount, uniqueCount: seen.size };
}

/**
 * Coerces a raw column (strings from CSV parse) to the appropriate type.
 */
export function coerceColumn(values, type) {
  if (type === "numeric") {
    return values.map((v) => {
      if (v === null || v === undefined || v === "" || v === "NA" || v === "N/A" || v === "null" || v === "NaN") {
        return null;
      }
      const n = Number(v);
      return isNaN(n) ? null : n;
    });
  }
  return values.map((v) =>
    v === null || v === undefined || v === "" || v === "NA" || v === "N/A" || v === "null"
      ? null
      : String(v).trim()
  );
}

// -----------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
