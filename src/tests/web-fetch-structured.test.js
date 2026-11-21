// src/tests/web-fetch-structured.test.js   (connector v13.37.0, TENAX-2026-11-10-02)
//
// web_fetch_page: structured data (R2) and a non-2xx reply returned as data (K).
//
// Every test drives the real handler, handleWebFetchPage, with a fake fetch in
// place of safeFetch (which refuses every non-public address, so a local server
// cannot be reached through it). Nothing leaves the process: the gateway
// forwarder is unconfigured here and returns before any request.
//
// The mutations that redden these tests are in
// scripts/verify-tenax-2026-11-10-02-mutations.mjs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  handleWebFetchPage, webFetchPageToolDefinition, blockedHint, STRUCTURED_MAX_BLOCKS,
} from "../tools/webFetch.js";

/** A Response-shaped reply, as safeFetch returns one. */
function reply(body, { status = 200, headers = {}, url = "https://shop.test/p/1" } = {}) {
  const h = { "content-type": "text/html; charset=utf-8", ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    truncated: false,
    headers: { get: (k) => h[String(k).toLowerCase()] ?? null },
    text: async () => body,
  };
}

const call = async (args, resp) => {
  const out = await handleWebFetchPage(args, { fetchImpl: async () => resp });
  return JSON.parse(out.content[0].text);
};

const PRODUCT = {
  "@context": "https://schema.org", "@type": "Product", name: "Acme Blender X500",
  gtin13: "0036000291452", mpn: "X500-B", brand: { "@type": "Brand", name: "Acme" },
  offers: { "@type": "Offer", price: "129.00", priceCurrency: "AUD" },
};

const PAGE = `<!doctype html><html><head><title>Acme Blender X500</title>
<script type="application/ld+json">${JSON.stringify(PRODUCT)}</script>
<script type="application/ld+json">{ this is not json }</script>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "BreadcrumbList" }] })}</script>
<script>window.dataLayer = [{ price: 1 }];</script>
</head><body><h1>Acme Blender X500</h1><p>Now $129.00 delivered.</p></body></html>`;

describe("R2: structured_data", () => {
  test("C-SD-01: each ld+json block that parses is returned as { @type, data }, as written", async () => {
    const r = await call({ url: "https://shop.test/p/1", include_structured_data: true }, reply(PAGE));
    assert.equal(r.structured_data.length, 2);
    assert.equal(r.structured_data[0]["@type"], "Product");
    assert.deepEqual(r.structured_data[0].data, PRODUCT);
    assert.equal(r.structured_data[1]["@type"], "@graph");
  });

  test("C-SD-02: a block that does not parse is counted, never guessed at", async () => {
    const r = await call({ url: "https://shop.test/p/1", include_structured_data: true }, reply(PAGE));
    assert.equal(r.structured_data_invalid, 1);
    assert.equal(r.structured_data_dropped, 0);
  });

  test("C-SD-03: the page text is unchanged, and carries no script content", async () => {
    const withSd = await call({ url: "https://shop.test/p/1", include_structured_data: true }, reply(PAGE));
    const without = await call({ url: "https://shop.test/p/1" }, reply(PAGE));
    assert.equal(withSd.text, without.text);
    assert.match(withSd.text, /Now \$129\.00 delivered/);
    assert.doesNotMatch(withSd.text, /gtin13|dataLayer/);
  });

  test("C-SD-04: it is returned only when asked for", async () => {
    const r = await call({ url: "https://shop.test/p/1" }, reply(PAGE));
    assert.equal("structured_data" in r, false);
    assert.equal("structured_data_invalid" in r, false);
  });

  test("C-SD-05: a page with none returns an empty list, which is an assertion and not an absence", async () => {
    const r = await call({ url: "https://shop.test/p/1", include_structured_data: true },
      reply("<html><head><title>t</title></head><body><p>No data here at all.</p></body></html>"));
    assert.deepEqual(r.structured_data, []);
    assert.equal(r.structured_data_invalid, 0);
  });

  test("C-SD-06: the list is bounded and what the bound left out is counted", async () => {
    const many = Array.from({ length: STRUCTURED_MAX_BLOCKS + 3 }, (_, i) =>
      `<script type="application/ld+json">${JSON.stringify({ "@type": "Thing", name: `n${i}` })}</script>`).join("");
    const r = await call({ url: "https://shop.test/p/1", include_structured_data: true },
      reply(`<html><head>${many}</head><body><p>x</p></body></html>`));
    assert.equal(r.structured_data.length, STRUCTURED_MAX_BLOCKS);
    assert.equal(r.structured_data_dropped, 3);
  });

  test("C-SD-07: the tool publishes both new inputs", () => {
    const props = webFetchPageToolDefinition.inputSchema.properties;
    assert.equal(props.include_structured_data.type, "boolean");
    assert.deepEqual(props.on_http_error.enum, ["throw", "return"]);
    assert.deepEqual(webFetchPageToolDefinition.inputSchema.required, ["url"]);
  });
});

describe("K: a non-2xx reply", () => {
  test("C-K-01: by default it still throws, with the status, exactly as before", async () => {
    await assert.rejects(
      () => handleWebFetchPage({ url: "https://shop.test/p/1" }, { fetchImpl: async () => reply("Forbidden", { status: 403 }) }),
      /^Error: HTTP 403 from https:\/\/shop\.test\/p\/1\. Content-Type: text\/html; charset=utf-8$/);
  });

  test("C-K-02: asked to return it, a 403 is data: status, upstream_ok false, the outcome, the excerpt, blocked", async () => {
    const r = await call({ url: "https://shop.test/p/1", on_http_error: "return" },
      // A neutral body, so it is the status alone that makes this a block.
      reply("<html><body><h1>Forbidden</h1><p>Reference 18.2f</p></body></html>", { status: 403 }));
    assert.equal(r.status_code, 403);
    assert.equal(r.upstream_ok, false);
    assert.equal(r.fetch_outcome, "upstream_non_2xx");
    assert.equal(r.blocked_hint, true);
    assert.equal(r.body_excerpt, "Forbidden Reference 18.2f");
    assert.equal(r.text, "");
  });

  test("C-K-03: a 404 is data and is not a block; a 429 and a 503 are told apart by their status", async () => {
    for (const status of [404, 429, 503]) {
      const r = await call({ url: "https://shop.test/p/1", on_http_error: "return" }, reply("Not here", { status }));
      assert.equal(r.status_code, status);
      assert.equal(r.blocked_hint, false, `status ${status}`);
      assert.equal(r.fetch_outcome, "upstream_non_2xx");
    }
  });

  test("C-K-04: a challenge behind another status is a block (header, or the body's own words)", async () => {
    const byHeader = await call({ url: "https://shop.test/p/1", on_http_error: "return" },
      reply("x", { status: 503, headers: { "cf-mitigated": "challenge" } }));
    assert.equal(byHeader.blocked_hint, true);
    const byBody = await call({ url: "https://shop.test/p/1", on_http_error: "return" },
      reply("<p>Just a moment... verify you are human</p>", { status: 503 }));
    assert.equal(byBody.blocked_hint, true);
    assert.equal(blockedHint(200, { get: () => null }, "captcha"), false, "a 2xx page that mentions a captcha is not a refusal");
  });

  test("C-K-05: no reply at all still throws, and names which kind", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    await assert.rejects(
      () => handleWebFetchPage({ url: "https://shop.test/p/1", on_http_error: "return" }, { fetchImpl: async () => { throw abort; } }),
      /timed out after \d+ms\. \(fetch_outcome: timeout\)/);
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    await assert.rejects(
      () => handleWebFetchPage({ url: "https://shop.test/p/1", on_http_error: "return" }, { fetchImpl: async () => { throw reset; } }),
      /Failed to fetch .*socket hang up \(fetch_outcome: transport_error ECONNRESET\)/);
  });

  test("C-K-06: a 2xx reply says so", async () => {
    const r = await call({ url: "https://shop.test/p/1" }, reply(PAGE));
    assert.equal(r.status_code, 200);
    assert.equal(r.upstream_ok, true);
    assert.equal(r.fetch_outcome, "ok");
  });
});
