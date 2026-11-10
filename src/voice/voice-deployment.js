// src/voice/voice-deployment.js
//
// Tenax Voice -- deployment faults that make voice, or its output, unusable.
//
// v13.37.0 (TENAX-VOICE-2026-10-07-02 section 5). Moved here verbatim from
// src/voice/voice-allowlist.js, which is deleted with the allowlist it held.
// The work order keeps this function: "it is about pinned interpreter and
// artifact paths, not permissions, and it should survive the file it lives in
// when that file is deleted." Its callers (routes/voice.js: /voice/health and
// the boot log) are unchanged.

// The only import this module needs: deploymentConfigProblems below checks
// whether pinned interpreter and artifact paths actually exist, and a path
// that is merely a string tells an operator nothing.
import { existsSync } from 'node:fs';

/**
 * Deployment faults that make voice, or its output,
 * unusable.
 *
 * v13.2.0. A silent correct refusal is still a support call, so a deployment fault is
 * named rather than left to be discovered.
 *
 * Reported by /voice/health and logged once at boot. Nothing here throws -- a
 * connector with a bad voice configuration must still serve everything else.
 *
 * @returns {string[]} Empty when the configuration is coherent.
 */
export function deploymentConfigProblems() {
  const problems = [];

  // CONNECTOR_URL is not a voice variable, and it is named here because its
  // absence produced the hardest-to-diagnose bug in this system: documents that
  // rendered successfully and came back with no way to open them. v13.1.1 made
  // that render FAIL rather than return an unusable success -- but a failure an
  // operator has to trigger to discover is still worse than a line at boot
  // naming the variable.
  if (!String(process.env.CONNECTOR_URL || '').trim()) {
    problems.push(
      'CONNECTOR_URL is not set, so no download link can be built for any '
      + 'rendered document or audio file. Rendering reports no_output_produced. '
      + "Set it to this service's public base URL.");
  }

  // A pinned interpreter that is not there. Reported rather than guessed at,
  // because the TTS supervisor deliberately declines rather than falling back to
  // a bare `python3` -- the system interpreter is the one we can be confident
  // does NOT have kokoro-onnx installed.
  for (const [name, effect] of [
    ['VOICE_PYTHON_BIN', 'Speech-to-text will fail on the first request'],
    ['VOICE_KOKORO_PYTHON', 'Text-to-speech cannot start'],
  ]) {
    const bin = String(process.env[name] || '').trim();
    if (bin && !existsSync(bin)) {
      problems.push(`${name} is set to "${bin}", which does not exist. ${effect}. `
        + 'Unset it to use the image default.');
    }
  }

  // A pinned artifact path that is not there. The resolver honours an explicit
  // path even when the file is absent, precisely so this is visible rather than
  // silently running different weights -- but it has to be SAID.
  for (const [name, label] of [
    ['VOICE_KOKORO_MODEL', 'model'],
    ['VOICE_KOKORO_VOICES', 'voice bundle'],
  ]) {
    const pinned = String(process.env[name] || '').trim();
    if (pinned && !existsSync(pinned)) {
      problems.push(`${name} is pinned to "${pinned}", which does not exist, so `
        + `the ${label} baked into the image is NOT being used. Unset it to fall `
        + 'back to the image copy.');
    }
  }

  return problems;
}

export default { deploymentConfigProblems };
