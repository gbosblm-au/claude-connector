// memoryWriteGuard.js  (shared: claude-connector 13.40.0 src/tools-memory/memoryWriteGuard.js
//                        and Gateway Service 2.266.0 lib/memory-write-guard.js)
// ---------------------------------------------------------------------------
// H-6 and H-10, TENAX-2026-10-15-01: memory write hardening. ONE FILE, TWO TREES.
//
// This file is byte-identical in both trees. The connector's memory_write tool
// and the gateway's memory routes (routes/memory.js /upsert and /write, and the
// route-local memory_write in routes/ti-chat.js) all decide through it, which
// is what makes their behaviour identical rather than similar: the temporal
// work's C-TWIN-PARITY discipline. Each tree pins this file's sha256 and runs
// the shared fixture (memory-guard-fixture.json) through it, so the two copies
// cannot drift without a red test on both sides.
//
// It imports nothing, so it loads unchanged under either tree. The one thing
// it reads from outside itself is process.env.MEMORY_CAPACITY_PER_SCOPE, once,
// when it loads (TENAX-2026-10-17-03): the same logic in both trees.
//
// WHAT IT DECIDES
// ---------------
//   scanMemoryValue(text)     refuse instruction-injection phrases,
//                             exfiltration instructions and invisible Unicode;
//                             a refusal states its reason (a false positive
//                             rejects and says why)
//   redactCredentials(text)   replace credential-shaped strings with a marker,
//                             before persistence and before injection
//   normaliseForDuplicate()   the comparison form the duplicate guard uses
//   findDuplicate()           an identical value already held under another key
//   resolveMemoryCapacity()   the ceiling from MEMORY_CAPACITY_PER_SCOPE, strict
//                             parse, clamped, default 1000
//   capacityDecision()        the at-ceiling answer: refuse new keys, return the
//                             oldest entries as consolidation candidates
//   recheckFor()              the H-10 re-check class and date for an entry
//   guardMemoryWrite()        all of the above, in order, for one write
//
// CAPACITY: PROVISIONAL, AND A RUNTIME VALUE (TENAX-2026-10-17-03)
// ---------------------------------------------------------------
// 1000 entries per visible scope is still provisional: the only observed
// figures are 538 rows in one tenant at source and 1,571 in one refusal. The
// final value is chosen from data, by running Gateway Service
// `npm run memory:capacity`, which runs docs/memory-capacity-query.sql.
//
// The ceiling is the environment variable MEMORY_CAPACITY_PER_SCOPE, read once
// when this file loads, so a change takes a restart and no release. Unset, it
// is 1000 and behaviour is exactly as before.
//
// The connector evaluates this guard BEFORE the gateway sees the request, so a
// value set on one service only changes nothing for the other's writes. The
// files stay byte-identical while the behaviour diverges, and no test in
// either tree can see that: set the variable on BOTH services, and compare the
// two boot lines ("Memory ceiling: ...").
// ---------------------------------------------------------------------------

/** The variable that sets the ceiling. One name for the constant and the variable. */
export const MEMORY_CAPACITY_ENV = 'MEMORY_CAPACITY_PER_SCOPE';

/** The ceiling when the variable is unset or unusable. */
export const MEMORY_CAPACITY_DEFAULT = 1000;

/** The bounds a set value is clamped to. */
export const MEMORY_CAPACITY_MIN = 100;
export const MEMORY_CAPACITY_MAX = 100000;

/** A decimal number, optionally signed, with an optional fraction and exponent: the shapes Number() reads in base ten. */
const DECIMAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * The ceiling from the environment, decided strictly.
 *
 *   unset, null, empty or whitespace   1000, source 'default', no warning
 *   a whole number in [100, 100000]    that number, source 'env'
 *   a whole number outside the bounds  clamped to 100 or 100000, source 'env',
 *                                      warning (a finite integer is clamped;
 *                                      '0', '-5', '50', '99999999' and '1e9'
 *                                      included, as the house envInt clamps)
 *   anything else                      1000, source 'default', warning: the
 *                                      whole string must be a decimal number,
 *                                      so '1000abc', '1,000', 'abc', '12.5',
 *                                      '0x3e8', 'Infinity' and 'NaN' are refused
 *
 * Number() on the whole trimmed string is the parse, never parseInt: parseInt
 * reads '1000abc' as 1000 and '1e9' as 1. The result is always a finite
 * integer in the bounds: never NaN, 0, Infinity or undefined. capacityDecision
 * tests count < limit, so a NaN or 0 limit would refuse every new key (an
 * outage that looks like the ceiling being too low) and Infinity would switch
 * the ceiling off.
 *
 * @param {Record<string, string|undefined>|null} [env]
 * @returns {{ limit: number, source: 'env'|'default', raw: string|null, warning: string|null }}
 */
export function resolveMemoryCapacity( env = ( typeof process !== 'undefined' && process && process.env ) || {} ) {
  const value = env ? env[ MEMORY_CAPACITY_ENV ] : undefined;
  if ( value === undefined || value === null || String( value ).trim() === '' ) {
    return { limit: MEMORY_CAPACITY_DEFAULT, source: 'default', raw: null, warning: null };
  }
  const raw = String( value ).trim();
  const n = DECIMAL_NUMBER.test( raw ) ? Number( raw ) : NaN;
  if ( ! Number.isFinite( n ) || ! Number.isInteger( n ) ) {
    return { limit: MEMORY_CAPACITY_DEFAULT, source: 'default', raw,
      warning: `${ MEMORY_CAPACITY_ENV }="${ raw.slice( 0, 40 ) }" is not a whole number; the default ${ MEMORY_CAPACITY_DEFAULT } is used.` };
  }
  if ( n < MEMORY_CAPACITY_MIN ) {
    return { limit: MEMORY_CAPACITY_MIN, source: 'env', raw,
      warning: `${ MEMORY_CAPACITY_ENV }=${ raw } is below the minimum; ${ MEMORY_CAPACITY_MIN } is used.` };
  }
  if ( n > MEMORY_CAPACITY_MAX ) {
    return { limit: MEMORY_CAPACITY_MAX, source: 'env', raw,
      warning: `${ MEMORY_CAPACITY_ENV }=${ raw } is above the maximum; ${ MEMORY_CAPACITY_MAX } is used.` };
  }
  return { limit: n, source: 'env', raw, warning: null };
}

/** The ceiling this process uses, resolved once when the file loads. */
export const MEMORY_CAPACITY = Object.freeze( resolveMemoryCapacity() );

/**
 * Entries per VISIBLE scope: the rows a writer's own prompts can read (its own
 * rows plus tenant-wide and shared rows, unexpired). Counted the same way on
 * every twin, which is what keeps their at-ceiling answers identical. The
 * resolved value; the name every caller already imports.
 */
export const MEMORY_CAPACITY_PER_SCOPE = MEMORY_CAPACITY.limit;

/**
 * The boot line both services print, so the two can be compared at a glance:
 *
 *   Memory ceiling: 3000 entries/scope (MEMORY_CAPACITY_PER_SCOPE=3000)
 *   Memory ceiling: 1000 entries/scope (default; MEMORY_CAPACITY_PER_SCOPE not set)
 *   Memory ceiling: 1000 entries/scope (MEMORY_CAPACITY_PER_SCOPE=1,000) WARNING: ...
 *
 * @param {{ limit: number, raw: string|null, warning: string|null }} [cap]
 * @returns {string}
 */
export function describeMemoryCapacity( cap = MEMORY_CAPACITY ) {
  const from = cap.raw === null ? `default; ${ MEMORY_CAPACITY_ENV } not set` : `${ MEMORY_CAPACITY_ENV }=${ cap.raw }`;
  return `Memory ceiling: ${ cap.limit } entries/scope (${ from })${ cap.warning ? ` WARNING: ${ cap.warning }` : '' }`;
}

/**
 * The most rows a write's duplicate check lists (TENAX-2026-10-17-03 item B).
 * The ceiling is decided by a count, so only the duplicate check reads values,
 * and it reads at most this many, newest first: never fewer than the ceiling
 * in force (listingMaxFor). Above it, duplicate detection covers the listed
 * window only; the caller says so in its log.
 */
export const MEMORY_CAPACITY_LISTING_MAX = 10000;

/**
 * The listing bound for a ceiling: the larger of MEMORY_CAPACITY_LISTING_MAX
 * and the ceiling itself.
 *
 * @param {number} [limit]
 * @returns {number}
 */
export function listingMaxFor( limit = MEMORY_CAPACITY_PER_SCOPE ) {
  const l = Number.isFinite( Number( limit ) ) ? Math.floor( Number( limit ) ) : MEMORY_CAPACITY_DEFAULT;
  return Math.max( MEMORY_CAPACITY_LISTING_MAX, l );
}

/** How many consolidation candidates an at-ceiling refusal returns. */
export const CONSOLIDATION_CANDIDATES = 10;

/**
 * The duplicate guard compares substantive values only. A short value ("1",
 * "yes", "tea") under two keys is usually two facts that happen to share an
 * answer, not one fact stored twice; refusing it would be a false positive on
 * ordinary use. 24 normalised characters is about a short sentence.
 */
export const DUPLICATE_MIN_CHARS = 24;

/** Instruction-injection phrases: text addressed to the model that will later read it. */
const INJECTION_PATTERNS = [
  [ /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|system|developer|all)\b[^.\n]{0,20}?\b(?:instructions?|prompts?|rules?|directives?|guidelines?)\b/i, 'it instructs the reader to ignore its instructions' ],
  [ /\byou\s+are\s+now\s+(?:a|an|the|in|no\s+longer)\b/i, 'it tries to reassign the reader\'s role ("you are now ...")' ],
  [ /\b(?:new|updated|revised|real)\s+(?:system\s+)?instructions?\s*:/i, 'it presents itself as new instructions' ],
  [ /\b(?:system|developer)\s+prompt\s*(?::|override|follows)/i, 'it presents itself as a system or developer prompt' ],
  [ /<\/?\s*(?:system|assistant|developer|instructions?|im_start|im_end)\s*>|<\|im_(?:start|end)\|>|\[\/?(?:INST|SYS)\]|<<\s*SYS\s*>>/i, 'it carries a chat-role or prompt-delimiter tag' ],
  [ /<\s*\/?\s*(?:function_calls|invoke|tool_call)\b/i, 'it carries tool-call markup' ],
  [ /\b(?:enter|enable|activate)\s+(?:developer|dan|jailbreak|god)\s+mode\b/i, 'it asks the reader to enter an unrestricted mode' ],
  [ /\bdo\s+not\s+(?:tell|inform|alert)\s+(?:the\s+)?(?:user|brian|anyone)\b/i, 'it asks the reader to hide something from the user' ],
];

/** Exfiltration instructions: text telling the reader to send data out. */
const EXFILTRATION_PATTERNS = [
  [ /\b(?:send|post|upload|forward|transmit|exfiltrate|leak|email|beacon)\b[^.\n]{0,60}?\b(?:memory|memories|conversations?|history|context|credentials?|keys?|tokens?|passwords?|secrets?|data|files?)\b[^.\n]{0,60}?\b(?:to|at|via)\b[^.\n]{0,40}?(?:https?:\/\/|www\.|[\w.-]+@[\w-]+\.[\w.]+|webhook)/i, 'it instructs the reader to send data to an outside address' ],
  [ /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\?[^)\s]*(?:\{|%7B|\$\{|data=|q=|d=)[^)]*\)/i, 'it carries a markdown image beacon that would carry data out in its URL' ],
  [ /\b(?:curl|wget|fetch|requests\.(?:get|post)|invoke-webrequest)\b[^\n]{0,80}?https?:\/\/\S+[^\n]{0,40}?\$\{?\w*(?:key|token|secret|memory|history|env)/i, 'it carries a command that sends secrets or memory to a URL' ],
];

/**
 * Invisible and direction-control code points. A zero-width joiner between two
 * pictographs is an emoji sequence and is allowed; everything else listed here
 * is refused because it can hide or reorder text the reader will act on.
 */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/u;
const EMOJI_ZWJ = /(\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;

/** Credential shapes, each replaced by "[REDACTED:<kind>]". Order matters: specific before generic. */
const CREDENTIAL_PATTERNS = [
  [ 'private_key',     /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, null ],
  [ 'anthropic_key',   /\bsk-ant-[A-Za-z0-9_-]{16,}/g, null ],
  [ 'openai_key',      /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, null ],
  [ 'stripe_key',      /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, null ],
  [ 'aws_access_key',  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, null ],
  [ 'github_token',    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, null ],
  [ 'slack_token',     /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, null ],
  [ 'google_api_key',  /\bAIza[0-9A-Za-z_-]{35}/g, null ],
  [ 'jwt',             /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, null ],
  // Keep the scheme and user; replace only the password.
  [ 'url_password',    /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]{3,})@/gi, ( m, head ) => `${ head }:[REDACTED:url_password]@` ],
  // Keep the word "Bearer"; replace the token.
  [ 'bearer_token',    /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, ( m, word ) => `${ word } [REDACTED:bearer_token]` ],
  // JSON-shaped: "password": "value". Keep the key; replace the value.
  [ 'assigned_secret', /(["'](?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|pwd)["']\s*:\s*)(["'])([^"']{6,})\2/gi,
    ( m, head, q ) => `${ head }${ q }[REDACTED:assigned_secret]${ q }` ],
  // Keep the key name; replace the value.
  [ 'assigned_secret', /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|pwd)\s*[:=]\s*)(["']?)([^\s"',;]{6,})\2/gi,
    ( m, head, q ) => `${ head }${ q }[REDACTED:assigned_secret]${ q }` ],
];

/** The closed re-check class (H-10). */
export const RECHECK_CLASSES = Object.freeze( [ 'artefact', 'deployment', 'version' ] );

/** Default re-check interval, in days, for an entry that qualifies. */
export const RECHECK_DEFAULT_DAYS = 7;

/** The bounds a caller-supplied interval is clamped to. */
const RECHECK_MIN_DAYS = 1;
const RECHECK_MAX_DAYS = 365;

/**
 * Text a value will be scanned as: the string itself, or its JSON.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function valueText( value ) {
  if ( typeof value === 'string' ) return value;
  try { return JSON.stringify( value ) ?? ''; } catch { return String( value ); }
}

/**
 * Find an invisible code point, ignoring emoji ZWJ sequences.
 *
 * @param {string} text
 * @returns {{ found: boolean, codepoint?: string }}
 */
export function invisibleIn( text ) {
  const cleaned = String( text ).replace( EMOJI_ZWJ, '$1' );
  const m = INVISIBLE.exec( cleaned );
  if ( ! m ) return { found: false };
  const cp = m[ 0 ].codePointAt( 0 ).toString( 16 ).toUpperCase().padStart( 4, '0' );
  return { found: true, codepoint: `U+${ cp }` };
}

/**
 * Scan a memory value at write time.
 *
 * @param {string} text
 * @returns {{ ok: true } | { ok: false, code: string, reason: string, match: string }}
 */
export function scanMemoryValue( text ) {
  const t = String( text ?? '' );
  const inv = invisibleIn( t );
  if ( inv.found ) {
    return { ok: false, code: 'MEMORY_INVISIBLE_UNICODE', reason: `Refused: the value contains an invisible or direction-control character (${ inv.codepoint }), which can hide or reorder text a reader will act on. Remove it and write again.`, match: inv.codepoint };
  }
  for ( const [ re, why ] of INJECTION_PATTERNS ) {
    const m = re.exec( t );
    if ( m ) return { ok: false, code: 'MEMORY_INJECTION_PATTERN', reason: `Refused: ${ why } ("${ m[ 0 ].slice( 0, 60 ) }"). Memory records facts; it is read back into a prompt that drives tools, so text addressed to that reader is not stored. If this is a fact about such text, describe it rather than quoting it.`, match: m[ 0 ].slice( 0, 80 ) };
  }
  for ( const [ re, why ] of EXFILTRATION_PATTERNS ) {
    const m = re.exec( t );
    if ( m ) return { ok: false, code: 'MEMORY_EXFILTRATION_PATTERN', reason: `Refused: ${ why } ("${ m[ 0 ].slice( 0, 60 ) }"). Describe the fact without the instruction.`, match: m[ 0 ].slice( 0, 80 ) };
  }
  return { ok: true };
}

/**
 * Replace credential-shaped strings with a marker.
 *
 * @param {string} text
 * @returns {{ text: string, redactions: Array<{ kind: string, count: number }> }}
 */
export function redactCredentials( text ) {
  let out = String( text ?? '' );
  const redactions = [];
  for ( const [ kind, re, replacer ] of CREDENTIAL_PATTERNS ) {
    let count = 0;
    out = out.replace( re, ( ...args ) => {
      count += 1;
      return replacer ? replacer( ...args ) : `[REDACTED:${ kind }]`;
    } );
    if ( count ) redactions.push( { kind, count } );
  }
  return { text: out, redactions };
}

/**
 * Credential-shaped strings present in a text, without changing it.
 *
 * @param {string} text
 * @returns {Array<{ kind: string, count: number }>}
 */
export function findCredentials( text ) {
  return redactCredentials( text ).redactions;
}

/**
 * Comparison form for the duplicate guard: whitespace collapsed, trimmed,
 * case-folded. Two values that differ only in spacing or case are the same
 * fact written twice.
 *
 * @param {string} text
 * @returns {string}
 */
export function normaliseForDuplicate( text ) {
  return String( text ?? '' ).replace( /\s+/g, ' ' ).trim().toLowerCase();
}

/**
 * Find an existing entry holding the same value under a DIFFERENT key.
 *
 * Same key and same value is an idempotent upsert and is not a duplicate; the
 * duplicate guard covers what key-upsert semantics cannot see.
 *
 * @param {{ category: string, key: string, text: string }} incoming
 * @param {Array<{ category: string, key: string, value: unknown }>} existing  The rows in the writer's own scope.
 * @returns {{ category: string, key: string }|null}
 */
export function findDuplicate( incoming, existing ) {
  // Values travel JSON-encoded on some paths (the connector forwards a string
  // value to the gateway as its JSON text) and plain on others, so both the
  // incoming value and each stored value are compared in both readings.
  const readings = ( text ) => {
    const t = typeof text === 'string' ? text : valueText( text );
    const out = [ normaliseForDuplicate( t ) ];
    try { const p = JSON.parse( t ); if ( typeof p === 'string' ) out.push( normaliseForDuplicate( p ) ); } catch { /* not JSON */ }
    return out;
  };
  const wants = new Set( readings( incoming.text ).filter( ( w ) => w.length >= DUPLICATE_MIN_CHARS ) );
  if ( ! wants.size ) return null;
  for ( const row of existing || [] ) {
    if ( row.category === incoming.category && row.key === incoming.key ) continue;
    if ( row.value === null || row.value === undefined ) continue;
    if ( readings( row.value ).some( ( r ) => wants.has( r ) ) ) {
      return { category: row.category, key: row.key };
    }
  }
  return null;
}

/**
 * The at-ceiling decision for a write.
 *
 * Updating an existing key never counts against the ceiling. A NEW key when
 * the scope already holds MEMORY_CAPACITY_PER_SCOPE entries is refused, and the
 * refusal returns the least recently updated entries so the caller can
 * consolidate them. Nothing is truncated or evicted silently.
 *
 * @param {object} o
 * @param {boolean} o.isNewKey
 * @param {number} o.count            Entries currently in the scope.
 * @param {Array<{ category: string, key: string, updated_at?: string|Date }>} [o.oldest]
 * @param {number} [o.limit]
 * @param {string} [o.limitSource]  'env' or 'default' for the process's own
 *        ceiling, 'caller' for a limit passed in; named in the refusal.
 * @returns {{ ok: true } | { ok: false, code: string, reason: string, limit: number, limit_source: string, limit_variable: string, count: number, consolidation_candidates: object[] }}
 */
export function capacityDecision( { isNewKey, count, oldest = [], limit = MEMORY_CAPACITY_PER_SCOPE, limitSource = limit === MEMORY_CAPACITY_PER_SCOPE ? MEMORY_CAPACITY.source : 'caller' } ) {
  if ( ! isNewKey || count < limit ) return { ok: true };
  const candidates = ( oldest || [] ).slice( 0, CONSOLIDATION_CANDIDATES ).map( ( r ) => ( {
    category: r.category,
    key: r.key,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : ( r.updated_at || null ),
  } ) );
  return {
    ok: false,
    code: 'MEMORY_AT_CAPACITY',
    reason: `Refused: this memory scope holds ${ count } entries and its ceiling is ${ limit }. A new key cannot be added until entries are consolidated. Merge or delete some of the least recently updated entries listed in consolidation_candidates, or update an existing key instead. The ceiling (${ limit }, ${ LIMIT_SOURCE_WORDS[ limitSource ] || limitSource }) is the ${ MEMORY_CAPACITY_ENV } variable, which must hold the same value on the gateway and the connector and takes a restart.`,
    limit,
    limit_source: limitSource,
    limit_variable: MEMORY_CAPACITY_ENV,
    count,
    consolidation_candidates: candidates,
  };
}

/** How a refusal names where its ceiling came from. */
const LIMIT_SOURCE_WORDS = Object.freeze( {
  env: `set by ${ MEMORY_CAPACITY_ENV }`,
  default: `the default; ${ MEMORY_CAPACITY_ENV } is not set or not usable`,
  caller: 'passed by the caller',
} );

/** Text that describes the state of an artefact, a deployment or a version. */
const RECHECK_VERSION = /\bv?\d+\.\d+\.\d+\b/;
const RECHECK_DEPLOY = /\b(?:deployed|deployment|released|in production|live on|rolled back|rollback)\b/i;
const RECHECK_ARTEFACT = /\b(?:artefact|artifact|build|release|package|archive|delivery|zip)\b/i;

/**
 * The re-check class and date for an entry (H-10).
 *
 * An explicit class is honoured when it is in the closed set; anything else
 * is refused, never stored as free text. Without one, an entry whose text
 * records a version, a deployment or an artefact's state qualifies and takes
 * the default interval. Expiry of a re-check date is an obligation to
 * re-verify by reading the artefact; it never removes or demotes the entry.
 *
 * @param {object} o
 * @param {string} o.text
 * @param {string|null} [o.recheckClass]
 * @param {number|null} [o.recheckAfterDays]
 * @param {Date} [o.now]
 * @returns {{ ok: true, recheck_class: string|null, recheck_at: string|null, inferred: boolean } | { ok: false, code: string, reason: string }}
 */
export function recheckFor( { text, recheckClass = null, recheckAfterDays = null, now = new Date() } ) {
  let cls = null;
  let inferred = false;
  if ( recheckClass !== null && recheckClass !== undefined && recheckClass !== '' ) {
    const c = String( recheckClass ).trim().toLowerCase();
    if ( ! RECHECK_CLASSES.includes( c ) ) {
      return { ok: false, code: 'MEMORY_RECHECK_CLASS_UNKNOWN', reason: `Refused: recheck_class "${ String( recheckClass ).slice( 0, 30 ) }" is not one of ${ RECHECK_CLASSES.join( ', ' ) }.` };
    }
    cls = c;
  } else {
    const t = String( text ?? '' );
    if ( RECHECK_VERSION.test( t ) && ( RECHECK_DEPLOY.test( t ) || RECHECK_ARTEFACT.test( t ) ) ) cls = 'version';
    else if ( RECHECK_DEPLOY.test( t ) ) cls = 'deployment';
    inferred = cls !== null;
  }
  if ( ! cls ) return { ok: true, recheck_class: null, recheck_at: null, inferred: false };
  let days = Number( recheckAfterDays );
  if ( ! Number.isFinite( days ) || days <= 0 ) days = RECHECK_DEFAULT_DAYS;
  days = Math.min( RECHECK_MAX_DAYS, Math.max( RECHECK_MIN_DAYS, Math.round( days ) ) );
  const at = new Date( now.getTime() + days * 86400000 );
  return { ok: true, recheck_class: cls, recheck_at: at.toISOString(), inferred };
}

/**
 * One write, decided: scan, redact, re-check class, then duplicate and
 * capacity against the writer's own scope.
 *
 * @param {object} o
 * @param {string} o.category
 * @param {string} o.key
 * @param {unknown} o.value
 * @param {Array<{ category: string, key: string, value: unknown, updated_at?: unknown }>} [o.scopeRows]
 *        Every row in the writer's own scope, newest first or any order.
 * @param {number|null} [o.scopeCount]
 *        The scope's true entry count, when scopeRows is a bounded listing
 *        (a store that lists at most N rows). The ceiling uses the larger of
 *        this and scopeRows.length; consolidation candidates are drawn only
 *        from real rows, so they are always entries the caller can act on.
 * @param {boolean|null} [o.keyExists]
 *        Whether (category, key) is already in the visible scope, from a
 *        lookup of its own, when scopeRows is a bounded listing that may not
 *        hold it. null: read from scopeRows, as before.
 * @param {Array<{ category: string, key: string, updated_at?: unknown }>|null} [o.oldestRows]
 *        The scope's least recently updated rows, oldest first, from a query
 *        of their own. null: sorted from scopeRows, as before.
 * @param {string|null} [o.recheckClass]
 * @param {number|null} [o.recheckAfterDays]
 * @param {number} [o.limit]
 * @param {Date} [o.now]
 * @returns {{ ok: true, text: string, redactions: object[], recheck: object } | { ok: false, code: string, reason: string, [k: string]: unknown }}
 */
export function guardMemoryWrite( { category, key, value, scopeRows = [], scopeCount = null, keyExists = null, oldestRows = null, recheckClass = null, recheckAfterDays = null, limit = MEMORY_CAPACITY_PER_SCOPE, now = new Date() } ) {
  const raw = valueText( value );
  const scan = scanMemoryValue( raw );
  if ( ! scan.ok ) return scan;

  const { text, redactions } = redactCredentials( raw );

  const recheck = recheckFor( { text, recheckClass, recheckAfterDays, now } );
  if ( ! recheck.ok ) return recheck;

  const dup = findDuplicate( { category, key, text }, scopeRows );
  if ( dup ) {
    return {
      ok: false,
      code: 'MEMORY_DUPLICATE',
      reason: `Refused: the same value is already stored as ${ dup.category }/${ dup.key }. Update that entry instead of storing the fact twice.`,
      duplicate_of: dup,
    };
  }

  const isNewKey = typeof keyExists === 'boolean' ? ! keyExists : ! ( scopeRows || [] ).some( ( r ) => r.category === category && r.key === key );
  const oldest = Array.isArray( oldestRows ) ? oldestRows : [ ...( scopeRows || [] ) ].sort( ( a, b ) => new Date( a.updated_at || 0 ) - new Date( b.updated_at || 0 ) );
  const counted = Number.isFinite( Number( scopeCount ) ) ? Math.max( Number( scopeCount ), ( scopeRows || [] ).length ) : ( scopeRows || [] ).length;
  const cap = capacityDecision( { isNewKey, count: counted, oldest, limit } );
  if ( ! cap.ok ) return cap;

  return { ok: true, text, redactions, recheck };
}

/**
 * Redaction before injection: the same credential redaction, applied to rows
 * on their way into a prompt, so entries stored before this guard existed
 * cannot carry a credential into a model either.
 *
 * @param {Array<object>} rows
 * @param {string} [field]
 * @returns {Array<object>} New row objects; the inputs are not mutated.
 */
export function redactRowsForInjection( rows, field = 'value' ) {
  return ( rows || [] ).map( ( r ) => {
    if ( ! r || typeof r !== 'object' ) return r;
    const v = r[ field ];
    if ( v === undefined || v === null ) return r;
    const { text, redactions } = redactCredentials( typeof v === 'string' ? v : valueText( v ) );
    return redactions.length ? { ...r, [ field ]: text } : r;
  } );
}

/** Nesting bound for redactDeepForInjection; deeper structure is passed through unchanged. */
const REDACT_MAX_DEPTH = 32;

/**
 * Redaction before injection for an arbitrary value: every string leaf of an
 * object or array (and a bare string) is passed through redactCredentials.
 * Keys are left as they are. Returns a new structure when anything changed and
 * the original when nothing did; the input is never mutated. Used where memory
 * reaches a model as a structured payload (a read result, a session context)
 * rather than as a list of rows.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactDeepForInjection( value, depth = 0 ) {
  if ( typeof value === 'string' ) {
    const r = redactCredentials( value );
    return r.redactions.length ? r.text : value;
  }
  if ( depth >= REDACT_MAX_DEPTH || value === null || typeof value !== 'object' ) return value;
  if ( value instanceof Date ) return value;
  if ( Array.isArray( value ) ) {
    let changed = false;
    const out = value.map( ( v ) => {
      const n = redactDeepForInjection( v, depth + 1 );
      if ( n !== v ) changed = true;
      return n;
    } );
    return changed ? out : value;
  }
  let changed = false;
  const out = {};
  for ( const [ k, v ] of Object.entries( value ) ) {
    const n = redactDeepForInjection( v, depth + 1 );
    if ( n !== v ) changed = true;
    out[ k ] = n;
  }
  return changed ? out : value;
}

export default {
  MEMORY_CAPACITY_ENV, MEMORY_CAPACITY_DEFAULT, MEMORY_CAPACITY_MIN, MEMORY_CAPACITY_MAX, MEMORY_CAPACITY, MEMORY_CAPACITY_LISTING_MAX,
  resolveMemoryCapacity, describeMemoryCapacity, listingMaxFor,
  MEMORY_CAPACITY_PER_SCOPE, CONSOLIDATION_CANDIDATES, DUPLICATE_MIN_CHARS, RECHECK_CLASSES, RECHECK_DEFAULT_DAYS,
  valueText, invisibleIn, scanMemoryValue, redactCredentials, findCredentials, normaliseForDuplicate,
  findDuplicate, capacityDecision, recheckFor, guardMemoryWrite, redactRowsForInjection, redactDeepForInjection,
};
