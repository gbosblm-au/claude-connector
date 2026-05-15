// src/tools/memory.test.js
// Node built-in test runner. Uses an in-memory SQLite instance per the TDD
// (Section 12.1). Covers all six tool handlers plus TTL expiry semantics.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { initDb, getDb, closeDb } from "./db.js";
import { handleMemoryWrite } from "./memory-write.js";
import { handleMemoryRead } from "./memory-read.js";
import { handleMemorySearch } from "./memory-search.js";
import { handleMemoryDelete } from "./memory-delete.js";
import { handleMemoryList } from "./memory-list.js";
import { handleMemoryGetSessionContext } from "./memory-get-session-context.js";
import { ToolError } from "./errors.js";

before(() => {
  // ":memory:" path uses an in-RAM SQLite instance; better-sqlite3 supports it.
  initDb(":memory:");
});

after(() => {
  closeDb();
});

beforeEach(() => {
  // Wipe between tests for isolation. FTS triggers will follow.
  getDb().exec("DELETE FROM memories");
});

test("memory_write creates an entry", async () => {
  const res = await handleMemoryWrite({
    category: "projects",
    key: "newsletter_tag_active",
    value: { id: 42, slug: "issue-may" },
  });
  assert.equal(res.success, true);
  assert.equal(res.operation, "created");
  assert.ok(res.id);
  assert.ok(res.updated_at);
});

test("memory_write upserts existing entry without changing id or created_at", async () => {
  const first = await handleMemoryWrite({
    category: "projects",
    key: "ifa_run_count",
    value: 1,
  });
  const second = await handleMemoryWrite({
    category: "projects",
    key: "ifa_run_count",
    value: 2,
  });
  assert.equal(second.operation, "updated");
  assert.equal(second.id, first.id);

  const read = await handleMemoryRead({
    category: "projects",
    key: "ifa_run_count",
  });
  assert.equal(read.entries[0].value, 2);
});

test("memory_write rejects invalid category", async () => {
  await assert.rejects(
    () =>
      handleMemoryWrite({
        category: "not_a_real_category",
        key: "x",
        value: 1,
      }),
    (err) => err instanceof ToolError && err.code === "VALIDATION_ERROR",
  );
});

test("memory_write rejects oversized value", async () => {
  const big = "x".repeat(70_000);
  await assert.rejects(
    () =>
      handleMemoryWrite({
        category: "facts",
        key: "too_big",
        value: big,
      }),
    (err) => err instanceof ToolError && err.code === "VALUE_TOO_LARGE",
  );
});

test("memory_read requires at least one filter", async () => {
  await assert.rejects(
    () => handleMemoryRead({}),
    (err) => err instanceof ToolError && err.code === "NO_FILTER_PROVIDED",
  );
});

test("memory_read returns entries filtered by tag (must contain ALL)", async () => {
  await handleMemoryWrite({
    category: "facts",
    key: "a",
    value: "alpha",
    tags: ["red", "blue"],
  });
  await handleMemoryWrite({
    category: "facts",
    key: "b",
    value: "beta",
    tags: ["red"],
  });
  const both = await handleMemoryRead({ tags: ["red", "blue"] });
  assert.equal(both.count, 1);
  assert.equal(both.entries[0].key, "a");
});

test("memory_search finds by full text and ranks by relevance", async () => {
  await handleMemoryWrite({
    category: "facts",
    key: "newsletter",
    value: "newsletter tag capacity policy",
    tags: ["wp"],
  });
  await handleMemoryWrite({
    category: "facts",
    key: "unrelated",
    value: "nothing to see here",
  });
  const res = await handleMemorySearch({ query: "newsletter" });
  assert.ok(res.count >= 1);
  assert.equal(res.results[0].key, "newsletter");
  assert.equal(typeof res.results[0].rank, "number");
});

test("memory_search prefix syntax", async () => {
  await handleMemoryWrite({
    category: "facts",
    key: "k1",
    value: "newsletter tag exists",
  });
  const res = await handleMemorySearch({ query: "news*" });
  assert.ok(res.count >= 1);
});

test("memory_delete returns deleted=false when entry does not exist", async () => {
  const res = await handleMemoryDelete({ category: "facts", key: "nope" });
  assert.equal(res.deleted, false);
});

test("memory_delete removes the entry", async () => {
  await handleMemoryWrite({ category: "facts", key: "tmp", value: 1 });
  const res = await handleMemoryDelete({ category: "facts", key: "tmp" });
  assert.equal(res.deleted, true);
  const after = await handleMemoryRead({ category: "facts", key: "tmp" });
  assert.equal(after.count, 0);
});

test("memory_list omits value by default, reports by_category", async () => {
  await handleMemoryWrite({ category: "facts", key: "a", value: 1 });
  await handleMemoryWrite({ category: "skills", key: "b", value: 2 });
  const list = await handleMemoryList({});
  assert.equal(list.total, 2);
  assert.equal(list.by_category.facts, 1);
  assert.equal(list.by_category.skills, 1);
  assert.equal(list.entries[0].value, undefined);

  const withValues = await handleMemoryList({ include_value: true });
  assert.ok(withValues.entries.every((e) => e.value !== undefined));
});

test("memory_get_session_context applies category caps", async () => {
  // Write 25 skills entries; cap is 20.
  for (let i = 0; i < 25; i++) {
    await handleMemoryWrite({
      category: "skills",
      key: `skill_${i}`,
      value: i,
    });
  }
  // Write 15 contacts; cap is 10.
  for (let i = 0; i < 15; i++) {
    await handleMemoryWrite({
      category: "contacts",
      key: `contact_${i}`,
      value: { name: `c${i}` },
    });
  }
  // Write 8 session; cap is 5.
  for (let i = 0; i < 8; i++) {
    await handleMemoryWrite({
      category: "session",
      key: `sess_${i}`,
      value: `s${i}`,
    });
  }
  // Write 3 facts; all included.
  for (let i = 0; i < 3; i++) {
    await handleMemoryWrite({
      category: "facts",
      key: `fact_${i}`,
      value: i,
    });
  }
  const ctx = await handleMemoryGetSessionContext({});
  assert.equal(Object.keys(ctx.context.skills).length, 20);
  assert.equal(Object.keys(ctx.context.contacts).length, 10);
  assert.equal(Object.keys(ctx.context.session).length, 5);
  assert.equal(Object.keys(ctx.context.facts).length, 3);
  assert.equal(ctx.entry_count, 20 + 10 + 5 + 3);
});

test("expired entries are excluded from read, list, and session context", async () => {
  // Backdate the ttl manually so we do not need to sleep.
  await handleMemoryWrite({
    category: "session",
    key: "expired_soon",
    value: "bye",
    ttl_days: 1,
  });
  // Force expiry into the past.
  const past = new Date(Date.now() - 60_000).toISOString();
  getDb()
    .prepare("UPDATE memories SET ttl = ? WHERE key = ?")
    .run(past, "expired_soon");

  const readRes = await handleMemoryRead({ category: "session" });
  assert.equal(readRes.count, 0);

  const listRes = await handleMemoryList({});
  assert.equal(listRes.total, 0);

  const ctxRes = await handleMemoryGetSessionContext({});
  assert.equal(Object.keys(ctxRes.context.session).length, 0);
});
