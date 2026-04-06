// tools/credentials.js
//
// MCP tools for setting WordPress and LinkedIn credentials at runtime
// from within the Claude environment, without touching Railway environment
// variables.
//
// TOOLS PROVIDED:
//   set_wordpress_credentials     - stores WP site URL, username, and app password
//   get_wordpress_credentials     - shows current WordPress config status (no passwords)
//   clear_wordpress_credentials   - removes runtime-stored WP credentials
//   set_linkedin_credentials      - stores LinkedIn OAuth client ID and secret
//   get_linkedin_credentials      - shows current LinkedIn config status (no secrets)
//   clear_linkedin_credentials    - removes runtime-stored LinkedIn credentials

import { log } from "../utils/logger.js";
import {
  setWordPressCredentials,
  getWordPressStatus,
  clearWordPressCredentials,
  setLinkedInCredentials,
  getLinkedInStatus,
  clearLinkedInCredentials,
} from "../utils/credentialStore.js";

// -----------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------

export const setWordPressCredentialsToolDefinition = {
  name: "set_wordpress_credentials",
  description:
    "Stores WordPress connection credentials so Claude can publish articles and pages to your " +
    "WordPress site. Credentials are saved to the connector's data directory and persist for the " +
    "lifetime of the current deployment. You only need to call this once — credentials are " +
    "remembered until you call clear_wordpress_credentials or redeploy the connector.\n\n" +
    "Required: your WordPress site URL, your WordPress username, and an Application Password " +
    "(created in WordPress Admin > Users > Your Profile > Application Passwords).",
  inputSchema: {
    type: "object",
    properties: {
      wp_url: {
        type: "string",
        description:
          "Your WordPress site URL, e.g. https://yoursite.com — include the protocol, no trailing slash.",
      },
      wp_username: {
        type: "string",
        description:
          "Your WordPress login username (the one you use to log into /wp-admin).",
      },
      wp_password: {
        type: "string",
        description:
          "Your WordPress Application Password. Create one in WordPress Admin > Users > Your Profile > " +
          "Application Passwords. Enter a name like 'Claude Connector' and click 'Add New'. " +
          "Copy the generated password (shown only once). It looks like: xxxx xxxx xxxx xxxx xxxx xxxx",
      },
    },
    required: ["wp_url", "wp_username", "wp_password"],
  },
};

export const getWordPressCredentialsToolDefinition = {
  name: "get_wordpress_credentials",
  description:
    "Returns the current WordPress connection status — whether credentials are configured, " +
    "where they came from (runtime store vs Railway environment variables), and the site URL. " +
    "Passwords are never shown. Call this to confirm WordPress is ready before publishing.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const clearWordPressCredentialsToolDefinition = {
  name: "clear_wordpress_credentials",
  description:
    "Removes the WordPress credentials that were stored via set_wordpress_credentials. " +
    "If WordPress environment variables (WP_URL, WP_USERNAME, WP_APP_PASSWORD) are set in " +
    "Railway, those will still be used as a fallback. " +
    "Use this to switch to a different WordPress site.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const setLinkedInCredentialsToolDefinition = {
  name: "set_linkedin_credentials",
  description:
    "Stores LinkedIn OAuth 2.0 application credentials so Claude can perform live LinkedIn " +
    "profile lookups and OAuth flows. Credentials are saved to the connector's data directory. " +
    "You need to create a LinkedIn Developer App at https://www.linkedin.com/developers/apps " +
    "and obtain the Client ID and Client Secret from the Auth tab.",
  inputSchema: {
    type: "object",
    properties: {
      linkedin_client_id: {
        type: "string",
        description:
          "The Client ID from your LinkedIn Developer App (Auth tab).",
      },
      linkedin_client_secret: {
        type: "string",
        description:
          "The Client Secret from your LinkedIn Developer App (Auth tab). Keep this private.",
      },
      linkedin_redirect_uri: {
        type: "string",
        description:
          "Optional. The OAuth redirect URI registered in your LinkedIn app. " +
          "Defaults to https://[your-railway-domain]/auth/linkedin/callback. " +
          "Only specify this if you need to override the auto-detected value.",
      },
    },
    required: ["linkedin_client_id", "linkedin_client_secret"],
  },
};

export const getLinkedInCredentialsToolDefinition = {
  name: "get_linkedin_credentials",
  description:
    "Returns the current LinkedIn OAuth configuration status — whether credentials are set, " +
    "where they came from, and the client ID. The client secret is never shown. " +
    "Call this to confirm LinkedIn OAuth is configured before calling linkedin_start_oauth.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const clearLinkedInCredentialsToolDefinition = {
  name: "clear_linkedin_credentials",
  description:
    "Removes the LinkedIn OAuth credentials stored via set_linkedin_credentials. " +
    "If LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET environment variables are set in " +
    "Railway, those will still be used as a fallback.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleSetWordPressCredentials(args) {
  try {
    setWordPressCredentials({
      wp_url:      args?.wp_url,
      wp_username: args?.wp_username,
      wp_password: args?.wp_password,
    });

    const status = getWordPressStatus();

    const lines = [
      "WordPress Credentials Saved",
      "===========================",
      `Site URL:  ${status.wp_url}`,
      `Username:  ${status.wp_username}`,
      `Password:  [stored securely — not displayed]`,
      `Source:    ${status.source}`,
      "",
      "WordPress connection is now configured.",
      "Call get_wordpress_credentials to confirm, or wordpress_site_info to test the connection.",
    ].join("\n");

    log("info", `WordPress credentials stored for: ${status.wp_url}`);
    return { content: [{ type: "text", text: lines }] };
  } catch (err) {
    log("error", `set_wordpress_credentials: ${err.message}`);
    return {
      content: [{ type: "text", text: `Failed to save WordPress credentials: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleGetWordPressCredentials(_args) {
  try {
    const status = getWordPressStatus();

    const lines = [
      "WordPress Credentials Status",
      "============================",
      `Configured: ${status.configured ? "YES" : "NO"}`,
      `Source:     ${status.source}`,
    ];

    if (status.configured) {
      lines.push(`Site URL:   ${status.wp_url}`);
      lines.push(`Username:   ${status.wp_username}`);
      lines.push(`Password:   [stored — not shown]`);
      lines.push("");
      lines.push("Call wordpress_site_info to test the live connection.");
    } else {
      lines.push("");
      lines.push("WordPress is not configured. Call set_wordpress_credentials to add your site.");
      lines.push("");
      lines.push("You will need:");
      lines.push("  1. Your WordPress site URL (e.g. https://yoursite.com)");
      lines.push("  2. Your WordPress username");
      lines.push("  3. An Application Password from WordPress Admin > Users > Your Profile");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    log("error", `get_wordpress_credentials: ${err.message}`);
    return {
      content: [{ type: "text", text: `Error checking WordPress credentials: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleClearWordPressCredentials(_args) {
  try {
    clearWordPressCredentials();

    const status = getWordPressStatus();
    const fallback = status.configured
      ? `Falling back to environment variables (${status.source}).`
      : "WordPress is now unconfigured. Call set_wordpress_credentials to add new credentials.";

    const lines = [
      "WordPress Credentials Cleared",
      "=============================",
      "Runtime-stored credentials have been removed.",
      fallback,
    ].join("\n");

    return { content: [{ type: "text", text: lines }] };
  } catch (err) {
    log("error", `clear_wordpress_credentials: ${err.message}`);
    return {
      content: [{ type: "text", text: `Error clearing WordPress credentials: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleSetLinkedInCredentials(args) {
  try {
    setLinkedInCredentials({
      linkedin_client_id:     args?.linkedin_client_id,
      linkedin_client_secret: args?.linkedin_client_secret,
      linkedin_redirect_uri:  args?.linkedin_redirect_uri,
    });

    const status = getLinkedInStatus();

    const lines = [
      "LinkedIn Credentials Saved",
      "==========================",
      `Client ID:    ${status.client_id}`,
      `Client Secret:[stored securely — not displayed]`,
      `Redirect URI: ${status.redirect_uri}`,
      `Source:       ${status.source}`,
      "",
      "LinkedIn OAuth is now configured.",
      "Call linkedin_start_oauth to begin the authorization flow.",
    ].join("\n");

    log("info", `LinkedIn credentials stored. Client ID: ${status.client_id}`);
    return { content: [{ type: "text", text: lines }] };
  } catch (err) {
    log("error", `set_linkedin_credentials: ${err.message}`);
    return {
      content: [{ type: "text", text: `Failed to save LinkedIn credentials: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleGetLinkedInCredentials(_args) {
  try {
    const status = getLinkedInStatus();

    const lines = [
      "LinkedIn Credentials Status",
      "===========================",
      `Configured:   ${status.configured ? "YES" : "NO"}`,
      `Source:       ${status.source}`,
    ];

    if (status.configured) {
      lines.push(`Client ID:    ${status.client_id}`);
      lines.push(`Redirect URI: ${status.redirect_uri}`);
      lines.push(`Client Secret:[stored — not shown]`);
      lines.push("");
      lines.push("Call linkedin_start_oauth to begin the OAuth authorization flow.");
    } else {
      lines.push("");
      lines.push("LinkedIn OAuth is not configured. Call set_linkedin_credentials to add your app credentials.");
      lines.push("");
      lines.push("To create a LinkedIn Developer App:");
      lines.push("  1. Go to https://www.linkedin.com/developers/apps");
      lines.push("  2. Create a new app");
      lines.push("  3. From the Auth tab, copy the Client ID and Client Secret");
      lines.push(`  4. Add ${status.redirect_uri || "https://[your-railway-domain]/auth/linkedin/callback"} as an Authorized redirect URL`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    log("error", `get_linkedin_credentials: ${err.message}`);
    return {
      content: [{ type: "text", text: `Error checking LinkedIn credentials: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleClearLinkedInCredentials(_args) {
  try {
    clearLinkedInCredentials();

    const status = getLinkedInStatus();
    const fallback = status.configured
      ? `Falling back to environment variables (${status.source}).`
      : "LinkedIn OAuth is now unconfigured. Call set_linkedin_credentials to add new credentials.";

    const lines = [
      "LinkedIn Credentials Cleared",
      "============================",
      "Runtime-stored LinkedIn credentials have been removed.",
      fallback,
    ].join("\n");

    return { content: [{ type: "text", text: lines }] };
  } catch (err) {
    log("error", `clear_linkedin_credentials: ${err.message}`);
    return {
      content: [{ type: "text", text: `Error clearing LinkedIn credentials: ${err.message}` }],
      isError: true,
    };
  }
}
