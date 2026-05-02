// src/tools/googleSheets.js
//
// Google Sheets integration for claude-connector v8.0.0
//
// TOOLS PROVIDED:
//   sheets_read_range     -- Read values from a named range or A1 notation
//   sheets_write_range    -- Write values to a named range or A1 notation (overwrites)
//   sheets_append_rows    -- Append rows to the end of data in a sheet
//   sheets_get_metadata   -- Return spreadsheet title, sheet list, and basic properties
//
// AUTHENTICATION:
//   Reuses the Google OAuth2 / Service Account infrastructure from googleDrive.js.
//   Additional scope required: https://www.googleapis.com/auth/spreadsheets
//   Add to GOOGLE_DRIVE_SCOPES in Railway Variables (space-separated):
//     GOOGLE_DRIVE_SCOPES=https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets
//
// SPREADSHEET ID:
//   The spreadsheet ID is the string in the Google Sheets URL between /d/ and /edit.
//   Example: https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit
//   Set GOOGLE_SHEETS_ID in env as a default for the most commonly used spreadsheet.

import { config } from "../config.js";
import { log } from "../utils/logger.js";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

// ---------------------------------------------------------------------------
// Auth helper - reuse token infrastructure from googleDrive.js
// ---------------------------------------------------------------------------

async function getSheetsToken() {
  const drive = await import("./googleDrive.js");
  return drive.getAccessToken();
}

async function sheetsFetch(token, url, init = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(init.headers || {}),
  };
  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const err = new Error(
      `Google Sheets API ${init.method || "GET"} ${url} failed (${resp.status}): ${body}`
    );
    err.status = resp.status;
    throw err;
  }
  return resp;
}

function defaultSpreadsheetId() {
  return (config.googleSheetsId || "").trim();
}

function requireSpreadsheetId(args) {
  const id = (args?.spreadsheet_id || defaultSpreadsheetId()).trim();
  if (!id) {
    throw new Error(
      "spreadsheet_id is required. " +
        "Pass it as a parameter or set GOOGLE_SHEETS_ID in Railway Variables. " +
        "The ID is the string between /d/ and /edit in the spreadsheet URL."
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Tool: sheets_get_metadata
// ---------------------------------------------------------------------------

export const sheetsGetMetadataToolDefinition = {
  name: "sheets_get_metadata",
  description:
    "Return metadata about a Google Spreadsheet: title, all sheet names, " +
    "sheet IDs, row/column counts, and basic properties. " +
    "Use this to discover available sheet names before reading or writing.",
  inputSchema: {
    type: "object",
    properties: {
      spreadsheet_id: {
        type: "string",
        description:
          "Google Sheets spreadsheet ID (from the URL). " +
          "Defaults to GOOGLE_SHEETS_ID env var.",
      },
    },
    required: [],
  },
};

export async function handleSheetsGetMetadata(args) {
  const spreadsheetId = requireSpreadsheetId(args);
  const token = await getSheetsToken();
  const resp = await sheetsFetch(
    token,
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties,sheets.properties`
  );
  const data = await resp.json();

  const sheets = (data.sheets || []).map((s) => ({
    sheet_id: s.properties?.sheetId,
    title: s.properties?.title,
    index: s.properties?.index,
    type: s.properties?.sheetType,
    row_count: s.properties?.gridProperties?.rowCount,
    column_count: s.properties?.gridProperties?.columnCount,
  }));

  const lines = [
    `Google Spreadsheet Metadata`,
    `===========================`,
    `Spreadsheet ID: ${data.spreadsheetId}`,
    `Title:          ${data.properties?.title || ""}`,
    `Locale:         ${data.properties?.locale || ""}`,
    `Timezone:       ${data.properties?.timeZone || ""}`,
    ``,
    `Sheets (${sheets.length}):`,
    ...sheets.map(
      (s) =>
        `  [${s.index}] "${s.title}" (ID: ${s.sheet_id}, ${s.row_count} rows x ${s.column_count} cols, type: ${s.type})`
    ),
  ];

  return {
    content: [
      {
        type: "text",
        text: lines.join("\n") + "\n\n" + JSON.stringify(sheets, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool: sheets_read_range
// ---------------------------------------------------------------------------

export const sheetsReadRangeToolDefinition = {
  name: "sheets_read_range",
  description:
    "Read cell values from a Google Sheet using A1 notation or a named range. " +
    "Returns values as a 2D array (rows of columns). " +
    "Example ranges: 'Sheet1!A1:Z100', 'Sheet1', 'A1:D10', 'MyNamedRange'.",
  inputSchema: {
    type: "object",
    properties: {
      spreadsheet_id: {
        type: "string",
        description: "Spreadsheet ID. Defaults to GOOGLE_SHEETS_ID env var.",
      },
      range: {
        type: "string",
        description:
          "A1 notation or named range to read (e.g. 'Sheet1!A1:Z500', 'Sheet1'). " +
          "Omit to read the entire first sheet.",
      },
      value_render_option: {
        type: "string",
        enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
        description:
          "How values are returned. FORMATTED_VALUE (default) returns display strings. " +
          "UNFORMATTED_VALUE returns raw numbers. FORMULA returns formula strings.",
      },
      major_dimension: {
        type: "string",
        enum: ["ROWS", "COLUMNS"],
        description: "Whether to return data organised by ROWS (default) or COLUMNS.",
      },
    },
    required: [],
  },
};

export async function handleSheetsReadRange(args) {
  const spreadsheetId = requireSpreadsheetId(args);
  const range = (args?.range || "").trim() || "Sheet1";
  const valueRenderOption = args?.value_render_option || "FORMATTED_VALUE";
  const majorDimension = args?.major_dimension || "ROWS";

  const params = new URLSearchParams({
    valueRenderOption,
    majorDimension,
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const token = await getSheetsToken();
  const resp = await sheetsFetch(
    token,
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params.toString()}`
  );
  const data = await resp.json();

  const values = data.values || [];
  const rowCount = values.length;
  const colCount = rowCount > 0 ? Math.max(...values.map((r) => r.length)) : 0;

  log("info", `sheets_read_range: ${rowCount} rows x ${colCount} cols from "${range}"`);

  const lines = [
    `Google Sheets Read: ${data.range || range}`,
    `Rows: ${rowCount}, Columns: ${colCount}`,
    `Render option: ${valueRenderOption}`,
    `---`,
  ];

  // Format as a simple text table
  if (rowCount === 0) {
    lines.push("(No data in this range)");
  } else {
    const colWidths = Array.from({ length: colCount }, (_, ci) =>
      Math.min(
        40,
        Math.max(...values.map((row) => String(row[ci] ?? "").length), 3)
      )
    );

    for (const row of values) {
      const padded = Array.from({ length: colCount }, (_, ci) =>
        String(row[ci] ?? "").padEnd(colWidths[ci]).slice(0, colWidths[ci])
      );
      lines.push(padded.join(" | "));
    }
  }

  // Also include raw JSON for programmatic use
  lines.push(`\n--- RAW JSON ---`);
  lines.push(JSON.stringify({ range: data.range, values }, null, 2));

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// Tool: sheets_write_range
// ---------------------------------------------------------------------------

export const sheetsWriteRangeToolDefinition = {
  name: "sheets_write_range",
  description:
    "Write values to a Google Sheet range in A1 notation. " +
    "Overwrites existing cell values starting from the top-left of the range. " +
    "Values are provided as a 2D array: an array of rows, each row an array of cell values. " +
    "Example: [[\"Name\",\"Score\"],[\"Alice\",95],[\"Bob\",88]]",
  inputSchema: {
    type: "object",
    properties: {
      spreadsheet_id: {
        type: "string",
        description: "Spreadsheet ID. Defaults to GOOGLE_SHEETS_ID env var.",
      },
      range: {
        type: "string",
        description:
          "A1 notation for the write target (e.g. 'Sheet1!A1', 'Sheet1!B3:E10'). " +
          "The range defines the starting cell; extra data extends beyond it.",
      },
      values: {
        type: "array",
        items: { type: "array" },
        description:
          "2D array of values to write. Each inner array is one row. " +
          "Cell values can be strings, numbers, or booleans.",
      },
      value_input_option: {
        type: "string",
        enum: ["RAW", "USER_ENTERED"],
        description:
          "RAW stores values exactly as provided. " +
          "USER_ENTERED (default) parses values as if typed into the sheet " +
          "(numbers stay numeric, dates are parsed, formulas starting with = are executed).",
      },
    },
    required: ["range", "values"],
  },
};

export async function handleSheetsWriteRange(args) {
  const spreadsheetId = requireSpreadsheetId(args);
  const range = (args?.range || "").trim();
  if (!range) throw new Error("'range' is required (e.g. 'Sheet1!A1').");

  if (!Array.isArray(args?.values) || args.values.length === 0) {
    throw new Error("'values' must be a non-empty 2D array.");
  }

  const valueInputOption = args?.value_input_option || "USER_ENTERED";

  const body = {
    range,
    majorDimension: "ROWS",
    values: args.values,
  };

  const params = new URLSearchParams({ valueInputOption });
  const token = await getSheetsToken();
  const resp = await sheetsFetch(
    token,
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params.toString()}`,
    { method: "PUT", body: JSON.stringify(body) }
  );
  const result = await resp.json();

  log(
    "info",
    `sheets_write_range: ${result.updatedRows} rows, ${result.updatedColumns} cols, ${result.updatedCells} cells in "${result.updatedRange}"`
  );

  const lines = [
    "Google Sheets Write Complete",
    "============================",
    `Spreadsheet ID:   ${result.spreadsheetId}`,
    `Updated range:    ${result.updatedRange}`,
    `Rows updated:     ${result.updatedRows}`,
    `Columns updated:  ${result.updatedColumns}`,
    `Cells updated:    ${result.updatedCells}`,
    `Input option:     ${valueInputOption}`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// Tool: sheets_append_rows
// ---------------------------------------------------------------------------

export const sheetsAppendRowsToolDefinition = {
  name: "sheets_append_rows",
  description:
    "Append one or more rows to the end of existing data in a Google Sheet. " +
    "Finds the last row with data and writes after it. " +
    "Does NOT overwrite existing data. " +
    "Values are provided as a 2D array: an array of rows, each row an array of cell values.",
  inputSchema: {
    type: "object",
    properties: {
      spreadsheet_id: {
        type: "string",
        description: "Spreadsheet ID. Defaults to GOOGLE_SHEETS_ID env var.",
      },
      range: {
        type: "string",
        description:
          "A1 notation that identifies the sheet and general region for append detection " +
          "(e.g. 'Sheet1!A:Z', 'Sheet1'). The API finds the next empty row automatically.",
      },
      values: {
        type: "array",
        items: { type: "array" },
        description:
          "2D array of rows to append. Each inner array is one row of cell values.",
      },
      value_input_option: {
        type: "string",
        enum: ["RAW", "USER_ENTERED"],
        description: "RAW stores verbatim. USER_ENTERED (default) parses as typed.",
      },
      insert_data_option: {
        type: "string",
        enum: ["OVERWRITE", "INSERT_ROWS"],
        description:
          "INSERT_ROWS (default) inserts new rows. " +
          "OVERWRITE writes into existing empty rows after the last data row.",
      },
    },
    required: ["range", "values"],
  },
};

export async function handleSheetsAppendRows(args) {
  const spreadsheetId = requireSpreadsheetId(args);
  const range = (args?.range || "").trim();
  if (!range) throw new Error("'range' is required (e.g. 'Sheet1!A:Z').");

  if (!Array.isArray(args?.values) || args.values.length === 0) {
    throw new Error("'values' must be a non-empty 2D array.");
  }

  const valueInputOption = args?.value_input_option || "USER_ENTERED";
  const insertDataOption = args?.insert_data_option || "INSERT_ROWS";

  const body = {
    range,
    majorDimension: "ROWS",
    values: args.values,
  };

  const params = new URLSearchParams({ valueInputOption, insertDataOption });
  const token = await getSheetsToken();
  const resp = await sheetsFetch(
    token,
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${params.toString()}`,
    { method: "POST", body: JSON.stringify(body) }
  );
  const result = await resp.json();

  const updates = result.updates || {};
  log(
    "info",
    `sheets_append_rows: ${updates.updatedRows} rows appended to "${updates.updatedRange}"`
  );

  const lines = [
    "Google Sheets Append Complete",
    "=============================",
    `Spreadsheet ID:   ${updates.spreadsheetId || spreadsheetId}`,
    `Appended to:      ${updates.updatedRange || range}`,
    `Rows appended:    ${updates.updatedRows || args.values.length}`,
    `Cells written:    ${updates.updatedCells || ""}`,
    `Insert option:    ${insertDataOption}`,
  ].filter((l) => l.split(":")[1]?.trim() !== "");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
