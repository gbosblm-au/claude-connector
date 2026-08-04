// src/utils/secretBox.js  v1.0.0
// ---------------------------------------------------------------------------
// Authenticated encryption for secrets at rest.
//
// Part of the TNX-H-014 remediation (audit TNX-AUDIT-2026-08).
//
// The audit notes that the gateway already has the correct primitive in
// lib/workflow-secrets.js -- AES-256-GCM with a versioned payload -- and that
// the connector simply was not using it. This module mirrors that scheme
// byte-for-byte so the two are interchangeable, which is what makes the
// eventual extraction into a shared package (Phase 2) a move rather than a
// reconciliation of two divergent formats.
//
// Payload format, identical to the gateway's:
//
//     v1:<base64(iv[12])>:<base64(tag[16])>:<base64(ciphertext)>
//
// GCM rather than CBC is the important choice. CBC provides confidentiality
// with no integrity, so ciphertext is malleable and a padding oracle is
// available. GCM authenticates: a modified ciphertext fails to decrypt rather
// than producing attacker-influenced plaintext. This is the same defect the
// audit records separately as TNX-M-008 in the PHP plugin, which uses
// aes-256-cbc with no MAC.
//
// The version prefix exists so a future scheme change can be migrated rather
// than requiring every stored secret to be re-entered by hand.
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO    = 'aes-256-gcm';
const IV_LEN  = 12;   // 96 bits, the size GCM is specified for
const TAG_LEN = 16;
const VERSION = 'v1';

/**
 * Resolve the 32-byte master key from the environment.
 *
 * Accepts 64 hex characters, 32 raw bytes base64-encoded, or 32 literal bytes,
 * matching the gateway's `getKey()` so an operator can use one generation
 * command for both services.
 *
 * @returns {Buffer|null} The key, or null when unset or the wrong length.
 */
export function getKey() {
  const raw = ( process.env.CONNECTOR_SECRET_KEY || '' ).trim();
  if ( ! raw ) return null;

  /** @type {Buffer|null} */
  let buf = null;

  if ( /^[0-9a-fA-F]{64}$/.test( raw ) ) {
    buf = Buffer.from( raw, 'hex' );
  } else {
    try {
      const b = Buffer.from( raw, 'base64' );
      if ( b.length === 32 ) buf = b;
    } catch { /* not base64 */ }
    if ( ! buf && Buffer.byteLength( raw ) === 32 ) buf = Buffer.from( raw );
  }

  return ( buf && buf.length === 32 ) ? buf : null;
}

/**
 * Whether encryption at rest is available.
 * @returns {boolean}
 */
export function encryptionEnabled() {
  return getKey() !== null;
}

/**
 * Encrypt a plaintext string.
 *
 * @param {string} plaintext
 * @param {Buffer} [key] Defaults to getKey().
 * @returns {string} The versioned payload.
 * @throws {Error} When no key is configured.
 */
export function encryptSecret( plaintext, key ) {
  const k = key || getKey();
  if ( ! k ) throw new Error( 'CONNECTOR_SECRET_KEY is not configured; cannot encrypt.' );

  const iv     = randomBytes( IV_LEN );
  const cipher = createCipheriv( ALGO, k, iv );
  const ct     = Buffer.concat( [ cipher.update( String( plaintext ), 'utf8' ), cipher.final() ] );
  const tag    = cipher.getAuthTag();

  return `${ VERSION }:${ iv.toString( 'base64' ) }:${ tag.toString( 'base64' ) }:${ ct.toString( 'base64' ) }`;
}

/**
 * Decrypt a versioned payload.
 *
 * @param {string} payload
 * @param {Buffer} [key] Defaults to getKey().
 * @returns {string} The plaintext.
 * @throws {Error} When the key is missing, the payload is malformed, or the
 *                 authentication tag does not verify.
 */
export function decryptSecret( payload, key ) {
  const k = key || getKey();
  if ( ! k ) throw new Error( 'CONNECTOR_SECRET_KEY is not configured; cannot decrypt.' );

  const parts = String( payload ).split( ':' );
  if ( parts.length !== 4 || parts[ 0 ] !== VERSION ) {
    throw new Error( 'Malformed secret payload.' );
  }

  const iv  = Buffer.from( parts[ 1 ], 'base64' );
  const tag = Buffer.from( parts[ 2 ], 'base64' );
  const ct  = Buffer.from( parts[ 3 ], 'base64' );

  if ( iv.length !== IV_LEN || tag.length !== TAG_LEN ) {
    throw new Error( 'Malformed secret payload.' );
  }

  const decipher = createDecipheriv( ALGO, k, iv );
  decipher.setAuthTag( tag );

  // final() throws when the tag does not verify. That throw IS the integrity
  // check, so it must not be swallowed by the caller.
  return Buffer.concat( [ decipher.update( ct ), decipher.final() ] ).toString( 'utf8' );
}

/**
 * Test whether a string looks like one of our payloads.
 *
 * Used by the migration path to tell an already-encrypted file from a legacy
 * plaintext one without attempting a decryption that would throw.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksEncrypted( value ) {
  return typeof value === 'string' && value.startsWith( `${ VERSION }:` ) && value.split( ':' ).length === 4;
}

export default { getKey, encryptionEnabled, encryptSecret, decryptSecret, looksEncrypted };
