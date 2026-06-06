// src/middleware/tenantAuth.js  v12.0.0
//
// Gateway authentication middleware for client tenant sessions.
//
// When TS_CLIENT_MODE=tenant, every incoming MCP request is validated
// against the TrueSource Client Gateway WordPress plugin before any
// tool is executed. If the key is invalid or the account is suspended,
// the request is rejected with a clear error message.
//
// When TS_CLIENT_MODE=owner (default), this middleware is a no-op and
// the connector behaves exactly as it did before v12.0.0.
//
// Environment variables:
//   TS_CLIENT_MODE         'owner' (default) | 'tenant'
//   TS_TENANT_GATEWAY_URL  Base URL of the gateway REST API
//                          e.g. https://truesourceconsulting.com.au/wp-json/ts-gateway/v1
//   TS_CLIENT_API_KEY      The plain API key generated for this tenant
//   TS_TENANT_ID           The tenant_id slug (e.g. smith-partners)
//                          Used for file path resolution and memory namespace.
//
// The middleware injects into the request context:
//   req.tsClientMode   'owner' | 'tenant'
//   req.tsTenantId     The authenticated tenant_id (tenant mode only)
//   req.tsTenantTier   The tier ('foundation'|'operational'|'strategic') (tenant mode only)
//
// Auth check is cached for 60 seconds per request cycle to avoid
// re-validating on every tool call within a single MCP session.
// The cache is cleared on any 403/401 response.

import { log } from '../utils/logger.js';

const CLIENT_MODE      = (process.env.TS_CLIENT_MODE       || 'owner').toLowerCase();
const GATEWAY_URL      = (process.env.TS_TENANT_GATEWAY_URL || '').replace(/\/$/, '');
const CLIENT_API_KEY   = process.env.TS_CLIENT_API_KEY      || '';
const CLIENT_TENANT_ID = process.env.TS_TENANT_ID           || '';

// Simple in-process cache: { result, cachedAt }
let _authCache = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Whether this connector instance is running in tenant mode.
 */
export function isTenantMode() {
  return CLIENT_MODE === 'tenant';
}

/**
 * Exported for use in path resolution and memory routing.
 * Returns the tenant_id from env (not from auth cache) for synchronous use.
 */
export function getTenantId() {
  return CLIENT_TENANT_ID;
}

/**
 * Express middleware. Validates the tenant API key against the gateway.
 * In owner mode, injects tsClientMode='owner' and calls next() immediately.
 * In tenant mode, calls the gateway auth endpoint; on failure returns 403.
 */
export async function tenantAuthMiddleware(req, res, next) {
  req.tsClientMode = CLIENT_MODE;

  if (CLIENT_MODE !== 'tenant') {
    // Owner mode: bypass all gateway checks.
    req.tsTenantId   = null;
    req.tsTenantTier = null;
    return next();
  }

  // Tenant mode: validate.
  try {
    const authResult = await validateTenantKey();

    if (!authResult.valid) {
      const msg = authResult.status === 'suspended'
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

    // Fail closed: if the gateway cannot be reached, block the request.
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

/**
 * Call the gateway auth endpoint. Results cached for CACHE_TTL_MS.
 * Cache is invalidated on any non-200 response (account may have been suspended mid-session).
 *
 * @returns {{ valid: boolean, status: string, tenant_id: string, tier: string }}
 */
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
        'User-Agent':   'claude-connector/12.0.0 (TrueSource tenant mode)',
      },
      body: JSON.stringify({ api_key: CLIENT_API_KEY }),
      signal: AbortSignal.timeout(8000), // 8 second timeout
    });
  } catch (netErr) {
    _authCache = null; // Clear cache on network error
    throw new Error(`Gateway network error: ${netErr.message}`);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // 403 = suspended or invalid, 429 = rate limited, 5xx = gateway error
    _authCache = null; // Do not cache failures
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

/**
 * Invalidate the auth cache. Called when a 403 is received from the gateway
 * mid-session (account suspended while session is active).
 */
export function invalidateAuthCache() {
  _authCache = null;
}

/**
 * Log the current tenant mode configuration at startup.
 */
export function logTenantModeStatus() {
  if (CLIENT_MODE === 'tenant') {
    const keyPreview = CLIENT_API_KEY ? CLIENT_API_KEY.slice(0, 12) + '...' : '(not set)';
    log('info', `[tenantAuth] MODE=tenant | tenant_id=${CLIENT_TENANT_ID || '(not set)'} | key=${keyPreview} | gateway=${GATEWAY_URL || '(not set)'}`);
  } else {
    log('info', '[tenantAuth] MODE=owner | tenant gateway bypass active');
  }
}
