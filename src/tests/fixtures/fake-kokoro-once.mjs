#!/usr/bin/env node
// src/tests/fixtures/fake-kokoro-once.mjs
//
// A stand-in for the Kokoro one-shot interpreter, used by
// src/tests/voice-segmenting.test.js and src/tests/voice-elevenlabs.test.js.
// v13.34.0 -- SPEC-AUDIO-003.
//
// The supervisor spawns `<VOICE_KOKORO_PYTHON> kokoro_worker.py --once ...` and
// writes one JSON request line to stdin. Pointing VOICE_KOKORO_PYTHON at this
// file (it is executable and ignores its argv) lets the REAL synthesis path --
// synthesizePcm, the segmenter, the duration check, the one-shot supervisor and
// its protocol parsing -- run without a 300 MB model.
//
// It reproduces the one kokoro-onnx 0.4.9 behaviour that matters here, read
// from that package's source: the phoneme string is split only at . , ! ? ;
// and any piece longer than MAX_PHONEME_LENGTH (510) is cut to 510 with a
// warning, and the call still succeeds. Each character stands in for one
// phoneme, and each surviving character yields a fixed number of samples, so a
// truncated rendering is measurably short.
//
// The samples are a non-zero tone, so edge fades at joins are observable.
//
// FAKE_KOKORO_LOG, when set, names a file each request's text is appended to
// (one JSON line per call), so a test can count and inspect engine calls. The
// supervisor hands its child a minimal environment, so the test's wrapper
// script sets this variable itself.
//
// `<FAKE_KOKORO_LOG>.fraction`, when that file exists, holds a number between 0
// and 1: the fraction of the audio actually returned. It simulates an engine
// that reports success with less audio than it was asked for (S2).

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const MAX_PHONEME_LENGTH = 510;
/** Characters per second of "speech" at length_scale 1. */
const CHARS_PER_SECOND = 15;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let request;
  try {
    request = JSON.parse(input.split('\n').filter(Boolean)[0]);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'bad_request', error: 'not JSON' })}\n`);
    return;
  }

  const text = String(request.text || '');
  if (process.env.FAKE_KOKORO_LOG) {
    appendFileSync(process.env.FAKE_KOKORO_LOG, `${JSON.stringify({ text })}\n`);
  }
  if (!text.trim()) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'empty_text', error: 'empty' })}\n`);
    return;
  }

  const rate = Number(request.sample_rate) || 24000;
  const lengthScale = Number(request.length_scale) > 0 ? Number(request.length_scale) : 1;

  // kokoro-onnx: re.split(r"([.,!?;])", phonemes), then truncate each batch.
  let spoken = 0;
  for (const part of text.split(/[.,!?;]/u)) {
    spoken += Math.min(part.trim().length, MAX_PHONEME_LENGTH);
  }
  let fraction = 1;
  const control = process.env.FAKE_KOKORO_LOG ? `${process.env.FAKE_KOKORO_LOG}.fraction` : '';
  if (control && existsSync(control)) {
    const f = Number(readFileSync(control, 'utf8').trim());
    if (Number.isFinite(f) && f > 0 && f <= 1) fraction = f;
  }
  const seconds = (spoken / CHARS_PER_SECOND) * lengthScale * fraction;
  const samples = Math.max(1, Math.round(seconds * rate));
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)) || 1000, i * 2);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true, sample_rate: rate, pcm_b64: pcm.toString('base64'),
    bytes: pcm.length, degraded: [],
  })}\n`);
});
