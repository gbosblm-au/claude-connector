// src/tools/healthLog.js  v12.5.0
//
// Peer Review health log tools - TENANT MODE ONLY.
//
// Three tools called by client Ava connectors:
//
//   health_log_write
//     Called at session close. POSTs to {gateway}/health/log with the tenant
//     api_key. The gateway upserts one record per tenant per UTC date, merging
//     signal (worst-seen), issues, and session_count on subsequent writes.
//
//   issue_flag
//     Called mid-session when a persistent or unresolved issue emerges.
//     POSTs to {gateway}/health/flag-issue. Creates today's log if none exists.
//
//   peer_review_consent_set
//     Called at first session after the consent dialogue.
//     POSTs to {gateway}/health/consent.
//     Once consent is set to true, Brian's connector can read this tenant's
//     health logs via the peer review endpoint.
//
// All three tools are suppressed (not advertised) when TS_CLIENT_MODE != 'tenant'
// or TS_TENANT_GATEWAY_URL / TS_CLIENT_API_KEY are not configured.
// This is enforced at registration time in server-http.js via isTenantMode().

import { log } from '../utils/logger.js';

const GATEWAY_URL = ( process.env.TS_TENANT_GATEWAY_URL || '' ).replace( /\/$/, '' );
const API_KEY     = process.env.TS_CLIENT_API_KEY || '';

// ---------------------------------------------------------------------------
// Shared gateway POST helper
// ---------------------------------------------------------------------------

async function gatewayPost( path, payload ) {
  if ( ! GATEWAY_URL || ! API_KEY ) {
    throw new Error(
      'TS_TENANT_GATEWAY_URL and TS_CLIENT_API_KEY must both be set in Railway Variables.'
    );
  }

  const url = `${ GATEWAY_URL }${ path }`;
  log( 'info', `[health] POST ${ url }` );

  const response = await fetch( url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify( { api_key: API_KEY, ...payload } ),
    signal:  AbortSignal.timeout( 10_000 ),
  } );

  const text = await response.text();
  let data;
  try { data = JSON.parse( text ); } catch { data = { raw: text }; }

  if ( ! response.ok ) {
    throw new Error( `Gateway ${ path } returned ${ response.status }: ${ data?.error || text }` );
  }

  return data;
}

// ---------------------------------------------------------------------------
// Tool 1: health_log_write
// ---------------------------------------------------------------------------

export const healthLogWriteToolDefinition = {
  name: 'health_log_write',
  description:
    'Write a health log entry at session close. Records the overall session signal ' +
    '(green/amber/red), a brief summary of what was covered, and any flagged issues. ' +
    'Call this as the final step of the session close sequence, after memory_write. ' +
    'Only available in tenant-mode connectors with peer review enabled.',
  inputSchema: {
    type: 'object',
    properties: {
      signal: {
        type: 'string',
        enum: [ 'green', 'amber', 'red' ],
        description:
          'Overall health signal for this session. ' +
          'green = engagement positive, no concerns. ' +
          'amber = some friction or a pattern worth watching. ' +
          'red = significant unresolved issue or relationship concern.',
      },
      summary: {
        type: 'string',
        maxLength: 500,
        description:
          'Brief honest summary of the session (max 500 chars). ' +
          'Cover what was worked on and how the engagement went. ' +
          'Be specific about any friction even if signal is green.',
      },
      issues: {
        type: 'array',
        description:
          'Array of issues to log. Use for recurring problems, unresolved requests, ' +
          'scope confusion, or anything that may require follow-up.',
        items: {
          type: 'object',
          properties: {
            severity:    { type: 'string', enum: [ 'low', 'medium', 'high' ] },
            topic:       { type: 'string', maxLength: 100, description: 'Short issue label.' },
            description: { type: 'string', maxLength: 500, description: 'Brief details.' },
            resolved:    { type: 'boolean', description: 'true if resolved in this session.' },
          },
          required: [ 'severity', 'topic' ],
        },
        default: [],
      },
    },
    required: [ 'signal', 'summary' ],
  },
};

export async function handleHealthLogWrite( args ) {
  const signal  = ( args.signal  || 'green' ).toLowerCase();
  const summary = String( args.summary || '' ).slice( 0, 500 );
  const issues  = Array.isArray( args.issues ) ? args.issues : [];

  try {
    const result = await gatewayPost( '/health/log', { signal, summary, issues } );

    return {
      content: [ {
        type: 'text',
        text: JSON.stringify( {
          health_log_written: true,
          operation:  result.operation,
          log_date:   result.log_date,
          signal:     result.signal,
        }, null, 2 ),
      } ],
    };

  } catch ( err ) {
    log( 'warn', `[health_log_write] failed: ${ err.message }` );
    return {
      content: [ {
        type: 'text',
        text: JSON.stringify( {
          health_log_written: false,
          error: err.message,
          note:  'Health log write failed. Session continues normally.',
        }, null, 2 ),
      } ],
    };
  }
}

// ---------------------------------------------------------------------------
// Tool 2: issue_flag
// ---------------------------------------------------------------------------

export const issueFlagToolDefinition = {
  name: 'issue_flag',
  description:
    'Flag a specific issue mid-session for peer review tracking. ' +
    'Use when an issue arises that cannot be resolved in the current session, ' +
    'recurs across sessions, or touches on scope, relationship, or expectation misalignment. ' +
    'Flagged issues appear in the peer review check-in so they receive attention at the right level. ' +
    'Only available in tenant-mode connectors with peer review enabled.',
  inputSchema: {
    type: 'object',
    properties: {
      severity: {
        type: 'string',
        enum: [ 'low', 'medium', 'high' ],
        description:
          'low = worth noting, not urgent. ' +
          'medium = recurring or unresolved, warrants monitoring. ' +
          'high = significant concern, may require Brian to act.',
      },
      topic: {
        type: 'string',
        maxLength: 100,
        description: 'Short label for the issue, e.g. "scope creep", "expectation mismatch".',
      },
      description: {
        type: 'string',
        maxLength: 500,
        description: 'Specific details about what happened and why it is being flagged.',
      },
    },
    required: [ 'severity', 'topic', 'description' ],
  },
};

export async function handleIssueFlag( args ) {
  const severity    = ( args.severity    || 'medium' ).toLowerCase();
  const topic       = String( args.topic       || '' ).slice( 0, 100 ).trim();
  const description = String( args.description || '' ).slice( 0, 500 ).trim();

  if ( ! topic ) {
    return {
      content: [ { type: 'text', text: JSON.stringify( { error: 'topic is required.' }, null, 2 ) } ],
      isError: true,
    };
  }

  try {
    const result = await gatewayPost( '/health/flag-issue', { severity, topic, description } );

    return {
      content: [ {
        type: 'text',
        text: JSON.stringify( {
          issue_flagged: true,
          issue:         result.issue,
        }, null, 2 ),
      } ],
    };

  } catch ( err ) {
    log( 'warn', `[issue_flag] failed: ${ err.message }` );
    return {
      content: [ {
        type: 'text',
        text: JSON.stringify( {
          issue_flagged: false,
          error: err.message,
          note:  'Issue flag write failed. Continue normally.',
        }, null, 2 ),
      } ],
    };
  }
}

// ---------------------------------------------------------------------------
// Tool 3: peer_review_consent_set
// ---------------------------------------------------------------------------

export const peerReviewConsentToolDefinition = {
  name: 'peer_review_consent_set',
  description:
    'Set the peer review consent status for this client. ' +
    'Call this at first session after the onboarding consent dialogue has been completed. ' +
    'Consent enables TrueSource to conduct periodic peer check-ins on session health. ' +
    'Consent can be revoked at any time by calling this tool with consent=false. ' +
    'Only available in tenant-mode connectors.',
  inputSchema: {
    type: 'object',
    properties: {
      consent: {
        type: 'boolean',
        description: 'true to enable peer review. false to revoke consent.',
      },
    },
    required: [ 'consent' ],
  },
};

export async function handlePeerReviewConsent( args ) {
  const consent = args.consent === true || args.consent === 'true';

  try {
    const result = await gatewayPost( '/health/consent', { consent } );

    return {
      content: [ {
        type: 'text',
        text: JSON.stringify( {
          consent_recorded: true,
          consent_given:    result.consent_given,
          message:          consent
            ? 'Peer review consent recorded. TrueSource will conduct periodic health check-ins on this engagement.'
            : 'Peer review consent revoked. No further health check-ins will be conducted.',
        }, null, 2 ),
      } ],
    };

  } catch ( err ) {
    log( 'warn', `[peer_review_consent_set] failed: ${ err.message }` );
    return {
      content: [ {
        type: 'text',
        text: JSON.stringify( {
          consent_recorded: false,
          error: err.message,
        }, null, 2 ),
      } ],
      isError: true,
    };
  }
}
