// src/index.js  v9.0.0
// Stdio MCP server - for Claude Desktop usage
//
// v9.0.0 (major release): Consolidated former stats-connector (data-analysis)
// into claude-connector. All previous claude-connector v8.0.0 capabilities are
// preserved. Adds 35 statistical / machine-learning tools (data_*, stats_*,
// ts_*, ml_*, plus stats_help).
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
  googleDriveListToolDefinition,
  handleGoogleDriveList,
  googleDriveCheckConnectionToolDefinition,
  googleDriveSearchFilesToolDefinition,
  googleDriveReadFileContentToolDefinition,
  googleDriveDownloadFileContentToolDefinition,
  googleDriveCreateFileToolDefinition,
  googleDriveOverwriteFileToolDefinition,
  googleDriveGetFileMetadataToolDefinition,
  googleDriveListRecentFilesToolDefinition,
  googleDriveGetFilePermissionsToolDefinition,
  handleGoogleDriveCheckConnection,
  handleGoogleDriveSearchFiles,
  handleGoogleDriveReadFileContent,
  handleGoogleDriveDownloadFileContent,
  handleGoogleDriveCreateFile,
  handleGoogleDriveOverwriteFile,
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
  wpGetContentToolDefinition,
  handleWpGetContent,
} from "./tools/wordpress.js";
import {
  emailReplyCheckToolDefinition,
  handleEmailReplyCheck,
} from "./tools/emailTracking.js";

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

import { getCurrentDateTime } from "./utils/helpers.js";
import { log } from "./utils/logger.js";

const server = new Server(
  { name: "claude-connector", version: "9.0.0" },
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
  wpGetContentToolDefinition,
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
  // TrueSource outreach email
  emailSendToolDefinition,
  emailGetConfigToolDefinition,
  emailGetSenderProfilesToolDefinition,
  emailValidateAddressToolDefinition,
  emailGetTrackingToolDefinition,
  emailTrackingSummaryToolDefinition,
  emailReplyCheckToolDefinition,
  emailScheduleToolDefinition,
  emailScheduleCancelToolDefinition,
  emailScheduleListToolDefinition,
  // Calendar
  calendarListEventsToolDefinition,
  calendarCreateEventToolDefinition,
  calendarUpdateEventToolDefinition,
  calendarDeleteEventToolDefinition,
  // Sheets
  sheetsGetMetadataToolDefinition,
  sheetsReadRangeToolDefinition,
  sheetsWriteRangeToolDefinition,
  sheetsAppendRowsToolDefinition,
  // Webhook
  webhookPollEventsToolDefinition,
  webhookClearEventsToolDefinition,
  webhookQueueStatusToolDefinition,
  // Messaging
  slackSendMessageToolDefinition,
  teamsSendMessageToolDefinition,
  // Web fetch
  webFetchPageToolDefinition,

  // ---------- v9.0.0: Statistical analysis & ML ----------
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
      case "wordpress_get_content":        return await handleWpGetContent(args);
      case "google_drive_list":                  return await handleGoogleDriveList(args);
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
      // SCOPE-01 / SCOPE-03 email
      case "email_send":                   return await handleEmailSend(args);
      case "email_get_config":             return await handleEmailGetConfig(args);
      case "email_get_sender_profiles":    return await handleEmailGetSenderProfiles(args);
      case "email_validate_address":       return await handleEmailValidateAddress(args);
      // SCOPE-04 tracking
      case "email_get_tracking":           return await handleEmailGetTracking(args);
      case "email_tracking_summary":       return await handleEmailTrackingSummary(args);
      case "email_reply_check":            return await handleEmailReplyCheck(args);
      // SCOPE-05 scheduling
      case "email_schedule":               return await handleEmailSchedule(args);
      case "email_schedule_cancel":        return await handleEmailScheduleCancel(args);
      case "email_schedule_list":          return await handleEmailScheduleList(args);
      // Calendar
      case "calendar_list_events":   return await handleCalendarListEvents(args);
      case "calendar_create_event":  return await handleCalendarCreateEvent(args);
      case "calendar_update_event":  return await handleCalendarUpdateEvent(args);
      case "calendar_delete_event":  return await handleCalendarDeleteEvent(args);
      // Sheets
      case "sheets_get_metadata":    return await handleSheetsGetMetadata(args);
      case "sheets_read_range":      return await handleSheetsReadRange(args);
      case "sheets_write_range":     return await handleSheetsWriteRange(args);
      case "sheets_append_rows":     return await handleSheetsAppendRows(args);
      // Webhook (stdio mode - polling only, no HTTP receiver)
      case "webhook_poll_events":    return await handleWebhookPollEvents(args);
      case "webhook_clear_events":   return await handleWebhookClearEvents(args);
      case "webhook_queue_status":   return await handleWebhookQueueStatus(args);
      // Messaging
      case "slack_send_message":     return await handleSlackSendMessage(args);
      case "teams_send_message":     return await handleTeamsSendMessage(args);
      // Web fetch
      case "web_fetch_page":         return await handleWebFetchPage(args);

      // ---------- v9.0.0: Statistical analysis & ML ----------
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Start the in-process scheduler so deferred sends fire even in stdio mode.
  try {
    startScheduler();
  } catch (err) {
    log("error", `Scheduler bootstrap error: ${err.message}`);
  }
  log("info", "claude-connector v9.0.0 running via stdio");
}

main().catch((err) => {
  log("error", "Fatal startup error", err.message);
  process.exit(1);
});
