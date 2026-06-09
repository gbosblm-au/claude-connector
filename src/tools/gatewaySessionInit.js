// src/tools/gatewaySessionInit.js  v12.3.0
//
// ts_gateway_session_init - Authenticate session with TrueSource Client Gateway.
//
// Called as Step 1 at session start from the client system prompt.
// POSTs to the WordPress gateway /session-init endpoint, validates the
// tenant API key + tenant_id pair, and returns session context plus an
// explicit ordered list of required next steps (including skill_compile).
//
// This tool is always advertised in tenant-mode connectors (TS_CLIENT_MODE=tenant).
// In owner mode it is suppressed - the owner connector does not use tenant auth.
//
// The response from /session-init intentionally repeats the full next-step
// sequence so Claude sees a tool result reinforcing the system prompt instruction.
// This is the fix for the "skipping skill_compile" regression: the gateway
// response explicitly names skill_compile as a required non-deferrable step,
// giving Claude two independent signals (system prompt + tool result) to act on.

import { log } from '../utils/logger.js';

const CLIENT_MODE    = (process.env.TS_CLIENT_MODE       || 'owner').toLowerCase();
const GATEWAY_URL    = (process.env.TS_TENANT_GATEWAY_URL || '').replace(/\/$/, '');
const CLIENT_API_KEY = process.env.TS_CLIENT_API_KEY      || '';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const tsGatewaySessionInitToolDefinition = {
  name: 'ts_gateway_session_init',
  description:
    'Authenticate this session with TrueSource infrastructure. Call as the very first step ' +
    'at session start, before any other tool. Validates the tenant API key, confirms the ' +
    'account is active, and returns the required next steps for this session including ' +
    'memory_get_session_context, profile_read, and skill_compile. ' +
    'If this call fails or returns session_authenticated=false, note the error and continue ' +
    'with reduced capability.',
  inputSchema: {
    type: 'object',
    properties: {
      api_key: {
        type: 'string',
        description: 'The tenant API key as provided in the system prompt.',
      },
      tenant_id: {
        type: 'string',
        description: 'The tenant ID as provided in the system prompt.',
      },
      gateway_url: {
        type: 'string',
        description: 'The gateway base URL as provided in the system prompt.',
      },
    },
    required: ['api_key', 'tenant_id', 'gateway_url'],
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleTsGatewaySessionInit(args) {
  const apiKey     = typeof args.api_key     === 'string' ? args.api_key.trim()     : '';
  const tenantId   = typeof args.tenant_id   === 'string' ? args.tenant_id.trim()   : '';
  const gatewayUrl = typeof args.gateway_url === 'string' ? args.gateway_url.replace(/\/$/, '') : '';

  if (!apiKey || !tenantId || !gatewayUrl) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          session_authenticated: false,
          error: 'api_key, tenant_id, and gateway_url are all required.',
          hint:  'These values are provided in the system prompt. Verify the call parameters match exactly.',
        }, null, 2),
      }],
      isError: true,
    };
  }

  const endpoint = `${gatewayUrl}/session-init`;
  log('info', `[ts_gateway_session_init] calling ${endpoint} for tenant=${tenantId}`);

  let response;
  try {
    response = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':   'claude-connector/12.3.0 (TrueSource session-init)',
      },
      body: JSON.stringify({ api_key: apiKey, tenant_id: tenantId }),
      signal: AbortSignal.timeout(10_000), // 10 second timeout
    });
  } catch (netErr) {
    log('warn', `[ts_gateway_session_init] network error: ${netErr.message}`);
    // Return a degraded result rather than hard error so session can continue
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          session_authenticated: false,
          error:  `Gateway unreachable: ${netErr.message}`,
          status: 'gateway_unavailable',
          degraded_mode: true,
          note: 'TrueSource infrastructure is unavailable. Continue with reduced capability: proceed with memory_get_session_context, profile_read, and skill_compile using the connector tools directly.',
        }, null, 2),
      }],
    };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    const status  = data?.status  || 'invalid';
    const message = data?.message || `HTTP ${response.status}`;

    log('warn', `[ts_gateway_session_init] auth failed for tenant=${tenantId}: ${status}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          session_authenticated: false,
          status,
          message,
          note: status === 'suspended'
            ? 'This account has been suspended. Contact TrueSource Consulting to reactivate.'
            : 'Authentication failed. Verify TS_CLIENT_API_KEY and TS_TENANT_ID in the connector environment.',
        }, null, 2),
      }],
    };
  }

  log('info', `[ts_gateway_session_init] authenticated tenant=${data.tenant_id} tier=${data.tier}`);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        session_authenticated: true,
        tenant_id:    data.tenant_id    || tenantId,
        display_name: data.display_name || '',
        tier:         data.tier         || 'operational',
        session_id:   data.session_id   || new Date().toISOString().replace(/[-T:]/g, '').slice(0, 15),
        // Explicit next-step sequence. Reinforces the system prompt so Claude
        // has two independent signals that skill_compile is non-deferrable.
        next_steps: [
          'Step 2: Call memory_get_session_context with a context_hint drawn from the opening message topic.',
          'Step 3: Call profile_read to identify the person you are speaking with.',
          'Step 4: Call skill_compile with query=opening_message, context_hint from Step 2, person_name from Step 3. This is required and non-deferrable. Do not respond to the user before skill_compile has completed.',
          'Step 5: Check memory for the established assistant name (category: "identity", key: "assistant_name"). If none, follow the first-session naming protocol.',
          'Step 6: Operate under the compiled skill guidelines for the full session.',
        ],
        skill_compile_required: true,
        note: `Session authenticated for ${data.tenant_id || tenantId}. Complete all six steps before responding to the user's opening message.`,
      }, null, 2),
    }],
  };
}
