// tools/dataManagement.js
// Tools for loading, inspecting, filtering and managing datasets.
// Supports CSV, TSV, JSON (array of objects), and Excel (.xlsx/.xls) files.

import { parse as csvParse } from "csv-parse/sync";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { log } from "../utils/logger.js";
import { buildTable, fmtNum, kv } from "../utils/format.js";
import {
  storeDataset, getDataset, listDatasets, dropDataset,
  clearAllDatasets, inferColumnMeta, coerceColumn,
} from "../store/dataStore.js";

// -----------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------

export const dataLoadToolDefinition = {
  name: "data_load",
  description:
    "Loads a dataset from a file (CSV, TSV, JSON, or Excel) or from inline data pasted directly. " +
    "Stores the dataset in memory under a given name for use by all analysis tools. " +
    "Automatically detects column types (numeric, categorical, datetime). " +
    "For inline data: paste CSV/TSV rows directly in the 'inline_data' field.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name to store the dataset under (e.g. 'sales', 'survey'). Used in all subsequent tool calls.",
      },
      file_path: {
        type: "string",
        description: "Absolute path to a CSV, TSV, JSON, or Excel file. One of file_path or inline_data is required.",
      },
      inline_data: {
        type: "string",
        description: "Paste CSV or TSV data directly here as a string. First row must be headers. One of file_path or inline_data is required.",
      },
      format: {
        type: "string",
        description: "File format: 'csv', 'tsv', 'json', 'excel'. Auto-detected from file extension if omitted.",
        enum: ["csv", "tsv", "json", "excel"],
      },
      delimiter: {
        type: "string",
        description: "Column delimiter for CSV/TSV. Auto-detected if omitted.",
      },
      has_header: {
        type: "boolean",
        description: "Whether the first row is a header. Defaults to true.",
      },
      sheet: {
        type: "string",
        description: "Sheet name or number (0-based) for Excel files. Defaults to first sheet.",
      },
    },
    required: ["name"],
  },
};

export const dataInfoToolDefinition = {
  name: "data_info",
  description:
    "Returns a comprehensive overview of a loaded dataset: row count, column count, " +
    "column names, data types, missing value counts, unique value counts, and a preview of the first 5 rows. " +
    "Call this immediately after loading data to understand its structure.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name (from data_load)." },
    },
    required: ["dataset"],
  },
};

export const dataPreviewToolDefinition = {
  name: "data_preview",
  description: "Shows the first or last N rows of a dataset as a formatted table.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      rows: { type: "number", description: "Number of rows to show (default 10, max 100).", minimum: 1, maximum: 100 },
      from: { type: "string", description: "'start' (first N rows) or 'end' (last N rows). Default 'start'.", enum: ["start", "end"] },
      columns: { type: "array", items: { type: "string" }, description: "Specific columns to show. Shows all if omitted." },
    },
    required: ["dataset"],
  },
};

export const dataListToolDefinition = {
  name: "data_list",
  description: "Lists all datasets currently loaded in memory with their sizes, row counts, and load times.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const dataDropToolDefinition = {
  name: "data_drop",
  description: "Removes a dataset from memory to free up space.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name to remove." },
    },
    required: ["dataset"],
  },
};

export const dataFilterToolDefinition = {
  name: "data_filter",
  description:
    "Creates a filtered subset of a dataset and stores it as a new named dataset. " +
    "Supports filtering by numeric range, categorical membership, null exclusion, and string matching.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Source dataset name." },
      output_name: { type: "string", description: "Name for the filtered output dataset." },
      filters: {
        type: "array",
        description: "List of filter conditions (all must be true - AND logic).",
        items: {
          type: "object",
          properties: {
            column: { type: "string", description: "Column to filter on." },
            operator: {
              type: "string",
              description: "Filter operator.",
              enum: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "not_null", "is_null"],
            },
            value: { description: "Value to compare against. For 'in'/'not_in' use an array." },
          },
          required: ["column", "operator"],
        },
      },
    },
    required: ["dataset", "output_name", "filters"],
  },
};

export const dataSelectToolDefinition = {
  name: "data_select",
  description: "Creates a new dataset containing only the specified columns (and optionally renamed).",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Source dataset name." },
      output_name: { type: "string", description: "Name for the output dataset." },
      columns: { type: "array", items: { type: "string" }, description: "Column names to keep." },
      rename: {
        type: "object",
        description: "Optional: map of old_name -> new_name for renaming columns.",
        additionalProperties: { type: "string" },
      },
    },
    required: ["dataset", "output_name", "columns"],
  },
};

export const dataSampleToolDefinition = {
  name: "data_sample",
  description: "Creates a random sample of a dataset as a new named dataset. Useful for testing analysis on large datasets.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Source dataset name." },
      output_name: { type: "string", description: "Name for the sampled dataset." },
      n: { type: "number", description: "Number of rows to sample. One of n or fraction is required.", minimum: 1 },
      fraction: { type: "number", description: "Fraction of rows to sample (0.0-1.0). One of n or fraction is required.", minimum: 0.001, maximum: 1.0 },
      seed: { type: "number", description: "Random seed for reproducibility." },
    },
    required: ["dataset", "output_name"],
  },
};

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleDataLoad(args) {
  const name = (args?.name || "").trim();
  if (!name) throw new Error("'name' is required.");
  if (!args?.file_path && !args?.inline_data) {
    throw new Error("Either 'file_path' or 'inline_data' is required.");
  }

  let rawText = "";
  let fmt = (args?.format || "").toLowerCase();
  let source = args?.file_path || "inline";

  if (args?.inline_data) {
    rawText = args.inline_data;
    fmt = fmt || "csv";
  } else {
    const fp = args.file_path;
    if (!existsSync(fp)) throw new Error(`File not found: ${fp}`);
    rawText = readFileSync(fp, "utf-8");
    if (!fmt) {
      const ext = fp.split(".").pop().toLowerCase();
      fmt = { csv: "csv", tsv: "tsv", txt: "csv", json: "json", xlsx: "excel", xls: "excel" }[ext] || "csv";
    }
  }

  let columnNames = [];
  const columnsMap = new Map();

  if (fmt === "excel") {
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    if (args?.file_path) {
      await wb.xlsx.readFile(args.file_path);
    } else {
      throw new Error("Excel format requires a file_path (inline not supported for Excel).");
    }
    const sheetArg = args?.sheet;
    let ws;
    if (sheetArg !== undefined) {
      ws = typeof sheetArg === "number"
        ? wb.worksheets[sheetArg]
        : wb.getWorksheet(sheetArg);
    } else {
      ws = wb.worksheets[0];
    }
    if (!ws) throw new Error("Worksheet not found.");

    const rows = [];
    ws.eachRow((row) => { rows.push(row.values.slice(1)); });
    if (rows.length === 0) throw new Error("Excel sheet is empty.");

    columnNames = rows[0].map(String);
    const dataRows = rows.slice(1);
    for (const col of columnNames) columnsMap.set(col, []);
    for (const row of dataRows) {
      columnNames.forEach((col, i) => {
        columnsMap.get(col).push(row[i] ?? null);
      });
    }
  } else if (fmt === "json") {
    let parsed;
    try { parsed = JSON.parse(rawText); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
    if (!Array.isArray(parsed)) throw new Error("JSON data must be an array of objects.");
    if (parsed.length === 0) throw new Error("JSON array is empty.");
    columnNames = Object.keys(parsed[0]);
    for (const col of columnNames) columnsMap.set(col, []);
    for (const row of parsed) {
      for (const col of columnNames) columnsMap.get(col).push(row[col] ?? null);
    }
  } else {
    // CSV or TSV
    const delimiter = args?.delimiter ||
      (fmt === "tsv" ? "\t" : rawText.split("\n")[0].includes("\t") ? "\t" : ",");
    let records;
    try {
      records = csvParse(rawText, {
        delimiter,
        columns: args?.has_header !== false,
        skip_empty_lines: true,
        trim: true,
        relax_quotes: true,
        relax_column_count: true,
      });
    } catch (e) {
      throw new Error(`CSV parse error: ${e.message}`);
    }
    if (records.length === 0) throw new Error("File is empty or has no data rows.");
    columnNames = Object.keys(records[0]);
    for (const col of columnNames) columnsMap.set(col, []);
    for (const row of records) {
      for (const col of columnNames) columnsMap.get(col).push(row[col] ?? null);
    }
  }

  // Infer and coerce column types
  for (const col of columnNames) {
    const rawVals = columnsMap.get(col);
    const meta = inferColumnMeta(col, rawVals);
    columnsMap.set(col, coerceColumn(rawVals, meta.type));
  }

  const ds = storeDataset(name, columnNames, columnsMap, source);

  const typesSummary = ds.columnMeta
    .map((m) => `  ${m.name.padEnd(30)} ${m.type.padEnd(12)} ${m.nullCount > 0 ? `(${m.nullCount} nulls)` : ""}`)
    .join("\n");

  return {
    content: [
      {
        type: "text",
        text:
          `Dataset loaded: "${name}"\n` +
          `${"=".repeat(50)}\n` +
          `Rows:      ${ds.rowCount.toLocaleString()}\n` +
          `Columns:   ${ds.columnNames.length}\n` +
          `Source:    ${source}\n` +
          `Loaded at: ${ds.loadedAt}\n` +
          `Memory:    ~${ds.sizeBytes > 1024 * 1024 ? (ds.sizeBytes / (1024 * 1024)).toFixed(1) + "MB" : (ds.sizeBytes / 1024).toFixed(1) + "KB"}\n\n` +
          `Columns:\n${typesSummary}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleDataInfo(args) {
  const ds = getDataset(args?.dataset);

  const rows = [];
  for (const meta of ds.columnMeta) {
    const col = ds.columns.get(meta.name) || [];
    const nonNull = col.filter((v) => v !== null && v !== undefined).length;
    rows.push([
      meta.name,
      meta.type,
      nonNull.toLocaleString(),
      meta.nullCount.toLocaleString(),
      `${((meta.nullCount / ds.rowCount) * 100).toFixed(1)}%`,
      meta.uniqueCount.toLocaleString(),
    ]);
  }

  const table = buildTable(
    ["Column", "Type", "Non-Null", "Nulls", "Null%", "Unique"],
    rows
  );

  // Preview first 3 rows
  const previewCols = ds.columnNames.slice(0, 8);
  const previewRows = [];
  for (let i = 0; i < Math.min(3, ds.rowCount); i++) {
    previewRows.push(previewCols.map((c) => {
      const v = ds.columns.get(c)?.[i];
      return v === null || v === undefined ? "NULL" : String(v).slice(0, 20);
    }));
  }
  const previewTable = buildTable(previewCols, previewRows);

  return {
    content: [
      {
        type: "text",
        text:
          `Dataset Info: "${ds.name}"\n` +
          `${"=".repeat(60)}\n` +
          `Rows: ${ds.rowCount.toLocaleString()}   Columns: ${ds.columnNames.length}   Source: ${ds.source}\n` +
          `Loaded: ${ds.loadedAt}\n\n` +
          `Column Summary:\n${table}\n\n` +
          `First 3 rows (first 8 columns):\n${previewTable}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleDataPreview(args) {
  const ds = getDataset(args?.dataset);
  const n = Math.min(Math.max(Number(args?.rows) || 10, 1), 100);
  const from = args?.from || "start";
  const selectedCols = args?.columns?.length ? args.columns : ds.columnNames.slice(0, 12);

  for (const c of selectedCols) {
    if (!ds.columns.has(c)) throw new Error(`Column "${c}" not found.`);
  }

  const startIdx = from === "end" ? Math.max(0, ds.rowCount - n) : 0;
  const endIdx = from === "end" ? ds.rowCount : Math.min(n, ds.rowCount);

  const tableRows = [];
  for (let i = startIdx; i < endIdx; i++) {
    tableRows.push(
      selectedCols.map((c) => {
        const v = ds.columns.get(c)?.[i];
        if (v === null || v === undefined) return "NULL";
        return String(v).slice(0, 25);
      })
    );
  }

  const table = buildTable(["#", ...selectedCols], tableRows.map((r, i) => [startIdx + i + 1, ...r]));

  return {
    content: [
      {
        type: "text",
        text: `Preview: "${ds.name}" (${from === "end" ? "last" : "first"} ${tableRows.length} of ${ds.rowCount.toLocaleString()} rows)\n\n${table}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleDataList(_args) {
  const datasets = listDatasets();
  if (datasets.length === 0) {
    return { content: [{ type: "text", text: "No datasets loaded. Use data_load to load data." }] };
  }
  const rows = datasets.map((d) => [
    d.name,
    d.rows.toLocaleString(),
    String(d.columns),
    d.sizeHuman,
    d.source.slice(0, 40),
    d.loadedAt.slice(0, 19),
  ]);
  const table = buildTable(["Name", "Rows", "Cols", "Memory", "Source", "Loaded"], rows);
  return { content: [{ type: "text", text: `Loaded Datasets (${datasets.length})\n\n${table}` }] };
}

// -----------------------------------------------------------------------

export async function handleDataDrop(args) {
  const name = args?.dataset;
  const dropped = dropDataset(name);
  return {
    content: [
      {
        type: "text",
        text: dropped
          ? `Dataset "${name}" removed from memory.`
          : `Dataset "${name}" was not found.`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleDataFilter(args) {
  const ds = getDataset(args?.dataset);
  const outName = (args?.output_name || "").trim();
  if (!outName) throw new Error("'output_name' is required.");
  const filters = args?.filters || [];
  if (!filters.length) throw new Error("At least one filter is required.");

  // Validate all filter columns exist
  for (const f of filters) {
    if (!ds.columns.has(f.column)) throw new Error(`Filter column "${f.column}" not found.`);
  }

  const included = [];
  for (let i = 0; i < ds.rowCount; i++) {
    let pass = true;
    for (const f of filters) {
      const v = ds.columns.get(f.column)?.[i];
      const fv = f.value;

      switch (f.operator) {
        case "eq":       pass = v == fv; break;
        case "ne":       pass = v != fv; break;
        case "gt":       pass = Number(v) > Number(fv); break;
        case "gte":      pass = Number(v) >= Number(fv); break;
        case "lt":       pass = Number(v) < Number(fv); break;
        case "lte":      pass = Number(v) <= Number(fv); break;
        case "in":       pass = Array.isArray(fv) && fv.includes(v); break;
        case "not_in":   pass = !Array.isArray(fv) || !fv.includes(v); break;
        case "contains": pass = v !== null && String(v).toLowerCase().includes(String(fv).toLowerCase()); break;
        case "not_null": pass = v !== null && v !== undefined; break;
        case "is_null":  pass = v === null || v === undefined; break;
        default:         throw new Error(`Unknown operator: ${f.operator}`);
      }
      if (!pass) break;
    }
    if (pass) included.push(i);
  }

  const newCols = new Map();
  for (const col of ds.columnNames) {
    newCols.set(col, included.map((i) => ds.columns.get(col)?.[i] ?? null));
  }

  storeDataset(outName, ds.columnNames, newCols, `filtered from "${ds.name}"`);

  return {
    content: [
      {
        type: "text",
        text:
          `Filter applied. New dataset: "${outName}"\n` +
          `Original rows: ${ds.rowCount.toLocaleString()}\n` +
          `Filtered rows: ${included.length.toLocaleString()}\n` +
          `Removed:       ${(ds.rowCount - included.length).toLocaleString()} (${(((ds.rowCount - included.length) / ds.rowCount) * 100).toFixed(1)}%)\n` +
          `Filters applied: ${filters.map((f) => `${f.column} ${f.operator} ${f.value ?? ""}`).join(", ")}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleDataSelect(args) {
  const ds = getDataset(args?.dataset);
  const outName = (args?.output_name || "").trim();
  const cols = args?.columns || [];
  const rename = args?.rename || {};

  if (!outName) throw new Error("'output_name' is required.");
  if (!cols.length) throw new Error("'columns' array is required.");
  for (const c of cols) {
    if (!ds.columns.has(c)) throw new Error(`Column "${c}" not found.`);
  }

  const newCols = new Map();
  const newNames = [];
  for (const c of cols) {
    const newName = rename[c] || c;
    newCols.set(newName, ds.columns.get(c));
    newNames.push(newName);
  }

  storeDataset(outName, newNames, newCols, `selected from "${ds.name}"`);

  return {
    content: [
      {
        type: "text",
        text:
          `Columns selected. New dataset: "${outName}"\n` +
          `Rows: ${ds.rowCount.toLocaleString()}\n` +
          `Columns (${newNames.length}): ${newNames.join(", ")}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleDataSample(args) {
  const ds = getDataset(args?.dataset);
  const outName = (args?.output_name || "").trim();
  if (!outName) throw new Error("'output_name' is required.");

  let sampleSize;
  if (args?.n) {
    sampleSize = Math.min(Math.max(Number(args.n), 1), ds.rowCount);
  } else if (args?.fraction) {
    sampleSize = Math.max(1, Math.round(ds.rowCount * Number(args.fraction)));
  } else {
    throw new Error("Either 'n' or 'fraction' is required.");
  }

  // Seeded shuffle using a simple LCG for reproducibility
  const seed = Number(args?.seed) || Math.floor(Math.random() * 1e9);
  const indices = Array.from({ length: ds.rowCount }, (_, i) => i);
  let s = seed;
  for (let i = indices.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = Math.abs(s) % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const sampled = indices.slice(0, sampleSize).sort((a, b) => a - b);

  const newCols = new Map();
  for (const col of ds.columnNames) {
    newCols.set(col, sampled.map((i) => ds.columns.get(col)?.[i] ?? null));
  }

  storeDataset(outName, ds.columnNames, newCols, `sampled from "${ds.name}"`);

  return {
    content: [
      {
        type: "text",
        text:
          `Random sample created. New dataset: "${outName}"\n` +
          `Original rows: ${ds.rowCount.toLocaleString()}\n` +
          `Sample rows:   ${sampleSize.toLocaleString()} (${((sampleSize / ds.rowCount) * 100).toFixed(1)}%)\n` +
          `Seed used:     ${seed}`,
      },
    ],
  };
}
