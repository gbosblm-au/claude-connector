#!/usr/bin/env node
// scripts/voice-provision.mjs
//
// Download Piper voice models onto the Railway volume.
//
//   node scripts/voice-provision.mjs                    # every known voice
//   node scripts/voice-provision.mjs en_US-lessac-medium
//   node scripts/voice-provision.mjs --list
//   node scripts/voice-provision.mjs --force en_US-lessac-medium
//
// Run it once per deployment that has a fresh volume. The files persist across
// restarts, so it does not need to run again unless the volume is replaced.
//
// The alternative to running this by hand is VOICE_PROVISION_VOICES, which does
// the same work in the background at boot. Both call the same module, so they
// cannot disagree about where the files go or which voice maps to which path.

import { installVoices, voicesDir,
         VOICE_SOURCES, MISSING_UPSTREAM } from '../src/voice/voice-provision.js';

const argv  = process.argv.slice(2);
const force = argv.includes('--force');
const list  = argv.includes('--list');
const voices = argv.filter(a => !a.startsWith('--'));

if (list) {
  console.log(`Voice directory: ${voicesDir()}\n`);
  console.log('Available:');
  for (const [id, path] of Object.entries(VOICE_SOURCES)) {
    console.log(`  ${id.padEnd(30)} rhasspy/piper-voices/${path}`);
  }
  if (Object.keys(MISSING_UPSTREAM).length) {
    console.log('\nNamed by the catalogue but NOT published upstream:');
    for (const [id, why] of Object.entries(MISSING_UPSTREAM)) {
      console.log(`  ${id}\n    ${why}`);
    }
  }
  process.exit(0);
}

const wanted = voices.length ? voices : Object.keys(VOICE_SOURCES);

console.log(`Installing into ${voicesDir()}`);
console.log(`Voices: ${wanted.join(', ')}\n`);

const results = await installVoices(wanted, { force, log: m => console.log(m) });

console.log('');
let bad = 0;
for (const r of results) {
  if (r.status === 'installed' || r.status === 'present') {
    console.log(`  OK       ${r.voice} (${r.status})`);
  } else {
    bad += 1;
    console.log(`  PROBLEM  ${r.voice}: ${r.error}`);
  }
}

// Non-zero exit on any problem, so this can be used in a deployment step that
// is supposed to stop when a voice does not arrive.
process.exit(bad ? 1 : 0);
