#!/usr/bin/env node
/* scripts/voice-provision.mjs
 *
 * Fetch the Kokoro engine artifacts onto the volume.
 *
 *   npm run voice:provision
 *
 * v13. Under Piper this downloaded one file pair PER VOICE from
 * rhasspy/piper-voices, and "install a voice" was a meaningful operation.
 * Kokoro is TWO FILES TOTAL: the model, and a bundle holding every voice as a
 * style vector. Adding a voice to the offered set is a registry edit, not a
 * download.
 */

import { installVoices, voicesDir, VOICE_SOURCES }
  from '../src/voice/voice-provision.js';
import { VOICE_REGISTRY } from '../src/voice/voice-registry.js';

console.log('Tenax voice -- Kokoro provisioning');
console.log(`  target: ${voicesDir()}`);
for (const [name, source] of Object.entries(VOICE_SOURCES)) {
  console.log(`  ${name.padEnd(7)} ${source.file}`);
}
console.log('');
console.log(`  ${VOICE_REGISTRY.filter(v => v.active).length} voices are offered from the `
  + 'bundle; none is downloaded separately.');
console.log('');

const result = await installVoices(['model', 'voices'], { log: m => console.log(m) });

console.log('');
if (result.ok) {
  console.log('PASS  both artifacts are present. Run `npm run voice:smoke` to '
    + 'confirm the engine loads them.');
  process.exit(0);
}
console.error(`FAIL  could not provision: ${result.failed.join(', ')}`);
process.exit(1);
