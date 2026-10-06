#!/usr/bin/env node
// src/tests/fixtures/fake-whisper-once.mjs
//
// A stand-in for the faster-whisper helper (src/voice/voice_stt.py), used by
// src/tests/voice-elevenlabs-stt.test.js. v13.35.0 -- SPEC-AUDIO-004.
//
// transcribe() in voice-engines.js spawns
//   <VOICE_PYTHON_BIN> voice_stt.py --transcribe <path> --model <m> --model-dir <d> [--language <l>]
// when the resident worker is off (VOICE_STT_WORKER_ENABLED=false). Pointing
// VOICE_PYTHON_BIN at a wrapper that runs this file lets the REAL route, the
// real validation and the real spawn path run without a Whisper model.
//
// It prints the helper's JSON answer. FAKE_WHISPER_LOG, when set, names a file
// each call is appended to as one JSON line ({bytes, language}), so a test can
// count Whisper calls. When `<FAKE_WHISPER_LOG>.fail` exists the helper answers
// with an error, as a broken model would.

import { appendFileSync, existsSync, statSync } from 'node:fs';

const argv = process.argv.slice(2);
const at = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const path = at('--transcribe');
const language = at('--language') || null;
const bytes = path && existsSync(path) ? statSync(path).size : 0;

if (process.env.FAKE_WHISPER_LOG) {
  appendFileSync(process.env.FAKE_WHISPER_LOG, `${JSON.stringify({ bytes, language })}\n`);
  if (existsSync(`${process.env.FAKE_WHISPER_LOG}.fail`)) {
    process.stdout.write(`${JSON.stringify({ error: 'model failed to load', code: 'stt_failed' })}\n`);
    process.exit(0);
  }
}

process.stdout.write(`${JSON.stringify({
  text: 'whisper heard this',
  language: language || 'en',
  duration_seconds: 1,
  segments: [{ start: 0, end: 1, text: 'whisper heard this' }],
})}\n`);
