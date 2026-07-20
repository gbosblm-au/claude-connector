# CHANGELOG - claude-connector

## 12.18.0 - Phase 6: Self-Model DB Migration - connector side (dual-write)

Adds the connector half of the SQLite -> Postgres migration: a gateway client for
the self-model API and an env-gated dual-write on the state path. SQLite remains
the source of truth throughout the transition; nothing here changes behaviour
unless dual-write is explicitly enabled.

### New

- **Gateway client** (`self-model/volume-assets/skill/ava/scripts/self_model_gateway.py`,
  stdlib urllib): read/write the gateway self-model API. Writes that fail (gateway
  unreachable) are appended to a local JSONL queue and replayed by flush_queue();
  reads return None on failure so callers fall back to SQLite. Configured by
  GATEWAY_URL, GATEWAY_API_KEY, SELF_MODEL_DUAL_WRITE, SELF_MODEL_QUEUE_PATH.

### Changed

- `src/tools-self-model/stateVector.js`: after the SQLite state write, a
  best-effort, fire-and-forget POST mirrors the vector to
  /ti-self-model/state - only when SELF_MODEL_DUAL_WRITE=1 and GATEWAY_URL is set.
  Fully guarded: it cannot throw into or change the primary SQLite write.

### Compatibility

- Additive and inert by default (dual-write off). No new runtime dependencies
  (stdlib only). Requires gateway >= 2.14.0 for the endpoints to exist.

### Verification performed

- Connector client tested against a live gateway (real Postgres): write_state ->
  read_state round-trips the JSONB payload; query returns rows; a write to a dead
  endpoint queues to JSONL and flush_queue replays it to the live gateway
  (sent 1, remaining 0). Offline self-test confirms queue-on-failure.
- Regression: Phase 1 + 2 unit suites still 14/14 with dual-write off; the state
  write path is unchanged when the env flag is unset.
