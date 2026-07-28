# claude-connector v12.27.0 - Post-session knowledge graph + quality scoring

Two new tenant-mode tools the client Ava calls at session close (after
memory_write), completing the connector side of the differentiator features.
Both are best-effort and never block session close.

## New tools (tenant mode only)

### knowledge_graph_extract  (src/tools/knowledgeGraph.js)

Extracts the people, topics, documents, workflows, and tools that surfaced in the
session, plus the relationships between them, and POSTs them to
{gateway}/ti-ingest/knowledge with the tenant api_key. Populates the client's
Knowledge Graph. Pure normaliser (normalizeExtraction) validates entity types,
dedupes, defaults external_id, keeps only relationships between known entities,
and caps counts.

### quality_score_submit  (src/tools/qualityScore.js)

Submits an honest self-assessed quality score (six components 0..1 plus risk
signals) to {gateway}/ti-ingest/quality. The gateway computes the weighted score
and routes low/risky sessions into the human review queue. Gated on the client's
quality-review consent (explicit arg, or the TS_QUALITY_REVIEW_CONSENT env
default). Pure normaliser (normalizeQuality) clamps components, coerces signals,
and resolves consent.

## Wiring (src/server-http.js)

Both tools are imported, advertised in tenant mode alongside the health-log
tools, and dispatched. Suppressed entirely outside tenant mode.

## Tests

src/tools/post-session.test.js (8): entity/relationship normalisation (dedupe,
type validation, edge resolution, caps), and quality normalisation (component
clamping, signal coercion, consent resolution, session_id passthrough).

## Env

- TS_TENANT_GATEWAY_URL, TS_CLIENT_API_KEY - already used by the health-log tools.
- TS_QUALITY_REVIEW_CONSENT=true - optional default consent for quality scoring.

## Pairs with

Gateway v2.32.0 (/ti-ingest/knowledge and /ti-ingest/quality).
