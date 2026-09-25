// src/bundles/search-worker.js  v13.30.0
//
// Runs a user-supplied regular expression over a bundle's text entries in a
// WORKER THREAD, so the main thread can kill it at the time budget.
// SPEC-SOURCE-BUNDLE-001 s10, review item 4.
//
// A backtracking pattern cannot be interrupted between steps: a single
// RegExp.test() on one line can run for minutes, and the connector is one
// thread for everything, so a pattern a model was steered into issuing could
// wedge the whole service. A pattern-length cap does not bound backtracking.
//
// Matches are posted after EACH entry, so when the main thread terminates this
// worker at the deadline, the checkpoint it already holds is a real partial
// result rather than nothing.
//
// v13.31.0: every blob is hash-verified here before it is decoded. The store's
// guarantee is that a mismatch is entry_integrity_failed and never silent
// bytes, and this was the one path around it: a regex query, and only a regex
// query, read the blob directly while readEntry and the literal search went
// through readVerified. A blob whose bytes do not hash to its own name is
// skipped and named in integrity_failures, so the caller is told rather than
// served unverified lines.

import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { decodeEntryForSearch } from './decode-for-search.js';

const { blobsDir, entries, pattern, caseSensitive, maxResults, lineCap, matchCap } = workerData;

let re;
try {
  re = new RegExp(pattern, caseSensitive ? '' : 'i');
} catch (err) {
  parentPort.postMessage({ type: 'error', code: 'query_invalid', message: err.message });
  process.exit(0);
}

const matches = [];
const integrityFailures = [];
let searched = 0;
let stopped = null;

for (const entry of entries) {
  let text;
  try {
    const bytes = readFileSync(join(blobsDir, entry.sha256));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      integrityFailures.push(entry.path);
      continue;
    }
    text = decodeEntryForSearch(bytes, entry);
  } catch (err) {
    // Unreadable (missing or permission), not corrupt: reported the same way,
    // because either way this entry was not searched.
    integrityFailures.push(entry.path);
    continue;
  }
  searched += 1;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i].slice(0, lineCap))) {
      matches.push({ path: entry.path, line: i + 1, text: lines[i].slice(0, matchCap) });
      if (matches.length >= maxResults) { stopped = 'max_results'; break; }
    }
  }
  // Checkpoint after every entry, not at the end.
  parentPort.postMessage({ type: 'progress', matches, entries_searched: searched, stopped,
                           integrity_failures: integrityFailures });
  if (stopped) break;
}

parentPort.postMessage({ type: 'done', matches, entries_searched: searched, stopped,
                        integrity_failures: integrityFailures });
