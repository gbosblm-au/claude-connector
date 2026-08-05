# claude-connector v12.33.0

**Phase 2 — Repeatability, Cycle 3B.** Roadmap items 1, 2, 11 and 12.

---

## The image loses several gigabytes (TNX-M-016)

The `Dockerfile` built a dedicated `android-sdk` stage — cmdline-tools,
platform-tools, `platforms;android-34`, `build-tools;34.0.0`, OpenJDK 17 JDK —
copied `/opt/android-sdk` into the **runtime** image, and installed an OpenJDK 17
JRE, justified in a comment as *"for the Android build tools invoked by
mobile_app_gen.py."*

**I verified that claim before removing anything**, because the `appforge`
mobile-app skill depends on that script and a wrong call here would break a real
feature.

`mobile_app_gen.py` is 783 lines and contains **no** `subprocess`, `os.system`,
`Popen`, `gradle`, `sdkmanager` or `javac` invocation, and never even reads
`ANDROID_HOME`. Every apparent match on "gradle" is a `gen_*_gradle()` function
name or an output filename. It is purely a source generator: it emits Gradle and
Java text files, which are compiled elsewhere.

So the toolchain was downloaded, installed and shipped, and never invoked.
Removing it strips several gigabytes from every deploy, removes a build-time
dependency on `dl.google.com`, and drops a large unaudited attack surface from
the runtime.

**`appforge` is unaffected** — it still generates a complete Android project,
built in Android Studio or CI as it always effectively was.

## Reproducible builds (TNX-H-010)

**`npm install` replaced with `npm ci`**, and `package-lock.json` is now
required. `npm ci` fails loudly when the lockfile is missing or out of step with
`package.json`; `npm install` silently mutates the tree to satisfy caret ranges.
All 23 dependencies used caret ranges, so two builds of the same commit could
resolve different trees — and "roll back and confirm" stops being dependable
incident response.

**One honest caveat about the lockfile.** A `package-lock.json` now exists, but
it was generated during this remediation work, so it records how the caret
ranges resolve **today**, not a historically known-good set. It makes future
builds reproducible; it does not reconstruct any past one. Treat the first
deploy on this lockfile as a dependency change and watch it accordingly.

**Base image pinning** is parameterised via `DEBIAN_DIGEST`, with the commands
to obtain the digest documented in the `Dockerfile`. **No digest is hardcoded.**
A digest is specific to the image the registry actually holds, and writing a
plausible-looking but unverified `sha256` would be worse than leaving it unset:
the build would either fail with a manifest error or, worse, succeed against
something nobody intended. A dated tag is mutable — registries repoint them on
security rebuilds — so this remains a real gap until the value is set.

## Constant-time secret comparison (TNX-M-018)

Seventeen comparisons replaced across `server-http.js`: `RAILWAY_RESTORE_TOKEN`
(×15), `MEMORY_AUTH_TOKEN` and `UPLOAD_API_KEY`, all previously `!==` on raw
strings. They now use the SHA-256 + `timingSafeEqual` helper added in v12.28.0.

## Committed bytecode removed (TNX-M-017)

`deploy/__pycache__/brain_scan.cpython-312.pyc` deleted. The image installs
Python **3.11**, so bytecode compiled for 3.12 could never have been loaded.
`__pycache__` and `*.pyc` added to `.dockerignore`, and
`PYTHONDONTWRITEBYTECODE=1` set so it cannot return.

## CI pipeline (TNX-H-009, roadmap item 1)

`.github/workflows/ci.yml`, three jobs matching the audit's resolution.

Every check **fails** the build rather than warning. Several of the audit's
findings were not subtle — a live RSA private key committed, a test suite never
run, a dependency tree with no lockfile. None needed a clever reviewer; each
needed a job that fails. A pipeline that reports without blocking is a
dashboard, and dashboards get ignored during a busy week.

Two details worth noting because I got them wrong first and verified before
shipping:

- **`node --test tests/` does not work.** Node resolves a bare directory as a
  *module* and fails with `MODULE_NOT_FOUND`. The workflow uses a glob.
- **`--test-timeout` is load-bearing.** `thinking-mode-stream.test.js` does not
  terminate — pre-existing, reproducible on the original archive. With the
  timeout it is reported as cancelled and the job completes; without one it
  hangs the runner.

`gitleaks` runs with `fetch-depth: 0`, because a secret removed in a later
commit is still in history and still compromised — which is exactly what
happened with TNX-C-002.

---

## Verification

Connector 61 passing, gateway 689 passing, plugin 35 passing with 4 baselined —
0 failures anywhere. All JavaScript parses cleanly.

Both CI test invocations were executed locally before being committed to the
workflow, rather than assumed to work.
