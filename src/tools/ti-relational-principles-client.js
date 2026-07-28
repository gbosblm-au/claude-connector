// src/tools/ti-relational-principles-client.js
// fetches relational principles from the gateway for system prompt assembly
// called during session init, at position 2 (after TVRL, before skill content)

const GATEWAY_URL = (process.env.GATEWAY_URL || process.env.TS_TENANT_GATEWAY_URL || '').replace(/\/$/, '');

export async function fetchRelationalPrinciples(tenantId, userId) {
  if (!tenantId || !userId) {
    console.warn('[ti-relational-principles] no tenantId/userId — skipping');
    return null;
  }
  if (!GATEWAY_URL) {
    console.warn('[ti-relational-principles] GATEWAY_URL not set — skipping');
    return null;
  }

  try {
    const url = `${GATEWAY_URL}/ti-relational-principles/${encodeURIComponent(tenantId)}/${encodeURIComponent(userId)}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 204) return null;          // no principles configured
    if (!res.ok) {
      console.error(`[ti-relational-principles] gateway returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    console.error('[ti-relational-principles] fetch failed:', err.message);
    return null;
  }
}