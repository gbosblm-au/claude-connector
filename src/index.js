// src/index.js  v5.0.0
// Stdio MCP server - for Claude Desktop usage
//
// v5 CHANGES:
//   - ADDED wordpress_set_seo_meta, wordpress_create_service_page (market publisher tools)
//   - ADDED set/get/clear credential tools for WordPress and LinkedIn
//   - Version aligned with server-http.js v5.0.0
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { webSearchToolDefinition, handleWebSearch } from "./tools/webSearch.js";
import { newsSearchToolDefinition, handleNewsSearch } from "./tools/newsSearch.js";
import {
  linkedinLoadToolDefinition, linkedinSearchToolDefinition,
  linkedinCountToolDefinition, linkedinProfileToolDefinition,
  handleLinkedinLoad, handleLinkedinSearch,
  handleLinkedinCount, handleLinkedinProfile,
} from "./tools/linkedin.js";
import {
  linkedinOAuthStartToolDefinition, linkedinOAuthStatusToolDefinition,
  linkedinOAuthLogoutToolDefinition, linkedinLiveProfileToolDefinition,
  handleLinkedinOAuthStart, handleLinkedinOAuthStatus,
  handleLinkedinOAuthLogout, handleLinkedinLiveProfile,
} from "./tools/linkedinOAuth.js";

import {
  wpSiteInfoToolDefinition,
  wpListPostsToolDefinition,
  wpListPagesToolDefinition,
  wpListCategoriesToolDefinition,
  wpListTagsToolDefinition,
  wpListMenusToolDefinition,
  wpListMenuItemsToolDefinition,
  wpCreatePostToolDefinition,
  wpCreatePageToolDefinition,
  wpAddMenuItemToolDefinition,
  wpUpdateContentToolDefinition,
  handleWpSiteInfo,
  handleWpListPosts,
  handleWpListPages,
  handleWpListCategories,
  handleWpListTags,
  handleWpListMenus,
  handleWpListMenuItems,
  handleWpCreatePost,
  handleWpCreatePage,
  handleWpAddMenuItem,
  handleWpUpdateContent,
} from "./tools/wordpress.js";

import {
  setWordPressCredentialsToolDefinition,
  getWordPressCredentialsToolDefinition,
  clearWordPressCredentialsToolDefinition,
  setLinkedInCredentialsToolDefinition,
  getLinkedInCredentialsToolDefinition,
  clearLinkedInCredentialsToolDefinition,
  handleSetWordPressCredentials,
  handleGetWordPressCredentials,
  handleClearWordPressCredentials,
  handleSetLinkedInCredentials,
  handleGetLinkedInCredentials,
  handleClearLinkedInCredentials,
} from "./tools/credentials.js";

import {
  wpSetSeoMetaToolDefinition,
  wpCreateServicePageToolDefinition,
  handleWpSetSeoMeta,
  handleWpCreateServicePage,
} from "./tools/marketPublisher.js";

import { getCurrentDateTime } from "./utils/helpers.js";
import { log } from "./utils/logger.js";

const server = new Server(
  { name: "claude-connector", version: "5.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  webSearchToolDefinition,
  newsSearchToolDefinition,
  linkedinLoadToolDefinition,
  linkedinSearchToolDefinition,
  linkedinCountToolDefinition,
  linkedinProfileToolDefinition,
  linkedinOAuthStartToolDefinition,
  linkedinOAuthStatusToolDefinition,
  linkedinOAuthLogoutToolDefinition,
  linkedinLiveProfileToolDefinition,
  // Credential management tools
  setWordPressCredentialsToolDefinition,
  getWordPressCredentialsToolDefinition,
  clearWordPressCredentialsToolDefinition,
  setLinkedInCredentialsToolDefinition,
  getLinkedInCredentialsToolDefinition,
  clearLinkedInCredentialsToolDefinition,
  // WordPress publishing tools
  wpSiteInfoToolDefinition,
  wpListPostsToolDefinition,
  wpListPagesToolDefinition,
  wpListCategoriesToolDefinition,
  wpListTagsToolDefinition,
  wpListMenusToolDefinition,
  wpListMenuItemsToolDefinition,
  wpCreatePostToolDefinition,
  wpCreatePageToolDefinition,
  wpAddMenuItemToolDefinition,
  wpUpdateContentToolDefinition,
  wpSetSeoMetaToolDefinition,
  wpCreateServicePageToolDefinition,
  {
    name: "get_current_datetime",
    description: "Returns the current UTC date and time.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("info", "ListTools");
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  log("info", `CallTool: ${name}`);
  try {
    switch (name) {
      case "web_search":                  return await handleWebSearch(args);
      case "news_search":                 return await handleNewsSearch(args);
      case "linkedin_load_connections":   return await handleLinkedinLoad(args);
      case "linkedin_search_connections": return await handleLinkedinSearch(args);
      case "linkedin_connection_count":   return await handleLinkedinCount(args);
      case "linkedin_get_profile":        return await handleLinkedinProfile(args);
      case "linkedin_start_oauth":        return await handleLinkedinOAuthStart(args);
      case "linkedin_oauth_status":       return await handleLinkedinOAuthStatus(args);
      case "linkedin_oauth_logout":       return await handleLinkedinOAuthLogout(args);
      case "linkedin_get_live_profile":   return await handleLinkedinLiveProfile(args);
      // Credential management
      case "set_wordpress_credentials":      return await handleSetWordPressCredentials(args);
      case "get_wordpress_credentials":      return await handleGetWordPressCredentials(args);
      case "clear_wordpress_credentials":    return await handleClearWordPressCredentials(args);
      case "set_linkedin_credentials":       return await handleSetLinkedInCredentials(args);
      case "get_linkedin_credentials":       return await handleGetLinkedInCredentials(args);
      case "clear_linkedin_credentials":     return await handleClearLinkedInCredentials(args);
      // WordPress tools
      case "wordpress_site_info":         return await handleWpSiteInfo(args);
      case "wordpress_list_posts":        return await handleWpListPosts(args);
      case "wordpress_list_pages":        return await handleWpListPages(args);
      case "wordpress_list_categories":   return await handleWpListCategories(args);
      case "wordpress_list_tags":         return await handleWpListTags(args);
      case "wordpress_list_menus":        return await handleWpListMenus(args);
      case "wordpress_list_menu_items":   return await handleWpListMenuItems(args);
      case "wordpress_create_post":       return await handleWpCreatePost(args);
      case "wordpress_create_page":       return await handleWpCreatePage(args);
      case "wordpress_add_menu_item":     return await handleWpAddMenuItem(args);
      case "wordpress_update_content":    return await handleWpUpdateContent(args);
      case "wordpress_set_seo_meta":      return await handleWpSetSeoMeta(args);
      case "wordpress_create_service_page": return await handleWpCreateServicePage(args);
      case "get_current_datetime": {
        const dt = getCurrentDateTime();
        return { content: [{ type: "text", text: JSON.stringify(dt, null, 2) }] };
      }
      default:
        throw new Error(`Unknown tool: "${name}"`);
    }
  } catch (err) {
    log("error", `Tool "${name}" error: ${err.message}`);
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "claude-connector v5.0.0 running via stdio");
}

main().catch((err) => {
  log("error", "Fatal startup error", err.message);
  process.exit(1);
});
