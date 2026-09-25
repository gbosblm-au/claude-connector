// src/bundles/decode-for-search.js  v13.30.0
//
// The one decode used by both the main thread's search and the worker's, so a
// regex and a literal query see exactly the same text. Never throws: an entry
// classed `text` can still hold an invalid byte beyond the sniff window
// (review item 2), and one bad byte must not end a search.

import { decodeStrict } from './classify.js';

/**
 * @param {Buffer} bytes
 * @param {{class: string, encoding: string|null}} entry
 * @returns {string}
 */
export function decodeEntryForSearch(bytes, entry) {
  if (entry.class === 'text') {
    try { return decodeStrict(bytes, entry.encoding || 'utf-8'); } catch { /* fall through, lossy */ }
  }
  return new TextDecoder(entry.encoding && entry.encoding !== 'utf-8' ? entry.encoding : 'utf-8').decode(bytes);
}
