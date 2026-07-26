// src/tests/profiles-postgres.test.js
//
// Tests the Postgres-primary behaviour of the connector profile tools with the
// PROFILES.md volume as cache/fallback. The gateway is simulated by mocking
// global.fetch; PROFILES.md is a real temp file. Identity is supplied via the
// per-call context argument.
//
// Covers the spec's connector test matrix:
//   - profile_read returns from Postgres when the gateway is reachable + has data
//   - profile_read falls back to PROFILES.md on 404
//   - profile_read falls back to PROFILES.md when the gateway is unreachable
//   - profile_read seeds Postgres when PROFILES.md has data but Postgres 404s
//   - profile_write_person writes Postgres first, then caches to PROFILES.md
//   - profile_write_person writes PROFILES.md only when Postgres is unreachable

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';

// Env must be set BEFORE importing the modules under test.
const PROFILES_PATH = join(tmpdir(), `profiles-pg-test-${randomUUID()}.md`);
process.env.PROFILES_FILE_PATH = PROFILES_PATH;
process.env.WP_SKILL_URL = '';               // no WordPress push in tests
process.env.SELF_MODEL_ENABLED = 'false';    // keep sessionContext inert
process.env.GATEWAY_URL = 'http://gateway.test.local';
process.env.GATEWAY_ADMIN_KEY = 'test-admin-key';

let handleProfileRead, handleProfileWritePerson;
let calls = [];
let routes = {};

before(async () => {
  const mod = await import('../tools/profiles.js');
  handleProfileRead = mod.handleProfileRead;
  handleProfileWritePerson = mod.handleProfileWritePerson;
});

beforeEach(() => {
  calls = [];
  routes = {};
  try { rmSync(PROFILES_PATH, { force: true }); } catch {}
  global.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method: opts?.method, body });
    // Allow a route to force a network failure.
    if (u.includes('/ti-tools/profile-read')  && routes.readReject)  throw new Error('ECONNREFUSED');
    if (u.includes('/ti-tools/profile-write') && routes.writeReject) throw new Error('ECONNREFUSED');
    if (u.includes('/ti-tools/profile-read')) {
      const r = routes.read || { status: 404, json: { existing: false } };
      return mkResp(r.status, r.json);
    }
    if (u.includes('/ti-tools/profile-write')) {
      const r = routes.write || { status: 200, json: { ok: true, changed: true, revision: 1 } };
      return mkResp(r.status, r.json);
    }
    return mkResp(404, {});
  };
});

after(() => {
  try { rmSync(PROFILES_PATH, { force: true }); } catch {}
});

function mkResp(status, json) {
  return { status, ok: status >= 200 && status < 300, async json() { return json; } };
}
function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}
function writeProfiles(content) {
  writeFileSync(PROFILES_PATH, content, 'utf8');
}
function readCallsTo(substr) {
  return calls.filter(c => c.url.includes(substr));
}

const CTX = { tenant_id: 'ts_50f3be57', user_id: '8' };

const ONE_PERSON = `# Ava User Profiles

---

## Brian
- Tone: concise

### Module Frequency
| module_id | sessions_active | sessions_total | frequency | last_active |
|-----------|-----------------|----------------|-----------|-------------|
| core      | 9               | 10             | 0.9       | 2026-07-01  |

---
`;

const TWO_PERSON = `# Ava User Profiles

---

## Brian
- Tone: concise

### Module Frequency
| module_id | sessions_active | sessions_total | frequency | last_active |
|-----------|-----------------|----------------|-----------|-------------|
| core      | 9               | 10             | 0.9       | 2026-07-01  |

---

## Mila
- Grade 6

---
`;

// ---------------------------------------------------------------------------

test('profile_read returns from Postgres when the gateway is reachable and has data', async () => {
  writeProfiles(ONE_PERSON);
  routes.read = { status: 200, json: { existing: true, content: '## Brian\nFrom Postgres', revision: 4, updated_at: '2026-07-26T00:00:00Z', source: 'ai_auto' } };

  const result = await handleProfileRead({}, CTX);
  const p = payloadOf(result);

  assert.equal(p.profile_source, 'postgres');
  assert.equal(p.personality_content, '## Brian\nFrom Postgres');
  assert.equal(p.personality_revision, 4);
  assert.equal(readCallsTo('/ti-tools/profile-read').length, 1);
  // No seeding write when Postgres already has data.
  assert.equal(readCallsTo('/ti-tools/profile-write').length, 0);
});

test('profile_read falls back to PROFILES.md when the gateway returns 404', async () => {
  writeProfiles(TWO_PERSON);                       // 2 persons -> not safe to seed
  routes.read = { status: 404, json: { existing: false } };

  const result = await handleProfileRead({}, CTX);
  const p = payloadOf(result);

  assert.equal(p.profile_source, 'volume');
  assert.ok(p.content.includes('## Brian'));       // served from the volume
  assert.equal(p.person_count, 2);
  // Multi-person file is not seeded.
  assert.equal(readCallsTo('/ti-tools/profile-write').length, 0);
});

test('profile_read falls back to PROFILES.md when the gateway is unreachable', async () => {
  writeProfiles(ONE_PERSON);
  routes.readReject = true;

  const result = await handleProfileRead({}, CTX);
  const p = payloadOf(result);

  assert.equal(p.profile_source, 'volume');
  assert.ok(p.content.includes('## Brian'));
  assert.equal(readCallsTo('/ti-tools/profile-read').length, 1); // attempted then failed
});

test('profile_read seeds Postgres when PROFILES.md has data but Postgres 404s', async () => {
  writeProfiles(ONE_PERSON);                       // single person -> safe to seed
  routes.read  = { status: 404, json: { existing: false } };
  routes.write = { status: 200, json: { ok: true, changed: true, revision: 1 } };

  const result = await handleProfileRead({}, CTX);
  const p = payloadOf(result);

  assert.equal(p.profile_source, 'volume');
  const writes = readCallsTo('/ti-tools/profile-write');
  assert.equal(writes.length, 1, 'exactly one seed write');
  assert.equal(writes[0].body.mode, 'replace');
  assert.equal(writes[0].body.source, 'profile_sync');
  assert.equal(writes[0].body.tenant_id, 'ts_50f3be57');
  assert.equal(writes[0].body.user_id, '8');
  assert.ok(writes[0].body.content.includes('## Brian'));
});

test('profile_write_person writes Postgres first, then caches to PROFILES.md', async () => {
  routes.write = { status: 200, json: { ok: true, changed: true, revision: 2 } };

  const result = await handleProfileWritePerson(
    { person_name: 'Brian', profile_content: '## Brian\nUpdated bio', change_note: 'tweak' },
    CTX
  );
  const p = payloadOf(result);

  assert.equal(p.success, true);
  assert.equal(p.primary_store, 'postgres');
  assert.equal(p.postgres.ok, true);
  assert.equal(p.postgres.revision, 2);
  // Postgres write happened...
  const writes = readCallsTo('/ti-tools/profile-write');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.mode, 'replace');
  assert.equal(writes[0].body.source, 'ai_auto');
  // ...and the PROFILES.md cache was written too.
  assert.ok(existsSync(PROFILES_PATH));
  assert.ok(readFileSync(PROFILES_PATH, 'utf8').includes('## Brian'));
});

test('profile_write_person writes PROFILES.md only when Postgres is unreachable', async () => {
  routes.writeReject = true;

  const result = await handleProfileWritePerson(
    { person_name: 'Brian', profile_content: '## Brian\nOffline bio', change_note: 'offline' },
    CTX
  );
  const p = payloadOf(result);

  assert.equal(p.success, true);
  assert.equal(p.primary_store, 'volume');
  assert.equal(p.postgres.attempted, true);
  assert.equal(p.postgres.ok, false);
  // The volume cache still holds the write (graceful degrade).
  assert.ok(existsSync(PROFILES_PATH));
  assert.ok(readFileSync(PROFILES_PATH, 'utf8').includes('Offline bio'));
});

test('profile_read stays on the volume when no identity is resolvable', async () => {
  writeProfiles(ONE_PERSON);
  routes.read = { status: 200, json: { existing: true, content: 'should-not-be-used', revision: 1 } };

  // No context and no session identity -> must not call the gateway at all.
  const result = await handleProfileRead({}, null);
  const p = payloadOf(result);

  assert.equal(p.profile_source, 'volume');
  assert.equal(calls.length, 0, 'gateway must not be called without identity');
});
