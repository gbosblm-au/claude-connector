// src/test.js
// Runs offline unit tests (no API keys needed) to verify:
//   1. All modules import without error
//   2. The CSV parser handles multiple LinkedIn export formats
//   3. The LinkedIn search logic correctly filters results
//   4. Config defaults are correct
//   5. Helpers work correctly

import "dotenv/config";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => {
          console.log(`  PASS  ${name}`);
          passed++;
        })
        .catch((err) => {
          console.error(`  FAIL  ${name}: ${err.message}`);
          failed++;
        });
    } else {
      console.log(`  PASS  ${name}`);
      passed++;
    }
  } catch (err) {
    console.error(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

console.log("\n=== claude-connector test suite ===\n");

// -----------------------------------------------------------------------
// 1. Module imports
// -----------------------------------------------------------------------
console.log("-- Module imports --");

let config, log, helpers, csvParser, webSearch, newsSearch, linkedin;

test("config module loads", async () => {
  const mod = await import("./config.js");
  config = mod.config;
  assert(config.searchProvider, "searchProvider should be set");
  assert(typeof config.defaultWebResults === "number", "defaultWebResults should be a number");
});

test("logger module loads", async () => {
  const mod = await import("./utils/logger.js");
  log = mod.log;
  assert(typeof log === "function", "log should be a function");
  log("info", "Logger test message - you should see this on stderr");
});

test("helpers module loads", async () => {
  const mod = await import("./utils/helpers.js");
  helpers = mod;
  assert(typeof helpers.getCurrentDateTime === "function");
  assert(typeof helpers.clamp === "function");
  assert(typeof helpers.truncate === "function");
});

test("csvParser module loads", async () => {
  const mod = await import("./utils/csvParser.js");
  csvParser = mod;
  assert(typeof csvParser.parseLinkedInCsv === "function");
});

test("webSearch module loads", async () => {
  const mod = await import("./tools/webSearch.js");
  webSearch = mod;
  assert(webSearch.webSearchToolDefinition.name === "web_search");
  assert(typeof webSearch.handleWebSearch === "function");
});

test("newsSearch module loads", async () => {
  const mod = await import("./tools/newsSearch.js");
  newsSearch = mod;
  assert(newsSearch.newsSearchToolDefinition.name === "news_search");
  assert(typeof newsSearch.handleNewsSearch === "function");
});

test("linkedin module loads", async () => {
  const mod = await import("./tools/linkedin.js");
  linkedin = mod;
  assert(linkedin.linkedinLoadToolDefinition.name === "linkedin_load_connections");
  assert(linkedin.linkedinSearchToolDefinition.name === "linkedin_search_connections");
  assert(linkedin.linkedinCountToolDefinition.name === "linkedin_connection_count");
  assert(typeof linkedin.handleLinkedinLoad === "function");
  assert(typeof linkedin.handleLinkedinSearch === "function");
});

// -----------------------------------------------------------------------
// 2. Helper functions
// -----------------------------------------------------------------------

// We run these after the async imports settle
setTimeout(async () => {
  await import("./utils/helpers.js").then(({ getCurrentDateTime, clamp, truncate }) => {
    console.log("\n-- Helper functions --");

    test("getCurrentDateTime returns ISO string", () => {
      const dt = getCurrentDateTime();
      assert(typeof dt.iso === "string", "iso should be a string");
      assert(dt.iso.includes("T"), "iso should be ISO format");
      assert(typeof dt.unixTimestamp === "number", "unixTimestamp should be a number");
    });

    test("clamp works correctly", () => {
      assert(clamp(5, 1, 10) === 5, "5 within range");
      assert(clamp(0, 1, 10) === 1, "below min clamped to 1");
      assert(clamp(99, 1, 10) === 10, "above max clamped to 10");
    });

    test("truncate works correctly", () => {
      assert(truncate("hello", 10) === "hello", "short string unchanged");
      assert(truncate("a".repeat(600), 500).endsWith("..."), "long string truncated");
      assert(truncate("", 500) === "", "empty string unchanged");
    });
  });

  // -----------------------------------------------------------------------
  // 3. CSV Parser tests with synthetic data
  // -----------------------------------------------------------------------

  const { writeFileSync, unlinkSync, mkdirSync } = await import("fs");
  const { parseLinkedInCsv } = await import("./utils/csvParser.js");

  console.log("\n-- CSV parser --");

  // Create a temp CSV matching LinkedIn's modern format
  const tempPath = "/tmp/test_connections.csv";

  const modernCsv = `First Name,Last Name,URL,Email Address,Company,Position,Connected On
Alice,Smith,https://linkedin.com/in/asmith,alice@example.com,Atlassian,Senior Engineer,15 Jan 2023
Bob,Jones,https://linkedin.com/in/bjones,,Canva,Product Manager,03 Mar 2022
Carol,Williams,https://linkedin.com/in/cwilliams,carol@acme.com,Acme Corp,CEO,22 Jun 2021
David,Brown,,,Canva,Designer,01 Dec 2023`;

  writeFileSync(tempPath, modernCsv);

  test("parses modern LinkedIn CSV format", () => {
    const { connections, total, skipped } = parseLinkedInCsv(tempPath);
    assert(connections.length === 4, `Expected 4 connections, got ${connections.length}`);
    assert(connections[0].firstName === "Alice", "First name parsed");
    assert(connections[0].company === "Atlassian", "Company parsed");
    assert(connections[1].email === "", "Missing email is empty string");
    assert(connections[0]._search.includes("atlassian"), "Search index includes company");
  });

  // Test with LinkedIn preamble lines (older exports)
  const preambleCsv = `Notes:
There are 4 connections in this file.

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Alice,Smith,https://linkedin.com/in/asmith,alice@example.com,Atlassian,Senior Engineer,15 Jan 2023
Bob,Jones,https://linkedin.com/in/bjones,,Canva,Product Manager,03 Mar 2022
Carol,Williams,https://linkedin.com/in/cwilliams,carol@acme.com,Acme Corp,CEO,22 Jun 2021
David,Brown,,,Canva,Designer,01 Dec 2023`;

  const preamblePath = "/tmp/test_preamble.csv";
  writeFileSync(preamblePath, preambleCsv);

  test("handles LinkedIn preamble lines", () => {
    const { connections } = parseLinkedInCsv(preamblePath);
    assert(connections.length === 4, `Expected 4, got ${connections.length}`);
  });

  unlinkSync(tempPath);
  unlinkSync(preamblePath);

  // -----------------------------------------------------------------------
  // 4. LinkedIn search logic (loads synthetic data then searches)
  // -----------------------------------------------------------------------

  console.log("\n-- LinkedIn search logic --");

  const { handleLinkedinLoad, handleLinkedinSearch, handleLinkedinCount } = await import("./tools/linkedin.js");

  // Write a temp CSV for the loader
  const searchTestCsv = `First Name,Last Name,URL,Email Address,Company,Position,Connected On
Alice,Smith,https://linkedin.com/in/asmith,alice@example.com,Atlassian,Senior Software Engineer,15 Jan 2023
Bob,Jones,https://linkedin.com/in/bjones,,Canva,Product Manager,03 Mar 2022
Carol,Williams,https://linkedin.com/in/cwilliams,carol@acme.com,Canva,CEO,22 Jun 2021
David,Brown,,,Reserve Bank,Economist,01 Dec 2020
Eve,Taylor,,,Atlassian,Engineering Manager,10 Feb 2024`;

  const searchTestPath = "/tmp/test_search.csv";
  writeFileSync(searchTestPath, searchTestCsv);

  const loadResult = await handleLinkedinLoad({ csv_path: searchTestPath });
  test("linkedin_load_connections loads data", () => {
    const text = loadResult.content[0].text;
    assert(text.includes("5"), "Should report 5 connections loaded");
    assert(!loadResult.isError, "Should not be an error");
  });

  test("linkedin_search by company finds correct results", async () => {
    const result = await handleLinkedinSearch({ company: "Canva" });
    const text = result.content[0].text;
    assert(text.includes("Bob"), "Should find Bob at Canva");
    assert(text.includes("Carol"), "Should find Carol at Canva");
    assert(!text.includes("Alice"), "Should not include Alice (Atlassian)");
    assert(!text.includes("David"), "Should not include David (Reserve Bank)");
  });

  test("linkedin_search by position finds correct results", async () => {
    const result = await handleLinkedinSearch({ position: "Engineer" });
    const text = result.content[0].text;
    assert(text.includes("Alice"), "Should find Alice (Senior Software Engineer)");
    assert(text.includes("Eve"), "Should find Eve (Engineering Manager)");
    assert(!text.includes("Bob"), "Should not include Bob (Product Manager)");
  });

  test("linkedin_search free text query works", async () => {
    const result = await handleLinkedinSearch({ query: "economist" });
    const text = result.content[0].text;
    assert(text.includes("David"), "Should find David (Economist)");
  });

  test("linkedin_search with no filters returns all", async () => {
    const result = await handleLinkedinSearch({});
    const text = result.content[0].text;
    assert(text.includes("Alice"), "Should include Alice");
    assert(text.includes("Bob"), "Should include Bob");
    assert(text.includes("Carol"), "Should include Carol");
    assert(text.includes("David"), "Should include David");
    assert(text.includes("Eve"), "Should include Eve");
  });

  test("linkedin_search pagination works", async () => {
    const page1 = await handleLinkedinSearch({ limit: 2, page: 1 });
    const page2 = await handleLinkedinSearch({ limit: 2, page: 2 });
    const text1 = page1.content[0].text;
    const text2 = page2.content[0].text;
    // The two pages should not have identical content
    assert(text1 !== text2, "Page 1 and Page 2 should differ");
  });

  test("linkedin_connection_count returns stats", async () => {
    const result = await handleLinkedinCount({});
    const text = result.content[0].text;
    assert(text.includes("5"), "Should report total of 5 connections");
    assert(text.includes("Atlassian"), "Should list Atlassian in companies");
  });

  test("linkedin_search no match returns friendly message", async () => {
    const result = await handleLinkedinSearch({ company: "NonExistentCompanyXYZ" });
    const text = result.content[0].text;
    assert(text.includes("No connections found"), "Should say no connections found");
  });

  unlinkSync(searchTestPath);

  // -----------------------------------------------------------------------
  // 5. Tool schema validation
  // -----------------------------------------------------------------------

  console.log("\n-- Tool schema validation --");

  const { webSearchToolDefinition } = await import("./tools/webSearch.js");
  const { newsSearchToolDefinition } = await import("./tools/newsSearch.js");
  const { linkedinLoadToolDefinition, linkedinSearchToolDefinition } = await import("./tools/linkedin.js");

  const toolsToValidate = [
    webSearchToolDefinition,
    newsSearchToolDefinition,
    linkedinLoadToolDefinition,
    linkedinSearchToolDefinition,
  ];

  for (const tool of toolsToValidate) {
    test(`tool "${tool.name}" has valid schema`, () => {
      assert(typeof tool.name === "string" && tool.name.length > 0, "name required");
      assert(typeof tool.description === "string" && tool.description.length > 0, "description required");
      assert(tool.inputSchema?.type === "object", "inputSchema.type must be 'object'");
      assert(Array.isArray(tool.inputSchema?.required), "inputSchema.required must be an array");
    });
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  // Give the async tests a moment to settle
  setTimeout(() => {
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    if (failed > 0) process.exit(1);
  }, 200);

}, 500);
