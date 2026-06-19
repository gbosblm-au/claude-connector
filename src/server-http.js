// src/server-http.js  v12.8.2
// HTTP MCP server for browser-based Claude (claude.ai) and Railway deployment.
//
// v12.4.0: Add skill_recompile MCP tool. Mid-session delta recompile: runs the
// full 6-layer dispatcher for a new topic query and returns only the modules
// not already loaded in the current session (the delta). Solves the context-shift
// problem documented in DC2026 session 2026-06-09: when a conversation topic
// changes significantly, skill_compile cannot be re-run (session-start only) and
// skill_load_specialist requires knowing the exact module ID. skill_recompile
// accepts the new query, runs the dispatcher, and returns only the additional
// content needed — keeping output small and avoiding duplication of content
// already in the append-only context window.
//
// AVA_MEMORY_WP_KEY are set, all six memory_* tools read and write directly
// to MySQL via the WordPress REST API. No Railway SQLite layer is involved.
// The ava_memory_backup and ava_memory_restore tools return informational
// no-op responses in MySQL-primary mode; ava_memory_sync_status returns live
// MySQL health stats instead of a SQLite vs MySQL comparison.
//
// v10.0.0 (major release): Integrates the TrueSource Persistent Memory MCP
// (six memory_* tools) directly into the connector. Memory storage uses
// SQLite + FTS5 on the Railway persistent volume mounted at /data. The
// memory subsystem is gated by AVA_MEMORY_WP_URL+AVA_MEMORY_WP_KEY (MySQL-primary)
// or MEMORY_AUTH_TOKEN (SQLite fallback). When neither is configured, the six memory
// tools are advertised and routed; when unset, those tools are omitted from
// the tool list and the rest of the connector continues to function unchanged.
//
// v9.0.0: Consolidated former stats-connector (data-analysis) into
// claude-connector. All previous claude-connector v8.0.0 capabilities are
// preserved. Adds 35 statistical / machine-learning tools (data_*, stats_*,
// ts_*, ml_*, plus stats_help). Express body limit raised to 50mb to support
// inline-data dataset loading.
//
// v7.0 CHANGES (TrueSource Outreach Direct Send):
//   - SCOPE-01 Tools: email_send, email_get_config, email_get_sender_profiles, email_validate_address
//   - SCOPE-03 HTML email templating integrated into email_send
//   - SCOPE-04 Tracking endpoints: GET /track/open, GET /track/click
//              + tools: email_get_tracking, email_tracking_summary
//   - SCOPE-05 Scheduling: cron-driven in-process scheduler started at boot
//              + tools: email_schedule, email_schedule_cancel, email_schedule_list

import "dotenv/config";
// v12.0.0: Tenant authentication middleware
import { tenantAuthMiddleware, logTenantModeStatus, isTenantMode } from './middleware/tenantAuth.js';
import { initDevice }                                               from './utils/deviceId.js';
import { registerProvisionRoute } from './routes/provision.js';
// v12.3.0: Tenant session init tool
import {
  tsGatewaySessionInitToolDefinition,
  handleTsGatewaySessionInit,
} from './tools/gatewaySessionInit.js';

// v12.5.0: Peer Review - health log tools (tenant mode) and check-in tools (owner mode)
import {
  healthLogWriteToolDefinition,
  issueFlagToolDefinition,
  peerReviewConsentToolDefinition,
  handleHealthLogWrite,
  handleIssueFlag,
  handlePeerReviewConsent,
} from './tools/healthLog.js';
import {
  clientRegistryUpdateToolDefinition,
  clientCheckinToolDefinition,
  escalationQueueReadToolDefinition,
  handleClientRegistryUpdate,
  handleClientCheckin,
  handleEscalationQueueRead,
} from './tools/clientCheckin.js';
import { createServer } from "http";
import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { dirname, join as pathJoin } from "path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest, CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
  googleDriveListToolDefinition,
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

// ---------- TrueSource outreach direct send (SCOPE-01/03/04/05) ----------
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
  emailScheduleToolDefinition,
  emailScheduleCancelToolDefinition,
  emailScheduleListToolDefinition,
  handleEmailSchedule,
  handleEmailScheduleCancel,
  handleEmailScheduleList,
} from "./tools/emailSchedule.js";

// v8.0.0 additions
import {
  calendarListEventsToolDefinition,
  calendarCreateEventToolDefinition,
  calendarUpdateEventToolDefinition,
  calendarDeleteEventToolDefinition,
  handleCalendarListEvents,
  handleCalendarCreateEvent,
  handleCalendarUpdateEvent,
  handleCalendarDeleteEvent,
} from "./tools/googleCalendar.js";

import {
  sheetsGetMetadataToolDefinition,
  sheetsReadRangeToolDefinition,
  sheetsWriteRangeToolDefinition,
  sheetsAppendRowsToolDefinition,
  handleSheetsGetMetadata,
  handleSheetsReadRange,
  handleSheetsWriteRange,
  handleSheetsAppendRows,
} from "./tools/googleSheets.js";

import {
  webhookPollEventsToolDefinition,
  webhookClearEventsToolDefinition,
  webhookQueueStatusToolDefinition,
  enqueueWebhookEvent,
  validateWebhookSecret,
  handleWebhookPollEvents,
  handleWebhookClearEvents,
  handleWebhookQueueStatus,
} from "./tools/webhook.js";

import {
  slackSendMessageToolDefinition,
  teamsSendMessageToolDefinition,
  handleSlackSendMessage,
  handleTeamsSendMessage,
} from "./tools/messaging.js";

import {
  webFetchPageToolDefinition,
  handleWebFetchPage,
} from "./tools/webFetch.js";

import {
  googleDriveOverwriteFileToolDefinition,
  handleGoogleDriveOverwriteFile,
} from "./tools/googleDrive.js";

import {
  wpGetContentToolDefinition,
  wpHealthToolDefinition,
  handleWpGetContent,
  handleWpHealth,
} from "./tools/wordpress.js";



// ---------- v10.0.0: Persistent Memory MCP integration ----------
// v10.0.1 fix: lazy-load the memory subsystem. The tools-memory/index.js
// chain transitively imports better-sqlite3 (native module). On hosts that
// have not yet built that binary (or where the persistent volume is not
// provisioned), eager imports caused module-load failures that took the
// entire connector down - which manifested to users as 'WordPress REST API
// stopped working'. We now resolve the memory bindings on first use only
// when MEMORY_AUTH_TOKEN is configured.
let ALL_MEMORY_TOOL_DEFINITIONS = [];
let MEMORY_TOOL_NAMES = new Set();
let dispatchMemoryTool = null;
let initMemorySubsystem = null;
let getMemoryHealthSnapshot = () => ({ enabled: false });
let memoryAdminDumpHandler = null;

// ---------- v9.0.0: Statistical analysis & machine learning ----------
import {
  dataLoadToolDefinition, dataInfoToolDefinition, dataPreviewToolDefinition,
  dataListToolDefinition, dataDropToolDefinition, dataFilterToolDefinition,
  dataSelectToolDefinition, dataSampleToolDefinition,
  handleDataLoad, handleDataInfo, handleDataPreview, handleDataList,
  handleDataDrop, handleDataFilter, handleDataSelect, handleDataSample,
} from "./tools-stats/dataManagement.js";
import {
  describeToolDefinition, frequencyToolDefinition, histogramToolDefinition,
  crosstabToolDefinition, normalityToolDefinition,
  handleDescribe, handleFrequency, handleHistogram, handleCrosstab, handleNormality,
} from "./tools-stats/descriptiveStats.js";
import {
  tTestToolDefinition, anovaToolDefinition, chiSquareToolDefinition,
  confidenceIntervalToolDefinition, mannWhitneyToolDefinition, proportionTestToolDefinition,
  handleTTest, handleAnova, handleChiSquare,
  handleConfidenceInterval, handleMannWhitney, handleProportionTest,
} from "./tools-stats/inferentialStats.js";
import {
  correlationToolDefinition, regressionToolDefinition, partialCorrelationToolDefinition,
  handleCorrelation, handleRegression, handlePartialCorrelation,
} from "./tools-stats/regressionCorrelation.js";
import {
  timeSeriesAnalyzeToolDefinition, movingAverageToolDefinition, forecastToolDefinition,
  handleTimeSeriesAnalyze, handleMovingAverage, handleForecast,
} from "./tools-stats/timeSeries.js";
import {
  kmeansToolDefinition, pcaToolDefinition, knnToolDefinition,
  naiveBayesToolDefinition, anomalyDetectionToolDefinition, featureImportanceToolDefinition,
  handleKMeans, handlePCA, handleKNN,
  handleNaiveBayes, handleAnomalyDetection, handleFeatureImportance,
} from "./tools-stats/machineLearning.js";

import {
  PIXEL_PNG,
  appendTrackingEvent,
  classifyUserAgent,
  hashIp,
  getSendMetadata,
  incrementOpen,
} from "./utils/tracking.js";
import { startScheduler } from "./utils/scheduler.js";

import { getCurrentDateTime } from "./utils/helpers.js";
import { log } from "./utils/logger.js";
import { validateAndConsumeState, storeToken } from "./utils/tokenStore.js";
import { getLinkedInCredentials } from "./utils/credentialStore.js";
import { config } from "./config.js";
import {
  skillReadToolDefinition,
  skillWriteToolDefinition,
  skillWriteAdditionToolDefinition,
  skillMergeAdditionsToolDefinition,
  skillHistoryToolDefinition,
  skillRollbackToolDefinition,
  skillAuditToolDefinition,
  handleSkillRead,
  handleSkillWrite,
  handleSkillWriteAddition,
  handleSkillMergeAdditions,
  handleSkillHistory,
  handleSkillRollback,
  handleSkillRestoreFromWp,
  handleSkillAudit,
} from "./tools/skill.js";
import {
  booksReadToolDefinition,
  booksLogWriteToolDefinition,
  handleBooksRead,
  handleBooksLogWrite,
  handleBooksRestoreFromWp,
} from "./tools/books.js";
import {
  profileReadToolDefinition,
  profileWritePersonToolDefinition,
  handleProfileRead,
  handleProfileWritePerson,
  handleProfilesRestoreFromWp,
} from "./tools/profiles.js";
import {
  skillCompileToolDefinition,
  skillLoadSpecialistToolDefinition,
  skillRecompileToolDefinition,
  personalityWriteToolDefinition,
  dispatchRuleAddToolDefinition,
  handleSkillCompile,
  handleSkillLoadSpecialist,
  handleSkillRecompile,
  handlePersonalityWrite,
  handleDispatchRuleAdd,
  handleModulesRestoreFromWp,
} from "./tools/skill-modular.js";
import {
  avaMemoryBackupToolDefinition,
  avaMemoryRestoreToolDefinition,
  avaMemorySyncStatusToolDefinition,
  handleAvaMemoryBackup,
  handleAvaMemoryRestore,
  handleAvaMemorySyncStatus,
} from "./tools/avaMemorySync.js";
import {
  moduleWriteToolDefinition,
  archiveListToolDefinition,
  archiveReadToolDefinition,
  archiveWriteToolDefinition,
  referenceListToolDefinition,
  referenceReadToolDefinition,
  referenceWriteToolDefinition,
  scriptListToolDefinition,
  scriptReadToolDefinition,
  scriptWriteToolDefinition,
  handleModuleWrite,
  handleArchiveList,
  handleArchiveRead,
  handleArchiveWrite,
  handleReferenceList,
  handleReferenceRead,
  handleReferenceWrite,
  handleScriptList,
  handleScriptRead,
  handleScriptWrite,
  handleArchiveRestoreFromWp,
  handleReferenceRestoreFromWp,
  handleScriptRestoreFromWp,
} from "./tools/skill-content.js";
import {
  handleScriptExecute,
  TOOL_DEFINITION as scriptExecuteToolDefinition,
} from "./tools/script-execute.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const UPLOAD_API_KEY = process.env.UPLOAD_API_KEY || "";
// Restore token gates POST /restore-skill (push-from-WordPress back to Railway volume).
// Must match RAILWAY_RESTORE_TOKEN configured in the ts-ava-skill WordPress plugin Settings tab.
const RAILWAY_RESTORE_TOKEN = process.env.RAILWAY_RESTORE_TOKEN || "";
// Memory is enabled when either MySQL-primary (WP) or SQLite (legacy) is configured.
const MEMORY_AUTH_TOKEN = process.env.MEMORY_AUTH_TOKEN || "";
let MEMORY_ENABLED = Boolean(MEMORY_AUTH_TOKEN) || Boolean(config.avaMemoryWpUrl && config.avaMemoryWpKey);

// Skill tools are enabled when SKILL_FILE_PATH is explicitly set in Railway Variables.
// The default paths resolve to /data/skill/ but tools are only advertised when the
// operator has provisioned the volume and set the env var.
const SKILL_ENABLED = Boolean(config.skillFilePath);
// Modular skill system - activated by SKILL_MODULAR_ENABLED=true AND SKILL_FILE_PATH set.
const SKILL_MODULAR_ENABLED = SKILL_ENABLED && process.env.SKILL_MODULAR_ENABLED === "true";

// ---------------------------------------------------------------------------
// Runtime modular mode helpers (v11.3.0)
//
// SKILL_MODULAR_ENABLED (above) reflects the env var at startup time only.
// isModularEnabled() checks a mode file on the Railway volume first, allowing
// WordPress to toggle the mode without a redeploy. The mode file takes
// precedence over the env var when present.
//
// Mode file path: {SKILL_FILE_PATH_base}/.modular_mode  (default: /data/skill/.modular_mode)
// File content: the string "true" or "false".
// ---------------------------------------------------------------------------

function getModeFilePath() {
  const skillPath = process.env.SKILL_FILE_PATH || "/data/skill/SKILL.md";
  return skillPath.replace(/SKILL\.md$/, "") + ".modular_mode";
}

function isModularEnabled() {
  if (!SKILL_ENABLED) return false;
  const modePath = getModeFilePath();
  if (existsSync(modePath)) {
    try {
      const val = readFileSync(modePath, "utf8").trim();
      return val === "true";
    } catch { /* fall through to env var */ }
  }
  return process.env.SKILL_MODULAR_ENABLED === "true";
}

function getModularModeStatus() {
  const modePath = getModeFilePath();
  const hasFile  = existsSync(modePath);
  let fileValue  = null;
  if (hasFile) {
    try { fileValue = readFileSync(modePath, "utf8").trim(); } catch { /* ignore */ }
  }
  const envVar  = process.env.SKILL_MODULAR_ENABLED || "not set";
  const enabled = isModularEnabled();
  return {
    enabled,
    source:          hasFile ? "mode_file" : "env_var",
    env_var:         envVar,
    file_value:      fileValue,
    mode_file_path:  modePath,
    note:            hasFile
      ? "Mode file present — overrides SKILL_MODULAR_ENABLED env var. Delete the file to revert to env var control."
      : "No mode file. Using SKILL_MODULAR_ENABLED env var (requires redeploy to change).",
  };
}

// Profiles tools are enabled when SKILL_FILE_PATH is set (they share the same volume).
// Can also be enabled independently via PROFILES_FILE_PATH.
const PROFILES_ENABLED = Boolean(config.skillFilePath) || Boolean(process.env.PROFILES_FILE_PATH);

// ---------------------------------------------------------------------------
// Personal-file WordPress Gateway backup (v12.1.0)
//
// When running in tenant mode (TS_CLIENT_MODE=tenant), personality_write,
// profile_write_person, and dispatch_rule_add call backupPersonalFileToGateway()
// after each successful write so that the WordPress Client Gateway always holds
// a current copy for disaster recovery.
//
// No new env vars needed: TS_TENANT_GATEWAY_URL and TS_CLIENT_API_KEY are
// already required for tenant mode authentication (tenantAuth.js).
// ---------------------------------------------------------------------------

// Base directory of the skill volume (e.g. /data/skill/ava).
// Derived from SKILL_FILE_PATH (/data/skill/ava/SKILL.md) via dirname().
const SKILL_BASE_DIR = SKILL_ENABLED ? dirname(config.skillFilePath) : null;

// Tenant gateway URL and API key (already set as env vars in tenant mode).
const TENANT_GATEWAY_URL = (process.env.TS_TENANT_GATEWAY_URL || "").replace(/\/$/, "");
const TENANT_API_KEY     = process.env.TS_CLIENT_API_KEY || "";

/**
 * Back up a personal file to the WordPress Client Gateway after it has been
 * updated on the Railway volume. Only runs in tenant mode with a gateway URL
 * and API key configured. Non-blocking: failures are logged but never surface
 * to the caller or affect the tool result.
 *
 * @param {'PERSONALITY.md'|'PROFILES.md'|'DISPATCH_RULES.json'} fileKey
 * @param {string} filePath  Absolute path to the file on the Railway volume.
 */
async function backupPersonalFileToGateway(fileKey, filePath) {
  if (!isTenantMode() || !TENANT_GATEWAY_URL || !TENANT_API_KEY) return;

  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (readErr) {
    log("warn", `[wp-backup] Cannot read ${fileKey} for gateway backup: ${readErr.message}`);
    return;
  }

  if (!content || !content.trim()) return;

  const backupUrl = `${TENANT_GATEWAY_URL}/backup/personal`;
  try {
    const resp = await fetch(backupUrl, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":   "claude-connector/12.8.0 (TrueSource tenant mode)",
      },
      body:   JSON.stringify({ api_key: TENANT_API_KEY, file_key: fileKey, content }),
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      log("info", `[wp-backup] ${fileKey} backed up to WordPress gateway (tenant: ${process.env.TS_TENANT_ID || "unknown"})`);
    } else {
      const errSnippet = (await resp.text().catch(() => "")).slice(0, 200);
      log("warn", `[wp-backup] ${fileKey} gateway backup HTTP ${resp.status}: ${errSnippet}`);
    }
  } catch (fetchErr) {
    log("warn", `[wp-backup] ${fileKey} gateway backup fetch failed: ${fetchErr.message}`);
  }
}

// Initialise the persistent memory subsystem when configured.
// v10.0.1: dynamic import keeps the rest of the connector functional even
// when better-sqlite3 fails to load (missing native binary, etc.).
if (MEMORY_ENABLED) {
  try {
    const memMod = await import("./tools-memory/index.js");
    const adminMod = await import("./tools-memory/admin.js");
    ALL_MEMORY_TOOL_DEFINITIONS = memMod.ALL_MEMORY_TOOL_DEFINITIONS;
    MEMORY_TOOL_NAMES = memMod.MEMORY_TOOL_NAMES;
    dispatchMemoryTool = memMod.dispatchMemoryTool;
    initMemorySubsystem = memMod.initMemorySubsystem;
    getMemoryHealthSnapshot = async () => memMod.getMemoryHealthSnapshot();
    memoryAdminDumpHandler = adminMod.adminDumpHandler;
    await initMemorySubsystem();
    log("info", "[memory] subsystem ENABLED");
  } catch (err) {
    MEMORY_ENABLED = false;
    log("error", `[memory] subsystem failed to initialise: ${err.message}. Continuing with memory disabled; all other tools (including WordPress REST) remain available.`);
  }
} else {
  log(
    "info",
    "[memory] memory_* tools disabled. Set AVA_MEMORY_WP_URL+AVA_MEMORY_WP_KEY (MySQL-primary) " +
      "or MEMORY_AUTH_TOKEN (SQLite) in Railway Variables to enable.",
  );
}

// -----------------------------------------------------------------------
// Tool registry
// -----------------------------------------------------------------------
const TOOLS = [
  // ---------- TrueSource Client Gateway session init (v12.3.0) ----------
  // Only advertised when TS_CLIENT_MODE=tenant. Authenticates the session
  // and returns the required next-step sequence including skill_compile.
  ...(isTenantMode() ? [tsGatewaySessionInitToolDefinition] : []),

  // ---------- Peer Review: health log tools (v12.5.0) ----------
  // health_log_write and issue_flag: tenant mode only (called by client Ava).
  // peer_review_consent_set: tenant mode only (first session consent dialogue).
  ...(isTenantMode() ? [
    healthLogWriteToolDefinition,
    issueFlagToolDefinition,
    peerReviewConsentToolDefinition,
  ] : []),

  // ---------- Peer Review: check-in tools (v12.5.0) ----------
  // client_checkin, client_registry_update, escalation_queue_read: owner mode only.
  ...(!isTenantMode() ? [
    clientRegistryUpdateToolDefinition,
    clientCheckinToolDefinition,
    escalationQueueReadToolDefinition,
  ] : []),

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
  setWordPressCredentialsToolDefinition,
  getWordPressCredentialsToolDefinition,
  clearWordPressCredentialsToolDefinition,
  setLinkedInCredentialsToolDefinition,
  getLinkedInCredentialsToolDefinition,
  clearLinkedInCredentialsToolDefinition,
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
  wpSetSeoMetaToolDefinition,
  wpCreateServicePageToolDefinition,
  imageDownloadToolDefinition,
  imageSearchDownloadToolDefinition,
  wpUploadMediaToolDefinition,
  wpSetFeaturedImageToolDefinition,
  googleDriveListToolDefinition,
  googleDriveCheckConnectionToolDefinition,
  googleDriveSearchFilesToolDefinition,
  googleDriveReadFileContentToolDefinition,
  googleDriveDownloadFileContentToolDefinition,
  googleDriveCreateFileToolDefinition,
  googleDriveOverwriteFileToolDefinition,
  googleDriveGetFileMetadataToolDefinition,
  googleDriveListRecentFilesToolDefinition,
  googleDriveGetFilePermissionsToolDefinition,
  psychologyEmotionTaxonomyToolDefinition,
  psychologySentimentAnalyzeToolDefinition,
  psychologyAlignmentAssessToolDefinition,

  // ---------- TrueSource outreach direct send ----------
  emailSendToolDefinition,
  emailGetConfigToolDefinition,
  emailGetSenderProfilesToolDefinition,
  emailValidateAddressToolDefinition,
  emailScheduleToolDefinition,
  emailScheduleCancelToolDefinition,
  emailScheduleListToolDefinition,

  // ---------- WordPress get content ----------
  wpGetContentToolDefinition,
  wpHealthToolDefinition,

  // ---------- Google Calendar (v8.0.0) ----------
  calendarListEventsToolDefinition,
  calendarCreateEventToolDefinition,
  calendarUpdateEventToolDefinition,
  calendarDeleteEventToolDefinition,

  // ---------- Google Sheets (v8.0.0) ----------
  sheetsGetMetadataToolDefinition,
  sheetsReadRangeToolDefinition,
  sheetsWriteRangeToolDefinition,
  sheetsAppendRowsToolDefinition,

  // ---------- Inbound Webhook (v8.0.0) ----------
  webhookPollEventsToolDefinition,
  webhookClearEventsToolDefinition,
  webhookQueueStatusToolDefinition,

  // ---------- Slack / Teams messaging (v8.0.0) ----------
  slackSendMessageToolDefinition,
  teamsSendMessageToolDefinition,

  // ---------- Full page web fetch (v8.0.0) ----------
  webFetchPageToolDefinition,

  // ---------- Statistical analysis & ML (v9.0.0) ----------
  // Data management (8)
  dataLoadToolDefinition,
  dataInfoToolDefinition,
  dataPreviewToolDefinition,
  dataListToolDefinition,
  dataDropToolDefinition,
  dataFilterToolDefinition,
  dataSelectToolDefinition,
  dataSampleToolDefinition,
  // Descriptive statistics (5)
  describeToolDefinition,
  frequencyToolDefinition,
  histogramToolDefinition,
  crosstabToolDefinition,
  normalityToolDefinition,
  // Inferential statistics (6)
  tTestToolDefinition,
  anovaToolDefinition,
  chiSquareToolDefinition,
  confidenceIntervalToolDefinition,
  mannWhitneyToolDefinition,
  proportionTestToolDefinition,
  // Regression & correlation (3)
  correlationToolDefinition,
  regressionToolDefinition,
  partialCorrelationToolDefinition,
  // Time series (3)
  timeSeriesAnalyzeToolDefinition,
  movingAverageToolDefinition,
  forecastToolDefinition,
  // Machine learning (6)
  kmeansToolDefinition,
  pcaToolDefinition,
  knnToolDefinition,
  naiveBayesToolDefinition,
  anomalyDetectionToolDefinition,
  featureImportanceToolDefinition,
  // Stats help
  {
    name: "stats_help",
    description:
      "Returns a categorised list of all available statistical and ML tools " +
      "with brief descriptions. Call this first to understand what statistical " +
      "analyses are available.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  {
    name: "get_current_datetime",
    description: "Returns the current UTC date and time.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // ---------- Ava Skill Volume (v10.7.0) ----------
  // Only advertised when SKILL_FILE_PATH is configured so Claude does not
  // see tools that will always error in a non-provisioned environment.
  ...(SKILL_ENABLED
    ? [
        skillReadToolDefinition,
        skillWriteToolDefinition,
        skillWriteAdditionToolDefinition,
        skillMergeAdditionsToolDefinition,
        skillHistoryToolDefinition,
        skillRollbackToolDefinition,
        skillAuditToolDefinition,
        booksReadToolDefinition,
        booksLogWriteToolDefinition,
        // ---------- Content sections (archive / references / scripts) ----------
        archiveListToolDefinition,
        archiveReadToolDefinition,
        archiveWriteToolDefinition,
        referenceListToolDefinition,
        referenceReadToolDefinition,
        referenceWriteToolDefinition,
        scriptListToolDefinition,
        scriptReadToolDefinition,
        scriptWriteToolDefinition,
        scriptExecuteToolDefinition,
      ]
    : []),

  // ---------- Modular Skill System (v11.0.0) ----------
  // Only advertised when SKILL_MODULAR_ENABLED=true (requires SKILL_FILE_PATH).
  // skill_compile replaces skill_read at session start when modular mode is active.
  ...(SKILL_MODULAR_ENABLED
    ? [
        skillCompileToolDefinition,
        skillLoadSpecialistToolDefinition,
        skillRecompileToolDefinition,
        personalityWriteToolDefinition,
        dispatchRuleAddToolDefinition,
        moduleWriteToolDefinition,
      ]
    : []),

  // ---------- Ava User Profiles (v10.8.0) ----------
  // Enabled when SKILL_FILE_PATH or PROFILES_FILE_PATH is configured.
  // profile_read called at session start after skill_read.
  // profile_write_person called after substantive turns when profile-relevant
  // information emerges, and when a new person is confirmed after anomaly check.
  ...(PROFILES_ENABLED
    ? [
        profileReadToolDefinition,
        profileWritePersonToolDefinition,
      ]
    : []),

  // ---------- Ava Memory Sync - durable MySQL backup (v10.1.0) ----------
  // Only advertised when AVA_MEMORY_WP_URL and AVA_MEMORY_WP_KEY are configured.
  ...(config.avaMemoryWpUrl && config.avaMemoryWpKey
    ? [avaMemoryBackupToolDefinition, avaMemoryRestoreToolDefinition, avaMemorySyncStatusToolDefinition]
    : []),

  // ---------- Persistent Memory MCP (v10.0.0) ----------
  // Only advertised when MEMORY_AUTH_TOKEN is configured so Claude does not
  // see tools that will always return MEMORY_DISABLED in a misconfigured env.
  ...(MEMORY_ENABLED ? ALL_MEMORY_TOOL_DEFINITIONS : []),
];


// -----------------------------------------------------------------------
// dispatchToolCall  (v12.8.0)
// Extracted from the MCP CallToolRequestSchema handler.
// Used by both the MCP server and the REST /tool-call endpoint so that
// tool handler logic lives in exactly one place.
// Returns the raw MCP-format result { content, isError }.
// -----------------------------------------------------------------------

async function dispatchToolCall(name, args) {
      switch (name) {
        // ---------- TrueSource Client Gateway session init (v12.3.0) ----------
        case "ts_gateway_session_init": return await handleTsGatewaySessionInit(args);

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
        case "set_wordpress_credentials":   return await handleSetWordPressCredentials(args);
        case "get_wordpress_credentials":   return await handleGetWordPressCredentials(args);
        case "clear_wordpress_credentials": return await handleClearWordPressCredentials(args);
        case "set_linkedin_credentials":    return await handleSetLinkedInCredentials(args);
        case "get_linkedin_credentials":    return await handleGetLinkedInCredentials(args);
        case "clear_linkedin_credentials":  return await handleClearLinkedInCredentials(args);
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
        case "wordpress_set_seo_meta":      return await handleWpSetSeoMeta(args);
        case "wordpress_create_service_page": return await handleWpCreateServicePage(args);
        case "image_download":              return await handleImageDownload(args);
        case "image_search_download":       return await handleImageSearchDownload(args);
        case "wordpress_upload_media":      return await handleWpUploadMedia(args);
        case "wordpress_set_featured_image":return await handleWpSetFeaturedImage(args);
        case "wordpress_get_content":       return await handleWpGetContent(args);
        case "wordpress_health":            return await handleWpHealth(args);
        case "google_drive_list":           return await handleGoogleDriveList(args);
        case "google_drive_check_connection":      return await handleGoogleDriveCheckConnection(args);
        case "google_drive_search_files":          return await handleGoogleDriveSearchFiles(args);
        case "google_drive_read_file_content":     return await handleGoogleDriveReadFileContent(args);
        case "google_drive_download_file_content": return await handleGoogleDriveDownloadFileContent(args);
        case "google_drive_create_file":           return await handleGoogleDriveCreateFile(args);
        case "google_drive_overwrite_file":        return await handleGoogleDriveOverwriteFile(args);
        case "google_drive_get_file_metadata":     return await handleGoogleDriveGetFileMetadata(args);
        case "google_drive_list_recent_files":     return await handleGoogleDriveListRecentFiles(args);
        case "google_drive_get_file_permissions":  return await handleGoogleDriveGetFilePermissions(args);
        case "psychology_emotion_taxonomy":  return await handlePsychologyEmotionTaxonomy(args);
        case "psychology_sentiment_analyze": return await handlePsychologySentimentAnalyze(args);
        case "psychology_alignment_assess":  return await handlePsychologyAlignmentAssess(args);

        // ---------- TrueSource outreach direct send ----------
        case "email_send":                   return await handleEmailSend(args);
        case "email_get_config":             return await handleEmailGetConfig(args);
        case "email_get_sender_profiles":    return await handleEmailGetSenderProfiles(args);
        case "email_validate_address":       return await handleEmailValidateAddress(args);
        case "email_schedule":               return await handleEmailSchedule(args);
        case "email_schedule_cancel":        return await handleEmailScheduleCancel(args);
        case "email_schedule_list":          return await handleEmailScheduleList(args);

        // ---------- Google Calendar (v8.0.0) ----------
        case "calendar_list_events":   return await handleCalendarListEvents(args);
        case "calendar_create_event":  return await handleCalendarCreateEvent(args);
        case "calendar_update_event":  return await handleCalendarUpdateEvent(args);
        case "calendar_delete_event":  return await handleCalendarDeleteEvent(args);

        // ---------- Google Sheets (v8.0.0) ----------
        case "sheets_get_metadata":    return await handleSheetsGetMetadata(args);
        case "sheets_read_range":      return await handleSheetsReadRange(args);
        case "sheets_write_range":     return await handleSheetsWriteRange(args);
        case "sheets_append_rows":     return await handleSheetsAppendRows(args);

        // ---------- Inbound Webhook (v8.0.0) ----------
        case "webhook_poll_events":    return await handleWebhookPollEvents(args);
        case "webhook_clear_events":   return await handleWebhookClearEvents(args);
        case "webhook_queue_status":   return await handleWebhookQueueStatus(args);

        // ---------- Slack / Teams messaging (v8.0.0) ----------
        case "slack_send_message":     return await handleSlackSendMessage(args);
        case "teams_send_message":     return await handleTeamsSendMessage(args);

        // ---------- Full page web fetch (v8.0.0) ----------
        case "web_fetch_page":         return await handleWebFetchPage(args);

        // ---------- Statistical analysis & ML (v9.0.0) ----------
        // Data management
        case "data_load":    return await handleDataLoad(args);
        case "data_info":    return await handleDataInfo(args);
        case "data_preview": return await handleDataPreview(args);
        case "data_list":    return await handleDataList(args);
        case "data_drop":    return await handleDataDrop(args);
        case "data_filter":  return await handleDataFilter(args);
        case "data_select":  return await handleDataSelect(args);
        case "data_sample":  return await handleDataSample(args);
        // Descriptive
        case "stats_describe":   return await handleDescribe(args);
        case "stats_frequency":  return await handleFrequency(args);
        case "stats_histogram":  return await handleHistogram(args);
        case "stats_crosstab":   return await handleCrosstab(args);
        case "stats_normality":  return await handleNormality(args);
        // Inferential
        case "stats_ttest":               return await handleTTest(args);
        case "stats_anova":               return await handleAnova(args);
        case "stats_chi_square":          return await handleChiSquare(args);
        case "stats_confidence_interval": return await handleConfidenceInterval(args);
        case "stats_mann_whitney":        return await handleMannWhitney(args);
        case "stats_proportion_test":     return await handleProportionTest(args);
        // Regression & correlation
        case "stats_correlation":         return await handleCorrelation(args);
        case "stats_regression":          return await handleRegression(args);
        case "stats_partial_correlation": return await handlePartialCorrelation(args);
        // Time series
        case "ts_analyze":        return await handleTimeSeriesAnalyze(args);
        case "ts_moving_average": return await handleMovingAverage(args);
        case "ts_forecast":       return await handleForecast(args);
        // Machine learning
        case "ml_kmeans":             return await handleKMeans(args);
        case "ml_pca":                return await handlePCA(args);
        case "ml_knn":                return await handleKNN(args);
        case "ml_naive_bayes":        return await handleNaiveBayes(args);
        case "ml_anomaly_detection":  return await handleAnomalyDetection(args);
        case "ml_feature_importance": return await handleFeatureImportance(args);
        case "stats_help":            return { content: [{ type: "text", text: STATS_HELP_TEXT }] };

        case "get_current_datetime":
          return { content: [{ type: "text", text: JSON.stringify(getCurrentDateTime(), null, 2) }] };

        // ---------- Ava Skill Volume (v10.7.0) ----------
        case "skill_read":              return await handleSkillRead(args);
        case "skill_write":             return await handleSkillWrite(args);
        case "skill_write_addition":    return await handleSkillWriteAddition(args);
        case "skill_merge_additions":   return await handleSkillMergeAdditions(args);
        case "skill_history":           return await handleSkillHistory(args);
        case "skill_rollback":          return await handleSkillRollback(args);
        case "skill_audit":             return await handleSkillAudit(args);
        // ---------- Modular Skill System (v11.0.0) ----------
        case "skill_compile":           return await handleSkillCompile(args);
        case "skill_load_specialist":   return await handleSkillLoadSpecialist(args);
        case "skill_recompile":         return await handleSkillRecompile(args);
        case "personality_write": {
          const _personalityResult = await handlePersonalityWrite(args);
          // Non-blocking WordPress gateway backup (tenant mode only).
          if (SKILL_BASE_DIR) {
            backupPersonalFileToGateway("PERSONALITY.md", `${SKILL_BASE_DIR}/PERSONALITY.md`)
              .catch(() => {}); // swallow - never let backup failure propagate
          }
          return _personalityResult;
        }
        case "dispatch_rule_add": {
          const _dispatchResult = await handleDispatchRuleAdd(args);
          // Non-blocking WordPress gateway backup (tenant mode only).
          if (SKILL_BASE_DIR) {
            backupPersonalFileToGateway("DISPATCH_RULES.json", `${SKILL_BASE_DIR}/DISPATCH_RULES.json`)
              .catch(() => {});
          }
          return _dispatchResult;
        }
        case "module_write":            return await handleModuleWrite(args);
        case "books_read":             return await handleBooksRead(args);
        case "books_log_write":        return await handleBooksLogWrite(args);
        // ---------- Content Sections: Archive / References / Scripts (v11.5.0) ----------
        case "archive_list":            return handleArchiveList(args);
        case "archive_read":            return handleArchiveRead(args);
        case "archive_write":           return await handleArchiveWrite(args);
        case "reference_list":          return handleReferenceList(args);
        case "reference_read":          return handleReferenceRead(args);
        case "reference_write":         return await handleReferenceWrite(args);
        case "script_list":             return handleScriptList(args);
        case "script_read":             return handleScriptRead(args);
        case "script_write":            return await handleScriptWrite(args);
        case "script_execute":          return await handleScriptExecute(args);

        // ---------- Ava User Profiles (v10.8.0) ----------
        case "profile_read":           return await handleProfileRead(args);
        case "profile_write_person": {
          const _profileResult = await handleProfileWritePerson(args);
          // Non-blocking WordPress gateway backup (tenant mode only).
          if (PROFILES_ENABLED && SKILL_BASE_DIR) {
            backupPersonalFileToGateway("PROFILES.md", `${SKILL_BASE_DIR}/PROFILES.md`)
              .catch(() => {});
          }
          return _profileResult;
        }

        // ---------- Ava Memory Sync - durable MySQL backup (v10.1.0) ----------
        case "ava_memory_backup":       return await handleAvaMemoryBackup(args);
        case "ava_memory_restore":      return await handleAvaMemoryRestore(args);
        case "ava_memory_sync_status":  return await handleAvaMemorySyncStatus();

        // ---------- Peer Review: health log tools (v12.5.0 - tenant mode) ----------
        case "health_log_write":         return await handleHealthLogWrite(args);
        case "issue_flag":               return await handleIssueFlag(args);
        case "peer_review_consent_set":  return await handlePeerReviewConsent(args);

        // ---------- Peer Review: check-in tools (v12.5.0 - owner mode) ----------
        case "client_registry_update":  return await handleClientRegistryUpdate(args);
        case "client_checkin":          return await handleClientCheckin(args);
        case "escalation_queue_read":   return await handleEscalationQueueRead(args);

        default:
          // ---------- v10.0.0: Persistent Memory MCP ----------
          if (MEMORY_TOOL_NAMES.has(name)) {
            if (!MEMORY_ENABLED) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        error:
                          "Memory subsystem is disabled. Set AVA_MEMORY_WP_URL+AVA_MEMORY_WP_KEY (MySQL-primary) or MEMORY_AUTH_TOKEN (SQLite fallback) in Railway Variables to enable.",
                        code: "MEMORY_DISABLED",
                      },
                      null,
                      2,
                    ),
                  },
                ],
                isError: true,
              };
            }
            return await dispatchMemoryTool(name, args);
          }
          throw new Error(`Unknown tool: "${name}"`);
      }
}

// -----------------------------------------------------------------------
// MCP Server factory
// -----------------------------------------------------------------------
function createMcpServer() {
  const server = new Server(
    { name: "claude-connector", version: "12.8.2" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Build the effective tool list at request time so that modular mode changes
    // (written via POST /set-modular-mode) take effect without a Railway redeploy.
    // The static TOOLS array is correct for all non-modular tools; we just replace
    // the modular section with a live isModularEnabled() check.
    const MODULAR_TOOL_NAMES = new Set([
      "skill_compile", "skill_load_specialist", "skill_recompile", "personality_write", "dispatch_rule_add", "module_write",
    ]);
    const baseTools = TOOLS.filter(t => !MODULAR_TOOL_NAMES.has(t.name));
    const modularTools = isModularEnabled()
      ? [
          skillCompileToolDefinition,
          skillLoadSpecialistToolDefinition,
          skillRecompileToolDefinition,
          personalityWriteToolDefinition,
          dispatchRuleAddToolDefinition,
          moduleWriteToolDefinition,
        ]
      : [];
    return { tools: [...baseTools, ...modularTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log("info", `Tool: ${name}`);
    try {
      // Dispatch to the central handler (defined above createMcpServer).
      // personality_write / dispatch_rule_add / profile_write_person
      // all include their WordPress gateway backup logic inside dispatchToolCall.
      return await dispatchToolCall(name, args);
    } catch (err) {
      log("error", `Tool "${name}" error: ${err.message}`);
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// -----------------------------------------------------------------------
// Stats / ML help text (v9.0.0)
// -----------------------------------------------------------------------
const STATS_HELP_TEXT = `
Claude Connector  v9.0.0  -  Statistical Analysis & ML Toolkit
${"=".repeat(65)}

DATA MANAGEMENT (load, inspect, transform)
  data_load          Load CSV, TSV, JSON, or Excel files (or inline data)
  data_info          Column types, missing values, unique counts, preview
  data_preview       Show first/last N rows as a table
  data_list          List all loaded datasets with sizes
  data_drop          Remove a dataset from memory
  data_filter        Create a filtered subset (eq, gt, in, not_null, etc.)
  data_select        Keep/rename specific columns
  data_sample        Random sample (by N or fraction, seeded)

DESCRIPTIVE STATISTICS
  stats_describe     Mean, median, SD, IQR, skewness, kurtosis, CV, SE
  stats_frequency    Frequency table with counts and cumulative %
  stats_histogram    Binned distribution with bar visualisation
  stats_crosstab     Cross-tabulation of two categorical columns + chi-square
  stats_normality    Jarque-Bera, D'Agostino-Pearson, Q-Q comparison

INFERENTIAL STATISTICS / HYPOTHESIS TESTS
  stats_ttest        One-sample, two-sample (Welch), or paired t-test
  stats_anova        One-way ANOVA + Tukey HSD post-hoc tests
  stats_chi_square   Chi-square goodness of fit or independence test
  stats_confidence_interval  CI for mean at 90%, 95%, 99%
  stats_mann_whitney Non-parametric two-group comparison (U test)
  stats_proportion_test  One- or two-sample z-test for proportions

REGRESSION & CORRELATION
  stats_correlation       Pearson/Spearman/Kendall correlation matrix
  stats_regression        Simple linear, multiple linear, polynomial, logistic
  stats_partial_correlation  Correlation controlling for covariates

TIME SERIES
  ts_analyze         Trend, stationarity (ADF), ACF, PACF, seasonality
  ts_moving_average  SMA, EMA, WMA with configurable window
  ts_forecast        Holt-Winters, SES, or linear trend forecasting

MACHINE LEARNING
  ml_kmeans          K-Means clustering with elbow method + silhouette score
  ml_pca             Principal Component Analysis with loadings + scores
  ml_knn             K-Nearest Neighbours classifier with cross-validation
  ml_naive_bayes     Gaussian Naive Bayes classifier with cross-validation
  ml_anomaly_detection  Z-score, IQR, Isolation Forest, Mahalanobis
  ml_feature_importance  Rank predictors by correlation/MI/ANOVA F-ratio

TYPICAL WORKFLOW:
  1. data_load        (load your file)
  2. data_info        (understand the structure)
  3. stats_describe   (summarise key columns)
  4. stats_normality  (check distributions)
  5. stats_correlation or stats_regression (analyse relationships)
  6. ml_kmeans or ml_pca (if exploratory/unsupervised)
  7. ml_knn or ml_naive_bayes (if classification needed)

All results include effect sizes, p-values with significance stars,
and plain-English interpretation of findings.
`.trim();

// -----------------------------------------------------------------------
// Express app
// -----------------------------------------------------------------------
const app = express();
// Body limit raised to 50mb (v9.0.0) to support inline-data dataset loading.
app.use(express.json({ limit: "50mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// -----------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------
app.get("/health", (_req, res) => {
  const memorySnapshot = MEMORY_ENABLED
    ? getMemoryHealthSnapshot()
    : { enabled: false };
  res.json({
    status: "ok",
    server: "claude-connector",
    version: "12.8.1",
    memory: memorySnapshot,
    statsAndMlEnabled: true,
    transport: ["streamable-http", "sse-legacy"],
    linkedinOAuth: !!(config.linkedinClientId && config.linkedinClientSecret),
    psychologyEndpoints: true,
    emailSendEnabled: config.emailSendEnabled,
    emailHtmlEnabled: config.emailHtmlEnabled,
    emailTrackingEnabled: config.emailTrackingEnabled,
    scheduleEnabled: config.scheduleEnabled,
    calendarEnabled: !!(config.googleCalendarId),
    sheetsEnabled: !!(config.googleSheetsId),
    slackEnabled: !!(config.slackBotToken),
    teamsEnabled: !!(config.teamsWebhookUrl),
    webhookEnabled: true,
    profilesEnabled: PROFILES_ENABLED,
    timestamp: new Date().toISOString(),
  });
});

// -----------------------------------------------------------------------
// v10.0.0: Persistent Memory admin export
// GET /memory/admin/dump - protected full corpus export (bearer required).
// Returns 404 when the memory subsystem is disabled.
// -----------------------------------------------------------------------
app.get("/memory/admin/dump", (req, res) => {
  if (!MEMORY_ENABLED) {
    res.status(404).json({ error: "Memory subsystem is not enabled." });
    return;
  }
  const header = req.headers["authorization"] || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const supplied = match ? match[1].trim() : "";
  if (!supplied || supplied !== MEMORY_AUTH_TOKEN) {
    res.status(401).json({
      error: "Authorization header missing or invalid.",
      code: "AUTH_REQUIRED",
    });
    return;
  }
  memoryAdminDumpHandler(req, res);
});

// -----------------------------------------------------------------------
// SCOPE-04 -- Tracking endpoints
// -----------------------------------------------------------------------

function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return fwd || req.ip || req.connection?.remoteAddress || "";
}

app.get("/track/open", async (req, res) => {
  // Always return the pixel - never expose validation errors to the recipient
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.status(200).end(PIXEL_PNG);

  if (!config.emailTrackingEnabled) return;

  try {
    const id = String(req.query.id || "");
    if (!id) return;
    const ua = req.headers["user-agent"] || "";
    const ref = req.headers["referer"] || req.headers["referrer"] || "";
    const uaType = classifyUserAgent(ua, ref);
    const ipHash = hashIp(clientIp(req));

    const meta = getSendMetadata(id) || {};
    const open_count = incrementOpen(id);

    appendTrackingEvent({
      tracking_id: id,
      event_type: "open",
      to_address: meta.to_address || "",
      to_name: meta.to_name || "",
      subject: meta.subject || "",
      sender_id: meta.sender_id || "",
      company: meta.company || "",
      send_timestamp: meta.send_timestamp || "",
      click_url: "",
      user_agent_type: uaType,
      open_count,
      schedule_id: meta.schedule_id || "",
      user_agent_raw: ua,
      ip_hash: ipHash,
    }).catch((e) => log("warn", `track/open append failed: ${e.message}`));
  } catch (err) {
    log("warn", `track/open handler error: ${err.message}`);
  }
});

app.get("/track/click", async (req, res) => {
  const SAFE_FALLBACK = "https://truesourceconsulting.com.au";
  let target = SAFE_FALLBACK;

  try {
    const id = String(req.query.id || "");
    const rawUrl = String(req.query.url || "");
    let isValid = false;
    try {
      const u = new URL(rawUrl);
      if (u.protocol === "https:") {
        target = u.toString();
        isValid = true;
      }
    } catch (_) {
      isValid = false;
    }

    if (config.emailTrackingEnabled && id) {
      const ua = req.headers["user-agent"] || "";
      const ref = req.headers["referer"] || req.headers["referrer"] || "";
      const uaType = classifyUserAgent(ua, ref);
      const ipHash = hashIp(clientIp(req));
      const meta = getSendMetadata(id) || {};

      appendTrackingEvent({
        tracking_id: id,
        event_type: "click",
        to_address: meta.to_address || "",
        to_name: meta.to_name || "",
        subject: meta.subject || "",
        sender_id: meta.sender_id || "",
        company: meta.company || "",
        send_timestamp: meta.send_timestamp || "",
        click_url: isValid ? target : "",
        user_agent_type: uaType,
        schedule_id: meta.schedule_id || "",
        user_agent_raw: ua,
        ip_hash: ipHash,
      }).catch((e) => log("warn", `track/click append failed: ${e.message}`));
    }
  } catch (err) {
    log("warn", `track/click handler error: ${err.message}`);
  }

  res.redirect(302, target);
});

// -----------------------------------------------------------------------
// LinkedIn OAuth callback
// -----------------------------------------------------------------------
app.get("/auth/linkedin/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    res.status(400).send(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h2 style="color:#c00">LinkedIn Authorization Failed</h2>
      <p><strong>Error:</strong> ${error}</p><p>${error_description || ""}</p>
      <p>Close this tab and call <code>linkedin_start_oauth</code> again in Claude.</p>
    </body></html>`);
    return;
  }

  if (!code || !state) {
    res.status(400).send(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h2 style="color:#c00">Invalid Callback</h2><p>Missing code or state. Try the authorization flow again.</p>
    </body></html>`);
    return;
  }

  if (!validateAndConsumeState(state)) {
    res.status(400).send(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h2 style="color:#c00">Expired or Invalid State</h2>
      <p>The authorization link expired (10 min limit) or was already used.</p>
      <p>Call <code>linkedin_start_oauth</code> in Claude to get a fresh link.</p>
    </body></html>`);
    return;
  }

  try {
    const tokenResp = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: getLinkedInCredentials().redirectUri,
        client_id: getLinkedInCredentials().clientId,
        client_secret: getLinkedInCredentials().clientSecret,
      }).toString(),
    });

    if (!tokenResp.ok) {
      const errBody = await tokenResp.text().catch(() => "");
      throw new Error(`LinkedIn token exchange failed (${tokenResp.status}): ${errBody}`);
    }

    const tokenData = await tokenResp.json();
    storeToken(tokenData);
    log("info", "LinkedIn token stored successfully");

    const expiresHours = tokenData.expires_in ? Math.round(tokenData.expires_in / 3600) : "unknown";

    res.send(`<html>
    <head><title>LinkedIn Connected</title></head>
    <body style="font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px;text-align:center">
      <div style="background:#e8f5e9;border:2px solid #4caf50;border-radius:10px;padding:40px">
        <h2 style="color:#2e7d32;margin-top:0">LinkedIn Connected!</h2>
        <p style="font-size:16px">Your LinkedIn account is now authorized.</p>
        <p>Close this tab and return to Claude.</p>
      </div>
      <p style="color:#888;font-size:12px;margin-top:20px">Token expires in approx. ${expiresHours} hours</p>
    </body></html>`);
  } catch (err) {
    log("error", `LinkedIn callback error: ${err.message}`);
    res.status(500).send(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h2 style="color:#c00">Server Error</h2><p>${err.message}</p>
      <p>Try <code>linkedin_start_oauth</code> again in Claude.</p>
    </body></html>`);
  }
});

// -----------------------------------------------------------------------
// Streamable HTTP - PRIMARY MCP TRANSPORT FOR CLAUDE.AI
// -----------------------------------------------------------------------
const streamableSessions = {};

// v12.0.0: Tenant authentication gate.
// In tenant mode, validates the API key against the TrueSource Client Gateway
// before the MCP session is allowed to proceed. In owner mode this is a no-op.
app.all("/mcp", tenantAuthMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  try {
    if (sessionId && streamableSessions[sessionId]) {
      await streamableSessions[sessionId].handleRequest(req, res, req.body);
      return;
    }
    if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const server = createMcpServer();
      transport.onclose = () => {
        if (transport.sessionId) { delete streamableSessions[transport.sessionId]; }
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      if (transport.sessionId) {
        streamableSessions[transport.sessionId] = transport;
        log("info", `New session: ${transport.sessionId}`);
      }
      return;
    }
    if (req.method === "GET" && !sessionId) {
      res.status(405).json({ error: "Session required for GET" });
      return;
    }
    res.status(400).json({ error: "Bad request: missing or invalid session" });
  } catch (err) {
    log("error", `MCP error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------------------------------------------------
// Legacy SSE transport
// -----------------------------------------------------------------------
const sseSessions = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseSessions[transport.sessionId] = transport;
  res.on("close", () => { delete sseSessions[transport.sessionId]; });
  await createMcpServer().connect(transport);
});

app.post("/messages", async (req, res) => {
  const transport = sseSessions[req.query.sessionId];
  if (!transport) { res.status(404).json({ error: "Session not found" }); return; }
  await transport.handlePostMessage(req, res, req.body);
});

// -----------------------------------------------------------------------
// Inbound Webhook receiver (v8.0.0)
// -----------------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  if (!validateWebhookSecret(req.headers)) {
    res.status(401).json({ error: "Invalid or missing X-Webhook-Secret header." });
    return;
  }

  let payload = req.body;
  if (!payload || (typeof payload === "object" && Object.keys(payload).length === 0)) {
    // Body may be raw text if content-type is not json
    payload = { raw: String(req.body || "") };
  }

  const sourceIp =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.ip ||
    "";

  try {
    const eventId = enqueueWebhookEvent(payload, sourceIp, req.headers);
    res.status(200).json({ ok: true, event_id: eventId });
  } catch (err) {
    log("error", `webhook enqueue error: ${err.message}`);
    res.status(500).json({ error: "Failed to enqueue event." });
  }
});

// -----------------------------------------------------------------------
// CSV upload endpoint (protected by UPLOAD_API_KEY)
// -----------------------------------------------------------------------
app.post("/upload/connections", async (req, res) => {
  if (!UPLOAD_API_KEY) {
    res.status(403).json({ error: "Upload disabled. Set UPLOAD_API_KEY in Railway Variables." });
    return;
  }
  if ((req.headers["x-upload-key"] || "") !== UPLOAD_API_KEY) {
    res.status(401).json({ error: "Invalid upload key" });
    return;
  }

  const ct = req.headers["content-type"] || "";
  let csvContent = "";
  if (ct.includes("text/csv") || ct.includes("text/plain")) {
    csvContent = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  } else if (req.body?.csv_base64) {
    csvContent = Buffer.from(req.body.csv_base64, "base64").toString("utf-8");
  } else if (req.body?.csv) {
    csvContent = req.body.csv;
  } else {
    res.status(400).json({ error: "Provide CSV as text/csv body, JSON {csv: '...'} or {csv_base64: '...'}" });
    return;
  }

  if (!csvContent?.trim()) { res.status(400).json({ error: "CSV is empty" }); return; }

  const targetPath = config.linkedinCsvPath;
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  try {
    writeFileSync(targetPath, csvContent, "utf-8");
    log("info", `CSV uploaded: ${csvContent.length} bytes`);
    res.json({ success: true, bytes: csvContent.length });
  } catch (err) {
    res.status(500).json({ error: `Write failed: ${err.message}` });
  }
});

// -----------------------------------------------------------------------
// POST /restore-skill
// Receives a canonical SKILL.md push from the WordPress admin "Push to Railway"
// button (ts-ava-skill plugin v1.3.0+). Validates X-Railway-Restore-Token, then
// runs the full canonicalWrite sequence (archive, version increment, WP backup).
// Requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN in Railway Variables.
// -----------------------------------------------------------------------
app.post("/restore-skill", async (req, res) => {
  if (!SKILL_ENABLED) {
    res.status(503).json({ error: "Skill Volume not configured. Set SKILL_FILE_PATH in Railway Variables." });
    return;
  }

  if (!RAILWAY_RESTORE_TOKEN) {
    res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set in Railway Variables. Configure it to enable WordPress restore pushes." });
    return;
  }

  const providedToken = (req.headers["x-railway-restore-token"] || "").trim();

  if (!providedToken) {
    res.status(401).json({ error: "Missing X-Railway-Restore-Token header." });
    return;
  }

  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    res.status(403).json({ error: "Invalid X-Railway-Restore-Token." });
    return;
  }

  const body = req.body || {};

  if (!body.content || typeof body.content !== "string" || !body.content.trim()) {
    res.status(400).json({ error: "content is required and must not be empty." });
    return;
  }

  try {
    const result = await handleSkillRestoreFromWp(body);
    if (result.success) {
      log("info", `restore-skill: ${result.version_id} (${result.line_count} lines) from ${body.source || "wordpress-push"}`);
      res.json(result);
    } else {
      log("error", `restore-skill failed: ${result.error}`);
      res.status(500).json(result);
    }
  } catch (err) {
    log("error", `restore-skill exception: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// POST /restore-books
// Receives a BOOKS_READ.md push from the WordPress admin "Push to Railway"
// button (ts-ava-skill plugin v1.5.0+). Validates X-Railway-Restore-Token,
// then writes the content directly to BOOKS_READ.md on the Railway volume.
// Requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN in Railway Variables.
// -----------------------------------------------------------------------
app.post("/restore-books", async (req, res) => {
  if (!SKILL_ENABLED) {
    res.status(503).json({ error: "Skill Volume not configured. Set SKILL_FILE_PATH in Railway Variables." });
    return;
  }

  if (!RAILWAY_RESTORE_TOKEN) {
    res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set in Railway Variables." });
    return;
  }

  const providedToken = (req.headers["x-railway-restore-token"] || "").trim();

  if (!providedToken) {
    res.status(401).json({ error: "Missing X-Railway-Restore-Token header." });
    return;
  }

  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    res.status(403).json({ error: "Invalid X-Railway-Restore-Token." });
    return;
  }

  const body = req.body || {};

  if (!body.content || typeof body.content !== "string" || !body.content.trim()) {
    res.status(400).json({ error: "content is required and must not be empty." });
    return;
  }

  try {
    const result = await handleBooksRestoreFromWp(body);
    if (result.success) {
      log("info", `restore-books: ${result.entry_count} entries from ${body.source || "wordpress-push"}`);
      res.json(result);
    } else {
      log("error", `restore-books failed: ${result.error}`);
      res.status(500).json(result);
    }
  } catch (err) {
    log("error", `restore-books exception: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// POST /restore-profiles
// Receives a PROFILES.md push from the WordPress admin "Push to Railway"
// button (ts-ava-skill plugin v1.6.0+). Validates X-Railway-Restore-Token,
// then writes the content directly to PROFILES.md on the Railway volume.
// Requires SKILL_FILE_PATH (or PROFILES_FILE_PATH) + RAILWAY_RESTORE_TOKEN.
// -----------------------------------------------------------------------
app.post("/restore-profiles", async (req, res) => {
  if (!PROFILES_ENABLED) {
    res.status(503).json({ error: "Profiles not configured. Set SKILL_FILE_PATH or PROFILES_FILE_PATH in Railway Variables." });
    return;
  }

  if (!RAILWAY_RESTORE_TOKEN) {
    res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set in Railway Variables." });
    return;
  }

  const providedToken = (req.headers["x-railway-restore-token"] || "").trim();

  if (!providedToken) {
    res.status(401).json({ error: "Missing X-Railway-Restore-Token header." });
    return;
  }

  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    res.status(403).json({ error: "Invalid X-Railway-Restore-Token." });
    return;
  }

  const body = req.body || {};

  if (!body.content || typeof body.content !== "string" || !body.content.trim()) {
    res.status(400).json({ error: "content is required and must not be empty." });
    return;
  }

  try {
    const result = await handleProfilesRestoreFromWp(body);
    if (result.success) {
      log("info", `restore-profiles: ${result.person_count} person(s) from ${body.source || "wordpress-push"}`);
      res.json(result);
    } else {
      log("error", `restore-profiles failed: ${result.error}`);
      res.status(500).json(result);
    }
  } catch (err) {
    log("error", `restore-profiles exception: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /restore-modules
// Push all modular skill files from WordPress to Railway volume /data/skill/ava/.
// Body: { files: { "relative/path": "content" }, change_summary?, timestamp?, source? }
// Requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN in Railway Variables.
app.post("/restore-modules", async (req, res) => {
  if (!SKILL_ENABLED) {
    return res.status(404).json({ error: "SKILL_FILE_PATH not set. Cannot restore modules." });
  }
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set in Railway Variables." });
  }
  const providedToken = req.headers["x-railway-restore-token"] || "";
  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token header." });
  }
  try {
    const body = req.body || {};
    const result = await handleModulesRestoreFromWp(body);
    if (!result.success) return res.status(500).json(result);
    log("info", `restore-modules: ${result.files_restored} files restored from ${body.source || "wordpress-push"}`);
    return res.json(result);
  } catch (err) {
    log("error", `restore-modules exception: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /restore-personality
// Push PERSONALITY.md from WordPress to Railway volume /data/skill/ava/PERSONALITY.md.
// Body: { content, change_summary?, timestamp?, source? }
// Requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN in Railway Variables.
app.post("/restore-personality", async (req, res) => {
  if (!SKILL_ENABLED) {
    return res.status(404).json({ error: "SKILL_FILE_PATH not set. Cannot restore personality." });
  }
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set in Railway Variables." });
  }
  const providedToken = req.headers["x-railway-restore-token"] || "";
  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token header." });
  }
  try {
    const body = req.body || {};
    const fileContent = typeof body.content === "string" ? body.content : "";
    if (!fileContent) return res.status(400).json({ error: "content is required" });
    const result = await handleModulesRestoreFromWp({ files: { "PERSONALITY.md": fileContent } });
    log("info", `restore-personality: written from ${body.source || "wordpress-push"}`);
    return res.json({ success: true, message: "PERSONALITY.md restored to Railway volume." });
  } catch (err) {
    log("error", `restore-personality exception: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /restore-dispatch-rules
// Push DISPATCH_RULES.json from WordPress to Railway volume /data/skill/ava/DISPATCH_RULES.json.
// Body: { content, change_summary?, timestamp?, source? }
// Requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN in Railway Variables.
app.post("/restore-dispatch-rules", async (req, res) => {
  if (!SKILL_ENABLED) {
    return res.status(404).json({ error: "SKILL_FILE_PATH not set. Cannot restore dispatch rules." });
  }
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set in Railway Variables." });
  }
  const providedToken = req.headers["x-railway-restore-token"] || "";
  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token header." });
  }
  try {
    const body = req.body || {};
    const fileContent = typeof body.content === "string" ? body.content : "";
    if (!fileContent) return res.status(400).json({ error: "content is required" });
    const result = await handleModulesRestoreFromWp({ files: { "DISPATCH_RULES.json": fileContent } });
    log("info", `restore-dispatch-rules: written from ${body.source || "wordpress-push"}`);
    return res.json({ success: true, message: "DISPATCH_RULES.json restored to Railway volume." });
  } catch (err) {
    log("error", `restore-dispatch-rules exception: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /restore-archive
// Receives archive file(s) push from the WordPress admin "Push to Railway" button.
// Body: { files: { "filename.md": "content" }, change_summary?, source? }
// Requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN in Railway Variables.
app.post("/restore-archive", async (req, res) => {
  if (!SKILL_ENABLED) {
    return res.status(503).json({ error: "SKILL_FILE_PATH not set. Cannot restore archive." });
  }
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set in Railway Variables." });
  }
  const providedToken = req.headers["x-railway-restore-token"] || "";
  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token header." });
  }
  try {
    const body   = req.body || {};
    const result = await handleArchiveRestoreFromWp(body);
    if (!result.success) return res.status(500).json(result);
    log("info", `restore-archive: ${result.files_restored} files restored from ${body.source || "wordpress-push"}`);
    return res.json(result);
  } catch (err) {
    log("error", `restore-archive exception: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /restore-references
// Receives reference file(s) push from the WordPress admin "Push to Railway" button.
// Body: { files: { "filename.md": "content" }, change_summary?, source? }
// Requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN in Railway Variables.
app.post("/restore-references", async (req, res) => {
  if (!SKILL_ENABLED) {
    return res.status(503).json({ error: "SKILL_FILE_PATH not set. Cannot restore references." });
  }
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set in Railway Variables." });
  }
  const providedToken = req.headers["x-railway-restore-token"] || "";
  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token header." });
  }
  try {
    const body   = req.body || {};
    const result = await handleReferenceRestoreFromWp(body);
    if (!result.success) return res.status(500).json(result);
    log("info", `restore-references: ${result.files_restored} files restored from ${body.source || "wordpress-push"}`);
    return res.json(result);
  } catch (err) {
    log("error", `restore-references exception: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /restore-scripts
// Receives script file(s) push from the WordPress admin "Push to Railway" button.
// Body: { files: { "extract_somatic.py": "content" }, change_summary?, source? }
// Requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN in Railway Variables.
app.post("/restore-scripts", async (req, res) => {
  if (!SKILL_ENABLED) {
    return res.status(503).json({ error: "SKILL_FILE_PATH not set. Cannot restore scripts." });
  }
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set in Railway Variables." });
  }
  const providedToken = req.headers["x-railway-restore-token"] || "";
  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token header." });
  }
  try {
    const body   = req.body || {};
    const result = await handleScriptRestoreFromWp(body);
    if (!result.success) return res.status(500).json(result);
    log("info", `restore-scripts: ${result.files_restored} files restored from ${body.source || "wordpress-push"}`);
    return res.json(result);
  } catch (err) {
    log("error", `restore-scripts exception: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});


// -----------------------------------------------------------------------
// GET /tools  (v12.8.0)
// Returns the effective tool manifest for the current connector instance.
// The Tenax Intelligence gateway calls this on each /stream request to
// discover which tools are available, then registers them with the LLM.
// Cached by the gateway (10-minute TTL per connector URL).
//
// Auth:    X-Railway-Restore-Token
// Returns: { tools: [{ name, description, input_schema }], count: N }
// -----------------------------------------------------------------------
app.get("/tools", (req, res) => {
  const token = (req.headers["x-railway-restore-token"] || "").trim();
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set. Cannot authenticate tool manifest requests." });
  }
  if (token !== RAILWAY_RESTORE_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token." });
  }

  // Mirror the ListTools dynamic logic: swap out modular tools based on
  // the mode file, which can be toggled without a Railway redeploy.
  const MODULAR_TOOL_NAMES = new Set([
    "skill_compile", "skill_load_specialist", "skill_recompile",
    "personality_write", "dispatch_rule_add", "module_write",
  ]);
  const baseTools    = TOOLS.filter(t => !MODULAR_TOOL_NAMES.has(t.name));
  const modularTools = isModularEnabled()
    ? [
        skillCompileToolDefinition,
        skillLoadSpecialistToolDefinition,
        skillRecompileToolDefinition,
        personalityWriteToolDefinition,
        dispatchRuleAddToolDefinition,
        moduleWriteToolDefinition,
      ]
    : [];

  const effectiveTools = [...baseTools, ...modularTools];

  // Normalise MCP inputSchema (camelCase) to Anthropic input_schema (snake_case)
  // so the gateway can pass these directly to the Anthropic / OpenAI-compat APIs.
  const tools = effectiveTools.map(t => ({
    name:         t.name,
    description:  t.description || "",
    input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {}, required: [] },
  }));

  log("info", `[/tools] manifest requested: ${tools.length} tools`);
  return res.json({ tools, count: tools.length });
});

// -----------------------------------------------------------------------
// POST /tool-call  (v12.8.0)
// Executes a single named tool and returns its result as JSON.
// The Tenax Intelligence gateway calls this when the LLM selects a tool
// that is not handled locally by the gateway (proxied tool calls).
//
// Auth:    X-Railway-Restore-Token
// Body:    { tool_name: string, tool_input: object }
// Returns: { result: string, is_error: boolean }
//
// The result is always a string (the text from the MCP content block).
// Callers should treat it as they would a raw tool result string.
// -----------------------------------------------------------------------
app.post("/tool-call", async (req, res) => {
  const token = (req.headers["x-railway-restore-token"] || "").trim();
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set. Cannot authenticate tool-call requests." });
  }
  if (token !== RAILWAY_RESTORE_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token." });
  }

  const { tool_name, tool_input } = req.body || {};

  if (!tool_name || typeof tool_name !== "string" || !tool_name.trim()) {
    return res.status(400).json({ error: "tool_name is required and must be a non-empty string." });
  }

  log("info", `[/tool-call] dispatching: ${tool_name}`);

  try {
    const mcpResult = await dispatchToolCall(tool_name.trim(), tool_input || {});

    // Extract the primary text content from the MCP result.
    // Most tools return a single text block; we join multiples with newlines.
    const text = Array.isArray(mcpResult?.content)
      ? mcpResult.content
          .filter(b => b.type === "text")
          .map(b => b.text || "")
          .join("\n")
      : JSON.stringify(mcpResult ?? "");

    return res.json({
      result:   text,
      is_error: Boolean(mcpResult?.isError),
    });

  } catch (err) {
    log("error", `[/tool-call] ${tool_name} error: ${err.message}`);
    // Return 404 for unknown tools so the gateway can distinguish
    // "tool not found" from "tool failed".
    const statusCode = err.message.startsWith("Unknown tool") ? 404 : 500;
    return res.status(statusCode).json({ error: err.message, is_error: true });
  }
});
// GET /download/:filename
// Serves a file from the script execute output directory.
// Files are written there by script_execute with return_files.
// Auth: X-Railway-Restore-Token
app.get( '/download/:filename', ( req, res ) => {
  const token = ( req.headers[ 'x-railway-restore-token' ] || '' ).trim();
  if ( ! RAILWAY_RESTORE_TOKEN || token !== RAILWAY_RESTORE_TOKEN ) {
    return res.status( 401 ).json( { error: 'Invalid token.' } );
  }

  const filename    = req.params.filename;
  const safeName    = path.basename( filename ); // prevent traversal
  const filePath    = path.join( '/data/skill/ava/archive', safeName );

  if ( ! existsSync( filePath ) ) {
    return res.status( 404 ).json( { error: `File not found: ${ safeName }` } );
  }

  const ext      = path.extname( safeName ).toLowerCase();
  const mimeMap  = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pdf':  'application/pdf',
    '.csv':  'text/csv',
    '.txt':  'text/plain',
    '.html': 'text/html',
    '.json': 'application/json',
  };

  res.setHeader( 'Content-Type', mimeMap[ ext ] || 'application/octet-stream' );
  res.setHeader( 'Content-Disposition', `attachment; filename="${ safeName }"` );
  res.sendFile( filePath );
} );
// -----------------------------------------------------------------------
// 404
// -----------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Modular mode read/write endpoints (v11.3.0)
// GET  /modular-mode         - returns effective mode, source, and env var value (no auth)
// POST /set-modular-mode     - writes .modular_mode file (requires X-Railway-Restore-Token)
//
// The mode file is checked by isModularEnabled() on every ListTools request,
// so toggling takes effect at the start of the next Claude session without
// a Railway redeploy. The file overrides SKILL_MODULAR_ENABLED env var when present.
// ---------------------------------------------------------------------------

app.get("/modular-mode", (_req, res) => {
  if (!SKILL_ENABLED) {
    return res.status(503).json({ error: "Skill volume not configured (SKILL_FILE_PATH not set)." });
  }
  res.json(getModularModeStatus());
});

app.post("/set-modular-mode", (req, res) => {
  if (!SKILL_ENABLED) {
    return res.status(503).json({ error: "Skill volume not configured (SKILL_FILE_PATH not set)." });
  }
  const token = req.headers["x-railway-restore-token"] || "";
  if (!RAILWAY_RESTORE_TOKEN || token !== RAILWAY_RESTORE_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token." });
  }
  const body    = req.body || {};
  const enabled = body.enabled;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled (boolean) is required in request body." });
  }
  const modePath = getModeFilePath();
  try {
    const dir = modePath.replace(/[/\\][^/\\]+$/, "");
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(modePath, String(enabled), "utf8");
    log("info", `set-modular-mode: mode file written -> ${enabled}`);
    const status = getModularModeStatus();
    return res.json({
      success:  true,
      enabled,
      previous: !enabled,
      status,
      note: "Mode file written. Takes effect at the start of the next Claude session (new MCP connection). No Railway redeploy needed.",
    });
  } catch (err) {
    log("error", `set-modular-mode: failed to write mode file: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /skill-export  (v12.2.2)
// Export all non-personal skill files from this connector's Railway volume.
// Paths returned are relative to the ava content directory — NO leading 'ava/'
// prefix — so they are directly usable by the gateway's /restore-modules endpoint.
//
// avaDir resolution (handles both common SKILL_FILE_PATH layouts):
//   /data/skill/SKILL.md     → SKILL_BASE_DIR=/data/skill     → avaDir=/data/skill/ava
//   /data/skill/ava/SKILL.md → SKILL_BASE_DIR=/data/skill/ava → avaDir=/data/skill/ava
//
// Auth: X-Railway-Restore-Token
// Response: { files: { "relative/path": "content" }, file_count: N, ava_dir: string }

app.get("/skill-export", (req, res) => {
  if (!SKILL_ENABLED || !SKILL_BASE_DIR) {
    return res.status(503).json({ error: "SKILL_FILE_PATH not set. Skill volume not configured." });
  }
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set. Configure it in Railway Variables." });
  }

  const providedToken = (req.headers["x-railway-restore-token"] || "").trim();
  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    return res.status(403).json({ error: "Invalid X-Railway-Restore-Token." });
  }

  // Determine the ava content directory regardless of SKILL_FILE_PATH layout
  const avaDir = SKILL_BASE_DIR.endsWith("/ava")
    ? SKILL_BASE_DIR
    : (SKILL_BASE_DIR + "/ava");

  if (!existsSync(avaDir)) {
    return res.status(503).json({
      error: `ava content directory not found at ${avaDir}. Push skill files to this connector first.`,
      ava_dir: avaDir,
    });
  }

  const PERSONAL_FILES = new Set(["PERSONALITY.md", "PROFILES.md"]);
  const files = {};

  function walkDir(absDir) {
    if (!existsSync(absDir)) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      log("warn", `skill-export: cannot read dir ${absDir}: ${e.message}`);
      return;
    }
    for (const entry of entries) {
      const absPath = `${absDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walkDir(absPath);
      } else if (entry.isFile()) {
        // Relative to avaDir — no leading 'ava/' prefix
        const relPath = absPath.slice(avaDir.length).replace(/^\//, "");
        if (PERSONAL_FILES.has(entry.name)) continue;
        if (entry.name.startsWith("."))      continue;
        if (!/\.(md|json|py|sh|js|ts|txt)$/i.test(entry.name)) continue;
        try {
          files[relPath] = readFileSync(absPath, "utf8");
        } catch (e) {
          log("warn", `skill-export: cannot read file ${absPath}: ${e.message}`);
        }
      }
    }
  }

  try {
    walkDir(avaDir);
    const fileCount = Object.keys(files).length;
    log("info", `skill-export: exported ${fileCount} files from ${avaDir}`);
    return res.json({ files, file_count: fileCount, ava_dir: avaDir });
  } catch (err) {
    log("error", `skill-export exception: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});


// POST /ti-skill-compile  (v12.7.0)
// ---------------------------------------------------------------------------
// Gateway-to-connector skill compilation endpoint for the Tenax Intelligence
// platform. Exposes handleSkillCompile() as a direct REST call so the TI
// gateway can fetch the compiled skill without needing an MCP client.
//
// Auth:    X-Railway-Restore-Token (same token as /skill-export and /restore-skill).
// Gating: Requires SKILL_ENABLED=true AND SKILL_MODULAR_ENABLED=true.
//         Returns 503 if either is not configured.
//
// Request body:
//   { query, context_hint, person_name, session_id }
//
// Response 200:
//   {
//     skill:            string,   // Full compiled skill text (CORE + modules + personality)
//     specialist_count: number,   // Specialist modules loaded
//     line_count:       number,   // Total compiled lines
//     modules_loaded:   string[], // Module names in load order
//     session_id:       string,
//     conditions:       string[], // Conditions detected from query
//     person_prior_active: bool,
//     note:             string,   // Human-readable compile summary
//   }
//
// Response 503: Not configured (modular mode off or token missing)
// Response 403: Invalid token
// Response 500: Compile error (check MANIFEST.json and CORE.md)
// ---------------------------------------------------------------------------

app.post("/ti-skill-compile", async (req, res) => {
  if (!SKILL_ENABLED) {
    return res.status(503).json({
      error: "Skill system not configured.",
      hint:  "Set SKILL_FILE_PATH in Railway Variables.",
    });
  }

  // SKILL_MODULAR_ENABLED is NOT checked here. handleSkillCompile() manages
  // its own path detection and returns a graceful error if modular files are
  // missing. The MCP skill_compile tool works the same way -- it never gates
  // on this flag. Removing this guard makes the HTTP endpoint consistent.

  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({
      error: "RAILWAY_RESTORE_TOKEN not set in Railway Variables.",
      hint:  "Set RAILWAY_RESTORE_TOKEN to enable this endpoint.",
    });
  }

  const providedToken = (req.headers["x-railway-restore-token"] || "").trim();
  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    return res.status(403).json({ error: "Invalid X-Railway-Restore-Token." });
  }

  const {
    query               = "",
    context_hint        = "",
    person_name         = "",
    session_id          = new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    module_access_level = "full",
  } = req.body || {};

  try {
    const result = await handleSkillCompile({ query, context_hint, person_name, session_id, module_access_level });

    if (result.isError) {
      let parsed = {};
      try { parsed = JSON.parse(result.content?.[0]?.text || "{}"); } catch { /* ignore */ }
      log("error", `[ti-skill-compile] compile error: ${parsed.error || "unknown"}`);
      return res.status(500).json({ error: parsed.error || "skill_compile failed.", hint: parsed.hint });
    }

    let parsed = {};
    try { parsed = JSON.parse(result.content[0].text); } catch { /* ignore */ }

    log("info", `[ti-skill-compile] compiled for session ${session_id}: ${parsed.specialist_count} specialists, ${parsed.line_count} lines`);

    return res.json({
      skill:               parsed.content        || "",
      specialist_count:    parsed.specialist_count || 0,
      line_count:          parsed.line_count       || 0,
      modules_loaded:      parsed.modules_loaded   || [],
      session_id:          parsed.session_id       || session_id,
      conditions:          parsed.conditions_detected || [],
      person_prior_active: parsed.person_prior_active || false,
      note:                parsed.note             || "",
    });

  } catch (err) {
    log("error", `[ti-skill-compile] exception: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /ti-skill-check-scope  (v12.9.0)
// Mid-session skill scope check. Called by the Tenax gateway at turns 2, 5, and 10
// to detect whether the conversation has entered territory requiring specialist
// modules not loaded at initial compile time. Returns delta module content only.
// Auth: X-Railway-Restore-Token (same as /ti-skill-compile).
app.post("/ti-skill-check-scope", async (req, res) => {
  if (!SKILL_ENABLED) {
    return res.status(503).json({ error: "Skill system not configured.", hint: "Set SKILL_FILE_PATH in Railway Variables." });
  }
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set.", hint: "Set RAILWAY_RESTORE_TOKEN to enable this endpoint." });
  }
  const providedToken = (req.headers["x-railway-restore-token"] || "").trim();
  if (providedToken !== RAILWAY_RESTORE_TOKEN) {
    return res.status(403).json({ error: "Invalid X-Railway-Restore-Token." });
  }

  const { conversation_text, loaded_modules = [], session_id } = req.body || {};
  if (!conversation_text || typeof conversation_text !== "string") {
    return res.status(400).json({ error: "conversation_text is required." });
  }

  try {
    const manifestPath = SKILL_BASE_DIR ? pathJoin(SKILL_BASE_DIR, "MANIFEST.json") : null;
    if (!manifestPath || !existsSync(manifestPath)) {
      return res.json({ new_modules: [], modules_loaded: loaded_modules, delta_content: null, checked_at: new Date().toISOString() });
    }

    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch {
      return res.json({ new_modules: [], modules_loaded: loaded_modules, delta_content: null, checked_at: new Date().toISOString() });
    }

    const modules   = manifest.modules || {};
    const loadedSet = new Set(loaded_modules);
    const ALWAYS_LOADED = new Set(["meta-trigger-recognition", "meta-dispatcher-routing", "meta-self-check", "meta-llm-environment", "meta-deepseek-counterpull", "meta-perplexity-counterpull"]);
    const SCORE_THRESHOLD   = 0.3;
    const MAX_NEW_PER_CHECK = 3;
    const lower = conversation_text.toLowerCase();

    const candidates = [];
    for (const [moduleId, entry] of Object.entries(modules)) {
      if (loadedSet.has(moduleId) || ALWAYS_LOADED.has(moduleId)) continue;
      const triggers = entry.dispatch_triggers || entry.triggers || [];
      if (!triggers.length) continue;
      let matchCount = 0;
      for (const t of triggers) {
        const tl = String(t).toLowerCase().trim();
        if (!tl) continue;
        if (lower.includes(tl)) { matchCount += 1.0; continue; }
        const words = tl.split(/\s+/).filter(w => w.length > 3);
        if (words.length) {
          const matched = words.filter(w => lower.includes(w)).length;
          if (matched > 0) matchCount += (matched / words.length) * 0.7;
        }
      }
      const score = Math.min(matchCount / Math.max(triggers.length, 1), 1.0);
      if (score >= SCORE_THRESHOLD) candidates.push({ moduleId, score, entry });
    }
    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates.slice(0, MAX_NEW_PER_CHECK);

    const newModules    = [];
    const triggerMatches = {};
    const chunks        = [];
    const modulesDir    = pathJoin(SKILL_BASE_DIR, "modules");

    for (const { moduleId, score, entry } of selected) {
      const paths = [
        pathJoin(modulesDir, moduleId + ".md"),
        pathJoin(SKILL_BASE_DIR, moduleId + ".md"),
      ];
      let content = null;
      for (const p of paths) {
        if (existsSync(p)) { content = readFileSync(p, "utf8"); break; }
      }
      if (!content) { log("warn", `[ti-skill-check-scope] Module file not found: ${moduleId}`); continue; }

      newModules.push(moduleId);
      triggerMatches[moduleId] = { score: Math.round(score * 100) / 100, triggers: (entry.dispatch_triggers || entry.triggers || []).slice(0, 5) };
      const body = content.replace(/^---[\s\S]*?---[\s]*?\n/m, "").trim();
      chunks.push(`### Module: ${moduleId}\n\n${body}`);
    }

    const sep = "\n\n---\n\n";
    const deltaContent = chunks.length
      ? `\n\n---\n\n## Mid-Session Specialist Modules\n\n${chunks.join(sep)}\n\n---\n`
      : null;

    log("info", `[ti-skill-check-scope] session=${session_id || "?"} new=${newModules.join(",") || "none"}`);
    return res.json({
      new_modules:     newModules,
      modules_loaded:  [...loaded_modules, ...newModules],
      delta_content:   deltaContent,
      trigger_matches: Object.keys(triggerMatches).length ? triggerMatches : undefined,
      checked_at:      new Date().toISOString(),
    });

  } catch (err) {
    log("error", `[ti-skill-check-scope] exception: ${err.message}`);
    return res.status(500).json({
      error: err.message, new_modules: [], modules_loaded: loaded_modules, delta_content: null, checked_at: new Date().toISOString(),
    });
  }
});


app.use((_req, res) => {
  res.status(404).json({
    error: "Not found",
    endpoints: {
      mcp:                   "POST /mcp",
      health:                "GET /health",
      restoreSkill:          "POST /restore-skill (X-Railway-Restore-Token required)",
      restoreBooks:          "POST /restore-books (X-Railway-Restore-Token required)",
      restoreProfiles:       "POST /restore-profiles (X-Railway-Restore-Token required)",
      restoreModules:        "POST /restore-modules (X-Railway-Restore-Token required)",
      restorePersonality:    "POST /restore-personality (X-Railway-Restore-Token required)",
      restoreDispatchRules:  "POST /restore-dispatch-rules (X-Railway-Restore-Token required)",
      restoreArchive:        "POST /restore-archive (X-Railway-Restore-Token required)",
      restoreReferences:     "POST /restore-references (X-Railway-Restore-Token required)",
      restoreScripts:        "POST /restore-scripts (X-Railway-Restore-Token required)",
      modularModeGet:        "GET /modular-mode (no auth)",
      modularModeSet:        "POST /set-modular-mode (X-Railway-Restore-Token required)",
      tiSkillCompile:        "POST /ti-skill-compile (X-Railway-Restore-Token required)",
      toolManifest:          "GET  /tools (X-Railway-Restore-Token required)",
      toolCall:              "POST /tool-call (X-Railway-Restore-Token required)",
      linkedinCallback:      "GET /auth/linkedin/callback",
      trackOpen:             "GET /track/open?id=...",
      trackClick:            "GET /track/click?id=...&url=...",
      upload:                "POST /upload/connections",
      webhook:               "POST /webhook",
    },
  });
});

// -----------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------
const httpServer = createServer(app);
httpServer.listen(PORT, HOST, () => {
  log("info", `claude-connector v12.8.2 on http://${HOST}:${PORT}`);
  log("info", `MCP: http://${HOST}:${PORT}/mcp (NO auth - open for claude.ai)`);
  log("info", `LinkedIn OAuth: ${config.linkedinClientId ? "CONFIGURED" : "not configured"}`);
  log("info", `Email send: ${config.emailSendEnabled ? "ENABLED" : "disabled"} | ` +
    `HTML: ${config.emailHtmlEnabled ? "ENABLED" : "disabled"} | ` +
    `Tracking: ${config.emailTrackingEnabled ? "ENABLED" : "disabled"} | ` +
    `Scheduling: ${config.scheduleEnabled ? "ENABLED" : "disabled"}`);
  log("info", `Tracking endpoints: GET /track/open, GET /track/click`);
  log("info", "Psychology endpoints: ENABLED (emotion/taxonomy, sentiment/analyze, alignment/assess)");
  log("info", `Calendar: ${config.googleCalendarId || "primary"} | Sheets: ${config.googleSheetsId || "not configured"}`);
  log("info", `Slack: ${config.slackBotToken ? "CONFIGURED" : "not configured"} | Teams: ${config.teamsWebhookUrl ? "CONFIGURED" : "not configured"}`);
  log("info", `Webhook receiver: POST /webhook | Secret: ${config.webhookSecret ? "CONFIGURED" : "OPEN (set WEBHOOK_SECRET)"}`);
  log("info", `Web page fetch: ENABLED (web_fetch_page)`);
  log("info", `Drive overwrite: google_drive_overwrite_file | Legacy google_drive_upload: REMOVED`);

  log(
    "info",
    `Memory MCP: ${MEMORY_ENABLED ? "ENABLED" : "disabled (set AVA_MEMORY_WP_URL+AVA_MEMORY_WP_KEY or MEMORY_AUTH_TOKEN to enable)"}`,
  );

  log(
    "info",
    `Skill Volume: ${SKILL_ENABLED ? `ENABLED (${process.env.SKILL_FILE_PATH}) — skill_read, skill_write, skill_write_addition, skill_merge_additions, skill_history, skill_rollback, skill_audit` : "disabled (set SKILL_FILE_PATH to enable)"}`,
  );
  log("info", `Skill restore endpoint: ${SKILL_ENABLED && RAILWAY_RESTORE_TOKEN ? "ENABLED (POST /restore-skill)" : SKILL_ENABLED ? "disabled (set RAILWAY_RESTORE_TOKEN)" : "disabled (SKILL_FILE_PATH not set)"}`);
  log("info", `Books restore endpoint: ${SKILL_ENABLED && RAILWAY_RESTORE_TOKEN ? "ENABLED (POST /restore-books)" : "disabled (requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN)"}`);
  log("info", `Profiles: ${PROFILES_ENABLED ? "ENABLED (profile_read, profile_write_person)" : "disabled (set SKILL_FILE_PATH or PROFILES_FILE_PATH to enable)"}`);
  log("info", `Profiles restore endpoint: ${PROFILES_ENABLED && RAILWAY_RESTORE_TOKEN ? "ENABLED (POST /restore-profiles)" : "disabled (requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN)"}`);
    logTenantModeStatus();
    if ( isTenantMode() ) initDevice();
    registerProvisionRoute(app);
  log("info", `Modular skill: env_var=${process.env.SKILL_MODULAR_ENABLED || "not set"} | effective=${isModularEnabled() ? "ENABLED" : "disabled"} | runtime toggle: GET /modular-mode, POST /set-modular-mode`);
  log("info", `Person-aware dispatch: AVA_PERSON_PRIOR_ENABLED=${process.env.AVA_PERSON_PRIOR_ENABLED || "not set (defaults true)"}`);
  log("info", `Module restore endpoints: ${SKILL_ENABLED && RAILWAY_RESTORE_TOKEN ? "ENABLED (POST /restore-modules, /restore-personality, /restore-dispatch-rules)" : "disabled (requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN)"}`);
  log("info", `Content sections: ${SKILL_ENABLED ? "ENABLED (archive_list/read/write, reference_list/read/write, script_list/read/write)" : "disabled (set SKILL_FILE_PATH)"}`);
  log("info", `Content restore endpoints: ${SKILL_ENABLED && RAILWAY_RESTORE_TOKEN ? "ENABLED (POST /restore-archive, /restore-references, /restore-scripts)" : "disabled (requires SKILL_FILE_PATH + RAILWAY_RESTORE_TOKEN)"}`);
  log("info", `module_write: ${SKILL_ENABLED ? (isModularEnabled() ? "ENABLED (modular mode active)" : "disabled (modular mode off)") : "disabled (set SKILL_FILE_PATH)"}`);;

  // Boot the in-process scheduler (loads schedule_store.json + starts cron)
  try {
    startScheduler();
  } catch (err) {
    log("error", `Scheduler boot failed: ${err.message}`);
  }
});

process.on("SIGINT",  () => { httpServer.close(() => process.exit(0)); });
process.on("SIGTERM", () => { httpServer.close(() => process.exit(0)); });
