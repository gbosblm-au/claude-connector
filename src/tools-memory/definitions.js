// src/tools-memory/definitions.js
// MCP tool descriptors. These are returned from ListToolsRequestSchema and
// drive Claude's tool-call UI. Descriptions are deliberately verbose so
// Claude reliably picks the correct tool from natural language.
//
// v10.0.3 changes:
//   - Added "conversations" to all category enum arrays.
//   - Updated memory_get_session_context definition: inputSchema now accepts
//     context_hint and conversations_limit; description updated accordingly.

export const memoryWriteToolDefinition = {
  name: "memory_write",
  description:
    "Create or update a persistent memory entry that survives across all Claude conversation sessions. " +
    "Uses upsert semantics: if (category, key) already exists, the existing value, tags, ttl, confidence, " +
    "and source_session are fully replaced. Use this tool at session close to record state changes, " +
    "session summaries, project advancement, contact data, or any fact that should be available to " +
    "future Claude sessions. Never store passwords, API keys, or credentials of any kind.",
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["projects", "skills", "preferences", "contacts", "facts", "session", "conversations"],
        description: "Memory bucket. Choose the most specific match.",
      },
      key: {
        type: "string",
        maxLength: 256,
        description: "Logical slot name within the category. Snake_case recommended.",
      },
      value: {
        description:
          "Any JSON-serialisable value: string, number, object, array, or boolean. Max 64KB serialised.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for cross-category grouping.",
      },
      ttl_days: {
        type: "number",
        description: "Days from now until automatic expiry. Omit for permanent.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "0.0 to 1.0. Default 1.0. Use lower values for inferred entries.",
      },
      source_session: {
        type: "string",
        description: "Free-text session label. Recommended: YYYY-MM-DD.",
      },
    },
    required: ["category", "key", "value"],
  },
};

export const memoryReadToolDefinition = {
  name: "memory_read",
  description:
    "Retrieve memory entries by filter. Returns entries ordered by most-recently-updated first. " +
    "At least one of category, key, or tags must be supplied to prevent accidental full-corpus reads. " +
    "Use this when you need precise recall of a known slot. For exploratory recall, use memory_search.",
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["projects", "skills", "preferences", "contacts", "facts", "session", "conversations"],
      },
      key: { type: "string", maxLength: 256 },
      tags: { type: "array", items: { type: "string" } },
      limit: { type: "number", minimum: 1, maximum: 200, default: 50 },
    },
  },
};

export const memorySearchToolDefinition = {
  name: "memory_search",
  description:
    "Full-text search across all memory entries using SQLite FTS5. Searches key, value, and tags fields. " +
    "Results are ranked by BM25 relevance. Supports FTS5 syntax including prefix queries (news*) and " +
    "phrase queries (\"newsletter tag\"). Use this for exploratory recall when you do not know the exact " +
    "category and key.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search terms. FTS5 match syntax supported.",
      },
      category: {
        type: "string",
        enum: ["projects", "skills", "preferences", "contacts", "facts", "session", "conversations"],
      },
      limit: { type: "number", minimum: 1, maximum: 50, default: 10 },
    },
    required: ["query"],
  },
};

export const memoryDeleteToolDefinition = {
  name: "memory_delete",
  description:
    "Permanently delete a memory entry by (category, key). Irreversible in v1.0. " +
    "Returns deleted=false if the entry did not exist (this is not an error).",
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["projects", "skills", "preferences", "contacts", "facts", "session", "conversations"],
      },
      key: { type: "string", maxLength: 256 },
    },
    required: ["category", "key"],
  },
};

export const memoryListToolDefinition = {
  name: "memory_list",
  description:
    "Return a summary of all non-expired memory entries. By default returns metadata only (id, category, " +
    "key, tags, updated_at) and omits the value field for lean responses. Set include_value=true to fetch " +
    "values too. The response includes a by_category count breakdown for at-a-glance corpus health.",
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["projects", "skills", "preferences", "contacts", "facts", "session", "conversations"],
      },
      include_value: { type: "boolean", default: false },
    },
  },
};

export const memoryGetSessionContextToolDefinition = {
  name: "memory_get_session_context",
  description:
    "Session initialisation tool. Returns a curated context bundle: all entries from projects, " +
    "preferences, and facts; the 20 most-recently-updated skills; the 10 most-recently-updated contacts; " +
    "the 5 most-recent session entries; and up to conversations_limit conversation entries (default 5). " +
    "Expired entries are excluded. " +
    "Accepts two optional parameters: " +
    "(1) context_hint - a short phrase describing the current topic or task. When supplied, the handler " +
    "runs an FTS5 relevance search over the conversations category and returns the most topically relevant " +
    "prior conversations instead of the most-recent-N recency sort. Pass this whenever there is an active " +
    "topic so that relevant past work is surfaced automatically. " +
    "(2) conversations_limit - maximum number of conversation entries to include (1-20, default 5). " +
    "Call this at the start of any skill or task that has a memory dependency so prior state is loaded " +
    "before substantive work begins.",
  inputSchema: {
    type: "object",
    properties: {
      context_hint: {
        type: "string",
        maxLength: 512,
        description:
          "Optional short phrase describing the current topic or task. When provided, triggers " +
          "FTS5 relevance ranking for the conversations category instead of recency ordering.",
      },
      conversations_limit: {
        type: "number",
        minimum: 1,
        maximum: 20,
        default: 5,
        description:
          "Maximum number of conversation entries to return (default 5, max 20).",
      },
    },
  },
};

export const ALL_MEMORY_TOOL_DEFINITIONS = [
  memoryWriteToolDefinition,
  memoryReadToolDefinition,
  memorySearchToolDefinition,
  memoryDeleteToolDefinition,
  memoryListToolDefinition,
  memoryGetSessionContextToolDefinition,
];
