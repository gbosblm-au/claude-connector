// utils/csvParser.js
// Parses LinkedIn connections CSV exports.
// LinkedIn has changed its export format several times, so this module
// handles multiple known column layouts automatically.

import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { log } from "./logger.js";

// Known column-name variants across LinkedIn export versions
const COLUMN_MAPS = {
  firstName:  ["First Name", "FirstName", "first_name", "first name"],
  lastName:   ["Last Name",  "LastName",  "last_name",  "last name"],
  email:      ["Email Address", "EmailAddress", "email", "Email"],
  company:    ["Company", "company", "Organisation", "Organization"],
  position:   ["Position", "position", "Title", "title", "Job Title"],
  url:        ["URL", "url", "ProfileURL", "Profile URL", "linkedin_url"],
  connectedOn:["Connected On", "ConnectedOn", "connected_on", "Connection Date"],
};

/**
 * Normalises a raw row object (with potentially messy headers) into a
 * standard connection object.
 */
function normaliseRow(raw) {
  const get = (variants) => {
    for (const v of variants) {
      if (raw[v] !== undefined && raw[v] !== null && raw[v] !== "") {
        return String(raw[v]).trim();
      }
    }
    return "";
  };

  const firstName  = get(COLUMN_MAPS.firstName);
  const lastName   = get(COLUMN_MAPS.lastName);
  const email      = get(COLUMN_MAPS.email);
  const company    = get(COLUMN_MAPS.company);
  const position   = get(COLUMN_MAPS.position);
  const url        = get(COLUMN_MAPS.url);
  const connectedOn = get(COLUMN_MAPS.connectedOn);

  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  if (!fullName && !email) return null; // skip completely empty rows

  return {
    firstName,
    lastName,
    fullName,
    email,
    company,
    position,
    url,
    connectedOn,
    // normalised lowercase copies for searching
    _search: [fullName, company, position, email]
      .join(" ")
      .toLowerCase(),
  };
}

/**
 * Loads and parses a LinkedIn connections CSV file.
 *
 * @param {string} filePath
 * @returns {{ connections: object[], skipped: number, total: number }}
 */
export function parseLinkedInCsv(filePath) {
  log("info", `Parsing LinkedIn CSV: ${filePath}`);

  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read LinkedIn CSV at "${filePath}": ${err.message}`
    );
  }

  // LinkedIn sometimes prepends a few header lines like:
  //   "Notes:"
  //   "There are N connections in this file."
  //   <blank line>
  //   <actual CSV header>
  // Strip any lines before the first line that looks like a CSV header
  // (heuristic: contains a comma and starts with a letter, not a digit).
  const lines = raw.split(/\r?\n/);
  let startIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      trimmed.length > 0 &&
      trimmed.includes(",") &&
      /^[A-Za-z"]/u.test(trimmed)
    ) {
      startIndex = i;
      break;
    }
  }
  const csvContent = lines.slice(startIndex).join("\n");

  let rows;
  try {
    rows = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      relax_column_count: true,
    });
  } catch (err) {
    throw new Error(`Failed to parse CSV content: ${err.message}`);
  }

  const connections = [];
  let skipped = 0;

  for (const row of rows) {
    const normalised = normaliseRow(row);
    if (normalised) {
      connections.push(normalised);
    } else {
      skipped++;
    }
  }

  log(
    "info",
    `Parsed ${connections.length} connections, skipped ${skipped} empty rows`
  );

  return { connections, skipped, total: rows.length };
}
