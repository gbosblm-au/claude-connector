// src/tools/knowledgeGraph.js  (post-session entity extraction -> knowledge graph)
//
// TENANT MODE ONLY. One tool, called by the client Ava at session close:
//
//   knowledge_graph_extract
//     Extracts the entities (people, topics, documents, workflows, tools) and
//     the relationships between them that surfaced during the session, and POSTs
//     them to {gateway}/ti-ingest/knowledge with the tenant api_key. The gateway
//     upserts them into the tenant knowledge graph (nodes + edges), which the
//     plugin's Knowledge Graph view renders.
//
//   Call this as part of the session-close sequence, after memory_write. It is
//   additive and best-effort: a failure never blocks session close.
//
// Suppressed (not advertised) unless TS_CLIENT_MODE == 'tenant' with
// TS_TENANT_GATEWAY_URL / TS_CLIENT_API_KEY configured (enforced in server-http.js).

import { log } from '../utils/logger.js';

const GATEWAY_URL = ( process.env.TS_TENANT_GATEWAY_URL || '' ).replace( /\/$/, '' );
const API_KEY     = process.env.TS_CLIENT_API_KEY || '';

const NODE_TYPES = new Set( [ 'conversation', 'document', 'workflow', 'person', 'topic', 'tool' ] );
const MAX_ENTITIES      = 60;
const MAX_RELATIONSHIPS = 120;

// ---------------------------------------------------------------------------
// Pure normaliser (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Validate and clamp an extraction payload before sending it to the gateway.
 * Drops invalid entities, dedupes, defaults external_id, and keeps only
 * relationships whose endpoints reference a kept entity (by external_id or label).
 * @returns {{ entities: object[], relationships: object[] }}
 */
export function normalizeExtraction( args ) {
  const rawEntities = Array.isArray( args?.entities ) ? args.entities : [];
  const seen = new Set();
  const refs = new Set();
  const entities = [];

  for ( const e of rawEntities ) {
    if ( entities.length >= MAX_ENTITIES ) break;
    if ( ! e || typeof e !== 'object' ) continue;
    const type = String( e.type || '' ).toLowerCase().trim();
    if ( ! NODE_TYPES.has( type ) ) continue;
    const label = String( e.label || '' ).trim().slice( 0, 300 );
    if ( ! label ) continue;
    const external_id = String( e.external_id || `${ type }:${ label.toLowerCase() }` ).trim().slice( 0, 300 );
    const key = `${ type }|${ external_id }`;
    if ( seen.has( key ) ) continue;
    seen.add( key );
    refs.add( external_id );
    refs.add( label.toLowerCase() );
    entities.push( {
      type,
      label,
      external_id,
      description: String( e.description || '' ).slice( 0, 1000 ),
      weight: ( typeof e.weight === 'number' && e.weight > 0 ) ? Math.min( 100, e.weight ) : 1,
    } );
  }

  const rawRels = Array.isArray( args?.relationships ) ? args.relationships : [];
  const relationships = [];
  for ( const r of rawRels ) {
    if ( relationships.length >= MAX_RELATIONSHIPS ) break;
    if ( ! r || typeof r !== 'object' ) continue;
    const source = String( r.source || '' ).trim();
    const target = String( r.target || '' ).trim();
    if ( ! source || ! target || source === target ) continue;
    const sOk = refs.has( source ) || refs.has( source.toLowerCase() );
    const tOk = refs.has( target ) || refs.has( target.toLowerCase() );
    if ( ! sOk || ! tOk ) continue;
    relationships.push( {
      source,
      target,
      type: String( r.type || 'related_to' ).toLowerCase().trim().slice( 0, 24 ) || 'related_to',
    } );
  }

  return { entities, relationships };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const knowledgeGraphExtractToolDefinition = {
  name: 'knowledge_graph_extract',
  description:
    'Extract the key entities and relationships from this session into the knowledge graph. ' +
    'Call as part of the session-close sequence, after memory_write. Identify the people, ' +
    'topics, documents, workflows, and tools that mattered this session, and how they connect. ' +
    'This populates the client\'s Knowledge Graph view. Best-effort: never blocks session close. ' +
    'Only available in tenant-mode connectors.',
  inputSchema: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        description: 'The entities that surfaced this session.',
        items: {
          type: 'object',
          properties: {
            type:        { type: 'string', enum: [ 'conversation', 'document', 'workflow', 'person', 'topic', 'tool' ] },
            label:       { type: 'string', maxLength: 300, description: 'Human-readable name, e.g. a person\'s name or a topic.' },
            external_id: { type: 'string', maxLength: 300, description: 'Optional stable id (e.g. a document id). Defaults to type:label.' },
            description: { type: 'string', maxLength: 1000, description: 'Optional one-line description.' },
          },
          required: [ 'type', 'label' ],
        },
        default: [],
      },
      relationships: {
        type: 'array',
        description: 'Connections between entities, referencing their external_id or label.',
        items: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'external_id or label of the source entity.' },
            target: { type: 'string', description: 'external_id or label of the target entity.' },
            type:   { type: 'string', maxLength: 24, description: 'Relationship type, e.g. discussed_with, generated_in, references.' },
          },
          required: [ 'source', 'target' ],
        },
        default: [],
      },
    },
    required: [ 'entities' ],
  },
};

export async function handleKnowledgeGraphExtract( args ) {
  const { entities, relationships } = normalizeExtraction( args );

  if ( ! entities.length ) {
    return {
      content: [ { type: 'text', text: JSON.stringify( { knowledge_graph_updated: false, note: 'No valid entities to record.' }, null, 2 ) } ],
    };
  }

  if ( ! GATEWAY_URL || ! API_KEY ) {
    return {
      content: [ { type: 'text', text: JSON.stringify( {
        knowledge_graph_updated: false,
        error: 'TS_TENANT_GATEWAY_URL and TS_CLIENT_API_KEY must both be set.',
      }, null, 2 ) } ],
    };
  }

  try {
    const res = await fetch( `${ GATEWAY_URL }/ti-ingest/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify( { api_key: API_KEY, entities, relationships } ),
      signal: AbortSignal.timeout( 10_000 ),
    } );
    const text = await res.text();
    let data; try { data = JSON.parse( text ); } catch { data = { raw: text }; }
    if ( ! res.ok ) throw new Error( `Gateway returned ${ res.status }: ${ data?.error || text }` );

    return {
      content: [ { type: 'text', text: JSON.stringify( {
        knowledge_graph_updated: true,
        nodes: data.nodes,
        edges: data.edges,
      }, null, 2 ) } ],
    };
  } catch ( err ) {
    log( 'warn', `[knowledge_graph_extract] failed: ${ err.message }` );
    return {
      content: [ { type: 'text', text: JSON.stringify( {
        knowledge_graph_updated: false,
        error: err.message,
        note:  'Knowledge graph update failed. Session continues normally.',
      }, null, 2 ) } ],
    };
  }
}
