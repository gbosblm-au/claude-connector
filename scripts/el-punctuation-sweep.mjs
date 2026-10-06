#!/usr/bin/env node
// scripts/el-punctuation-sweep.mjs
//
// Work order W7 rev 1.1, deliverable 3: the calibration harness for
// diagnostics D2, D3 and D4. Connector v13.35.0.
//
// ONE COMMAND RENDERS THE WHOLE SWEEP through the connector's own ElevenLabs
// adapter (src/voice/elevenlabs.js, the production request builder) and writes
// one WAV per case (pcm_24000 wrapped by the production wrapPcmAsWav), plus:
//
//   manifest.json      every case: id, group, the exact text sent, whether
//                      previous_text / next_text were sent, file, duration.
//   RESULTS-TEMPLATE.md  the results table W7 section 3 asks for, one row per
//                      case, with the verdict columns blank. A listener fills
//                      it in and it is copied into docs/W7-ENGINE-FORM.md.
//
// Usage:
//
//   ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... \
//     node scripts/el-punctuation-sweep.mjs --out ./el-sweep [--model eleven_multilingual_v2]
//                                           [--only d2,d3,d4,tags] [--dry-run]
//
// v13.36.0 (W7 rev 2.1 deliverable 10): versioned PER MODEL. Everything is
// written under <out>/<model>/, because the verdicts move when the pin moves
// (section 7.4), and a 'tags' group renders the section 7 tag-capability
// fixture with the tag switch on and off. Engine text is built by the same
// function the synthesis paths use (elevenLabsEngineText).
//
// This script needs ELEVENLABS_API_KEY in the shell of the workstation that
// runs it. It is NOT for the deployed connector, whose environment never holds
// a key (W7 rev 2.1 section 6.1, non-goal 18); inside the platform the
// instrument is the probe route (POST /ti-voice/elevenlabs/probe).
//
//   --dry-run  writes manifest.json and RESULTS-TEMPLATE.md with the texts that
//              WOULD be sent, and makes no request. Needs no key.
//
// The key is read from the environment, sent only in the xi-api-key header by
// the adapter, and never written to stdout, stderr, the manifest or the
// template. Exit codes: 0 all rendered, 1 one or more renders failed (named in
// the manifest by reason only), 2 usage or configuration error.
//
// Re-run the sweep whenever the model pin changes (W7 section 6) and bump
// ENGINE_FORM_VERSION in src/voice/engine-form.js with the new verdicts.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);

/**
 * The value after a flag, or the fallback.
 *
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string|undefined}
 */
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return (undefined === v || v.startsWith('--')) ? fallback : v;
}

function usage(message) {
  process.stderr.write(`${message}\n`
    + 'usage: node scripts/el-punctuation-sweep.mjs --out <dir> [--model <id>] '
    + '[--only d2,d3,d4,tags] [--dry-run]\n');
  process.exit(2);
}

const KNOWN = new Set(['--out', '--model', '--only', '--dry-run']);
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--') && !KNOWN.has(args[i])) usage(`unknown option ${args[i]}`);
}

const outDir = flag('--out');
if (!outDir) usage('--out is required');
const dryRun = args.includes('--dry-run');
const model = flag('--model', 'eleven_multilingual_v2');
if (!/^[a-z0-9_]{1,64}$/u.test(model)) usage('--model must look like an ElevenLabs model id');
const only = new Set(String(flag('--only', 'd2,d3,d4,tags')).split(',').map((s) => s.trim().toLowerCase())
  .filter(Boolean));
for (const g of only) if (!['d2', 'd3', 'd4', 'tags'].includes(g)) usage(`--only: unknown group ${g}`);

const apiKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
const voiceId = String(process.env.ELEVENLABS_VOICE_ID || '').trim();
if (!dryRun) {
  if (!apiKey) usage('ELEVENLABS_API_KEY is not set (or use --dry-run)');
  if (!/^[A-Za-z0-9]{1,64}$/u.test(voiceId)) usage('ELEVENLABS_VOICE_ID is not set or malformed');
}

// The adapter reads ELEVENLABS_SEGMENT_UNIT and ELEVENLABS_PUNCTUATION at call
// time; the harness sets them per case and restores them.
// Every case renders with the punctuation rules OFF; each candidate is applied
// explicitly below (applyPunctuationRules with its own env). A rule set in the
// operator's shell would otherwise reach every case through process.env, the
// engine-form cases and the live-path cases alike, and relabel the WAVs, so it
// is cleared for this run before any module reads it.
for (const k of ['ELEVENLABS_PUNCTUATION', 'ELEVENLABS_BREAK_TAGS_VERIFIED']) {
  if (undefined !== process.env[k]) {
    process.stderr.write(`[sweep] ${k} is set in this shell; ignored for the sweep (cases set rules explicitly)\n`);
    delete process.env[k];
  }
}
const adapter = await import('../src/voice/elevenlabs.js');
const form = await import('../src/voice/engine-form.js');
const engines = await import('../src/voice/voice-engines.js');
const { analyse, prosodyConfig } = await import('../src/voice/prosody.js');
const { prepareForKokoro } = await import('../src/voice/voice-prosody-prep.js');

const SAMPLE_RATE = 24000;
const config = { apiKey, voiceId, modelId: model };

// ===========================================================================
// THE TEXTS
// ===========================================================================

/** D2 and D4: comma-dense prose of the kind the live artefact was heard on. */
const COMMA_TEXT = 'When the test finished, we read the results, compared them with the baseline, '
  + 'and, after a short pause, wrote the report. The numbers, as it turned out, were fine.';

/** D3: one frame, one mark changed per case (minimal pairs). */
const D3_PAIRS = [
  ['comma', 'The result was clear, we moved on to the next step.'],
  ['period', 'The result was clear. We moved on to the next step.'],
  ['colon', 'The result was clear: we moved on to the next step.'],
  ['semicolon', 'The result was clear; we moved on to the next step.'],
  ['emdash-spaced', 'The result was clear \u2014 we moved on to the next step.'],
  ['emdash-closed', 'The result was clear\u2014we moved on to the next step.'],
  ['ellipsis-character', 'The result was clear… we moved on to the next step.'],
  ['ellipsis-dots', 'The result was clear... we moved on to the next step.'],
  ['ellipsis-spaced', 'The result was clear . . . we moved on to the next step.'],
  ['quotes-none', 'She said the result was clear and we moved on.'],
  ['quotes-double', 'She said “the result was clear” and we moved on.'],
  ['parentheses', 'The result (which was clear) let us move on to the next step.'],
  ['parentheses-as-commas', 'The result, which was clear, let us move on to the next step.'],
  ['hyphen', 'Read pages 10-20 of the well-known report.'],
  ['endash', 'Read pages 10–20 of the well–known report.'],
  ['colon-list', 'Three things matter: speed, cost and accuracy.'],
];

/**
 * The decisive break-tag case (D3). Sent RAW, bypassing the formatter, because
 * the question is what the endpoint does with the tag. A pause means break
 * tags are live on this model; the words "break time" spoken means they are
 * dead here and ELEVENLABS_BREAK_TAGS_VERIFIED must stay unset.
 */
const BREAK_CASE = 'The result was clear. <break time="0.5s" /> We moved on to the next step.';

/** D4: the same two segments, joined cold and joined with context. */
const D4_SEGMENTS = [
  ['sentence-seam', 'The first sentence sets up the point.', 'The second sentence lands it.'],
  ['comma-seam', 'When the test finished,', 'we read the results and wrote the report.'],
  ['colon-seam', 'There is one thing left to check:', 'the totals at the bottom of the page.'],
];

// ===========================================================================
// THE CASES
// ===========================================================================

/**
 * Run fn with environment variables set, restoring them after.
 *
 * @param {object} vars
 * @param {Function} fn
 * @returns {Promise<*>}
 */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (undefined === v) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (undefined === v) delete process.env[k]; else process.env[k] = v;
    }
  }
}

/**
 * The pre-W7 phrase texts, for the A/B in D2: what v13.34.0 sent for each
 * prosody phrase (prepareForKokoro in its espeak mode, which appends a comma to
 * a non-final phrase). Reproduced here so the sweep can render the old path
 * without the old build.
 *
 * @param {string} text
 * @returns {string[]}
 */
function preW7PhraseTexts(text) {
  const phrases = engines.speakablePhrases(analyse(text, { baseLengthScale: 1, config: prosodyConfig() }).phrases);
  const closingIndex = phrases.length - 1;
  return phrases.map((p, i) => prepareForKokoro(adapter.stripMisakiMarkup(p.text), {
    g2p: 'espeak', emphasis: false, lexicon: {},
    position: i < closingIndex ? 'continuation' : 'final',
  }).text);
}

/** @typedef {{id: string, group: string, label: string, parts?: Array<{text: string, previousText?: string, nextText?: string}>, live?: object, note?: string, engineForm?: string}} SweepCase */

/** @returns {SweepCase[]} */
function buildCases() {
  const cases = [];
  const ef = (t) => engines.elevenLabsEngineText(t, { modelId: model, tags: false });

  if (only.has('d2')) {
    cases.push({ id: 'd2-i-one-generation', group: 'D2', label: 'unsegmented, one generation',
      parts: [{ text: ef(COMMA_TEXT) }] });
    cases.push({ id: 'd2-ii-live-sentence', group: 'D2', label: 'live path, v13.35.0 (sentence units)',
      live: { text: COMMA_TEXT, unit: 'sentence' } });
    cases.push({ id: 'd2-ii-live-phrase', group: 'D2', label: 'live path, phrase units (ELEVENLABS_SEGMENT_UNIT=phrase)',
      live: { text: COMMA_TEXT, unit: 'phrase' } });
    const old = preW7PhraseTexts(COMMA_TEXT);
    cases.push({ id: 'd2-ii-pre-w7-replica', group: 'D2', label: 'pre-W7 path replica (phrase units, contour commas)',
      parts: old.map((text, i) => ({ text,
        previousText: i > 0 ? old[i - 1] : '', nextText: i < old.length - 1 ? old[i + 1] : '' })),
      note: 'what v13.34.0 sent' });
  }

  if (only.has('d3')) {
    // The marks are sent AS WRITTEN: the question is what the model does with
    // each one. The manifest also records the engine form production would
    // send for the same text (the normaliser already removes some marks, for
    // example typographic quotes), so a verdict can be read against both.
    for (const [mark, text] of D3_PAIRS) {
      cases.push({ id: `d3-${mark}`, group: 'D3', label: `mark: ${mark}`, parts: [{ text }],
        engineForm: ef(text) });
    }
    // Every candidate substitution the rule table offers, on the frame where
    // its mark appears, so the choice per mark is made by ear.
    for (const [mark, rule] of Object.entries(form.RULES)) {
      const source = D3_PAIRS.find(([m]) => m.startsWith(mark === 'emdash' ? 'emdash-spaced' : mark));
      if (!source) continue;
      for (const to of Object.keys(rule.to)) {
        if ('break' === to) continue;   // covered by the decisive case below
        const text = form.applyPunctuationRules(ef(source[1]),
          { modelId: model, env: { ELEVENLABS_PUNCTUATION: `${mark}=${to}` } });
        cases.push({ id: `d3-candidate-${mark}-to-${to}`, group: 'D3', label: `candidate ${mark}=${to}`,
          parts: [{ text }] });
      }
    }
    cases.push({ id: 'd3-break-tag', group: 'D3', label: 'break tag, sent raw (pause or spoken?)',
      parts: [{ text: BREAK_CASE }],
      note: 'the decisive break-tag verdict; set ELEVENLABS_BREAK_TAGS_VERIFIED=true only if this is a pause' });
  }

  if (only.has('tags')) {
    // W7 rev 2.1 section 7: the same fixture, same voice, every model tested.
    // Three verdicts recorded separately (warm, pause, softly). A model that
    // reads the brackets aloud fails all three the same way.
    cases.push({ id: 'tags-fixture-switch-on', group: 'TAGS', label: 'tag fixture, tag switch on (cues sent)',
      tags: true,
      parts: [{ text: engines.elevenLabsEngineText(form.TAG_FIXTURE, { modelId: model, tags: true }) }],
      note: 'listen: [warm] warm, [pause] a pause, [softly] quieter; or brackets read aloud' });
    cases.push({ id: 'tags-fixture-switch-off', group: 'TAGS', label: 'tag fixture, tag switch off (cues removed)',
      parts: [{ text: engines.elevenLabsEngineText(form.TAG_FIXTURE, { modelId: model, tags: false }) }],
      note: 'the reference: the same sentences with no cues' });
  }

  if (only.has('d4')) {
    for (const [name, a, b] of D4_SEGMENTS) {
      cases.push({ id: `d4-${name}-cold`, group: 'D4', label: `${name}: two generations, no context`,
        parts: [{ text: a }, { text: b }] });
      cases.push({ id: `d4-${name}-context`, group: 'D4', label: `${name}: two generations with previous/next`,
        parts: [{ text: a, nextText: b }, { text: b, previousText: a }] });
      cases.push({ id: `d4-${name}-single`, group: 'D4', label: `${name}: one generation (reference)`,
        parts: [{ text: `${a} ${b}` }] });
    }
  }
  return cases;
}

// ===========================================================================
// RENDERING
// ===========================================================================

/**
 * Render one case to PCM.
 *
 * @param {SweepCase} c
 * @returns {Promise<Buffer>}
 */
async function render(c) {
  if (c.live) {
    // The buffered route's renderer, exactly as /voice/synthesize runs it with
    // prosody on: the analysis, the units, the neighbours, the joins.
    const out = await withEnv({ ELEVENLABS_SEGMENT_UNIT: c.live.unit }, () => engines.synthesizeElevenLabs({
      text: c.live.text, elevenlabs: config, sampleRate: SAMPLE_RATE, mode: 'prosody',
    }));
    return out.wav.subarray(44);
  }
  const segments = [];
  // Sequential, so a case's generations are requested in reading order. The
  // break case reaches the endpoint unformatted; the adapter's tagless
  // assertion concerns square brackets and allows it.
  for (const part of c.parts) {
    const out = await adapter.synthesizeElevenLabsPcm({
      // The tag-switch case is sent as a user with the switch on, so the
      // adapter's G3 guard admits the cues it carries.
      config: c.tags ? { ...config, tags: true } : config, text: part.text, previousText: part.previousText, nextText: part.nextText,
      sampleRate: SAMPLE_RATE,
    });
    segments.push({ pcm: out.pcm, pauseAfterMs: 0 });
  }
  // Joined as production joins phrases: short edge fades, no added pause.
  return engines.concatPhrasePcm(segments, SAMPLE_RATE, prosodyConfig().joinFadeMs);
}

/**
 * Markdown cell text: pipes and newlines cannot break the table.
 *
 * @param {string} s
 * @returns {string}
 */
function cell(s) {
  return String(s).replace(/\|/gu, '\\|').replace(/\n/gu, ' ');
}

async function main() {
  const dir = resolve(outDir, model);
  mkdirSync(dir, { recursive: true });
  const cases = buildCases();
  const manifest = {
    harness: 'el-punctuation-sweep/2',
    engine_form: form.ENGINE_FORM_VERSION,
    registry: form.REGISTRY_VERSION,
    model,
    sample_rate: SAMPLE_RATE,
    dry_run: dryRun,
    generated_at: new Date().toISOString(),
    cases: [],
  };
  let failed = 0;

  for (const c of cases) {
    const entry = {
      id: c.id, group: c.group, label: c.label, note: c.note,
      sent: c.live
        ? { live_path: true, segment_unit: c.live.unit, reply_text: c.live.text }
        : c.parts.map((p) => ({ text: p.text, previous_text: Boolean(p.previousText),
                                next_text: Boolean(p.nextText) })),
      file: null,
    };
    if (undefined !== c.engineForm) entry.production_engine_form = c.engineForm;
    if (!dryRun) {
      try {
        const pcm = await render(c);
        const file = `${c.id}.wav`;
        writeFileSync(join(dir, file), engines.wrapPcmAsWav(pcm, SAMPLE_RATE));
        entry.file = file;
        entry.seconds = Number((pcm.length / 2 / SAMPLE_RATE).toFixed(3));
        process.stdout.write(`rendered ${file} (${entry.seconds} s)\n`);
      } catch (err) {
        // The adapter's errors carry a reason and a status only, never the key.
        failed += 1;
        entry.error = { reason: (err && err.reason) || 'error', status: (err && err.status) || null,
                        code: (err && err.code) || null };
        process.stdout.write(`FAILED ${c.id} (${entry.error.reason}${entry.error.status ? ` ${entry.error.status}` : ''})\n`);
      }
    }
    manifest.cases.push(entry);
  }

  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const rows = manifest.cases.map((e) => {
    const text = Array.isArray(e.sent) ? e.sent.map((p) => p.text).join(' / ') : `(live path) ${e.sent.reply_text}`;
    return `| ${e.id} | ${cell(e.label)} | ${cell(text)} | ${e.file || '(not rendered)'} | | | |`;
  });
  const template = [
    '# W7 calibration results',
    '',
    `Model: ${model}. Engine form: ${form.ENGINE_FORM_VERSION}. Rendered: ${manifest.generated_at}.`,
    '',
    'Fill in by ear. "Artefact" is a restart, a stop, a jump in pitch or pace, or spoken punctuation or tag text.',
    '',
    '| Case | What | Text sent | File | Artefact heard (none / which) | Reads clean (y/n) | Notes |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Verdicts to record in docs/W7-ENGINE-FORM.md',
    '',
    '- D2: jumps in d2-i (one generation)? in d2-ii-pre-w7-replica? in d2-ii-live-sentence? (ours / vendor / stacked)',
    '- D3: per mark, the engine-form replacement chosen (or "keep"), and the ELEVENLABS_PUNCTUATION value',
    '- D3 break tag: pause or spoken (sets ELEVENLABS_BREAK_TAGS_VERIFIED)',
    '- D4: does the seam disappear with context (cold vs context vs single, per seam)?',
    '- Tags (this model): [warm] rendered warm / read aloud; [pause] rendered a pause / read aloud; '
      + '[softly] rendered quieter / read aloud. Model, date, voice.',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'RESULTS-TEMPLATE.md'), template);

  process.stdout.write(`${cases.length} case(s); ${dryRun ? 'dry run, nothing sent' : `${failed} failed`}; `
    + `manifest and template in ${dir}\n`);
  process.exit(failed ? 1 : 0);
}

await main();
