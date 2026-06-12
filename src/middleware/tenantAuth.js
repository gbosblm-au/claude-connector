// src/middleware/tenantAuth.js  v12.6.0
//
// Gateway authentication middleware for client tenant sessions.
//
// CHANGELOG v12.6.0:
//   - Sends device_id (from deviceId utility) and device_name (TS_DEVICE_NAME)
//     with every /auth call. The gateway records these, enforces per-tenant
//     device caps, and can disable individual devices from the WordPress admin.
//
// Environment variables (new in v12.6.0):
//   TS_DEVICE_NAME   Human-readable name for this connector instance.
//                    Shown in the WordPress device management UI.
//                    Falls back to OS hostname then "Unknown Device".

import { log }               from '../utils/logger.js';
import { getDeviceId,
         getDeviceName }     from '../utils/deviceId.js';

const CLIENT_MODE      = (process.env.TS_CLIENT_MODE       || 'owner').toLowerCase();
const GATEWAY_URL      = (process.env.TS_TENANT_GATEWAY_URL || '').replace(/\/$/, '');
const CLIENT_API_KEY   = process.env.TS_CLIENT_API_KEY      || '';
const CLIENT_TENANT_ID = process.env.TS_TENANT_ID           || '';

// Simple in-process cache: { result, cachedAt }
let _authCache = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

export function isTenantMode() {
  return CLIENT_MODE === 'tenant';
}

export function getTenantId() {
  return CLIENT_TENANT_ID;
}

export async function tenantAuthMiddleware(req, res, next) {
  req.tsClientMode = CLIENT_MODE;

  if (CLIENT_MODE !== 'tenant') {
    req.tsTenantId   = null;
    req.tsTenantTier = null;
    return next();
  }

  try {
    const authResult = await validateTenantKey();

    if (!authResult.valid) {
      const isDisabled  = authResult.status === 'device_disabled';
      const isSuspended = authResult.status === 'suspended';
      const isCapped    = authResult.status === 'device_cap_reached';

      const msg = isDisabled
        ? 'This device has been disabled by your administrator. Contact TrueSource Consulting.'
        : isCapped
        ? 'The maximum number of devices for this account has been reached. Contact TrueSource Consulting to increase the limit or remove an existing device.'
        : isSuspended
        ? 'This account has been suspended. Please contact TrueSource Consulting.'
        : 'Authentication failed. Check TS_CLIENT_API_KEY in your connector environment.';

      log('warn', `[tenantAuth] Access denied for tenant ${CLIENT_TENANT_ID}: ${authResult.status}`);

      return res.status(403).json({
        jsonrpc: '2.0',
        error: {
          code:    -32001,
          message: msg,
          data:    { status: authResult.status, tenant_id: CLIENT_TENANT_ID },
        },
        id: null,
      });
    }

    req.tsTenantId   = authResult.tenant_id;
    req.tsTenantTier = authResult.tier;
    return next();

  } catch (err) {
    log('error', `[tenantAuth] Gateway unreachable: ${err.message}`);

    return res.status(503).json({
      jsonrpc: '2.0',
      error: {
        code:    -32002,
        message: 'TrueSource Client Gateway is unreachable. Please try again shortly.',
        data:    { gateway_url: GATEWAY_URL },
      },
      id: null,
    });
  }
}

async function validateTenantKey() {
  const now = Date.now();

  if (_authCache && (now - _authCache.cachedAt) < CACHE_TTL_MS) {
    return _authCache.result;
  }

  if (!GATEWAY_URL) {
    throw new Error('TS_TENANT_GATEWAY_URL is not set. Cannot authenticate tenant session.');
  }
  if (!CLIENT_API_KEY) {
    throw new Error('TS_CLIENT_API_KEY is not set. Cannot authenticate tenant session.');
  }

  const url = `${GATEWAY_URL}/auth`;
  let res;

  try {
    res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':   'claude-connector/12.6.0 (TrueSource tenant mode)',
      },
      body: JSON.stringify({
        api_key:     CLIENT_API_KEY,
        device_id:   getDeviceId(),
        device_name: getDeviceName(),
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (netErr) {
    _authCache = null;
    throw new Error(`Gateway network error: ${netErr.message}`);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    _authCache = null;
    return {
      valid:     false,
      status:    data.status || 'invalid',
      tenant_id: CLIENT_TENANT_ID,
      tier:      '',
    };
  }

  const result = {
    valid:     data.valid === true,
    status:    data.status || 'unknown',
    tenant_id: data.tenant_id || CLIENT_TENANT_ID,
    tier:      data.tier || '',
  };

  _authCache = { result, cachedAt: now };
  return result;
}

export function invalidateAuthCache() {
  _authCache = null;
}

export function logTenantModeStatus() {
  if (CLIENT_MODE === 'tenant') {
    const keyPreview = CLIENT_API_KEY ? CLIENT_API_KEY.slice(0, 12) + '...' : '(not set)';
    log('info', `[tenantAuth] MODE=tenant | tenant_id=${CLIENT_TENANT_ID || '(not set)'} | key=${keyPreview} | gateway=${GATEWAY_URL || '(not set)'}`);\
  } else {
    log('info', '[tenantAuth] MODE=owner | tenant gateway bypass active');
  }
}
