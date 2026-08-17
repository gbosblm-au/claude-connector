// src/tests/voice-auth.test.js
//
// Tenax Voice -- the transport credential, and the two failures it fixes.
// (v12.50.0)
//
// Run: node --test src/tests/voice-auth.test.js
//
// ===========================================================================
// WHAT THIS FILE IS GUARDING
// ===========================================================================
//
// Three defects shipped together in v12.49.0 and presented as one symptom:
// "voice is off and the Railway variables are being ignored".
//
//   1. /voice/* sat behind MCP_API_KEY, which the Gateway Service does not
//      hold. Every gateway call was 401'd before any voice code ran, so
//      /ti-voice/status reported connector_unreachable and the mic never
//      rendered -- whatever VOICE_ENABLED was set to.
//
//   2. requireAuth() checked req.authenticated, a flag nothing in this
//      connector sets. A correctly credentialled, correctly allowlisted
//      operator still got 401 from POST /voice/transcribe.
//
//   3. /voice/health returns the identical "off" body to any caller it
//      refuses, so an operator debugging a per-user refusal read
//      enabled:false as proof that VOICE_ENABLED was being ignored.
//
// None of the three is visible from a unit test of any single module, which is
// why they are tested here through a real Express app with the real
// authentication gate mounted in front of the real routes.
//
// The tests below must keep BOTH properties true at once, and they pull in
// opposite directions:
//
//   REACHABLE   the gateway, holding only the restore token, must get through.
//   CLOSED      an unauthorised caller must not, and a refused caller must not
//               learn that the feature exists.

import test    from 'node:test';
import assert  from 'node:assert/strict';
import express from 'express';

import { mcpAuthMiddleware, assertConfigured,
         isPublicPath, isSelfAuthenticatedPath } from '../middleware/mcpAuth.js';
import { registerVoiceRoutes }                   from '../routes/voice.js';
import { classifyVoiceCredential, constantTimeEquals,
         extractBearer, extractRestoreToken }    from '../voice/voice-auth.js';
import { installedVoices }                       from '../voice/voice-engines.js';
import { VOICE_SOURCES, MISSING_UPSTREAM,
         installVoice, voicesDir }              from '../voice/voice-provision.js';
import { VOICE_CATALOG }                        from '../voice/voice-catalog.js';

const MCP_KEY      = 'k'.repeat(48);
const RESTORE_TOKEN = 'r'.repeat(40);

/**
 * Run a body with a known voice environment, restoring it afterwards.
 *
 * Async-aware: a plain try/finally would restore the environment the moment an
 * async fn() returned its promise, so the body would run against the restored
 * values.
 *
 * @param {object} vars
 * @param {Function} fn
 * @returns {Promise<void>}
 */
async function withEnv(vars, fn) {
  const prior = {};
  for (const key of Object.keys(vars)) {
    prior[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(prior)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

/** The real stack: authentication gate first, then the voice routes. */
async function listenWithAuthGate() {
  assertConfigured();
  const app = express();
  app.use(mcpAuthMiddleware);
  registerVoiceRoutes(app);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(r => server.close(r)),
  };
}

const asOperator = () => ({ Authorization: `Bearer ${MCP_KEY}` });
const asGateway  = () => ({ 'X-Railway-Restore-Token': RESTORE_TOKEN });
const identity   = (userId, tenantId) => {
  const h = {};
  if (userId) h['X-Tenax-User-Id'] = userId;
  if (tenantId) h['X-Tenax-Tenant-Id'] = tenantId;
  return h;
};

const VOICE_ON = {
  MCP_API_KEY: MCP_KEY,
  RAILWAY_RESTORE_TOKEN: RESTORE_TOKEN,
  VOICE_ENABLED: 'on',
  VOICE_ALLOWLIST_SOURCE: 'env',
  VOICE_TEST_USERS: 'ava:38',
  // Absolute and absent, so the TTS probe answers deterministically here
  // instead of depending on what the test machine happens to have installed.
  VOICE_PIPER_BIN: '/nonexistent/piper',
};

// ===========================================================================
test('the voice routes are exempt from the MCP key but are not public', () => {
  for (const p of ['/voice/health', '/voice/transcribe', '/voice/synthesize']) {
    assert.equal(isSelfAuthenticatedPath(p), true,
      `${p} must be exempt from MCP_API_KEY; the gateway holds the restore token instead`);
    assert.equal(isPublicPath(p), false,
      `${p} verifies a credential of its own and must never be public`);
  }
});

test('the exemption is exact, so a future /voice/* route is not exempt by default', () => {
  // A prefix entry here would silently exempt every voice route anyone adds
  // later. That is the TNX-C-001 failure mode, restated for this feature.
  for (const p of ['/voice', '/voice/', '/voice/anything-new', '/voice/healthz']) {
    assert.equal(isSelfAuthenticatedPath(p), false, `${p} must not be exempt`);
    assert.equal(isPublicPath(p), false, `${p} must not be public`);
  }
});

// ===========================================================================
test('the credential classifier accepts exactly two credentials', async () => {
  await withEnv(VOICE_ON, () => {
    const operator = classifyVoiceCredential({ headers: { authorization: `Bearer ${MCP_KEY}` } });
    assert.deepEqual(operator, { ok: true, credential: 'mcp_api_key', operator: true });

    // The alternate carrier mcpAuth also accepts, so a client that can already
    // talk to the connector needs no new behaviour.
    const alt = classifyVoiceCredential({ headers: { 'x-mcp-api-key': MCP_KEY } });
    assert.equal(alt.ok, true);
    assert.equal(alt.operator, true);

    const gateway = classifyVoiceCredential({ headers: { 'x-railway-restore-token': RESTORE_TOKEN } });
    assert.deepEqual(gateway, { ok: true, credential: 'restore_token', operator: false },
      'the gateway is authenticated but is NOT the operator');

    for (const headers of [ {}, { authorization: 'Bearer wrong' },
                            { 'x-railway-restore-token': 'wrong' },
                            { authorization: `Bearer ${MCP_KEY.slice(0, -1)}` } ]) {
      assert.equal(classifyVoiceCredential({ headers }).ok, false,
        `must refuse ${JSON.stringify(headers)}`);
    }
  });
});

test('a header sent twice is ambiguous and is treated as absent', async () => {
  await withEnv(VOICE_ON, () => {
    // Section 6.4: fail closed on ambiguity, rather than picking one of the two
    // values on the caller's behalf.
    const req = { headers: { 'x-railway-restore-token': [RESTORE_TOKEN, 'other'] } };
    assert.equal(extractRestoreToken(req), '');
    assert.equal(classifyVoiceCredential(req).ok, false);
  });
});

test('the token comparison is constant-time and refuses empty operands', () => {
  assert.equal(constantTimeEquals('abc', 'abc'), true);
  assert.equal(constantTimeEquals('abc', 'abd'), false);
  // Different lengths must not throw. A throw would turn a 401 into a 500 and
  // leak the expected length through the difference.
  assert.equal(constantTimeEquals('a', 'a'.repeat(500)), false);
  assert.equal(constantTimeEquals('', ''), false);
  assert.equal(constantTimeEquals(undefined, 'x'), false);
  assert.equal(extractBearer({ headers: { authorization: 'Basic abc' } }), '');
});

// ===========================================================================
test('REGRESSION: the gateway reaches voice with the restore token alone', async () => {
  await withEnv(VOICE_ON, async () => {
    const { base, close } = await listenWithAuthGate();
    try {
      // This is the exact call routes/ti-voice.js makes on /ti-voice/status.
      // Before v12.50.0 it was 401, so connector_ready was false forever and
      // the mic button never mounted.
      const r = await fetch(`${base}/voice/health`, {
        headers: { ...asGateway(), ...identity('38', 'ava') },
      });
      assert.equal(r.status, 200);

      const body = await r.json();
      assert.equal(body.enabled, true);
      assert.equal(body.voice_enabled_for_this_user, true,
        'the flag /ti-voice/status branches on must be true for a granted user');

      // The gateway is authenticated but is not the operator, so it must not
      // receive the diagnostics: anything it holds can reach a browser.
      assert.equal(body.operator_diagnostics, undefined);
    } finally {
      await close();
    }
  });
});

test('REGRESSION: an authorised transcribe is no longer refused as unauthenticated', async () => {
  await withEnv(VOICE_ON, async () => {
    const { base, close } = await listenWithAuthGate();
    try {
      for (const [who, creds] of [['operator', asOperator()], ['gateway', asGateway()]]) {
        const r = await fetch(`${base}/voice/transcribe`, {
          method: 'POST',
          headers: { ...creds, ...identity('38', 'ava'), 'Content-Type': 'audio/wav' },
          body: Buffer.alloc(4096),
        });
        // What it becomes is a validation answer about the audio (this body is
        // not a real WAV). What it must never again be is 401.
        assert.notEqual(r.status, 401, `${who} must not be told it is unauthenticated`);
        assert.equal(r.status === 404, false, `${who} is allowlisted and must pass the gate`);
      }
    } finally {
      await close();
    }
  });
});

// ===========================================================================
test('an uncredentialled caller is refused, allowlisted or not', async () => {
  await withEnv(VOICE_ON, async () => {
    const { base, close } = await listenWithAuthGate();
    try {
      const r = await fetch(`${base}/voice/health`, { headers: identity('38', 'ava') });
      assert.equal(r.status, 401);

      const wrong = await fetch(`${base}/voice/health`, {
        headers: { 'X-Railway-Restore-Token': 'not-the-token', ...identity('38', 'ava') },
      });
      assert.equal(wrong.status, 401);
    } finally {
      await close();
    }
  });
});

test('an uncredentialled upload is drained and answered, not reset mid-stream', async () => {
  await withEnv(VOICE_ON, async () => {
    const { base, close } = await listenWithAuthGate();
    try {
      // The v12.31.0 lesson: responding while the client is still uploading
      // resets the stream, and over HTTP/2 the caller then sees a transport
      // error rather than a status code. A 2 MB body must still produce a
      // readable 401.
      const r = await fetch(`${base}/voice/transcribe`, {
        method: 'POST',
        headers: { ...identity('38', 'ava'), 'Content-Type': 'audio/wav' },
        body: Buffer.alloc(2 * 1024 * 1024),
      });
      assert.equal(r.status, 401);
      const body = await r.json();
      assert.equal(body.code, 'VOICE_AUTH_REQUIRED');
    } finally {
      await close();
    }
  });
});

test('the feature gate still 404s a credentialled but non-allowlisted caller', async () => {
  await withEnv(VOICE_ON, async () => {
    const { base, close } = await listenWithAuthGate();
    try {
      // Exemption from the MCP key is not exemption from the gate. Holding the
      // operator key does not put an arbitrary user on the allowlist, and the
      // refusal is still the indistinguishable 404, never a 403.
      const r = await fetch(`${base}/voice/transcribe`, {
        method: 'POST',
        headers: { ...asOperator(), ...identity('99', 'ava'), 'Content-Type': 'audio/wav' },
        body: Buffer.alloc(1024),
      });
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: 'not_found' });
    } finally {
      await close();
    }
  });
});

// ===========================================================================
test('health explains a refusal to the operator and to nobody else', async () => {
  await withEnv(VOICE_ON, async () => {
    const { base, close } = await listenWithAuthGate();
    try {
      // The reported case: master switch on, tenant-qualified allowlist entry,
      // and a caller sending only the user header. The body must still look
      // exactly like "voice is off" ...
      const r = await fetch(`${base}/voice/health`, {
        headers: { ...asOperator(), ...identity('38') },
      });
      const body = await r.json();
      assert.equal(body.enabled, false);
      assert.equal(body.voice_enabled_for_this_user, false);

      // ... while telling the operator, and only the operator, what actually
      // happened. This is the part that stops enabled:false being read as
      // "VOICE_ENABLED is ignored".
      const d = body.operator_diagnostics;
      assert.ok(d, 'the operator must be told why');
      assert.equal(d.master_switch, true);
      assert.equal(d.denied_reason, 'identity_not_allowlisted');
      assert.equal(d.identity_seen.user_id, '38');
      assert.equal(d.identity_seen.tenant_id, null,
        'the missing tenant header is the whole cause and must be visible');

      // Never the entries themselves: they are account identifiers.
      assert.equal(JSON.stringify(body).includes('ava:38'), false);
      assert.equal(d.allowlist.count, 1, 'a count, not a list');
    } finally {
      await close();
    }
  });
});

test('health names the master switch when that is what refused the caller', async () => {
  await withEnv({ ...VOICE_ON, VOICE_ENABLED: 'false' }, async () => {
    const { base, close } = await listenWithAuthGate();
    try {
      const r = await fetch(`${base}/voice/health`, {
        headers: { ...asOperator(), ...identity('38', 'ava') },
      });
      const body = await r.json();
      assert.equal(body.enabled, false, 'the kill switch still wins over everything');
      assert.equal(body.operator_diagnostics.master_switch, false);
      assert.equal(body.operator_diagnostics.denied_reason, 'master_switch_off');
    } finally {
      await close();
    }
  });
});

test('a refused NON-operator learns nothing beyond the standard off body', async () => {
  await withEnv(VOICE_ON, async () => {
    const { base, close } = await listenWithAuthGate();
    try {
      const r = await fetch(`${base}/voice/health`, {
        headers: { ...asGateway(), ...identity('99', 'ava') },
      });
      const body = await r.json();
      assert.equal(body.operator_diagnostics, undefined);
      assert.deepEqual(Object.keys(body).sort(),
        ['enabled', 'models_loaded', 'stt_ready', 'tts_ready', 'voice_enabled_for_this_user']);
    } finally {
      await close();
    }
  });
});

// ===========================================================================
test('the TTS probe survives the pinned engine, which has no --version', async () => {
  await withEnv(VOICE_ON, async () => {
    const { base, close } = await listenWithAuthGate();
    try {
      const body = await (await fetch(`${base}/voice/health`, {
        headers: { ...asOperator(), ...identity('38', 'ava') },
      })).json();

      // VOICE_PIPER_BIN points at nothing here, so the probe must say WHICH
      // variable is wrong rather than reporting an argparse usage banner --
      // which is what `piper --version` produced against piper-tts 1.2.0,
      // whose -m/--model argument is required.
      assert.match(String(body.errors.tts), /VOICE_PIPER_BIN|not found/);
      assert.equal(/the following arguments are required/.test(String(body.errors.tts)), false,
        'a usage banner is not a diagnosis');
      assert.equal(body.tts_ready, false);
    } finally {
      await close();
    }
  });
});

test('the STT probe reports the helper\'s own error instead of "probe failed"', async () => {
  // This test runs on a machine where faster-whisper is NOT installed, which is
  // the failing case it needs. VOICE_PYTHON_BIN is deliberately not overridden:
  // voice-engines.js binds its configuration at module load, so an override set
  // here would not reach the already-imported module and the test would be
  // asserting against a value it did not actually change.
  await withEnv(VOICE_ON, async () => {
    const { base, close } = await listenWithAuthGate();
    try {
      const body = await (await fetch(`${base}/voice/health`, {
        headers: { ...asOperator(), ...identity('38', 'ava') },
      })).json();

      // voice_stt.py writes its {error, code} to STDOUT and exits non-zero. The
      // previous probe parsed stdout only on exit 0, so on the one path where
      // the message exists it discarded it and reported the bare string
      // "probe failed" -- an operator told that the probe failed, and nothing
      // else, for the failure the helper was written to explain.
      assert.equal(body.stt_ready, false, 'faster-whisper is not installed in the test image');
      assert.notEqual(body.errors.stt, 'probe failed',
        'the placeholder string is the defect: it names no cause');
      assert.match(String(body.errors.stt),
        /faster-whisper|faster_whisper|VOICE_PYTHON_BIN|exited/,
        'the operator must get a cause they can act on');
    } finally {
      await close();
    }
  });
});

test('installed voices are read from the volume, not from the licence catalogue', async () => {
  await withEnv({ ...VOICE_ON, VOICE_VOICES_DIR: '/nonexistent/voices' }, () => {
    // The catalogue lists five licence-cleared voices whether or not a single
    // .onnx has been downloaded. Conflating the two is what let TTS report
    // itself ready and then fail on the first press of the speak button.
    assert.deepEqual(installedVoices(), []);
  });
});

// ===========================================================================
// Voice model provisioning (v12.50.0)
// ===========================================================================

test('every catalogue voice either has a download source or is named as missing', () => {
  // The failure this catches: a voice offered by the API that nothing can ever
  // download, discovered by a user pressing a speak button. Each catalogue
  // entry must resolve to a repository path, or be explicitly recorded as
  // unavailable with a reason.
  for (const entry of VOICE_CATALOG) {
    const known = Object.prototype.hasOwnProperty.call(VOICE_SOURCES, entry.voice_id)
      || Object.prototype.hasOwnProperty.call(MISSING_UPSTREAM, entry.voice_id);
    assert.equal(known, true,
      `${entry.voice_id} is offered by the catalogue but has no recorded source`);
  }
});

test('a catalogue voice that does not exist upstream is reported, not substituted', async () => {
  // ja_JP-ryoko-medium is the Japanese default in VOICE_CATALOG and is not
  // published by rhasspy/piper-voices. VOICE_CATALOG is a LICENCE record, so
  // silently pointing that id at a different voice would put an unreviewed
  // model behind a reviewed name. The provisioner must refuse and explain.
  const result = await installVoice('ja_JP-ryoko-medium');
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /ja_JA-hi_fi_captain-medium/);
  assert.equal(Object.prototype.hasOwnProperty.call(VOICE_SOURCES, 'ja_JP-ryoko-medium'), false,
    'the missing id must not be aliased to another voice');
});

test('an unknown voice id is refused without touching the network', async () => {
  const result = await installVoice('../../etc/passwd');
  assert.equal(result.status, 'unknown');
  // The id is looked up in a fixed table, so a path-shaped id resolves to
  // nothing rather than to a path.
  assert.match(result.error, /No source is recorded/);
});

test('the voices directory follows the same variables as the engine', async () => {
  await withEnv({ VOICE_VOICES_DIR: '/tmp/tenax-voice-test-dir' }, () => {
    assert.equal(voicesDir(), '/tmp/tenax-voice-test-dir');
  });
  await withEnv({ VOICE_VOICES_DIR: undefined, VOICE_PIPER_DIR: '/data/voice/piper' }, () => {
    // Must match voice-engines.js, or the provisioner writes where nothing reads.
    assert.equal(voicesDir(), '/data/voice/piper/voices');
  });
});

test('provisioning is opt-in and never fires unrequested', async () => {
  const { provisionFromEnv } = await import('../voice/voice-provision.js');
  await withEnv({ VOICE_PROVISION_VOICES: undefined }, () => {
    assert.equal(provisionFromEnv(() => {}), null, 'unset must do nothing at all');
  });
  await withEnv({ VOICE_PROVISION_VOICES: '  ,  ,' }, () => {
    assert.equal(provisionFromEnv(() => {}), null, 'an empty list must do nothing');
  });
});
