// src/utils/callContext.js  (claude-connector v13.41.0)
// ---------------------------------------------------------------------------
// The identity of the caller of ONE tool call, for the code that call runs.
//
// WHY THIS EXISTS (WO-ISO-276-001 A3, the connector half)
// ------------------------------------------------------
// In tenant mode every memory_* tool calls the gateway's /memory/* routes.
// Until Gateway 2.277.0 those routes accepted a request with no user_id and
// fell back to tenant-wide rows: every account on the tenant read the same
// ownerless rows, and an ownerless write became readable by all of them. The
// gateway now refuses a memory request that does not name an account on the
// api key's tenant. This module is how the connector names one.
//
// The gateway already sends { tenant_id, user_id } as `context` with every
// proxied tool call (POST /tool-call). dispatchToolCall() opens a scope with
// runWithCallContext(); anything the call awaits reads it back with
// currentCallContext(), without a parameter threaded through every handler.
// AsyncLocalStorage keeps concurrent calls apart: two users' calls in flight
// at once each see their own identity.
//
// WHAT IS DELIBERATELY NOT USED
// -----------------------------
// tools-self-model/sessionContext.js getCurrentUser(): a process-wide value
// set by the last ts_gateway_session_init. With two sessions open it holds
// whichever started last, so using it to scope memory would be a guess about
// whose rows to read: the failure this change exists to remove.
//
// RESOLUTION ORDER (resolveMemoryUserId)
// --------------------------------------
//   1. a gateway-proxied call (its context names a tenant or a user) uses
//      the context's user_id and nothing else: with none, it is refused;
//   2. a call with no gateway context (a direct MCP session) uses
//      TS_CLIENT_USER_ID: the one account a single-user tenant-mode
//      deployment acts for (the operator sets it at provisioning; Gateway
//      scripts/provision-tenant.mjs prints the id);
//   3. otherwise a refusal (TENANT_USER_REQUIRED), before anything is sent.
// A value that is present but is not a positive whole number is refused, not
// skipped, and a gateway call without a user is refused, not completed with
// the configured account: either would be a different identity.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

/**
 * @param {object|null|undefined} context  { tenant_id, user_id } as the gateway sends it.
 * @returns {{ tenantId: string|null, userId: unknown }}
 */
function normalise( context ) {
  if ( ! context || typeof context !== 'object' ) return { tenantId: null, userId: null };
  const t = context.tenant_id ?? context.tenantId ?? null;
  const u = context.user_id ?? context.userId ?? null;
  return {
    tenantId: t !== null && t !== undefined && String( t ).trim() !== '' ? String( t ).trim() : null,
    userId: u === undefined ? null : u,
  };
}

/**
 * Run `fn` with `context` as the current call's identity.
 *
 * @template T
 * @param {object|null|undefined} context
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithCallContext( context, fn ) {
  return store.run( normalise( context ), fn );
}

/** The current call's identity, or null outside a call scope. */
export function currentCallContext() {
  return store.getStore() || null;
}

/**
 * A positive whole number, or null when the value is not one.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function positiveUserId( raw ) {
  const shaped = typeof raw === 'number' || ( typeof raw === 'string' && /^\s*\d+\s*$/.test( raw ) );
  const n = shaped ? Number( raw ) : NaN;
  return Number.isInteger( n ) && n > 0 ? n : null;
}

/**
 * The account a tenant-mode memory call acts for.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, userId: number, source: 'call_context'|'TS_CLIENT_USER_ID' }
 *         | { ok: false, reason: string }}
 */
export function resolveMemoryUserId( env = process.env ) {
  const ctx = currentCallContext();
  const hasUser = ctx && ctx.userId !== null && ctx.userId !== undefined && ctx.userId !== '';
  if ( hasUser ) {
    const id = positiveUserId( ctx.userId );
    if ( id === null ) {
      return { ok: false, reason: `the calling gateway sent user_id ${ JSON.stringify( ctx.userId ) }, which is not a positive whole number` };
    }
    return { ok: true, userId: id, source: 'call_context' };
  }
  if ( ctx && ctx.tenantId ) {
    return { ok: false, reason: `the calling gateway named tenant ${ JSON.stringify( ctx.tenantId ) } and no user; a gateway call acts for its own user or for no one, never for TS_CLIENT_USER_ID` };
  }
  const configured = env.TS_CLIENT_USER_ID;
  if ( configured !== undefined && String( configured ).trim() !== '' ) {
    const id = positiveUserId( String( configured ) );
    if ( id === null ) {
      return { ok: false, reason: `TS_CLIENT_USER_ID is "${ configured }", which is not a positive whole number` };
    }
    return { ok: true, userId: id, source: 'TS_CLIENT_USER_ID' };
  }
  return {
    ok: false,
    reason: 'no account is named: this call carries no per-call user_id and TS_CLIENT_USER_ID is not set. '
      + 'The tenant gateway refuses a memory request that does not name an account on its tenant.',
  };
}

export default { runWithCallContext, currentCallContext, resolveMemoryUserId, positiveUserId };
