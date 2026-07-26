# Connector v12.26.0 - Postgres-primary profile tools (PROFILES.md as cache/fallback)

Implements the connector side of the "Postgres as primary store" specification.
The profile tools now read and write the authoritative per-user profile in
Postgres via the gateway's new /ti-tools endpoints, keeping PROFILES.md on the
Railway volume as a local cache and fallback. The migration is additive,
non-breaking, and self-healing (profiles seed into Postgres on first read).

## What changed in 12.26.0

### New: src/tools/ti-tools-client.js
A thin client for the gateway /ti-tools endpoints (profile-read, profile-write,
module-frequency, assistant-name) using GATEWAY_URL + GATEWAY_ADMIN_KEY with a
5s timeout and X-Admin-Key auth. Also provides `resolveSessionIdentity(context,
args)`, which resolves { tenantId, userId } in priority order: per-call gateway
context -> explicit tool args -> connector session context (seeded at
ts_gateway_session_init) -> TS_TENANT_ID for the tenant only. It never hardcodes
a user. When the user cannot be resolved, callers fall back to PROFILES.md.

### src/tools/profiles.js -- profile_read / profile_write_person rewritten
- profile_read: Postgres-primary. On 200 it returns the authoritative
  personality content (profile_source: 'postgres'); on 404 it serves PROFILES.md
  and, when this user's single section is safely identifiable, seeds Postgres via
  profile-write (mode=replace, source=profile_sync); on unreachable/error or no
  identity it serves PROFILES.md (profile_source: 'volume'). All existing
  volume-derived fields (content, persons, person_count, ...) are preserved for
  backward compatibility.
- profile_write_person: writes to Postgres first (best-effort, mode=replace),
  then always writes the PROFILES.md cache and pushes to WordPress exactly as
  before. If Postgres is unreachable the volume write still succeeds
  (primary_store: 'volume'). The PROFILES.md write remains section-aware, so
  other persons in the multi-person file are never clobbered.

### src/tools/skill-modular.js -- person-prior (Layer 0) Postgres-primary
handleSkillCompile and handleSkillRecompile now resolve module frequency from
self_model via /ti-tools/module-frequency when identity + gateway are available,
applying the same threshold/min-session gating as before (refactored into a
shared buildPriorFromParsed). On empty data, error, unreachable gateway, or
missing identity, they fall back to the PROFILES.md module_frequency table
exactly as before.

### src/server-http.js -- per-call identity threaded to the handlers
dispatchToolCallCore now forwards the per-call `context` to skill_compile,
skill_recompile, profile_read, and profile_write_person, so those tools get the
authoritative { tenant_id, user_id } when the gateway proxies them.

## Scope notes (honest boundaries)
- The gateway handles profile_read and skill_compile LOCALLY in the ts-client
  (deepseek) flow, so this connector rewrite governs the direct-MCP connector
  flow and the PROFILES.md-as-cache model, exactly as the spec frames it.
- profile_read does not cache back to the shared multi-person PROFILES.md (that
  write is "optional/best-effort" in the spec); avoiding it prevents clobbering
  other persons. The write path keeps PROFILES.md current, section-aware.
- style_signals: the dispatcher does not currently consume a style_signals prior
  (only module_frequency drives Layer 0), so there is nothing to migrate for it;
  no speculative behaviour was added.

## Deploy
Deploy with gateway v2.25.0. Connector env required for the Postgres path:
GATEWAY_URL (or TS_TENANT_GATEWAY_URL) and GATEWAY_ADMIN_KEY. Without them, the
tools transparently use PROFILES.md as before.

## Tests
src/tests/profiles-postgres.test.js (7): profile_read from Postgres on data;
fallback to PROFILES.md on 404; fallback when unreachable; seeds Postgres from a
single-person PROFILES.md on 404; profile_write_person Postgres-first-then-cache;
PROFILES.md-only when Postgres is unreachable; and no gateway call when identity
is unresolvable. Existing self-model/identity tests still pass (28 total in the
self-model + profiles set).

## Also included (earlier, in the same build)
This build layers on the prior connector work (self-model per-user identity,
v12.25.0). See CHANGELOG-v12.25.0.md.
