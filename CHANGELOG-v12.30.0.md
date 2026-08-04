# claude-connector v12.30.0

**Phase 1 — Reliability, Cycle 2B** — audit `TNX-AUDIT-2026-08`.

Follows v12.29.0.

---

## THIS RELEASE FIXES SILENT DATA LOSS

If you have ever set WordPress or LinkedIn credentials through the MCP tools
`set_wordpress_credentials` or `set_linkedin_credentials`, **they were being
destroyed on every redeploy**, with no error at any point.

This release both fixes the cause and rescues any credentials still present on
a running container. **Deploy this build without first rebuilding the container
image**, so the migration can read the legacy file before it vanishes. If the
image has already been rebuilt, the old credentials are gone and must be
re-entered once.

---

## New environment variables

| Variable | Purpose |
|---|---|
| `CONNECTOR_DATA_DIR` | Credential directory. Defaults to `/data`, the Railway volume mount |
| `CONNECTOR_SECRET_KEY` | 32-byte key for encryption at rest. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Without `CONNECTOR_SECRET_KEY` the store still works, but credentials are
written unencrypted and the connector logs a warning at boot.

---

## TNX-H-014 — Runtime credential storage was plaintext and on the wrong filesystem (High)

Four defects, of which the first was actively destroying data.

### 1. The file was on the wrong filesystem

```js
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = resolve(__dirname, "../../data");
```

From `/app/src/utils/` that resolves to **`/app/data`**, inside the container
image. The Railway volume is mounted at **`/data`** (`railway.toml`:
`dest = "/data"`). Every credential set through the documented MCP workflow was
therefore lost on every redeploy.

The old module header asserted the opposite:

> *"With a Railway volume mounted at /data (or similar), the file persists
> across restarts."*

That was wrong, because the file was never written to `/data` in the first
place. An operator following the documented process would find their WordPress
and LinkedIn integrations breaking after each deploy with nothing explaining
why — the worst kind of failure, because the system reports success and then
quietly discards the work.

`DATA_DIR` now defaults to `/data`, overridable with `CONNECTOR_DATA_DIR`, and
the module logs an **error** at boot if the resolved path is inside the image.

### 2. Plaintext at rest

No encryption, and `writeFileSync` used the default mode (0666 before umask), so
the file was likely world-readable inside the container. Any tool with
filesystem access could read it — `script_execute` (TNX-C-004) being the obvious
one, which before v12.28.0 also inherited the entire process environment.

Secret fields are now encrypted with **AES-256-GCM** via the new
`src/utils/secretBox.js`, which mirrors the gateway's `lib/workflow-secrets.js`
scheme byte-for-byte, including the `v1:<iv>:<tag>:<ciphertext>` payload format.
The audit's point was that the correct primitive already existed and simply was
not being used; matching the format exactly is what makes the eventual
extraction into a shared package a move rather than a reconciliation of two
divergent formats.

GCM rather than CBC matters. CBC gives confidentiality with no integrity, so
ciphertext is malleable and a padding oracle is available. GCM authenticates: a
modified ciphertext fails to decrypt rather than producing attacker-influenced
plaintext. A field that fails to decrypt is **dropped and logged**, not returned
— handing ciphertext to WordPress as if it were a password would produce a
confusing authentication error instead of an obvious configuration one.

Only credential fields are encrypted. `wp_url` and `wp_username` stay readable
so the file remains diagnosable by an operator.

### 3. Non-atomic writes

`writeFileSync` truncates in place. A crash between the truncate and the write
left an empty or partial file, losing **every** stored credential rather than
just the one being written.

Writes now go to a temp file **in the same directory** (rename is only atomic
within one filesystem, and `/tmp` is frequently a different mount from a
volume), are `fsync`ed, and are then renamed. The fsync matters independently:
without it the rename can reach the disk before the data does, and a power loss
leaves a correctly-named empty file.

### 4. No writability check

A read-only or unmounted volume failed only when someone tried to save a
credential. `checkStorageLocation()` now probes with a real write at boot, and
the credential store is reported as a **non-critical** readiness check — the
connector serves its other tools perfectly well without it, and removing the
whole instance from rotation would be a larger outage than the one being
reported.

### Migration

`migrateLegacyCredentials()` runs once at boot. If `/app/data/credentials.json`
exists and the volume path has no file yet, it is read and rewritten encrypted
at the correct location. The legacy file is **left in place** rather than
deleted: it lives in the image and will vanish on the next deploy anyway, and
deleting it would remove the only copy if the write to the volume failed. An
existing file at the new path is never overwritten.

---

## Verification performed

44 automated tests in `src/tests/phase0-security.test.js`, all passing.

Behavioural verification against the acceptance criteria:

| Criterion | Result |
|---|---|
| Credentials survive a redeploy | round-trip through a fresh module instance succeeds |
| The file is mode 0600 | `600` |
| Contents are not readable as plaintext | password and client secret absent from the file |
| A crash during write does not lose existing credentials | atomic rename; no temp files left after 5 writes; target always valid JSON |

Additionally verified: a tampered ciphertext is **rejected**, not returned as
garbage; the auth header reconstructs correctly from the decrypted password;
status objects returned to users contain no secret; a short key is refused; and
the legacy migration recovers plaintext credentials, encrypts them, leaves the
original in place and refuses to overwrite live data on a second run.

---

## Still outstanding in this component

`TNX-H-001` stage 1 — externalising correctness-critical state from twelve
process-local `Map` caches — is Cycle 2C, and remains the single most
consequential architectural constraint in the system.
