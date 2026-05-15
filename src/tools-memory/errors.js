// src/utils/errors.js
// Structured tool error class. Mirrors TDD Section 7.5 (Error Response Format).

export class ToolError extends Error {
  constructor(code, message, httpStatus = 400, details = null) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }

  toJSON() {
    const body = { error: this.message, code: this.code };
    if (this.details) body.details = this.details;
    return body;
  }
}

/**
 * Format a thrown error as the standard MCP tool response. Recognises
 * ToolError instances and falls back to INTERNAL_ERROR for everything else.
 */
export function formatToolError(err) {
  if (err instanceof ToolError) {
    return {
      content: [{ type: "text", text: JSON.stringify(err.toJSON(), null, 2) }],
      isError: true,
    };
  }
  const body = {
    error: err?.message || "Internal server error.",
    code: "INTERNAL_ERROR",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

/**
 * Wrap a successful tool payload in the MCP content envelope.
 */
export function asToolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}
