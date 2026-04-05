// tools/linkedin.js
// Provides tools for loading and searching a user's LinkedIn connections
// from a CSV export (the only reliable way to access connection data,
// since LinkedIn's r_network API permission requires special partner access).
//
// How to export your LinkedIn connections:
//   1. Go to LinkedIn > Me > Settings & Privacy
//   2. Data Privacy > Get a copy of your data
//   3. Select "Connections" and request the export
//   4. Download the ZIP and extract Connections.csv
//   5. Place it at ./data/connections.csv (or set LINKEDIN_CSV_PATH)

import { existsSync, readFileSync, writeFileSync } from "fs";
import { config } from "../config.js";
import { parseLinkedInCsv } from "../utils/csvParser.js";
import { truncate } from "../utils/helpers.js";
import { log } from "../utils/logger.js";

// -----------------------------------------------------------------------
// In-memory connection store
// -----------------------------------------------------------------------

let _connections = [];
let _loadedFrom = "";
let _loadedAt = null;

function getStore() {
  return { connections: _connections, loadedFrom: _loadedFrom, loadedAt: _loadedAt };
}

// -----------------------------------------------------------------------
// Tool definitions
// -----------------------------------------------------------------------

export const linkedinLoadToolDefinition = {
  name: "linkedin_load_connections",
  description:
    "Loads (or reloads) your LinkedIn connections from a CSV file exported from LinkedIn. " +
    "Must be called at least once before using linkedin_search_connections. " +
    "The CSV is the 'Connections.csv' file from LinkedIn's 'Get a copy of your data' export.",
  inputSchema: {
    type: "object",
    properties: {
      csv_path: {
        type: "string",
        description:
          "Absolute or relative path to the LinkedIn Connections.csv file. " +
          `Defaults to the configured path: ${config.linkedinCsvPath}`,
      },
    },
    required: [],
  },
};

export const linkedinSearchToolDefinition = {
  name: "linkedin_search_connections",
  description:
    "Searches your loaded LinkedIn connections using flexible criteria. " +
    "Can filter by name, company, job title/position, email, and connection date range. " +
    "Returns matching connections sorted by relevance. " +
    "You must call linkedin_load_connections first.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Free-text search across name, company, and position fields. Case-insensitive. Optional.",
      },
      name: {
        type: "string",
        description: "Filter connections whose full name contains this string. Optional.",
      },
      company: {
        type: "string",
        description: "Filter connections who currently work at this company. Optional.",
      },
      position: {
        type: "string",
        description: "Filter connections whose job title contains this string. Optional.",
      },
      email: {
        type: "string",
        description: "Filter by email address fragment. Optional.",
      },
      connected_after: {
        type: "string",
        description:
          "Only return connections made on or after this date. Format: YYYY-MM-DD. Optional.",
      },
      connected_before: {
        type: "string",
        description:
          "Only return connections made on or before this date. Format: YYYY-MM-DD. Optional.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default 25, max 200).",
        minimum: 1,
        maximum: 200,
      },
      page: {
        type: "number",
        description: "Page number for pagination (1-based, default 1).",
        minimum: 1,
      },
    },
    required: [],
  },
};

export const linkedinCountToolDefinition = {
  name: "linkedin_connection_count",
  description:
    "Returns the total number of LinkedIn connections currently loaded in memory, " +
    "along with metadata about the loaded dataset.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const linkedinProfileToolDefinition = {
  name: "linkedin_get_profile",
  description:
    "Returns the user's own LinkedIn profile information from a locally stored profile JSON file. " +
    "This is populated from your LinkedIn data export (profile.json) or manually configured. " +
    "Useful for giving Claude context about who the user is before searching connections.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleLinkedinLoad(args) {
  const csvPath = args?.csv_path || config.linkedinCsvPath;

  if (!existsSync(csvPath)) {
    return {
      content: [
        {
          type: "text",
          text:
            `LinkedIn CSV file not found at: "${csvPath}"\n\n` +
            `How to export your LinkedIn connections:\n` +
            `  1. Go to LinkedIn > Me (top right) > Settings & Privacy\n` +
            `  2. Click "Data Privacy" in the left sidebar\n` +
            `  3. Click "Get a copy of your data"\n` +
            `  4. Select "Connections" and click "Request archive"\n` +
            `  5. LinkedIn will email you a download link (usually within a few minutes)\n` +
            `  6. Download the ZIP, extract it, and find Connections.csv\n` +
            `  7. Copy Connections.csv to: ${csvPath}\n` +
            `  8. Run this tool again.\n\n` +
            `Alternatively, set the LINKEDIN_CSV_PATH environment variable to the correct path.`,
        },
      ],
      isError: true,
    };
  }

  try {
    const { connections, skipped, total } = parseLinkedInCsv(csvPath);
    _connections = connections;
    _loadedFrom = csvPath;
    _loadedAt = new Date().toISOString();

    // Build a quick company/position summary
    const companies = {};
    for (const c of connections) {
      if (c.company) companies[c.company] = (companies[c.company] || 0) + 1;
    }
    const topCompanies = Object.entries(companies)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => `  ${name} (${count})`)
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text:
            `LinkedIn connections loaded successfully.\n\n` +
            `File: ${csvPath}\n` +
            `Total rows parsed: ${total}\n` +
            `Connections loaded: ${connections.length}\n` +
            `Rows skipped (empty): ${skipped}\n` +
            `Loaded at: ${_loadedAt}\n\n` +
            `Top companies represented:\n${topCompanies || "  (none detected)"}`,
        },
      ],
    };
  } catch (err) {
    log("error", "linkedin_load_connections failed", err.message);
    return {
      content: [{ type: "text", text: `Failed to load connections: ${err.message}` }],
      isError: true,
    };
  }
}

// -----------------------------------------------------------------------

export async function handleLinkedinSearch(args) {
  if (_connections.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No connections loaded. Please run linkedin_load_connections first.",
        },
      ],
      isError: true,
    };
  }

  const query          = (args?.query || "").trim().toLowerCase();
  const nameFilter     = (args?.name || "").trim().toLowerCase();
  const companyFilter  = (args?.company || "").trim().toLowerCase();
  const positionFilter = (args?.position || "").trim().toLowerCase();
  const emailFilter    = (args?.email || "").trim().toLowerCase();
  const connAfter      = args?.connected_after || "";
  const connBefore     = args?.connected_before || "";
  const limit          = Math.min(Math.max(Number(args?.limit) || 25, 1), 200);
  const page           = Math.max(Number(args?.page) || 1, 1);

  const connAfterTs  = connAfter  ? new Date(connAfter).getTime()  : 0;
  const connBeforeTs = connBefore ? new Date(connBefore + "T23:59:59Z").getTime() : Infinity;

  // Score each connection
  const scored = _connections
    .map((c) => {
      let score = 0;

      // Free-text query match
      if (query) {
        if (c._search.includes(query)) score += 10;
        else {
          const words = query.split(/\s+/);
          for (const word of words) {
            if (c._search.includes(word)) score += 3;
          }
        }
      }

      // Exact field filters (must all pass to be included)
      if (nameFilter && !c.fullName.toLowerCase().includes(nameFilter)) return null;
      if (companyFilter && !c.company.toLowerCase().includes(companyFilter)) return null;
      if (positionFilter && !c.position.toLowerCase().includes(positionFilter)) return null;
      if (emailFilter && !c.email.toLowerCase().includes(emailFilter)) return null;

      // Date filters
      if (connAfter || connBefore) {
        if (!c.connectedOn) {
          // If we can't parse the date, include it but with zero bonus
        } else {
          const ts = parseConnectedOnDate(c.connectedOn);
          if (ts !== null) {
            if (ts < connAfterTs || ts > connBeforeTs) return null;
          }
        }
      }

      // Boost score for field specificity
      if (nameFilter && c.fullName.toLowerCase().includes(nameFilter)) score += 5;
      if (companyFilter && c.company.toLowerCase().includes(companyFilter)) score += 5;
      if (positionFilter && c.position.toLowerCase().includes(positionFilter)) score += 5;

      // If there are no filters at all, return all connections
      const hasFilters = query || nameFilter || companyFilter || positionFilter || emailFilter || connAfter || connBefore;
      if (!hasFilters) score = 1; // Return all when no filters

      return score > 0 || !query ? { connection: c, score } : null;
    })
    .filter(Boolean);

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const totalMatches = scored.length;
  const start = (page - 1) * limit;
  const paginated = scored.slice(start, start + limit);

  if (paginated.length === 0) {
    const noResultMsg = [
      `No connections found matching your criteria.`,
      `Total connections loaded: ${_connections.length}`,
      query           ? `Free-text query: "${query}"`          : null,
      nameFilter      ? `Name filter: "${nameFilter}"`         : null,
      companyFilter   ? `Company filter: "${companyFilter}"`   : null,
      positionFilter  ? `Position filter: "${positionFilter}"` : null,
      emailFilter     ? `Email filter: "${emailFilter}"`       : null,
      connAfter       ? `Connected after: ${connAfter}`        : null,
      connBefore      ? `Connected before: ${connBefore}`      : null,
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text", text: noResultMsg }] };
  }

  const resultLines = paginated.map(({ connection: c, score }, idx) => {
    const num = start + idx + 1;
    const parts = [`[${num}] ${c.fullName || "(name unknown)"}`];
    if (c.position) parts.push(`  Position:   ${c.position}`);
    if (c.company)  parts.push(`  Company:    ${c.company}`);
    if (c.email)    parts.push(`  Email:      ${c.email}`);
    if (c.url)      parts.push(`  LinkedIn:   ${c.url}`);
    if (c.connectedOn) parts.push(`  Connected:  ${c.connectedOn}`);
    return parts.join("\n");
  });

  const filtersApplied = [
    query           ? `query="${query}"`                    : null,
    nameFilter      ? `name="${nameFilter}"`                : null,
    companyFilter   ? `company="${companyFilter}"`          : null,
    positionFilter  ? `position="${positionFilter}"`        : null,
    emailFilter     ? `email="${emailFilter}"`              : null,
    connAfter       ? `connected_after=${connAfter}`        : null,
    connBefore      ? `connected_before=${connBefore}`      : null,
  ].filter(Boolean).join(", ");

  const paginationInfo =
    totalMatches > limit
      ? `\nShowing ${start + 1}–${start + paginated.length} of ${totalMatches} matches. ` +
        `Use page=${page + 1} to see more.`
      : "";

  const header =
    `LinkedIn connections matching: ${filtersApplied || "(all)"}\n` +
    `Total matches: ${totalMatches} | Loaded connections: ${_connections.length}` +
    paginationInfo;

  return {
    content: [
      {
        type: "text",
        text: `${header}\n\n${resultLines.join("\n\n")}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleLinkedinCount(args) {
  const { connections, loadedFrom, loadedAt } = getStore();

  if (connections.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No connections loaded. Please run linkedin_load_connections first.",
        },
      ],
    };
  }

  // Summarise companies and positions
  const companies = {};
  const positions = {};
  for (const c of connections) {
    if (c.company) companies[c.company] = (companies[c.company] || 0) + 1;
    if (c.position) {
      const key = c.position.length > 40 ? c.position.slice(0, 40) + "..." : c.position;
      positions[key] = (positions[key] || 0) + 1;
    }
  }

  const topCompanies = Object.entries(companies)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([n, cnt]) => `  ${n} (${cnt})`)
    .join("\n");

  const topPositions = Object.entries(positions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([n, cnt]) => `  ${n} (${cnt})`)
    .join("\n");

  const connectionsWithEmail = connections.filter((c) => c.email).length;

  return {
    content: [
      {
        type: "text",
        text:
          `LinkedIn Connections Summary\n` +
          `============================\n` +
          `Total connections: ${connections.length}\n` +
          `Connections with email: ${connectionsWithEmail}\n` +
          `Loaded from: ${loadedFrom}\n` +
          `Loaded at: ${loadedAt}\n\n` +
          `Top Companies (by connection count):\n${topCompanies || "  (none)"}\n\n` +
          `Top Positions (by connection count):\n${topPositions || "  (none)"}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleLinkedinProfile(args) {
  const profilePath = config.linkedinProfilePath;

  if (!existsSync(profilePath)) {
    return {
      content: [
        {
          type: "text",
          text:
            `No profile.json found at: "${profilePath}"\n\n` +
            `To set up your LinkedIn profile data:\n\n` +
            `Option 1 (LinkedIn Export):\n` +
            `  1. Follow the same data export steps as for connections\n` +
            `  2. In the exported ZIP you will find "Profile.csv" or "profile.json"\n` +
            `  3. If it's a CSV, convert it to JSON or create a profile.json manually\n` +
            `  4. Place it at: ${profilePath}\n\n` +
            `Option 2 (Manual):\n` +
            `  Create ${profilePath} with JSON content like:\n` +
            `  {\n` +
            `    "name": "Your Name",\n` +
            `    "headline": "Your Job Title at Your Company",\n` +
            `    "location": "Melbourne, VIC, Australia",\n` +
            `    "industry": "Technology",\n` +
            `    "summary": "Brief bio..."\n` +
            `  }`,
        },
      ],
    };
  }

  try {
    const raw = readFileSync(profilePath, "utf-8");
    const profile = JSON.parse(raw);
    return {
      content: [
        {
          type: "text",
          text: `LinkedIn Profile:\n\n${JSON.stringify(profile, null, 2)}`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to read profile.json: ${err.message}`,
        },
      ],
      isError: true,
    };
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/**
 * Attempts to parse a LinkedIn "Connected On" date string into a Unix timestamp.
 * LinkedIn exports have used formats like:
 *   "01 Jan 2023", "January 1, 2023", "2023-01-01", "1/1/2023"
 */
function parseConnectedOnDate(str) {
  if (!str) return null;
  const ts = new Date(str).getTime();
  return isNaN(ts) ? null : ts;
}
