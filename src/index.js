// src/index.js  v7.0.0
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
  googleDriveCheckConnectionToolDefinition,
  googleDriveSearchFilesToolDefinition,
  googleDriveReadFileContentToolDefinition,
  googleDriveDownloadFileContentToolDefinition,
  googleDriveCreateFileToolDefinition,
  googleDriveGetFileMetadataToolDefinition,
  googleDriveListRecentFilesToolDefinition,
  googleDriveGetFilePermissionsToolDefinition,
  handleGoogleDriveCheckConnection,
  handleGoogleDriveSearchFiles,
  handleGoogleDriveReadFileContent,
  handleGoogleDriveDownloadFileContent,
  handleGoogleDriveCreateFile,
  handleGoogleDriveGetFileMetadata,
  handleGoogleDriveListRecentFiles,
  handleGoogleDriveGetFilePermissions,
} from "./tools/googleDrive.js";

import {
  psychologyEmotionTaxonomyToolDefinition,
  psychologySentimentAnalyzeToolDefinition,
  psychologyAlignmentAssessToolDefinition,
  handlePsychologyEmotionTaxonomy,
  handlePsychologySentimentAnalyze,
  handlePsychologyAlignmentAssess,
} from "./tools/psychology.js";

// SCOPE-01 / SCOPE-03 / SCOPE-04 / SCOPE-05 -- TrueSource outreach email
import {
  emailSendToolDefinition,
  emailGetConfigToolDefinition,
  emailGetSenderProfilesToolDefinition,
  emailValidateAddressToolDefinition,
  handleEmailSend,
  handleEmailGetConfig,
  handleEmailGetSenderProfiles,
  handleEmailValidateAddress,
} from "./tools/email.js";
import {
  emailGetTrackingToolDefinition,
  emailTrackingSummaryToolDefinition,
  handleEmailGetTracking,
  handleEmailTrackingSummary,
} from "./tools/emailTracking.js";
import {
  emailScheduleToolDefinition,
  emailScheduleCancelToolDefinition,
  emailScheduleListToolDefinition,
  handleEmailSchedule,
  handleEmailScheduleCancel,
  handleEmailScheduleList,
} from "./tools/emailSchedule.js";
import { startScheduler } from "./utils/scheduler.js";

import { getCurrentDateTime } from "./utils/helpers.js";
import { log } from "./utils/logger.js";

const server = new Server(
  { name: "claude-connector", version: "7.0.0" },
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
  imageDownloadToolDefinition,
  imageSearchDownloadToolDefinition,
  wpUploadMediaToolDefinition,
  wpSetFeaturedImageToolDefinition,
  googleDriveUploadToolDefinition,
  googleDriveListToolDefinition,
  googleDriveCheckConnectionToolDefinition,
  googleDriveSearchFilesToolDefinition,
  googleDriveReadFileContentToolDefinition,
  googleDriveDownloadFileContentToolDefinition,
  googleDriveCreateFileToolDefinition,
  googleDriveGetFileMetadataToolDefinition,
  googleDriveListRecentFilesToolDefinition,
  googleDriveGetFilePermissionsToolDefinition,
  psychologyEmotionTaxonomyToolDefinition,
  psychologySentimentAnalyzeToolDefinition,
  psychologyAlignmentAssessToolDefinition,
  // TrueSource outreach email
  emailSendToolDefinition,
  emailGetConfigToolDefinition,
  emailGetSenderProfilesToolDefinition,
  emailValidateAddressToolDefinition,
  emailGetTrackingToolDefinition,
  emailTrackingSummaryToolDefinition,
  emailScheduleToolDefinition,
  emailScheduleCancelToolDefinition,
  emailScheduleListToolDefinition,
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
      case "image_search":                return await handleImageSearch(args);
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
      case "image_download":               return await handleImageDownload(args);
      case "image_search_download":        return await handleImageSearchDownload(args);
      case "wordpress_upload_media":       return await handleWpUploadMedia(args);
      case "wordpress_set_featured_image": return await handleWpSetFeaturedImage(args);
      case "google_drive_upload":                return await handleGoogleDriveUpload(args);
      case "google_drive_list":                  return await handleGoogleDriveList(args);
      case "google_drive_check_connection":      return await handleGoogleDriveCheckConnection(args);
      case "google_drive_search_files":          return await handleGoogleDriveSearchFiles(args);
      case "google_drive_read_file_content":     return await handleGoogleDriveReadFileContent(args);
      case "google_drive_download_file_content": return await handleGoogleDriveDownloadFileContent(args);
      case "google_drive_create_file":           return await handleGoogleDriveCreateFile(args);
      case "google_drive_get_file_metadata":     return await handleGoogleDriveGetFileMetadata(args);
      case "google_drive_list_recent_files":     return await handleGoogleDriveListRecentFiles(args);
      case "google_drive_get_file_permissions":  return await handleGoogleDriveGetFilePermissions(args);
      case "psychology_emotion_taxonomy":  return await handlePsychologyEmotionTaxonomy(args);
      case "psychology_sentiment_analyze": return await handlePsychologySentimentAnalyze(args);
      case "psychology_alignment_assess":  return await handlePsychologyAlignmentAssess(args);
      // SCOPE-01 / SCOPE-03 email
      case "email_send":                   return await handleEmailSend(args);
      case "email_get_config":             return await handleEmailGetConfig(args);
      case "email_get_sender_profiles":    return await handleEmailGetSenderProfiles(args);
      case "email_validate_address":       return await handleEmailValidateAddress(args);
      // SCOPE-04 tracking
      case "email_get_tracking":           return await handleEmailGetTracking(args);
      case "email_tracking_summary":       return await handleEmailTrackingSummary(args);
      // SCOPE-05 scheduling
      case "email_schedule":               return await handleEmailSchedule(args);
      case "email_schedule_cancel":        return await handleEmailScheduleCancel(args);
      case "email_schedule_list":          return await handleEmailScheduleList(args);
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
  // Start the in-process scheduler so deferred sends fire even in stdio mode.
  try {
    startScheduler();
  } catch (err) {
    log("error", `Scheduler bootstrap error: ${err.message}`);
  }
  log("info", "claude-connector v7.0.0 running via stdio");
}

main().catch((err) => {
  log("error", "Fatal startup error", err.message);
  process.exit(1);
});
