// src/index.js  v3.0.0
// Stdio MCP server - for Claude Desktop usage
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { webSearchToolDefinition, handleWebSearch } from "./tools/webSearch.js";
import { newsSearchToolDefinition, handleNewsSearch } from "./tools/newsSearch.js";
import { imageSearchToolDefinition, handleImageSearch } from "./tools/imageSearch.js";
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
  wpCreateCategoryToolDefinition,
  wpCreateTagsToolDefinition,
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
  handleWpCreateCategory,
  handleWpCreateTags,
  handleWpListMenus,
  handleWpListMenuItems,
  handleWpCreatePost,
  handleWpCreatePage,
  handleWpAddMenuItem,
  handleWpUpdateContent,
} from "./tools/wordpress.js";

import {
  imageDownloadToolDefinition,
  imageSearchDownloadToolDefinition,
  handleImageDownload,
  handleImageSearchDownload,
} from "./tools/imageDownloader.js";
import {
  wpUploadMediaToolDefinition,
  wpSetFeaturedImageToolDefinition,
  handleWpUploadMedia,
  handleWpSetFeaturedImage,
} from "./tools/wordpressMedia.js";
import {
  googleDriveUploadToolDefinition,
  googleDriveListToolDefinition,
  handleGoogleDriveUpload,
  handleGoogleDriveList,
} from "./tools/googleDrive.js";

import { getCurrentDateTime } from "./utils/helpers.js";
import { log } from "./utils/logger.js";

const server = new Server(
  { name: "claude-connector", version: "6.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  webSearchToolDefinition,
  newsSearchToolDefinition,
  imageSearchToolDefinition,
  linkedinLoadToolDefinition,
  linkedinSearchToolDefinition,
  linkedinCountToolDefinition,
  linkedinProfileToolDefinition,
  linkedinOAuthStartToolDefinition,
  linkedinOAuthStatusToolDefinition,
  linkedinOAuthLogoutToolDefinition,
  linkedinLiveProfileToolDefinition,
  wpSiteInfoToolDefinition,
  wpListPostsToolDefinition,
  wpListPagesToolDefinition,
  wpListCategoriesToolDefinition,
  wpListTagsToolDefinition,
  wpCreateCategoryToolDefinition,
  wpCreateTagsToolDefinition,
  wpListMenusToolDefinition,
  wpListMenuItemsToolDefinition,
  wpCreatePostToolDefinition,
  wpCreatePageToolDefinition,
  wpAddMenuItemToolDefinition,
  wpUpdateContentToolDefinition,
  // Image download & upload tools
  imageDownloadToolDefinition,
  imageSearchDownloadToolDefinition,
  wpUploadMediaToolDefinition,
  wpSetFeaturedImageToolDefinition,
  googleDriveUploadToolDefinition,
  googleDriveListToolDefinition,
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
      case "image_search":               return await handleImageSearch(args);
      case "linkedin_load_connections":   return await handleLinkedinLoad(args);
      case "linkedin_search_connections": return await handleLinkedinSearch(args);
      case "linkedin_connection_count":   return await handleLinkedinCount(args);
      case "linkedin_get_profile":        return await handleLinkedinProfile(args);
      case "linkedin_start_oauth":        return await handleLinkedinOAuthStart(args);
      case "linkedin_oauth_status":       return await handleLinkedinOAuthStatus(args);
      case "linkedin_oauth_logout":       return await handleLinkedinOAuthLogout(args);
      case "linkedin_get_live_profile":   return await handleLinkedinLiveProfile(args);
      case "wordpress_site_info":         return await handleWpSiteInfo(args);
      case "wordpress_list_posts":        return await handleWpListPosts(args);
      case "wordpress_list_pages":        return await handleWpListPages(args);
      case "wordpress_list_categories":   return await handleWpListCategories(args);
      case "wordpress_list_tags":         return await handleWpListTags(args);
      case "wordpress_create_category":   return await handleWpCreateCategory(args);
      case "wordpress_create_tags":       return await handleWpCreateTags(args);
      case "wordpress_list_menus":        return await handleWpListMenus(args);
      case "wordpress_list_menu_items":   return await handleWpListMenuItems(args);
      case "wordpress_create_post":       return await handleWpCreatePost(args);
      case "wordpress_create_page":       return await handleWpCreatePage(args);
      case "wordpress_add_menu_item":     return await handleWpAddMenuItem(args);
      case "wordpress_update_content":    return await handleWpUpdateContent(args);
      // Image download & upload
      case "image_download":                return await handleImageDownload(args);
      case "image_search_download":         return await handleImageSearchDownload(args);
      case "wordpress_upload_media":        return await handleWpUploadMedia(args);
      case "wordpress_set_featured_image":  return await handleWpSetFeaturedImage(args);
      case "google_drive_upload":           return await handleGoogleDriveUpload(args);
      case "google_drive_list":             return await handleGoogleDriveList(args);
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
  log("info", "claude-connector v6.0.0 running via stdio");
}

main().catch((err) => {
  log("error", "Fatal startup error", err.message);
  process.exit(1);
});
