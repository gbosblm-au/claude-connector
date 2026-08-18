// src/voice/voice-catalog.js
//
// Tenax Voice -- the commercial-OK voice allowlist. Specification Section 6.3,
// compliance obligation 2: "per-voice license audit against a commercial-OK
// allowlist before any voice ships; some Piper voices are non-commercial."
//
// ---------------------------------------------------------------------------
// WHY THIS IS AN ALLOWLIST AND NOT A BLOCKLIST
// ---------------------------------------------------------------------------
//
// Piper voice licences are mixed -- CC BY 4.0, CC0, MIT, Apache 2.0, and some
// non-commercial -- and each voice's own MODEL_CARD governs. There is no rule
// that derives the licence from the voice name, so the only safe default for a
// voice nobody has checked is REFUSAL.
//
// A blocklist gets this backwards: it ships every voice not yet known to be
// bad, which means a new voice added to rhasspy/piper-voices is commercially
// used the moment someone types its name. This module inverts that. A voice
// absent from the table cannot be synthesised, and the failure is a clear 422
// naming the reason.
//
// ---------------------------------------------------------------------------
// AUDIT STATUS IS NOT THE SAME AS COMMERCIAL-OK
// ---------------------------------------------------------------------------
//
// Each entry carries `audited`, separate from `commercial_ok`. The distinction
// matters and collapsing it would defeat the obligation:
//
//   audited: true   -- a human has opened this voice's MODEL_CARD and recorded
//                      what it says.
//   audited: false  -- the licence below is TRANSCRIBED FROM THE SPECIFICATION,
//                      which is a planning document, not the MODEL_CARD itself.
//
// v12.50.0 UPDATE. Two entries are now `audited: true`, and the audit was a real
// one: the MODEL_CARD was fetched from rhasspy/piper-voices and, where it linked
// out, the linked licence page was read as well. The remaining three are still
// `audited: false` -- unread is unread, and marking them otherwise would put a
// fabricated compliance record in the one place a lawyer would later look.
//
// The audit changed a default. `en_US-lessac-medium` shipped as the English
// default; its MODEL_CARD points at the CSTR Blizzard 2013 Lessac dataset page,
// which states the data is "released under a license for non-commercial use
// only". It is therefore marked commercial_ok:false and REFUSED, which is what
// this table exists to do. English now defaults to `en_US-kristin-medium`,
// trained on public-domain LibriVox recordings.
//
// This is exactly the failure mode described above: nothing about the name
// "lessac" reveals its licence, and it was one download away from speaking in a
// commercial product.
//
// `AUDIT_REQUIRED` below is therefore ON by default, and while it is on, an
// unaudited voice is refused even if this table claims it is commercial-OK.
// Set VOICE_AUDIT_REQUIRED=false only once the audit is genuinely done, and
// flip the entries to `audited: true` with the MODEL_CARD URL recorded.
//
// The alternative -- shipping with these marked audited because the
// specification lists them as defaults -- would put a fabricated compliance
// record in the one place a lawyer would later look.

/**
 * The launch voice set (Specification Section 5, Table 2).
 *
 * `licence: null` means UNVERIFIED, not "no licence". Every one of these is
 * unverified today.
 */
export const VOICE_CATALOG = Object.freeze([
  {
    // AUDITED v12.50.0. MODEL_CARD read directly:
    //   Dataset: https://librivox.org
    //   License: public domain
    //   "US English female voice. Single Speaker. ... about 11.5 hours of
    //    recordings. All recordings came from LibriVox.org."
    //
    // Public domain source material, so there is no commercial restriction and
    // no attribution obligation. That is what makes it a safe default for a
    // commercial deployment, which the voice it replaces was not.
    voice_id: 'en_US-kristin-medium',
    language: 'en',
    quality_tier: 'mature',       // Section 13: English and Japanese are mature
    role: 'default',
    licence: 'Public domain (LibriVox source recordings)',
    commercial_ok: true,
    attribution_required: false,
    audited: true,
    model_card: 'https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/kristin/medium/MODEL_CARD',
    active: true,
  },
  {
    // AUDITED v12.50.0, and the audit disqualified it.
    //
    // MODEL_CARD gives the dataset as the CSTR Blizzard 2013 Lessac corpus. That
    // project page states plainly: "This data is released under a license for
    // non-commercial use only." Speaker: Catherine Byers.
    //
    // Left in the table rather than deleted, and left `active: true`. Removal
    // would produce "unknown_voice" for anyone who has the id configured, which
    // reads like a typo. voicePermitted() instead returns voice_non_commercial
    // with a message that says why, and says it whatever VOICE_AUDIT_REQUIRED is
    // set to -- a known-bad licence is not a missing one.
    voice_id: 'en_US-lessac-medium',
    language: 'en',
    quality_tier: 'mature',
    role: 'alternate',
    licence: 'Non-commercial use only (CSTR Blizzard 2013 Lessac corpus)',
    commercial_ok: false,
    attribution_required: false,
    audited: true,
    model_card: 'https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/lessac/medium/MODEL_CARD',
    active: true,
  },
  {
    voice_id: 'ja_JP-ryoko-medium',
    language: 'ja',
    quality_tier: 'mature',
    role: 'default',
    licence: null,
    commercial_ok: null,
    attribution_required: null,
    audited: false,
    model_card: null,
    active: true,
  },
  {
    voice_id: 'zh_CN-huayan-medium',
    language: 'zh',
    quality_tier: 'serviceable',  // Section 13: Chinese is serviceable
    role: 'default',
    licence: null,
    commercial_ok: null,
    attribution_required: null,
    audited: false,
    model_card: null,
    active: true,
  },
  {
    voice_id: 'vi_VN-vais1000-medium',
    language: 'vi',
    // Section 5: "Vietnamese is the constraint language for TTS ... quality is
    // below the English/Japanese tier." Section 14 requires an explicit
    // acceptance threshold before this ships as a default at all.
    quality_tier: 'weak',
    role: 'default',
    licence: null,
    commercial_ok: null,
    attribution_required: null,
    audited: false,
    model_card: null,
    active: true,
  },
  {
    voice_id: 'vi_VN-25hours_single-low',
    language: 'vi',
    quality_tier: 'weak',
    role: 'fallback',             // Table 2: documented Vietnamese fallback
    licence: null,
    commercial_ok: null,
    attribution_required: null,
    audited: false,
    model_card: null,
    active: true,
  },
]);

/** Launch languages (Section 13). STT covers far more; TTS covers these. */
export const TTS_LANGUAGES = Object.freeze(['en', 'vi', 'zh', 'ja']);

/**
 * Whether an unaudited voice may be used.
 *
 * Defaults to REQUIRING the audit. Same reasoning as the feature gate: only an
 * explicit affirmative relaxes a compliance control, so a typo cannot ship a
 * non-commercial voice into a commercial product.
 */
export function auditRequired() {
  const raw = (process.env.VOICE_AUDIT_REQUIRED || '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  return true;
}

/** @param {string} voiceId @returns {object|null} */
export function findVoice(voiceId) {
  if (!voiceId) return null;
  const id = String(voiceId).trim();
  return VOICE_CATALOG.find(v => v.voice_id === id) || null;
}

/**
 * May this voice be synthesised right now?
 *
 * Returns a reason on refusal rather than a bare boolean, because Section 16
 * requires "a clear 422 with a message the UI can render, not a 500" -- and a
 * boolean cannot carry a message.
 *
 * @param {string} voiceId
 * @returns {{ok: boolean, reason: string|null, message: string|null, voice: object|null}}
 */
export function voicePermitted(voiceId) {
  const voice = findVoice(voiceId);

  if (!voice) {
    return {
      ok: false,
      reason: 'unknown_voice',
      message: `Voice "${voiceId}" is not in the Tenax voice catalogue.`,
      voice: null,
    };
  }

  if (!voice.active) {
    return {
      ok: false, reason: 'voice_inactive',
      message: `Voice "${voiceId}" is not currently available.`,
      voice,
    };
  }

  // Explicitly non-commercial. Refused whatever the audit setting says: this
  // is a known-bad answer, not a missing one.
  if (voice.commercial_ok === false) {
    return {
      ok: false, reason: 'voice_non_commercial',
      message: `Voice "${voiceId}" is licensed for non-commercial use only and cannot be used here.`,
      voice,
    };
  }

  if (auditRequired() && !voice.audited) {
    return {
      ok: false, reason: 'voice_unaudited',
      message:
        `Voice "${voiceId}" has not completed its licence audit. Each Piper voice is `
        + 'governed by its own MODEL_CARD and some are non-commercial, so voices are '
        + 'refused until audited. Complete the audit and set VOICE_AUDIT_REQUIRED=false.',
      voice,
    };
  }

  return { ok: true, reason: null, message: null, voice };
}

/**
 * Voices usable for a language, best first.
 *
 * Defaults precede fallbacks so a caller that takes the first entry gets the
 * specification's intended default rather than an arbitrary one.
 *
 * @param {string} language
 * @returns {object[]}
 */
export function voicesForLanguage(language) {
  const lang = String(language || '').trim().toLowerCase();
  return VOICE_CATALOG
    .filter(v => v.language === lang && v.active && voicePermitted(v.voice_id).ok)
    .sort((a, b) => (a.role === 'default' ? -1 : 1) - (b.role === 'default' ? -1 : 1));
}

/**
 * Attribution lines for CC BY 4.0 voices (compliance obligation 3).
 *
 * Only voices that have been audited AND require attribution appear. An
 * unaudited voice contributes nothing, because we do not yet know what its
 * MODEL_CARD asks for -- and an attribution page that invents credits is worse
 * than one that is short.
 *
 * @returns {Array<{voice_id: string, licence: string, model_card: string|null}>}
 */
export function attributions() {
  return VOICE_CATALOG
    .filter(v => v.audited && v.attribution_required)
    .map(v => ({ voice_id: v.voice_id, licence: v.licence, model_card: v.model_card }));
}

/**
 * Languages that can actually be spoken RIGHT NOW.
 *
 * v12.51.0. `usable_by_language` answers a LICENCE question: which voices are
 * cleared to ship. It says nothing about whether the model file exists on the
 * volume, and the two diverge constantly -- a fresh volume has a fully populated
 * catalogue and not one .onnx file.
 *
 * A UI that offers a language on the strength of the licence answer alone
 * offers something that fails at the engine. So this intersects the two: a
 * language is speakable when it has at least one voice that is BOTH permitted
 * by the catalogue AND installed on disk.
 *
 * The installed list is passed in rather than imported, so this module keeps
 * knowing nothing about the filesystem and stays unit-testable without one.
 *
 * @param {string[]} installedVoiceIds Voice ids present on the volume.
 * @returns {{languages: string[], by_language: Object<string, string[]>}}
 */
export function speakableLanguages(installedVoiceIds) {
  const installed = new Set(Array.isArray(installedVoiceIds) ? installedVoiceIds : []);
  const byLanguage = {};

  for (const lang of TTS_LANGUAGES) {
    const ready = voicesForLanguage(lang)
      .filter(v => installed.has(v.voice_id))
      .map(v => v.voice_id);
    if (ready.length) byLanguage[lang] = ready;
  }

  return { languages: Object.keys(byLanguage), by_language: byLanguage };
}

/**
 * The best voice to use for a language, preferring one that is installed.
 *
 * voicesForLanguage() returns catalogue order, defaults first. Taking its first
 * entry blindly can select a licence-cleared voice whose model was never
 * downloaded, which reaches Piper and fails as a 500 -- an engine error for what
 * is really a missing file. Preferring an installed voice turns that into a
 * successful request whenever any installed voice would do, and the caller can
 * refuse cleanly when none would.
 *
 * @param {string} language
 * @param {string[]} installedVoiceIds
 * @returns {{voice_id: string|null, installed: boolean, candidates: number}}
 */
export function bestVoiceForLanguage(language, installedVoiceIds) {
  const installed = new Set(Array.isArray(installedVoiceIds) ? installedVoiceIds : []);
  const candidates = voicesForLanguage(language);

  const ready = candidates.find(v => installed.has(v.voice_id));
  if (ready) return { voice_id: ready.voice_id, installed: true, candidates: candidates.length };

  return {
    voice_id: candidates.length ? candidates[0].voice_id : null,
    installed: false,
    candidates: candidates.length,
  };
}

/**
 * Catalogue state for /voice/health and for the settings UI.
 *
 * Deliberately reports how many voices are actually usable, which is zero until
 * the audit is done. A health endpoint that showed five available voices while
 * every synthesise call 422s would be worse than useless.
 */
export function catalogState() {
  const usable = VOICE_CATALOG.filter(v => voicePermitted(v.voice_id).ok);
  return {
    total: VOICE_CATALOG.length,
    usable: usable.length,
    audit_required: auditRequired(),
    unaudited: VOICE_CATALOG.filter(v => !v.audited).map(v => v.voice_id),
    languages: TTS_LANGUAGES.slice(),
    usable_by_language: TTS_LANGUAGES.reduce((acc, l) => {
      acc[l] = voicesForLanguage(l).map(v => v.voice_id);
      return acc;
    }, {}),
  };
}

export default {
  VOICE_CATALOG, TTS_LANGUAGES,
  auditRequired, findVoice, voicePermitted, voicesForLanguage,
  speakableLanguages, bestVoiceForLanguage,
  attributions, catalogState,
};
