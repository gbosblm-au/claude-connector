// src/tests/helpers/mockRes.js  v1.0.0
// ---------------------------------------------------------------------------
// Minimal Express response double.
//
// Cross-process loopback is unavailable in some CI sandboxes, so the internal
// config handler is exercised directly rather than over HTTP. The handler only
// uses status(), json() and setHeader(), so a full HTTP stack would add moving
// parts without adding coverage of anything this test is about.
// ---------------------------------------------------------------------------

/**
 * Create a response double.
 *
 * @returns {{ statusCode: number, body: any, headers: Record<string,string>,
 *             status: Function, json: Function, setHeader: Function }}
 */
export function makeRes() {
  const res = {
    statusCode: 200,
    body:       undefined,
    headers:    {},

    /**
     * @param {number} code
     * @returns {object} this, for chaining
     */
    status( code ) {
      this.statusCode = code;
      return this;
    },

    /**
     * @param {any} payload
     * @returns {object} this
     */
    json( payload ) {
      this.body = payload;
      return this;
    },

    /**
     * @param {string} name
     * @param {string} value
     * @returns {void}
     */
    setHeader( name, value ) {
      this.headers[ name ] = value;
    },
  };

  return res;
}

export default { makeRes };
