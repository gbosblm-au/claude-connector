/* voice-registry.js  --  the deployable Kokoro voice set.
 *
 * SPEC-KOKORO-001 v1.1, Section 8 (Voice Library and Registry)
 * Section 10 (Per-Assistant / Per-Tenant Voice Selection)
 *
 * ===========================================================================
 * WHAT CHANGED FROM THE SPECIFICATION, AND WHY
 * ===========================================================================
 *
 * Section 8 models a registry row as `weight_file` -- "path to the .pt voice
 * weight bundle" -- with one file per voice. That is not how the artifact is
 * shaped. kokoro-onnx v1.0 ships ONE model (`kokoro-v1.0.onnx`) and ONE voices
 * file (`voices-v1.0.bin`) containing every voice as a 256-dimensional style
 * vector. There is no per-voice file to point at.
 *
 * So a row addresses a voice INSIDE a bundle: `bundle` plus `name`. The
 * distinction matters operationally, because it means adding a voice is not a
 * file drop -- the bundle either contains the name or it does not, and the only
 * authority on that is the bundle itself.
 *
 * Which is why nothing here asserts a voice exists. `VOICE_REGISTRY` is the set
 * this deployment is CONFIGURED to offer; the worker reports what the bundle
 * actually holds, and `reconcile()` below intersects the two. A registry entry
 * with no matching vector is reported as unavailable rather than offered and
 * then failed at synthesis time -- which is the difference between a greyed-out
 * option and a broken Speak button.
 *
 * ===========================================================================
 * WHY THE LICENCE MACHINERY GOT SIMPLER
 * ===========================================================================
 *
 * The Piper catalogue carried a per-voice licence audit because Piper voices
 * come from many datasets with divergent terms -- and that audit caught a real
 * one: `en_US-lessac-medium` was one download away from speaking in a commercial
 * product under a non-commercial-only corpus licence.
 *
 * Kokoro is different in kind. One model, Apache-2.0, trained by its author on
 * permissive and non-copyrighted audio, with every voice a vector inside that
 * one Apache-2.0 artifact. There is no per-voice licence to diverge, so there is
 * no per-voice audit to perform and no honest way to make one look meaningful.
 *
 * The `licence` field is retained and populated, because Section 8 asks for it
 * and because an operator asking "can I ship this" deserves an answer in the
 * same place they always found one.
 *
 * ONE THING THIS DOES NOT COVER. Apache-2.0 governs the MODEL. It does not
 * govern the phonemiser: kokoro-onnx's default tokenizer runs
 * phonemizer/espeak-ng, and espeak-ng is GPL-3.0. Retiring Piper therefore does
 * NOT retire the GPL boundary -- it moves it. See kokoro-worker-supervisor.js,
 * which keeps the minimal-environment discipline for exactly that reason.
 */

'use strict';

/** The voices this deployment offers. Platform decision, 2026-08-19. */
export const VOICE_REGISTRY = Object.freeze([
  {
    name: 'af_bella',
    bundle: 'voices-v1.0.bin',
    source: 'default',
    language: 'en',
    accent: 'en-US',
    label: 'Bella (US, female)',
    // THE PLATFORM DEFAULT. Chosen by audition on the Hugging Face Space, which
    // is the only way a voice choice can honestly be made -- no metric here
    // substitutes for hearing it.
    role: 'default',
    licence: 'Apache-2.0 (Kokoro-82M model weights)',
    commercial_ok: true,
    attribution_required: false,
    created: '2025-01-27',
    sample: null,
    active: true,
  },
  {
    name: 'af_nicole',
    bundle: 'voices-v1.0.bin',
    source: 'default',
    language: 'en',
    accent: 'en-US',
    label: 'Nicole (US, female)',
    role: 'alternate',
    licence: 'Apache-2.0 (Kokoro-82M model weights)',
    commercial_ok: true,
    attribution_required: false,
    created: '2025-01-27',
    sample: null,
    active: true,
  },
  {
    name: 'af_heart',
    bundle: 'voices-v1.0.bin',
    source: 'default',
    language: 'en',
    accent: 'en-US',
    label: 'Heart (US, female)',
    role: 'alternate',
    licence: 'Apache-2.0 (Kokoro-82M model weights)',
    commercial_ok: true,
    attribution_required: false,
    created: '2025-01-27',
    sample: null,
    active: true,
  },
  {
    name: 'bf_emma',
    bundle: 'voices-v1.0.bin',
    source: 'default',
    language: 'en',
    accent: 'en-GB',
    label: 'Emma (UK, female)',
    role: 'alternate',
    licence: 'Apache-2.0 (Kokoro-82M model weights)',
    commercial_ok: true,
    attribution_required: false,
    created: '2025-01-27',
    sample: null,
    active: true,
  },
  {
    name: 'af_aoede',
    bundle: 'voices-v1.0.bin',
    source: 'default',
    language: 'en',
    accent: 'en-US',
    label: 'Aoede (US, female)',
    role: 'alternate',
    licence: 'Apache-2.0 (Kokoro-82M model weights)',
    commercial_ok: true,
    attribution_required: false,
    created: '2025-01-27',
    sample: null,
    active: true,
  },
]);

/**
 * Languages this deployment can SPEAK.
 *
 * English only, and that is a deliberate, recorded loss rather than an
 * oversight. The Piper catalogue carried Vietnamese, Chinese and Japanese
 * voices. Kokoro's inventory covers English, Japanese, Mandarin, Spanish,
 * French, Hindi, Italian and Brazilian Portuguese -- and NOT Vietnamese, at any
 * version. Japanese and Mandarin voices exist but need language-specific G2P
 * (misaki[ja], misaki[zh]) rather than the English path, and none of the five
 * voices this platform deploys is one of them.
 *
 * Accepted on the platform decision of 2026-08-19: Piper was a proof of concept
 * and its non-English voices were never in production use.
 *
 * The consequence is visible rather than silent. speakableLanguages() narrows to
 * this list, /voice/status reports it, and the client's own languageSpeakable()
 * gate hides the Speak button for a language it cannot serve -- which is a
 * missing button, not a button that fails.
 */
export const TTS_LANGUAGES = Object.freeze(['en']);

/** The default voice when nothing is configured for a tenant. */
export const DEFAULT_VOICE = 'af_bella';

/**
 * Output sample rates an admin may select.
 *
 * Kokoro synthesises at 24 kHz natively. 16 kHz is offered because it is a third
 * smaller on the wire and telephony-band audio is adequate for speech, but it
 * costs a resample, so 24 kHz is the default: the native rate is the one that
 * involves no processing and cannot introduce an artifact.
 */
export const SAMPLE_RATES = Object.freeze([24_000, 16_000]);

/** Kokoro's native rate. Not configurable -- it is a property of the model. */
export const NATIVE_SAMPLE_RATE = 24_000;

/**
 * Resolve the configured output sample rate.
 *
 * Anything unrecognised falls back to the native rate rather than being
 * honoured. A typo in an env var should not silently resample every reply
 * through an untested ratio.
 *
 * @param {string|number|undefined} raw
 * @returns {number}
 */
export function outputSampleRate(raw) {
  const wanted = Number.parseInt(String(raw ?? '').trim(), 10);
  return SAMPLE_RATES.includes(wanted) ? wanted : NATIVE_SAMPLE_RATE;
}

/**
 * Look up a registry entry by name.
 *
 * @param {string} name
 * @returns {object|null}
 */
export function findVoice(name) {
  const wanted = String(name ?? '').trim();
  if (!wanted) return null;
  return VOICE_REGISTRY.find(v => v.name === wanted) || null;
}

/**
 * May this voice be used?
 *
 * Kept as a gate with the same shape the Piper catalogue used, so callers do not
 * have to learn a new refusal contract. Every registry voice is Apache-2.0, so
 * the only refusal left is "not a voice this deployment offers" -- but the gate
 * stays because an unknown name arriving from a tenant setting or an API caller
 * still has to be refused somewhere, and refusing it here means the engine never
 * sees it.
 *
 * @param {string} name
 * @returns {{ok: boolean, reason?: string, message?: string, voice?: object}}
 */
export function voicePermitted(name) {
  const voice = findVoice(name);
  if (!voice) {
    return {
      ok: false,
      reason: 'unknown_voice',
      // Names the offered set rather than saying "invalid", because the caller
      // is usually a tenant setting holding a stale value and the fix is to
      // pick from the list.
      message: `Unknown voice "${ String(name ?? '') }". Available: `
        + `${ VOICE_REGISTRY.filter(v => v.active).map(v => v.name).join(', ') }.`,
    };
  }
  if (!voice.active) {
    return {
      ok: false,
      reason: 'voice_inactive',
      message: `The voice "${ voice.name }" is not enabled in this deployment.`,
    };
  }
  return { ok: true, voice };
}

/**
 * Resolve which voice to speak with, in precedence order.
 *
 * Section 10, with tenant scope added on the platform decision of 2026-08-19:
 * a tenant default is settable from the Client Gateway, so one client can be
 * read by one voice across every assistant they have.
 *
 *   1. an explicit per-request voice     (an API caller asked for one)
 *   2. the assistant's configured voice  (Section 10)
 *   3. the tenant's configured voice     (the Client Gateway setting)
 *   4. the platform default              (af_bella)
 *
 * An unusable value at any level falls through to the next rather than failing.
 * A stale voice name in a tenant setting is a configuration problem, and the
 * right response to it is a reply in the default voice plus a log line -- not
 * silence. This function therefore reports which level answered, so that log
 * line can say something useful.
 *
 * @param {{requested?: string, assistant?: string, tenant?: string}} [opts]
 * @returns {{voice: string, source: string, ignored: Array<{level: string, value: string}>}}
 */
export function resolveVoice(opts) {
  const o = opts || {};
  const levels = [
    ['request', o.requested],
    ['assistant', o.assistant],
    ['tenant', o.tenant],
  ];

  const ignored = [];
  for (const [level, value] of levels) {
    const candidate = String(value ?? '').trim();
    if (!candidate) continue;
    if (voicePermitted(candidate).ok) return { voice: candidate, source: level, ignored };
    ignored.push({ level, value: candidate });
  }

  return { voice: DEFAULT_VOICE, source: 'default', ignored };
}

/**
 * Intersect the configured registry with what the bundle actually contains.
 *
 * The bundle is the only authority on which vectors exist. Offering a voice the
 * bundle lacks produces a Speak button that fails at synthesis; reporting it
 * unavailable produces one that is visibly absent. The second is the honest
 * failure.
 *
 * A null or empty report means the worker has not told us yet -- at boot, or
 * with the worker disabled. That is NOT the same as "the bundle contains
 * nothing", so the registry is passed through unfiltered rather than narrowed to
 * zero, which would make the platform look mute during startup.
 *
 * @param {Array<string>|null|undefined} bundleVoices Names the worker reported.
 * @returns {{available: Array<object>, missing: Array<string>, extra: Array<string>,
 *            reconciled: boolean}}
 */
export function reconcile(bundleVoices) {
  const active = VOICE_REGISTRY.filter(v => v.active);

  if (!Array.isArray(bundleVoices) || 0 === bundleVoices.length) {
    return { available: active.slice(), missing: [], extra: [], reconciled: false };
  }

  const inBundle = new Set(bundleVoices.map(v => String(v).trim()));
  const available = active.filter(v => inBundle.has(v.name));
  const missing = active.filter(v => !inBundle.has(v.name)).map(v => v.name);
  // Voices the bundle has that this deployment does not offer. Not an error --
  // the v1.0 bundle carries dozens -- but worth reporting so an operator adding
  // a voice can see the name is already there to be enabled.
  const offered = new Set(active.map(v => v.name));
  const extra = [...inBundle].filter(n => !offered.has(n)).sort();

  return { available, missing, extra, reconciled: true };
}

/**
 * Which languages can actually be spoken, given what is installed?
 *
 * Mirrors the Piper catalogue's function of the same name so /voice/status and
 * the client gate keep working without change. With a single-language voice set
 * this is either ['en'] or [].
 *
 * @param {Array<string>|null} bundleVoices
 * @returns {Array<string>}
 */
export function speakableLanguages(bundleVoices) {
  const { available } = reconcile(bundleVoices);
  const langs = new Set(available.map(v => v.language));
  return TTS_LANGUAGES.filter(l => langs.has(l));
}

/**
 * Attribution notices for voices in use.
 *
 * Apache-2.0 requires the licence and notice be preserved in redistribution. A
 * hosted service is not redistribution, so no per-reply attribution is owed --
 * but the notice belongs somewhere an operator can find it.
 *
 * @returns {Array<{name: string, licence: string}>}
 */
export function attributions() {
  return VOICE_REGISTRY
    .filter(v => v.active)
    .map(v => ({ name: v.name, licence: v.licence }));
}

/**
 * Registry state for /voice/health and the admin surface.
 *
 * @param {Array<string>|null} bundleVoices
 * @returns {object}
 */
export function registryState(bundleVoices) {
  const { available, missing, extra, reconciled } = reconcile(bundleVoices);
  return {
    engine: 'kokoro',
    model: 'Kokoro-82M v1.0',
    licence: 'Apache-2.0',
    default_voice: DEFAULT_VOICE,
    languages: TTS_LANGUAGES.slice(),
    native_sample_rate: NATIVE_SAMPLE_RATE,
    selectable_sample_rates: SAMPLE_RATES.slice(),
    voices: available.map(v => ({
      name: v.name, label: v.label, accent: v.accent,
      role: v.role, source: v.source, licence: v.licence,
    })),
    // Named explicitly. A voice configured but absent from the bundle is the one
    // state an operator has to act on, and burying it in a count would hide it.
    unavailable: missing,
    bundle_has_unoffered: extra.length,
    reconciled,
  };
}

export default {
  VOICE_REGISTRY, TTS_LANGUAGES, DEFAULT_VOICE, SAMPLE_RATES, NATIVE_SAMPLE_RATE,
  outputSampleRate, findVoice, voicePermitted, resolveVoice, reconcile,
  speakableLanguages, attributions, registryState,
};
