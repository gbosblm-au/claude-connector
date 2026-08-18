# CHANGELOG v12.54.2

Hotfix. **The worker looked for its interpreter in the wrong place, and the gate
that would have caught it was never in the image.**

Follows v12.54.1, which fixed the fallback so this failure degrades instead of
502ing. This fixes the cause.

---

## The interpreter default was wrong about this repository's own layout

The Dockerfile in this tree sets:

```dockerfile
RUN python3 -m venv /opt/piper \
    && /opt/piper/bin/pip install piper-tts==1.2.0
ENV VOICE_PIPER_BIN=/opt/piper/bin/piper \
    VOICE_PIPER_DIR=/data/voice/piper
```

`VOICE_PIPER_BIN` is the venv. `VOICE_PIPER_DIR` is the **voices directory on
the mounted volume**. Two different things.

v12.53.0 guessed the interpreter as `VOICE_PIPER_DIR/venv/bin/python3` — a path
that exists on no correctly built deployment — and then fell back to the bare
system `python3`, which is the one interpreter guaranteed not to have piper,
because piper is installed in its own prefix precisely to keep a GPL dependency
out of everything else.

Now **derived** rather than guessed:

```js
const bin = env('VOICE_PIPER_BIN', '');          // /opt/piper/bin/piper
if (bin) {
  const sibling = join(dirname(bin), 'python3'); // /opt/piper/bin/python3
  if (existsSync(sibling)) return sibling;
}
```

`python3 -m venv /opt/piper` puts the console script and the interpreter in the
same `bin`, so this is that venv's interpreter by construction. The two cannot
drift apart, because one is computed from the other. The old directory guess is
retained as a secondary, tried after — derivation is evidence, the guess is an
assumption.

**No redeploy needed to unblock:** `VOICE_PIPER_PYTHON=/opt/piper/bin/python3`
has always been honoured and is what this default now produces on its own.

---

## The deployment gate was not in the deployment

```
Error: Cannot find module '/app/scripts/voice-worker-smoke.mjs'
```

`.dockerignore` explicitly allows `scripts/`. The Dockerfile never copied it:

```dockerfile
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./
```

So `npm run voice:smoke` — the §8 gate written to catch exactly the interpreter
fault above — could never run in the container. Neither could
`voice:benchmark`, which has been unrunnable in the image since it was written
and is the §8 item 2 gate.

Fixed with `COPY scripts/ ./scripts/`. Tests stay out: `.dockerignore` drops
`**/*.test.js` inside allowed paths.

A test now walks every `npm run` entry that points into `scripts/` and asserts
the file exists, so a script referenced by package.json but absent from the tree
fails CI rather than production.

---

## The smoke test carried its own copy of the resolution

It reimplemented `piperPython()`. The two drifted the instant the supervisor's
was corrected — which is the worst place for a gate to disagree with the thing
it gates: it can pass while production fails, or fail while production works.

It now imports `workerState().interpreter` from the supervisor. When nothing
resolves it fails with the fix rather than a stack trace:

```
FAIL: no Piper interpreter could be resolved
Set VOICE_PIPER_PYTHON to the python3 inside the Piper virtual environment.
In the image built by this repository's Dockerfile that is:
  VOICE_PIPER_PYTHON=/opt/piper/bin/python3
Note that VOICE_PIPER_DIR is the VOICES directory on the volume, not the venv.
Synthesis will use the CLI fallback until this resolves.
```

---

## Test results

```
voice-gpl-boundary    22 passed  (3 new)
voice-prosody         63 passed
voice-stt-worker      34 passed
voice                 47 passed
voice-auth            29 passed
```

---

## Deploying

`COPY scripts/` changes the image, so this one **does** need a rebuild — unlike
the env-var mitigation, which works on the running container immediately.

After deploying:

```bash
npm run voice:smoke
```

Expect `adapter: stream_raw` (the 1.2.0 API), the voice's sample rate, and a
warm synthesis time. That finally closes §8 item 1.
