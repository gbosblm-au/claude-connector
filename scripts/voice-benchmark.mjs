#!/usr/bin/env node
// scripts/voice-benchmark.mjs
//
// Tenax Voice -- Phase 0 benchmark gate. Specification Section 14.
//
// "A half-day step that runs before any defaults are locked. Deploy the voice
//  engine on the actual target Railway CPU and benchmark base/small/medium STT
//  tiers plus the four launch TTS voices. Measure real-time factor, first-byte
//  latency, RAM and CPU under load."
//
// Section 14 calls the gate HARD: "no defaults ship until the benchmark
// confirms the Section 12 budgets." This script is that gate. It measures, it
// compares against the budget table, and it prints the values to lock. It does
// not choose them for you and it does not write configuration -- a benchmark
// that silently rewrote the defaults it was meant to validate would be marking
// its own homework.
//
// WHERE TO RUN IT
// ---------------
// On the TARGET Railway container, not a laptop. The whole point is the actual
// CPU under the actual co-tenancy with the rest of the connector. A run on
// different hardware produces numbers that look like measurements and are not.
//
//   node scripts/voice-benchmark.mjs --base http://127.0.0.1:8080 \
//        --sample /path/to/sample-en.wav --token "$AUTH"
//
// Samples: one recording per launch language, 10 seconds of clear speech.
// Section 16 wants "correct text for a known sample in each of English,
// Vietnamese, Chinese and Japanese", so the transcript is printed for a human
// to judge -- accuracy is not something this script can score for you.

import { readFileSync, existsSync } from 'node:fs';
import { basename }                 from 'node:path';

// Section 12. These are the numbers the gate tests against.
const BUDGETS = {
  stt_realtime_factor:   { limit: 1.0, unit: 'x',  label: 'STT real-time factor' },
  stt_end_to_end_10s:    { limit: 2000, unit: 'ms', label: 'STT end-to-end (10s utterance)' },
  tts_first_byte:        { limit: 200,  unit: 'ms', label: 'TTS first byte' },
  tts_realtime_factor:   { limit: 0.5,  unit: 'x',  label: 'TTS real-time factor' },
  round_trip:            { limit: 3000, unit: 'ms', label: 'Voice round trip (short utterance)' },
};

const STT_TIERS = ['base', 'small', 'medium'];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE   = (arg('base', 'http://127.0.0.1:8080') || '').replace(/\/$/, '');
const TOKEN  = arg('token', process.env.VOICE_BENCH_TOKEN || '');
const RUNS   = parseInt(arg('runs', '3'), 10) || 3;

/** Samples: --sample-<lang>, or a single --sample treated as English. */
function samples() {
  const out = {};
  for (const lang of ['en', 'vi', 'zh', 'ja']) {
    const p = arg(`sample-${lang}`);
    if (p && existsSync(p)) out[lang] = p;
  }
  const single = arg('sample');
  if (single && existsSync(single) && !out.en) out.en = single;
  return out;
}

function headers(extra) {
  const h = { ...(extra || {}) };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

/** Wall-clock duration of a WAV, so real-time factor has a denominator. */
function wavSeconds(buf) {
  if (buf.length < 44 || buf.slice(0, 4).toString() !== 'RIFF') return null;
  let off = 12, byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.slice(off, off + 4).toString('ascii');
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    else if (id === 'data') return byteRate ? Math.min(size, buf.length - off - 8) / byteRate : null;
    off += 8 + size + (size % 2);
    if (size <= 0) break;
  }
  return null;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Memory now, so the delta across a tier shows what the model actually cost. */
async function rss() {
  try {
    const h = await fetch(`${BASE}/voice/health`, { headers: headers() });
    await h.json();
  } catch (e) { /* health is best-effort here */ }
  return process.memoryUsage().rss;
}

async function benchSTT(tier, lang, path) {
  const audio = readFileSync(path);
  const seconds = wavSeconds(audio);
  const times = [];
  let transcript = '';
  let failure = null;

  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/voice/transcribe?model=${tier}&language=${lang}`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'audio/wav' }),
        body: audio,
      });
      const elapsed = Date.now() - t0;
      if (!res.ok) { failure = `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`; break; }
      const body = await res.json();
      // The FIRST run pays the model download and load. Including it in the
      // median would report a cold-start cost as steady-state latency and make
      // every tier look like it misses the budget.
      if (i > 0 || RUNS === 1) times.push(elapsed);
      transcript = body.text || '';
    } catch (err) { failure = err.message; break; }
  }

  if (failure) return { tier, lang, failure };
  const ms = median(times);
  return {
    tier, lang,
    median_ms: Math.round(ms),
    audio_seconds: seconds,
    realtime_factor: seconds ? +(ms / 1000 / seconds).toFixed(3) : null,
    transcript,
  };
}

async function benchTTS(voice, lang, text) {
  const times = [];
  const firstBytes = [];
  let audioSeconds = null;
  let failure = null;

  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/voice/synthesize`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text, voice, language: lang }),
      });
      if (!res.ok) { failure = `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`; break; }

      // First byte is measured off the reader, not the resolved body: awaiting
      // the whole response measures total synthesis, which is a different line
      // in the budget table.
      const reader = res.body.getReader();
      const first = await reader.read();
      const firstByteMs = Date.now() - t0;

      const chunks = first.value ? [first.value] : [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = Date.now() - t0;
      const wav = Buffer.concat(chunks.map(Buffer.from));
      audioSeconds = wavSeconds(wav);

      if (i > 0 || RUNS === 1) { times.push(total); firstBytes.push(firstByteMs); }
    } catch (err) { failure = err.message; break; }
  }

  if (failure) return { voice, lang, failure };
  const ms = median(times);
  return {
    voice, lang,
    median_ms: Math.round(ms),
    first_byte_ms: Math.round(median(firstBytes)),
    audio_seconds: audioSeconds,
    realtime_factor: audioSeconds ? +(ms / 1000 / audioSeconds).toFixed(3) : null,
  };
}

function verdict(value, budgetKey) {
  const b = BUDGETS[budgetKey];
  if (value === null || value === undefined) return '  ?  ';
  return value <= b.limit ? ' PASS' : ' FAIL';
}

async function main() {
  console.log('Tenax Voice -- Phase 0 benchmark gate (Specification Section 14)');
  console.log(`Target: ${BASE}   runs per measurement: ${RUNS} (first run discarded as cold start)\n`);

  const health = await fetch(`${BASE}/voice/health`, { headers: headers() })
    .then(r => r.json()).catch(e => ({ error: e.message }));

  if (!health.enabled) {
    console.error('Voice is not enabled on the target. Set VOICE_ENABLED=true and redeploy.');
    process.exit(2);
  }
  if (!health.stt_ready || !health.tts_ready) {
    console.error(`Engines not ready -- stt:${health.stt_ready} tts:${health.tts_ready}`);
    console.error(`  stt: ${health.errors?.stt || 'ok'}`);
    console.error(`  tts: ${health.errors?.tts || 'ok'}`);
    process.exit(2);
  }
  if (health.catalogue && health.catalogue.usable === 0) {
    console.error('No voice has cleared its licence audit, so no TTS measurement is possible.');
    console.error('Complete the per-voice MODEL_CARD audit (compliance obligation 2) first.');
    process.exit(2);
  }

  const files = samples();
  if (!Object.keys(files).length) {
    console.error('No sample audio. Pass --sample-en <file> (and vi/zh/ja) or --sample <file>.');
    console.error('Section 16 wants a known sample per launch language, ~10s of clear speech.');
    process.exit(2);
  }

  const rows = [];
  let failures = 0;

  console.log('SPEECH TO TEXT');
  console.log('tier    lang  median      RTF    budget          transcript');
  for (const tier of STT_TIERS) {
    for (const [lang, path] of Object.entries(files)) {
      const before = await rss();
      const r = await benchSTT(tier, lang, path);
      const after = await rss();
      if (r.failure) { console.log(`${tier.padEnd(7)} ${lang}     FAILED  ${r.failure}`); failures++; continue; }

      const rtf = verdict(r.realtime_factor, 'stt_realtime_factor');
      const e2e = verdict(r.median_ms, 'stt_end_to_end_10s');
      if (rtf.trim() === 'FAIL' || e2e.trim() === 'FAIL') failures++;

      console.log(
        `${tier.padEnd(7)} ${lang}    ${String(r.median_ms).padStart(6)}ms  `
        + `${String(r.realtime_factor).padStart(5)}  RTF${rtf} E2E${e2e}  `
        + `"${(r.transcript || '').slice(0, 40)}"`);
      rows.push({ kind: 'stt', ...r, rss_delta_mb: +((after - before) / 1048576).toFixed(1) });
    }
  }

  console.log('\nTEXT TO SPEECH');
  console.log('voice                        lang  median   first-byte   RTF    budget');
  const SENTENCES = {
    en: 'The quick brown fox jumps over the lazy dog.',
    vi: 'Xin chao, day la mot cau thu nghiem.',
    zh: 'This is a Chinese test sentence.',
    ja: 'This is a Japanese test sentence.',
  };
  for (const [lang, voices] of Object.entries(health.catalogue.usable_by_language || {})) {
    for (const voice of voices) {
      const r = await benchTTS(voice, lang, SENTENCES[lang] || SENTENCES.en);
      if (r.failure) { console.log(`${voice.padEnd(28)} ${lang}    FAILED  ${r.failure}`); failures++; continue; }

      const fb = verdict(r.first_byte_ms, 'tts_first_byte');
      const rtf = verdict(r.realtime_factor, 'tts_realtime_factor');
      if (fb.trim() === 'FAIL' || rtf.trim() === 'FAIL') failures++;

      console.log(
        `${voice.padEnd(28)} ${lang}   ${String(r.median_ms).padStart(5)}ms  `
        + `${String(r.first_byte_ms).padStart(6)}ms  ${String(r.realtime_factor).padStart(5)}  `
        + `FB${fb} RTF${rtf}`);
      rows.push({ kind: 'tts', ...r });
    }
  }

  console.log('\n' + '-'.repeat(78));
  const sttPassing = rows.filter(r => r.kind === 'stt'
    && r.realtime_factor <= BUDGETS.stt_realtime_factor.limit
    && r.median_ms <= BUDGETS.stt_end_to_end_10s.limit);

  if (sttPassing.length) {
    // Largest tier that still fits the budget: accuracy rises with tier, so the
    // right default is the biggest one the CPU sustains, not the fastest.
    const order = { base: 0, small: 1, medium: 2 };
    const best = sttPassing.sort((a, b) => order[b.tier] - order[a.tier])[0];
    console.log(`Largest STT tier within budget: ${best.tier}`);
    console.log(`  Lock with:  VOICE_STT_TIER=${best.tier}`);
  } else {
    console.log('NO STT tier met the Section 12 budgets on this CPU.');
    console.log('  Section 14: the gate is hard. Do not lock a default. Escalate to');
    console.log('  Phase 2 extraction (Section 11) or a larger instance.');
  }

  console.log('');
  if (failures === 0 && sttPassing.length) {
    console.log('GATE PASSED. Record the date to mark the gate cleared:');
    console.log(`  VOICE_BENCHMARK_COMPLETED=${new Date().toISOString().slice(0, 10)}`);
    console.log('');
    console.log('Still required before any commercial release:');
    console.log('  - Vietnamese TTS quality acceptance threshold (Section 14, Open Item 4)');
    console.log('  - per-voice MODEL_CARD audit (compliance obligation 2)');
    console.log('  - legal sign-off on the GPL process boundary (Open Item 1)');
  } else {
    console.log(`GATE NOT PASSED -- ${failures} measurement(s) outside budget.`);
    console.log('Section 14: no defaults ship until the benchmark confirms Section 12.');
  }

  if (arg('json')) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(arg('json'), JSON.stringify({
      target: BASE, at: new Date().toISOString(), budgets: BUDGETS, rows,
    }, null, 2));
    console.log(`\nWrote ${basename(arg('json'))}`);
  }

  process.exit(failures === 0 && sttPassing.length ? 0 : 1);
}

main().catch((err) => { console.error('Benchmark failed:', err.message); process.exit(3); });
