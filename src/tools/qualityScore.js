// src/tools/qualityScore.js  (post-session quality scoring -> review queue)
//
// TENANT MODE ONLY. One tool, called by the client Ava at session close:
//
//   quality_score_submit
//     Records a self-assessed quality score for the session and POSTs it to
//     {gateway}/ti-ingest/quality with the tenant api_key. The gateway computes
//     the weighted score, decides whether the session enters the human review
//     queue, and stores it for the Quality Review dashboard.
//
//   Call as part of the session-close sequence, after memory_write. Honest
//   self-assessment is the point: low scores and flagged risks are what route a
//   session to review. Best-effort: never blocks session close. Gated on the
//   client's quality-review consent.
//
// Suppressed unless tenant mode with gateway URL + api key configured.

import { log } from '../utils/logger.js';

const GATEWAY_URL = ( process.env.TS_TENANT_GATEWAY_URL || '' ).replace( /\/$/, '' );
const API_KEY     = process.env.TS_CLIENT_API_KEY || '';

// Consent default: quality scoring only runs when the client has opted in. The
// connector env can set it; otherwise the tool requires an explicit consent arg.
const CONSENT_ENV = ( process.env.TS_QUALITY_REVIEW_CONSENT || '' ).toLowerCase() === 'true';

const COMPONENT_KEYS = [
  'tvrl_coverage', 'response_coherence', 'memory_accuracy',
  'tool_efficiency', 'satisfaction_proxy', 'hallucination_free',
];

// ---------------------------------------------------------------------------
// Pure normaliser (exported for tests)
// ---------------------------------------------------------------------------

function clamp01( v ) {
  const n = typeof v === 'number' ? v : parseFloat( v );
  if ( ! Number.isFinite( n ) ) return 0;
  return Math.max( 0, Math.min( 1, n ) );
}

/**
 * Normalise a quality submission: clamp each known component to 0..1, coerce
 * signals to the shapes the gateway expects, and resolve consent (explicit arg
 * overrides the env default).
 * @returns {{ components: object, signals: object, consent: boolean, session_id: (string|null) }}
 */
export function normalizeQuality( args ) {
  const a = args || {};
  const components = {};
  const src = ( a.components && typeof a.components === 'object' ) ? a.components : {};
  for ( const key of COMPONENT_KEYS ) {
    if ( src[ key ] != null ) components[ key ] = clamp01( src[ key ] );
  }

  const s = ( a.signals && typeof a.signals === 'object' ) ? a.signals : {};
  const signals = {};
  if ( s.hallucination_rate != null ) signals.hallucination_rate = clamp01( s.hallucination_rate );
  signals.tvrl_critical_failed          = s.tvrl_critical_failed === true;
  signals.user_reported_issue           = s.user_reported_issue === true;
  signals.assistant_flagged_uncertainty = s.assistant_flagged_uncertainty === true;

  const consent = ( a.consent === true ) || ( a.consent == null && CONSENT_ENV );
  const session_id = ( typeof a.session_id === 'string' && a.session_id.trim() ) ? a.session_id.trim() : null;

  return { components, signals, consent, session_id };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const qualityScoreSubmitToolDefinition = {
  name: 'quality_score_submit',
  description:
    'Submit an honest self-assessed quality score for this session to the peer-review system. ' +
    'Call as part of the session-close sequence, after memory_write. Rate each component from 0 to 1 ' +
    '(tvrl_coverage, response_coherence, memory_accuracy, tool_efficiency, satisfaction_proxy, ' +
    'hallucination_free where 1 means no hallucination), and flag any risk signals. Low scores and ' +
    'flagged risks route the session to human review -- honesty is the point, not a high score. ' +
    'Requires the client\'s quality-review consent. Best-effort: never blocks session close. ' +
    'Only available in tenant-mode connectors.',
  inputSchema: {
    type: 'object',
    properties: {
      components: {
        type: 'object',
        description: 'Quality components, each 0..1.',
        properties: {
          tvrl_coverage:      { type: 'number', minimum: 0, maximum: 1, description: 'Fraction of claims that were TVRL-verified.' },
          response_coherence: { type: 'number', minimum: 0, maximum: 1, description: 'Coherence / relevance of responses.' },
          memory_accuracy:    { type: 'number', minimum: 0, maximum: 1, description: 'Accuracy of recalled memory.' },
          tool_efficiency:    { type: 'number', minimum: 0, maximum: 1, description: 'Tool use was efficient (no wasted calls).' },
          satisfaction_proxy: { type: 'number', minimum: 0, maximum: 1, description: 'Proxy for user satisfaction.' },
          hallucination_free: { type: 'number', minimum: 0, maximum: 1, description: '1 = no hallucination, 0 = severe.' },
        },
      },
      signals: {
        type: 'object',
        description: 'Risk signals that can force review regardless of score.',
        properties: {
          hallucination_rate:            { type: 'number', minimum: 0, maximum: 1 },
          tvrl_critical_failed:          { type: 'boolean' },
          user_reported_issue:           { type: 'boolean' },
          assistant_flagged_uncertainty: { type: 'boolean' },
        },
      },
      consent: { type: 'boolean', description: 'Whether the client consented to quality review. Omit to use the connector default.' },
      session_id: { type: 'string', description: 'Optional gateway session id this score is for.' },
    },
    required: [ 'components' ],
  },
};

export async function handleQualityScoreSubmit( args ) {
  const payload = normalizeQuality( args );

  if ( ! payload.consent ) {
    return {
      content: [ { type: 'text', text: JSON.stringify( {
        quality_score_submitted: false,
        reason: 'consent_not_granted',
        note:   'Quality review is off for this client. Nothing was sent.',
      }, null, 2 ) } ],
    };
  }

  if ( ! GATEWAY_URL || ! API_KEY ) {
    return {
      content: [ { type: 'text', text: JSON.stringify( {
        quality_score_submitted: false,
        error: 'TS_TENANT_GATEWAY_URL and TS_CLIENT_API_KEY must both be set.',
      }, null, 2 ) } ],
    };
  }

  try {
    const res = await fetch( `${ GATEWAY_URL }/ti-ingest/quality`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify( {
        api_key:    API_KEY,
        components: payload.components,
        signals:    payload.signals,
        consent:    payload.consent,
        session_id: payload.session_id,
      } ),
      signal: AbortSignal.timeout( 10_000 ),
    } );
    const text = await res.text();
    let data; try { data = JSON.parse( text ); } catch { data = { raw: text }; }
    if ( ! res.ok ) throw new Error( `Gateway returned ${ res.status }: ${ data?.error || text }` );

    return {
      content: [ { type: 'text', text: JSON.stringify( {
        quality_score_submitted: data.stored !== false,
        score:         data.score,
        review_status: data.review_status,
        queue_reasons: data.queue_reasons || [],
      }, null, 2 ) } ],
    };
  } catch ( err ) {
    log( 'warn', `[quality_score_submit] failed: ${ err.message }` );
    return {
      content: [ { type: 'text', text: JSON.stringify( {
        quality_score_submitted: false,
        error: err.message,
        note:  'Quality score submission failed. Session continues normally.',
      }, null, 2 ) } ],
    };
  }
}
