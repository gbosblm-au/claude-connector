import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  webSearchToolDefinition,
  handleWebSearch,
} from "./tools/webSearch.js";

import {
  newsSearchToolDefinition,
  handleNewsSearch,
} from "./tools/newsSearch.js";

import {
  linkedinLoadToolDefinition,
  linkedinSearchToolDefinition,
  linkedinCountToolDefinition,
  linkedinProfileToolDefinition,
  handleLinkedinLoad,
  handleLinkedinSearch,
  handleLinkedinCount,
  handleLinkedinProfile,
} from "./tools/linkedin.js";

import { getCurrentDateTime } from "./utils/helpers.js";
import { log } from "./utils/logger.js";

// -----------------------------------------------------------------------
// Server initialisation
// -----------------------------------------------------------------------

const server = new Server(
  {
    name: "claude-connector",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// -----------------------------------------------------------------------
// Tool registry
// -----------------------------------------------------------------------

const TOOLS = [
  webSearchToolDefinition,
  newsSearchToolDefinition,
  linkedinLoadToolDefinition,
  linkedinSearchToolDefinition,
  linkedinCountToolDefinition,
  linkedinProfileToolDefinition,
  {
    name: "get_current_datetime",
    description:
      "Returns the current UTC date and time. Useful for anchoring time-sensitive queries such as 'latest news today' or 'events this week'.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// -----------------------------------------------------------------------
// List tools handler
// -----------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("info", "ListTools request received");
  return { tools: TOOLS };
});

// -----------------------------------------------------------------------
// Call tool handler
// -----------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  log("info", `CallTool: ${name}`, args);

  try {
    switch (name) {
      case "web_search":
        return await handleWebSearch(args);

      case "news_search":
        return await handleNewsSearch(args);

      case "linkedin_load_connections":
        return await handleLinkedinLoad(args);

      case "linkedin_search_connections":
        return await handleLinkedinSearch(args);

      case "linkedin_connection_count":
        return await handleLinkedinCount(args);

      case "linkedin_get_profile":
        return await handleLinkedinProfile(args);

      case "get_current_datetime": {
        const dt = getCurrentDateTime();
        return {
          content: [{ type: "text", text: JSON.stringify(dt, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: "${name}"`);
    }
  } catch (err) {
    log("error", `Tool "${name}" threw an error`, err.message);
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// -----------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "claude-connector MCP server is running via stdio");
}

main().catch((err) => {
  log("error", "Fatal startup error", err.message);
  process.exit(1);
});
