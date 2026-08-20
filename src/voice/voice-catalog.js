/* voice-catalog.js  --  the licence-and-availability view of the voice set.
 *
 * SPEC-KOKORO-001 v1.1, Section 8.
 *
 * ===========================================================================
 * WHY THIS FILE STILL EXISTS AFTER THE KOKORO SWAP
 * ===========================================================================
 *
 * voice-registry.js is the source of truth for which voices this deployment
 * offers. This file is the ADAPTER that presents that truth in the shape the
 * rest of the connector already consumes: routes/voice.js, voice-schema.js and
 * the existing test suites all import these symbols by name.
 *
 * The interface was never the Piper-specific part -- "which voices exist, may
 * this one be used, which languages can be spoken, what must be attributed" are
 * questions any engine has to answer. Only the CONTENTS were Piper's. So the
 * contents were replaced and the interface was kept, which is why the swap did
 * not become a rewrite of every caller.
 *
 * ===========================================================================
 * THE AUDIT MACHINERY IS RETAINED BUT NO LONGER LOAD-BEARING
 * ===========================================================================
 *
 * The Piper catalogue carried a per-voice licence audit because Piper voices
 * come from many datasets with divergent terms, and that audit caught a real
 * problem: `en_US-lessac-medium` was one download away from speaking in a
 * commercial product under a non-commercial-only corpus licence.
 *
 * Kokoro is different in kind. ONE model, Apache-2.0, whose voices are style
 * vectors inside one artifact. There is no per-voice licence to diverge, so
 * every row is audited:true and commercial_ok:true -- not because the audit was
 * skipped, but because there is a single licence and it has been read.
 *
 * `auditRequired()` and the `audited` column stay, because voice_catalog is a
 * database table that other things read and because a future engine could
 * reintroduce divergent terms. What changes is that no row can now fail the
 * check.
 *
 * WHAT APACHE-2.0 DOES NOT COVER: the phonemiser. kokoro-onnx drives espeak-ng
 * through `phonemizer`, and espeak-ng is GPL-3.0. That obligation is a PROCESS
 * boundary question, not a per-voice one, so it lives in
 * kokoro-worker-supervisor.js rather than in this table.
 */

'use strict';

import {
  VOICE_REGISTRY, TTS_LANGUAGES as REGISTRY_LANGUAGES, DEFAULT_VOICE,
  voicePermitted as registryPermitted, findVoice as registryFind,
  reconcile, attributions as registryAttributions,
} from './voice-registry.js';

/**
 * The catalogue, in the row shape voice-schema.js mirrors into the database.
 *
 * Derived from the registry rather than duplicated. Two hand-maintained lists
 * of the same voices is how a deployment ends up offering a voice the engine
 * cannot speak, or refusing one it can.
 */
export const VOICE_CATALOG = Object.freeze(VOICE_REGISTRY.map(v => Object.freeze({
  voice_id: v.name,
  language: v.language,
  quality_tier: 'mature',
  role: v.role,
  licence: v.licence,
  commercial_ok: v.commercial_ok,
  attribution_required: v.attribution_required,
  // True for every row, and truthfully so: there is one licence covering the
  // whole model and it has been read. See the header.
  audited: true,
  model_card: 'https://huggingface.co/hexgrad/Kokoro-82M',
  active: v.active,
})));

/** Languages this deployment can speak. English only -- see voice-registry.js. */
export const TTS_LANGUAGES = REGISTRY_LANGUAGES;

/**
 * Whether an unaudited voice may be used.
 *
 * Retained for interface compatibility and for a future engine with divergent
 * per-voice terms. With Kokoro every row is audited, so this cannot refuse
 * anything today.
 *
 * @returns {boolean}
 */
export function auditRequired() {
  const raw = (process.env.VOICE_AUDIT_REQUIRED || '').trim().toLowerCase();
  if ('false' === raw || '0' === raw || 'no' === raw) return false;
  return true;
}

/**
 * Find a catalogue row.
 *
 * @param {string} voiceId
 * @returns {object|null}
 */
export function findVoice(voiceId) {
  const wanted = String(voiceId ?? '').trim();
  return VOICE_CATALOG.find(v => v.voice_id === wanted) || null;
}

/**
 * May this voice be used?
 *
 * Delegates to the registry so there is exactly one refusal contract. The
 * registry's message names the available set rather than saying "invalid",
 * because the caller is usually a stale setting and the fix is to pick from
 * the list.
 *
 * @param {string} voiceId
 * @returns {{ok: boolean, reason?: string, message?: string}}
 */
export function voicePermitted(voiceId) {
  return registryPermitted(voiceId);
}

/**
 * Voices offered for a language.
 *
 * @param {string} language
 * @returns {Array<object>}
 */
export function voicesForLanguage(language) {
  const wanted = String(language ?? '').trim().toLowerCase();
  return VOICE_CATALOG.filter(v => v.active && v.language === wanted);
}

/**
 * Which languages can actually be spoken right now?
 *
 * Takes the INSTALLED voice list, because the catalogue answers the licence
 * question and only the engine answers "would it actually speak". Those two
 * diverging is exactly the state that produced a healthy-looking catalogue
 * beside an engine that could not synthesise a word.
 *
 * @param {Array<string>} installedVoiceIds
 * @returns {Array<string>}
 */
export function speakableLanguages(installedVoiceIds) {
  const installed = new Set((installedVoiceIds || []).map(v => String(v)));
  const langs = new Set(
    VOICE_CATALOG.filter(v => v.active && installed.has(v.voice_id)).map(v => v.language));
  return TTS_LANGUAGES.filter(l => langs.has(l));
}

/**
 * The best voice to speak a language with, given what is installed.
 *
 * Prefers a voice that is both permitted AND present. Falls back to naming a
 * candidate that is merely permitted, so the caller can tell "no such voice"
 * apart from "that voice is not downloaded yet".
 *
 * @param {string} language
 * @param {Array<string>} installedVoiceIds
 * @returns {{voice_id: string|null, installed: boolean, candidates: number}}
 */
export function bestVoiceForLanguage(language, installedVoiceIds) {
  const installed = new Set((installedVoiceIds || []).map(v => String(v)));
  const candidates = voicesForLanguage(language);

  // The platform default first when it fits, so an unconfigured request gets
  // the voice the deployment was tuned and auditioned on rather than whichever
  // row happens to sort first.
  const preferred = candidates.find(v => v.voice_id === DEFAULT_VOICE && installed.has(v.voice_id))
    || candidates.find(v => installed.has(v.voice_id));

  if (preferred) {
    return { voice_id: preferred.voice_id, installed: true, candidates: candidates.length };
  }
  return {
    voice_id: candidates.length ? candidates[0].voice_id : null,
    installed: false,
    candidates: candidates.length,
  };
}

/**
 * Attribution notices.
 *
 * Apache-2.0 requires the licence and notice be preserved on redistribution. A
 * hosted service is not redistribution, so no per-reply attribution is owed --
 * but the notice belongs somewhere an operator can find it.
 *
 * @returns {Array<{voice_id: string, licence: string, model_card: string|null}>}
 */
export function attributions() {
  return VOICE_CATALOG
    .filter(v => v.active && v.attribution_required)
    .map(v => ({ voice_id: v.voice_id, licence: v.licence, model_card: v.model_card }));
}

/**
 * Catalogue state for /voice/health.
 *
 * @param {Array<string>} [installedVoiceIds]
 * @returns {object}
 */
export function catalogState(installedVoiceIds) {
  const { available, missing, reconciled } = reconcile(installedVoiceIds);
  return {
    engine: 'kokoro',
    model: 'Kokoro-82M v1.0',
    licence: 'Apache-2.0',
    default_voice: DEFAULT_VOICE,
    audit_required: auditRequired(),
    total: VOICE_CATALOG.length,
    active: VOICE_CATALOG.filter(v => v.active).length,
    // Every Kokoro voice is covered by one read licence, so these are constants
    // rather than counts of an ongoing process. Reported anyway: a dashboard
    // built against the Piper shape keeps working.
    audited: VOICE_CATALOG.filter(v => v.audited).length,
    commercial_ok: VOICE_CATALOG.filter(v => v.commercial_ok).length,
    unverified: 0,
    languages: TTS_LANGUAGES.slice(),
    available: available.map(v => v.name),
    unavailable: missing,
    reconciled,
    attributions: registryAttributions(),
  };
}

export default {
  VOICE_CATALOG, TTS_LANGUAGES, auditRequired, findVoice, voicePermitted,
  voicesForLanguage, speakableLanguages, bestVoiceForLanguage, attributions,
  catalogState,
};
