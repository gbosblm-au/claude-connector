// src/utils/safeFetch.js  v1.0.0
// ---------------------------------------------------------------------------
// SSRF-hardened HTTP client.
//
// Remediates TNX-C-009 (audit TNX-AUDIT-2026-08).
//
// What was wrong
// --------------
// src/tools/webFetch.js validated only the URL scheme:
//
//     const u = new URL(urlStr);
//     return u.protocol === "https:" || u.protocol === "http:";
//
// and then fetched with `redirect: "follow"`. A repository-wide search for
// `169.254`, `isPrivateIp`, `blockPrivate` or any allowlist construct returned
// no SSRF controls in any tool. Fifteen tool modules accept a caller-supplied
// URL.
//
// Combined with TNX-C-001 (no authentication), an unauthenticated caller could
// use the connector as a proxy into the private network:
//
//   http://169.254.169.254/latest/meta-data/iam/security-credentials/
//     -- cloud instance metadata and short-lived IAM credentials
//   http://localhost:3000/memory/admin/dump
//     -- every other connector route, from inside the trust boundary
//   http://10.x.x.x/  -- the Gateway Service and Postgres on the internal
//     network, which are not otherwise internet-reachable
//
// Why validating the URL is not enough
// ------------------------------------
// Three distinct bypasses have to be closed, and each needs a different control.
//
// 1. REDIRECTS. `redirect: "follow"` means a perfectly public URL can 302 to
//    http://169.254.169.254/. Validating only the initial URL is useless. We
//    therefore set redirect to manual and re-validate every single hop.
//
// 2. DNS REBINDING. Resolving a hostname, checking the IP, and then handing the
//    hostname to fetch means the name is resolved a SECOND time at connect
//    time. An attacker controlling the DNS response can return a public IP for
//    the check and 127.0.0.1 for the connect. The window is small but entirely
//    practical with a low TTL.
//
//    We close it by resolving once, validating, and then pinning: the request
//    is issued with a custom `lookup` function that ignores DNS entirely and
//    returns the single address we already approved. `lookup` is a documented
//    option on http.request/https.request, passed through to
//    net.createConnection.
//
//    Note carefully why we pin via `lookup` rather than by rewriting the URL to
//    an IP literal. Rewriting would break TLS: the SNI extension and the
//    certificate hostname check both derive from the URL host. Keeping the
//    hostname in the URL and overriding only the address resolution preserves
//    full certificate validation while removing the attacker's second bite.
//
// 3. ADDRESS ENCODING. Decimal (2130706433), octal (0177.0.0.1), IPv6-mapped
//    IPv4 (::ffff:127.0.0.1) and IPv6 loopback all reach the same places.
//    Classification is done on the resolved binary address, not on the text the
//    caller supplied, so encoding tricks are irrelevant by construction.
//
// What this module does NOT do
// ----------------------------
// Application-level SSRF defence is necessary but it is not what makes the
// system robust. The connector should also be deployed with an egress network
// policy restricting outbound traffic to known provider domains, and the cloud
// metadata endpoint should be disabled at the platform level or require
// IMDSv2. Those are infrastructure changes and are recorded as such in the
// changelog. This module is the part that lives in the code.
// ---------------------------------------------------------------------------

import { request as httpRequest }  from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup }     from 'node:dns';
import { isIP }                    from 'node:net';
import { Readable }                from 'node:stream';

/** Default ceiling on redirect hops. Each hop is independently revalidated. */
const DEFAULT_MAX_REDIRECTS = 5;

/** Default total wall-clock budget for the whole request, redirects included. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Default cap on response body size. Prevents a hostile endpoint exhausting memory. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Error thrown when a request is refused by policy rather than failing in
 * transit. Callers can distinguish "we would not make this request" from
 * "the request failed", which matters for the message shown to the user.
 */
export class SsrfBlockedError extends Error {
  /**
   * @param {string} message Human-readable reason.
   * @param {object} [meta]  Structured detail for logging.
   */
  constructor( message, meta = {} ) {
    super( message );
    this.name    = 'SsrfBlockedError';
    this.code    = 'SSRF_BLOCKED';
    this.blocked = true;
    Object.assign( this, meta );
  }
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/**
 * Parse a dotted-quad IPv4 string into a 32-bit unsigned integer.
 *
 * @param {string} ip Dotted-quad address.
 * @returns {number|null} Unsigned 32-bit value, or null when unparseable.
 */
function ipv4ToInt( ip ) {
  const parts = String( ip ).split( '.' );
  if ( parts.length !== 4 ) return null;
  let value = 0;
  for ( const part of parts ) {
    if ( ! /^\d{1,3}$/.test( part ) ) return null;
    const octet = Number( part );
    if ( octet > 255 ) return null;
    value = ( value * 256 ) + octet;
  }
  return value >>> 0;
}

/**
 * Test whether an IPv4 address is outside the public unicast space.
 *
 * Ranges refused, and why each one matters here:
 *   0.0.0.0/8          this host, and on Linux 0.0.0.0 reaches localhost
 *   10.0.0.0/8         RFC1918 private, where the gateway and Postgres live
 *   100.64.0.0/10      CGNAT, routable inside many cloud provider networks
 *   127.0.0.0/8        loopback, i.e. the connector's own routes
 *   169.254.0.0/16     link-local, which is where cloud instance metadata sits
 *   172.16.0.0/12      RFC1918 private
 *   192.0.0.0/24       IETF protocol assignments
 *   192.0.2.0/24       TEST-NET-1
 *   192.88.99.0/24     deprecated 6to4 relay anycast
 *   192.168.0.0/16     RFC1918 private
 *   198.18.0.0/15      benchmarking
 *   198.51.100.0/24    TEST-NET-2
 *   203.0.113.0/24     TEST-NET-3
 *   224.0.0.0/4        multicast
 *   240.0.0.0/4        reserved, and 255.255.255.255 broadcast within it
 *
 * @param {string} ip Dotted-quad address.
 * @returns {string|null} The reason it is blocked, or null when public.
 */
export function ipv4BlockReason( ip ) {
  const n = ipv4ToInt( ip );
  if ( n === null ) return 'unparseable IPv4 address';

  /**
   * @param {string} base Network base address.
   * @param {number} bits Prefix length.
   * @returns {boolean}
   */
  const inRange = ( base, bits ) => {
    const baseInt = ipv4ToInt( base );
    if ( baseInt === null ) return false;
    // A /0 mask would overflow the shift; no range below uses one.
    const mask = bits === 0 ? 0 : ( ( 0xFFFFFFFF << ( 32 - bits ) ) >>> 0 );
    return ( n & mask ) >>> 0 === ( baseInt & mask ) >>> 0;
  };

  if ( inRange( '0.0.0.0',       8  ) ) return 'unspecified / this-host range 0.0.0.0/8';
  if ( inRange( '10.0.0.0',      8  ) ) return 'private range 10.0.0.0/8';
  if ( inRange( '100.64.0.0',    10 ) ) return 'CGNAT range 100.64.0.0/10';
  if ( inRange( '127.0.0.0',     8  ) ) return 'loopback range 127.0.0.0/8';
  if ( inRange( '169.254.0.0',   16 ) ) return 'link-local range 169.254.0.0/16 (cloud instance metadata)';
  if ( inRange( '172.16.0.0',    12 ) ) return 'private range 172.16.0.0/12';
  if ( inRange( '192.0.0.0',     24 ) ) return 'IETF protocol assignments 192.0.0.0/24';
  if ( inRange( '192.0.2.0',     24 ) ) return 'documentation range TEST-NET-1';
  if ( inRange( '192.88.99.0',   24 ) ) return 'deprecated 6to4 relay anycast';
  if ( inRange( '192.168.0.0',   16 ) ) return 'private range 192.168.0.0/16';
  if ( inRange( '198.18.0.0',    15 ) ) return 'benchmarking range 198.18.0.0/15';
  if ( inRange( '198.51.100.0',  24 ) ) return 'documentation range TEST-NET-2';
  if ( inRange( '203.0.113.0',   24 ) ) return 'documentation range TEST-NET-3';
  if ( inRange( '224.0.0.0',     4  ) ) return 'multicast range 224.0.0.0/4';
  if ( inRange( '240.0.0.0',     4  ) ) return 'reserved range 240.0.0.0/4';

  return null;
}

/**
 * Expand an IPv6 address to its sixteen bytes.
 *
 * @param {string} ip IPv6 address, possibly compressed or IPv4-mapped.
 * @returns {number[]|null} Sixteen byte values, or null when unparseable.
 */
function ipv6ToBytes( ip ) {
  let text = String( ip ).trim().toLowerCase();

  // Strip a zone index (fe80::1%eth0). The zone never affects classification.
  const zone = text.indexOf( '%' );
  if ( zone !== -1 ) text = text.slice( 0, zone );

  // An embedded IPv4 tail, as in ::ffff:127.0.0.1, is converted to two groups.
  const v4Match = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec( text );
  if ( v4Match ) {
    const v4 = ipv4ToInt( v4Match[ 2 ] );
    if ( v4 === null ) return null;
    const hi = ( ( v4 >>> 16 ) & 0xFFFF ).toString( 16 );
    const lo = ( v4 & 0xFFFF ).toString( 16 );
    text = `${ v4Match[ 1 ] }${ hi }:${ lo }`;
  }

  const halves = text.split( '::' );
  if ( halves.length > 2 ) return null;

  /**
   * @param {string} part Colon-separated hextet list.
   * @returns {number[]|null}
   */
  const toGroups = ( part ) => {
    if ( part === '' ) return [];
    const out = [];
    for ( const h of part.split( ':' ) ) {
      if ( ! /^[0-9a-f]{1,4}$/.test( h ) ) return null;
      out.push( parseInt( h, 16 ) );
    }
    return out;
  };

  const head = toGroups( halves[ 0 ] );
  const tail = halves.length === 2 ? toGroups( halves[ 1 ] ) : [];
  if ( head === null || tail === null ) return null;

  let groups;
  if ( halves.length === 2 ) {
    const fill = 8 - head.length - tail.length;
    if ( fill < 0 ) return null;
    groups = [ ...head, ...new Array( fill ).fill( 0 ), ...tail ];
  } else {
    groups = head;
  }

  if ( groups.length !== 8 ) return null;

  const bytes = [];
  for ( const g of groups ) {
    bytes.push( ( g >> 8 ) & 0xFF, g & 0xFF );
  }
  return bytes;
}

/**
 * Test whether an IPv6 address is outside the public unicast space.
 *
 * IPv4-mapped and IPv4-compatible addresses are unwrapped and delegated to the
 * IPv4 classifier, because ::ffff:169.254.169.254 reaches exactly the same
 * metadata service as 169.254.169.254 does.
 *
 * @param {string} ip IPv6 address.
 * @returns {string|null} The reason it is blocked, or null when public.
 */
export function ipv6BlockReason( ip ) {
  const b = ipv6ToBytes( ip );
  if ( b === null ) return 'unparseable IPv6 address';

  const allZeroTo = ( n ) => b.slice( 0, n ).every( ( x ) => x === 0 );

  // ::ffff:a.b.c.d  -- IPv4-mapped. Classify as the IPv4 address it carries.
  if ( allZeroTo( 10 ) && b[ 10 ] === 0xFF && b[ 11 ] === 0xFF ) {
    const v4 = `${ b[ 12 ] }.${ b[ 13 ] }.${ b[ 14 ] }.${ b[ 15 ] }`;
    const reason = ipv4BlockReason( v4 );
    return reason ? `IPv4-mapped ${ v4 }: ${ reason }` : null;
  }

  // ::  unspecified, and ::1 loopback.
  if ( allZeroTo( 15 ) ) {
    return b[ 15 ] === 1 ? 'IPv6 loopback ::1' : 'IPv6 unspecified ::';
  }

  // ::a.b.c.d  -- deprecated IPv4-compatible form.
  if ( allZeroTo( 12 ) ) {
    const v4 = `${ b[ 12 ] }.${ b[ 13 ] }.${ b[ 14 ] }.${ b[ 15 ] }`;
    const reason = ipv4BlockReason( v4 );
    return reason ? `IPv4-compatible ${ v4 }: ${ reason }` : null;
  }

  if ( ( b[ 0 ] & 0xFE ) === 0xFC )                        return 'unique local address fc00::/7';
  if ( b[ 0 ] === 0xFE && ( b[ 1 ] & 0xC0 ) === 0x80 )     return 'link-local fe80::/10';
  if ( b[ 0 ] === 0xFF )                                   return 'multicast ff00::/8';
  if ( b[ 0 ] === 0x01 && allZeroTo( 8 ) === false && b.slice( 1, 8 ).every( ( x ) => x === 0 ) ) {
    return 'discard-only 100::/64';
  }
  if ( b[ 0 ] === 0x20 && b[ 1 ] === 0x01 && b[ 2 ] === 0x00 && ( b[ 3 ] & 0xF0 ) === 0x00 ) {
    return 'IETF protocol assignment 2001:0::/24';
  }
  if ( b[ 0 ] === 0x20 && b[ 1 ] === 0x01 && b[ 2 ] === 0x0D && b[ 3 ] === 0xB8 ) {
    return 'documentation range 2001:db8::/32';
  }

  return null;
}

/**
 * Classify any IP literal.
 *
 * @param {string} ip IPv4 or IPv6 address.
 * @returns {string|null} The reason it is blocked, or null when public.
 */
export function ipBlockReason( ip ) {
  const family = isIP( ip );
  if ( family === 4 ) return ipv4BlockReason( ip );
  if ( family === 6 ) return ipv6BlockReason( ip );
  return 'not a valid IP address';
}

// ---------------------------------------------------------------------------
// URL and host validation
// ---------------------------------------------------------------------------

/**
 * Resolve a hostname and confirm that EVERY returned address is public.
 *
 * All addresses are checked, not just the one we intend to use. A hostname
 * resolving to both a public and a private address is a classic split-horizon
 * SSRF trick, and accepting it because the first record happened to be public
 * would leave the door open on retry.
 *
 * @param {string} hostname Host portion of the URL.
 * @returns {Promise<{ address: string, family: number }>} The pinned address.
 * @throws {SsrfBlockedError} When any resolved address is non-public.
 */
export async function resolveAndValidateHost( rawHostname ) {
  // WHATWG URL keeps the square brackets on an IPv6 host, so `new
  // URL('http://[::1]/').hostname` is the string "[::1]" and NOT a valid IP
  // literal. Without stripping them, isIP() returns 0, the address falls
  // through to a DNS lookup, and the request is refused only because
  // getaddrinfo fails on a bracketed name.
  //
  // That happens to block it today, but by accident rather than by policy: the
  // caller gets an opaque ENOTFOUND instead of a refusal, and any change to
  // resolution behaviour could turn the accident into a bypass. Strip the
  // brackets so IPv6 literals are classified deliberately.
  const hostname = /^\[.*\]$/.test( String( rawHostname ) )
    ? String( rawHostname ).slice( 1, -1 )
    : String( rawHostname );

  // An IP literal needs no resolution, only classification.
  if ( isIP( hostname ) ) {
    const reason = ipBlockReason( hostname );
    if ( reason ) {
      throw new SsrfBlockedError(
        `Refusing to connect to ${ hostname }: ${ reason }.`,
        { hostname, address: hostname }
      );
    }
    return { address: hostname, family: isIP( hostname ) };
  }

  /** @type {Array<{ address: string, family: number }>} */
  const addresses = await new Promise( ( resolve, reject ) => {
    dnsLookup( hostname, { all: true, verbatim: true }, ( err, result ) => {
      if ( err ) reject( err );
      else resolve( Array.isArray( result ) ? result : [] );
    } );
  } );

  if ( addresses.length === 0 ) {
    throw new SsrfBlockedError( `Hostname ${ hostname } did not resolve to any address.`, { hostname } );
  }

  for ( const entry of addresses ) {
    const reason = ipBlockReason( entry.address );
    if ( reason ) {
      throw new SsrfBlockedError(
        `Refusing to connect to ${ hostname }: it resolves to ${ entry.address }, which is ${ reason }.`,
        { hostname, address: entry.address }
      );
    }
  }

  return addresses[ 0 ];
}

/**
 * Validate a URL string for scheme, port and credentials.
 *
 * @param {string} urlStr Candidate URL.
 * @returns {URL} The parsed URL.
 * @throws {SsrfBlockedError} When the URL is refused by policy.
 */
export function validateUrl( urlStr ) {
  /** @type {URL} */
  let u;
  try {
    u = new URL( String( urlStr ) );
  } catch {
    throw new SsrfBlockedError( `Not a valid absolute URL: ${ String( urlStr ).slice( 0, 200 ) }` );
  }

  if ( u.protocol !== 'http:' && u.protocol !== 'https:' ) {
    // file:, gopher:, ftp:, data: and dict: have all been used to turn an
    // SSRF into a local file read or a protocol-confusion attack.
    throw new SsrfBlockedError( `Scheme ${ u.protocol } is not permitted. Only http and https.`, { url: u.href } );
  }

  // Credentials in the URL are stripped rather than forwarded. `http://
  // attacker@internal-host/` is a well-known way to confuse naive host parsing,
  // and no legitimate tool call needs them.
  if ( u.username || u.password ) {
    throw new SsrfBlockedError( 'URLs containing credentials are not permitted.', { url: `${ u.protocol }//${ u.hostname }${ u.pathname }` } );
  }

  const port = u.port ? Number( u.port ) : ( u.protocol === 'https:' ? 443 : 80 );
  if ( ! Number.isInteger( port ) || port < 1 || port > 65535 ) {
    throw new SsrfBlockedError( `Invalid port ${ u.port }.`, { url: u.href } );
  }

  const allowedPorts = String( process.env.SAFE_FETCH_ALLOWED_PORTS || '80,443,8080,8443' )
    .split( ',' ).map( ( p ) => Number( p.trim() ) ).filter( Number.isInteger );

  if ( ! allowedPorts.includes( port ) ) {
    throw new SsrfBlockedError(
      `Port ${ port } is not permitted. Allowed: ${ allowedPorts.join( ', ' ) }.`,
      { url: u.href, port }
    );
  }

  return u;
}

// ---------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------

/**
 * Perform one HTTP request with a pinned address, without following redirects.
 *
 * @param {URL}    url        Validated URL.
 * @param {string} address    Pre-validated IP to connect to.
 * @param {object} opts
 * @param {string} opts.method
 * @param {Record<string,string>} opts.headers
 * @param {string|Buffer|null}    opts.body
 * @param {number} opts.timeoutMs Remaining wall-clock budget.
 * @param {number} opts.maxBytes
 * @param {AbortSignal|null} opts.signal
 * @returns {Promise<{ status: number, headers: Record<string,string|string[]>, body: Buffer, truncated: boolean }>}
 */
function requestOnce( url, address, opts ) {
  const { method, headers, body, timeoutMs, maxBytes, signal } = opts;
  const isHttps = url.protocol === 'https:';
  const doRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise( ( resolve, reject ) => {
    /**
     * Pinned resolver. Node calls this instead of dns.lookup at connect time.
     * It ignores the hostname entirely and returns the address we validated,
     * which is what removes the DNS-rebinding window.
     *
     * @param {string}   _hostname Ignored by design.
     * @param {object}   options   Node's lookup options.
     * @param {Function} callback  Node's lookup callback.
     */
    const pinnedLookup = ( _hostname, options, callback ) => {
      const cb     = typeof options === 'function' ? options : callback;
      const family = isIP( address );
      if ( options && options.all ) {
        cb( null, [ { address, family } ] );
      } else {
        cb( null, address, family );
      }
    };

    const req = doRequest( {
      protocol: url.protocol,
      // hostname stays as the real name so TLS SNI and the certificate
      // hostname check both operate on it. Only address resolution is pinned.
      hostname: url.hostname,
      port:     url.port || ( isHttps ? 443 : 80 ),
      path:     `${ url.pathname }${ url.search }`,
      method,
      headers:  { ...headers, host: url.host },
      lookup:   pinnedLookup,
      timeout:  timeoutMs,
      // Explicit: never disable certificate verification.
      rejectUnauthorized: true,
    }, ( res ) => {
      /** @type {Buffer[]} */
      const chunks = [];
      let received  = 0;
      let truncated = false;

      res.on( 'data', ( chunk ) => {
        received += chunk.length;
        if ( received > maxBytes ) {
          // Stop reading rather than buffering an unbounded response. The
          // partial body is still returned so a caller gets something useful.
          truncated = true;
          res.destroy();
          return;
        }
        chunks.push( chunk );
      } );

      res.on( 'end', () => {
        resolve( {
          status:    res.statusCode || 0,
          headers:   res.headers,
          body:      Buffer.concat( chunks ),
          truncated,
        } );
      } );

      res.on( 'close', () => {
        // Reached when we destroyed the stream on the size cap. 'end' does not
        // fire in that case, so resolve here instead of hanging forever.
        if ( truncated ) {
          resolve( {
            status:  res.statusCode || 0,
            headers: res.headers,
            body:    Buffer.concat( chunks ),
            truncated: true,
          } );
        }
      } );

      res.on( 'error', reject );
    } );

    req.on( 'timeout', () => {
      req.destroy( new Error( `Request to ${ url.hostname } timed out after ${ timeoutMs }ms` ) );
    } );

    req.on( 'error', reject );

    if ( signal ) {
      if ( signal.aborted ) {
        req.destroy( new Error( 'Request aborted' ) );
      } else {
        signal.addEventListener( 'abort', () => req.destroy( new Error( 'Request aborted' ) ), { once: true } );
      }
    }

    if ( body ) req.write( body );
    req.end();
  } );
}

/**
 * SSRF-safe replacement for `fetch`.
 *
 * Returns a Response-like object exposing the subset of the fetch API the
 * connector's tools actually use, so migration is a one-line import change at
 * each call site rather than a rewrite.
 *
 * @param {string} urlStr Absolute http(s) URL.
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {Record<string,string>} [options.headers={}]
 * @param {string|Buffer|null}    [options.body=null]
 * @param {number} [options.timeoutMs]      Total budget across all hops.
 * @param {number} [options.maxBytes]       Response body cap.
 * @param {number} [options.maxRedirects]   Hop cap.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{
 *   ok: boolean, status: number, statusText: string, url: string,
 *   redirected: boolean, truncated: boolean,
 *   headers: { get(name: string): string|null },
 *   text(): Promise<string>, json(): Promise<any>,
 *   arrayBuffer(): Promise<ArrayBuffer>, buffer(): Buffer,
 *   body: import('node:stream').Readable
 * }>}
 * @throws {SsrfBlockedError} When the request is refused by policy.
 */
export async function safeFetch( urlStr, options = {} ) {
  const {
    method       = 'GET',
    headers      = {},
    body         = null,
    timeoutMs    = DEFAULT_TIMEOUT_MS,
    maxBytes     = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    signal       = null,
  } = options;

  const deadline = Date.now() + timeoutMs;

  let current    = validateUrl( urlStr );
  let hops       = 0;
  let redirected = false;
  let currentMethod = String( method ).toUpperCase();
  let currentBody   = body;

  // Header names are normalised to lower case once so the redirect logic below
  // can strip Authorization reliably regardless of how the caller spelled it.
  /** @type {Record<string,string>} */
  let currentHeaders = {};
  for ( const [ k, v ] of Object.entries( headers || {} ) ) {
    currentHeaders[ String( k ).toLowerCase() ] = String( v );
  }

  // eslint-disable-next-line no-constant-condition
  while ( true ) {
    const remaining = deadline - Date.now();
    if ( remaining <= 0 ) {
      throw new Error( `safeFetch exceeded its ${ timeoutMs }ms total time budget.` );
    }

    // Every hop is validated from scratch. This is the control that makes a
    // public URL redirecting to http://10.0.0.1/ fail at the redirect rather
    // than succeed.
    const pinned = await resolveAndValidateHost( current.hostname );

    const result = await requestOnce( current, pinned.address, {
      method:    currentMethod,
      headers:   currentHeaders,
      body:      currentBody,
      timeoutMs: remaining,
      maxBytes,
      signal,
    } );

    const isRedirect = [ 301, 302, 303, 307, 308 ].includes( result.status );
    const location   = result.headers.location;

    if ( isRedirect && location ) {
      hops += 1;
      if ( hops > maxRedirects ) {
        throw new SsrfBlockedError(
          `Exceeded the redirect limit of ${ maxRedirects } hops.`,
          { url: current.href }
        );
      }

      const next = validateUrl( new URL( location, current ).toString() );

      // Credentials must not survive a cross-origin redirect. Without this, an
      // attacker-controlled endpoint could redirect to a host of their choosing
      // and receive the caller's Authorization header.
      if ( next.origin !== current.origin ) {
        delete currentHeaders.authorization;
        delete currentHeaders.cookie;
      }

      // 301, 302 and 303 are rewritten to GET by every real client; 307 and 308
      // preserve the method and body.
      if ( [ 301, 302, 303 ].includes( result.status ) && currentMethod !== 'HEAD' ) {
        currentMethod = 'GET';
        currentBody   = null;
        delete currentHeaders[ 'content-type' ];
        delete currentHeaders[ 'content-length' ];
      }

      current    = next;
      redirected = true;
      continue;
    }

    const buf = result.body;

    return {
      ok:         result.status >= 200 && result.status < 300,
      status:     result.status,
      statusText: '',
      url:        current.href,
      redirected,
      truncated:  result.truncated,
      headers: {
        /**
         * @param {string} name Header name, case-insensitive.
         * @returns {string|null}
         */
        get( name ) {
          const v = result.headers[ String( name ).toLowerCase() ];
          if ( v === undefined ) return null;
          return Array.isArray( v ) ? v.join( ', ' ) : String( v );
        },
        raw: () => result.headers,
      },
      async text()        { return buf.toString( 'utf8' ); },
      async json()        { return JSON.parse( buf.toString( 'utf8' ) ); },
      async arrayBuffer() { return buf.buffer.slice( buf.byteOffset, buf.byteOffset + buf.byteLength ); },
      buffer:             () => buf,
      get body()          { return Readable.from( buf ); },
    };
  }
}

export default safeFetch;
