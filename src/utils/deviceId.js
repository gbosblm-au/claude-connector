// src/utils/deviceId.js  v12.6.0
//
// Persistent device identity for TrueSource tenant-mode connectors.
//
// Each connector deployment is a "device" from the gateway's perspective.
// On first startup this module generates a UUID and writes it to
// /data/device.json on the Railway volume. On subsequent starts it loads
// the stored value so the same device_id survives container restarts.
//
// If the volume is unavailable (owner mode, local dev) the UUID is kept
// in memory only. The gateway accepts transient device_ids gracefully;
// they simply won't be recognised as the same device across restarts.
//
// Environment variables:
//   TS_DEVICE_NAME   Human-readable label for this connector instance.
//                    e.g. "DC2026 Primary", "Brian MacBook Pro".
//                    Falls back to the hostname then "Unknown Device".
//                    Displayed in the WordPress device management UI.
//
// Exports:
//   getDeviceId()    Returns the UUID string (sync after init).
//   getDeviceName()  Returns the human-readable device label (sync).
//   initDevice()     Loads or generates the device_id. Call at startup.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID }                                         from 'node:crypto';
import { hostname }                                           from 'node:os';
import { log }                                               from './logger.js';

const DEVICE_FILE  = '/data/device.json';
const DATA_DIR     = '/data';

let _deviceId   = null;
let _deviceName = null;

// ---------------------------------------------------------------------------
// initDevice
//
// Call once at startup (e.g. from server-http.js before starting to serve).
// Safe to call multiple times; subsequent calls are no-ops.
// ---------------------------------------------------------------------------

export function initDevice() {
  if ( _deviceId ) return; // Already initialised.

  _deviceName = ( process.env.TS_DEVICE_NAME || '' ).trim()
    || hostname()
    || 'Unknown Device';

  // Attempt to load existing device.json from the Railway volume.
  try {
    if ( existsSync( DEVICE_FILE ) ) {
      const stored = JSON.parse( readFileSync( DEVICE_FILE, 'utf8' ) );
      if ( stored?.device_id && typeof stored.device_id === 'string' && stored.device_id.length > 10 ) {
        _deviceId = stored.device_id;
        log( 'info', `[deviceId] Loaded existing device_id=${ _deviceId } name="${ _deviceName }"` );
        return;
      }
    }
  } catch ( err ) {
    log( 'warn', `[deviceId] Could not read ${ DEVICE_FILE }: ${ err.message }` );
  }

  // Generate a new UUID and persist it.
  _deviceId = randomUUID();

  try {
    if ( !existsSync( DATA_DIR ) ) mkdirSync( DATA_DIR, { recursive: true } );
    writeFileSync( DEVICE_FILE, JSON.stringify( { device_id: _deviceId, created_at: new Date().toISOString() }, null, 2 ), 'utf8' );
    log( 'info', `[deviceId] Generated new device_id=${ _deviceId } name="${ _deviceName }" (saved to ${ DEVICE_FILE })` );
  } catch ( err ) {
    // Volume not writable (owner mode / local dev). Keep UUID in memory only.
    log( 'warn', `[deviceId] Could not persist device_id to ${ DEVICE_FILE }: ${ err.message }. ID will be transient.` );
  }
}

// ---------------------------------------------------------------------------
// Accessors (synchronous after initDevice() has been called)
// ---------------------------------------------------------------------------

export function getDeviceId() {
  if ( !_deviceId ) initDevice(); // Lazy init as fallback.
  return _deviceId;
}

export function getDeviceName() {
  if ( !_deviceName ) initDevice();
  return _deviceName;
}
