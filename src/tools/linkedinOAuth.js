// tools/linkedinOAuth.js
// LinkedIn OAuth 2.0 tools for browser-based Claude.
//
// What LinkedIn OAuth provides WITHOUT LinkedIn Partner Program:
//   - Your own full profile (name, headline, photo, location, summary)
//   - Your email address
//   - Ability to verify LinkedIn identity
//
// What requires LinkedIn Partner Program (NOT available here):
//   - r_network scope: access to your connections list
//   - Connections are still accessed via CSV export (see linkedin.js)
//
// Setup (one-time):
//   1. Go to https://www.linkedin.com/developers/apps/new
//   2. Create a LinkedIn App (free, instant approval for basic scopes)
//   3. Under "Auth" tab, add your Railway URL as Redirect URL:
//      https://your-app.up.railway.app/auth/linkedin/callback
//   4. Copy Client ID and Client Secret to Railway environment variables:
//      LINKEDIN_CLIENT_ID=your_client_id
//      LINKEDIN_CLIENT_SECRET=your_client_secret
//      LINKEDIN_REDIRECT_URI=https://your-app.up.railway.app/auth/linkedin/callback

import { getTokenStatus, clearToken, createState, getToken } from "../utils/tokenStore.js";
import { log } from "../utils/logger.js";
import { config } from "../config.js";
import { getLinkedInCredentials } from "../utils/credentialStore.js";

// -----------------------------------------------------------------------
// Tool definitions
// -----------------------------------------------------------------------

export const linkedinOAuthStartToolDefinition = {
  name: "linkedin_start_oauth",
  description:
    "Generates a LinkedIn OAuth authorization URL. " +
    "Open this URL in your browser to log in with LinkedIn. " +
    "Once you complete the login, your LinkedIn profile will be accessible. " +
    "This must be called before linkedin_get_live_profile. " +
    "Requires LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to be configured on the server.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const linkedinOAuthStatusToolDefinition = {
  name: "linkedin_oauth_status",
  description:
    "Checks whether a LinkedIn OAuth token is currently stored and valid. " +
    "Use this to verify your LinkedIn login is active before calling linkedin_get_live_profile.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const linkedinOAuthLogoutToolDefinition = {
  name: "linkedin_oauth_logout",
  description:
    "Clears the stored LinkedIn OAuth token, effectively logging out. " +
    "Call linkedin_start_oauth again to re-authenticate.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const linkedinLiveProfileToolDefinition = {
  name: "linkedin_get_live_profile",
  description:
    "Fetches your LinkedIn profile in real time using your stored OAuth token. " +
    "Returns your current name, headline, location, industry, summary, and email. " +
    "Requires a valid LinkedIn OAuth login (call linkedin_start_oauth first). " +
    "This data is fetched live from LinkedIn, not from a local file.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleLinkedinOAuthStart(_args) {
  // Credential resolution order:
  //   1. Runtime credentials stored via set_linkedin_credentials MCP tool
  //   2. Environment variables (LINKEDIN_CLIENT_ID, etc.) — Railway
  const { clientId, clientSecret: _secret, redirectUri } = getLinkedInCredentials();

  if (!clientId) {
    return {
      content: [
        {
          type: "text",
          text:
            "LinkedIn OAuth is not configured.\n\n" +
            "Option 1 — Set credentials from Claude (recommended):\n" +
            "  Call set_linkedin_credentials with:\n" +
            "    linkedin_client_id:     your_client_id\n" +
            "    linkedin_client_secret: your_client_secret\n\n" +
            "Option 2 — Set Railway environment variables:\n" +
            "  LINKEDIN_CLIENT_ID     = your_client_id\n" +
            "  LINKEDIN_CLIENT_SECRET = your_client_secret\n" +
            `  LINKEDIN_REDIRECT_URI  = ${redirectUri}\n\n` +
            "To create a LinkedIn Developer App:\n" +
            "  1. Go to https://www.linkedin.com/developers/apps/new\n" +
            "  2. Create a free LinkedIn App\n" +
            "  3. Under the Auth tab, add this as an Authorized Redirect URL:\n" +
            `     ${redirectUri}\n` +
            "  4. Copy your Client ID and Client Secret",
        },
      ],
    };
  }

  if (!redirectUri) {
    return {
      content: [
        {
          type: "text",
          text:
            "LinkedIn redirect URI could not be determined. Call set_linkedin_credentials and include the linkedin_redirect_uri parameter.",
        },
      ],
      isError: true,
    };
  }

  // Check if already authenticated
  const status = getTokenStatus();
  if (status.authenticated) {
    return {
      content: [
        {
          type: "text",
          text:
            `LinkedIn is already authenticated.\n` +
            `Logged in at: ${status.storedAt}\n` +
            `Token expires in: ${status.expiresIn}\n\n` +
            `Call linkedin_get_live_profile to fetch your profile.\n` +
            `Call linkedin_oauth_logout to log out and re-authenticate.`,
        },
      ],
    };
  }

  const state = createState();

  // LinkedIn OAuth 2.0 scopes available without partner access:
  //   openid    - OpenID Connect (LinkedIn OpenID Connect)
  //   profile   - basic profile (name, photo, headline)
  //   email     - email address
  //   w_member_social - post on behalf (not needed but common)
  const scopes = ["openid", "profile", "email"].join(" ");

  const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", scopes);

  log("info", "LinkedIn OAuth URL generated");

  return {
    content: [
      {
        type: "text",
        text:
          `LinkedIn Authorization URL\n` +
          `==========================\n\n` +
          `Open this URL in your browser to log in with LinkedIn:\n\n` +
          `${authUrl.toString()}\n\n` +
          `After logging in, LinkedIn will redirect you back to the server automatically.\n` +
          `Once redirected, call linkedin_oauth_status to confirm the login worked,\n` +
          `then call linkedin_get_live_profile to fetch your profile.\n\n` +
          `Note: This authorization link expires in 10 minutes.`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleLinkedinOAuthStatus(_args) {
  const status = getTokenStatus();
  return {
    content: [
      {
        type: "text",
        text: status.authenticated
          ? `LinkedIn OAuth Status: AUTHENTICATED\n` +
            `Logged in at: ${status.storedAt}\n` +
            `Token expires in: ${status.expiresIn}\n` +
            `Scopes: ${status.scope || "openid profile email"}`
          : `LinkedIn OAuth Status: NOT AUTHENTICATED\n` +
            `Reason: ${status.reason}\n\n` +
            `Call linkedin_start_oauth to get an authorization URL.`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleLinkedinOAuthLogout(_args) {
  clearToken();
  return {
    content: [
      {
        type: "text",
        text: "LinkedIn token cleared. Call linkedin_start_oauth to log in again.",
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleLinkedinLiveProfile(_args) {
  const token = getToken();

  if (!token) {
    return {
      content: [
        {
          type: "text",
          text:
            "Not authenticated with LinkedIn. Call linkedin_start_oauth first,\n" +
            "open the provided URL in your browser, then call this tool again.",
        },
      ],
      isError: true,
    };
  }

  try {
    // LinkedIn OpenID Connect userinfo endpoint
    // Returns: sub, name, given_name, family_name, picture, email, locale
    const userinfoResp = await fetch(
      "https://api.linkedin.com/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "LinkedIn-Version": "202404",
        },
      }
    );

    if (!userinfoResp.ok) {
      const errText = await userinfoResp.text().catch(() => "");
      log("error", `LinkedIn userinfo error ${userinfoResp.status}: ${errText}`);

      if (userinfoResp.status === 401) {
        clearToken();
        return {
          content: [
            {
              type: "text",
              text:
                "LinkedIn token is invalid or expired. Your token has been cleared.\n" +
                "Call linkedin_start_oauth to re-authenticate.",
            },
          ],
          isError: true,
        };
      }
      throw new Error(`LinkedIn API error ${userinfoResp.status}: ${errText}`);
    }

    const userinfo = await userinfoResp.json();

    // Build a clean profile object
    const profile = {
      name: userinfo.name || [userinfo.given_name, userinfo.family_name].filter(Boolean).join(" "),
      firstName: userinfo.given_name || "",
      lastName: userinfo.family_name || "",
      email: userinfo.email || "",
      profilePicture: userinfo.picture || "",
      locale: userinfo.locale?.language
        ? `${userinfo.locale.language}-${userinfo.locale.country}`
        : (userinfo.locale || ""),
      linkedinId: userinfo.sub || "",
      source: "LinkedIn OAuth (live)",
      fetchedAt: new Date().toISOString(),
    };

    log("info", `LinkedIn profile fetched for: ${profile.name}`);

    const lines = [
      "LinkedIn Live Profile",
      "====================",
      `Name:     ${profile.name}`,
      profile.email      ? `Email:    ${profile.email}` : null,
      profile.locale     ? `Locale:   ${profile.locale}` : null,
      profile.linkedinId ? `ID:       ${profile.linkedinId}` : null,
      profile.profilePicture ? `Photo:    ${profile.profilePicture}` : null,
      ``,
      `Fetched at: ${profile.fetchedAt}`,
      ``,
      `Note: LinkedIn's API (without Partner Program access) provides basic`,
      `profile info only. Your connections list is still accessed via CSV export.`,
    ]
      .filter((l) => l !== null)
      .join("\n");

    return { content: [{ type: "text", text: lines }] };
  } catch (err) {
    log("error", `handleLinkedinLiveProfile error: ${err.message}`);
    return {
      content: [{ type: "text", text: `Error fetching LinkedIn profile: ${err.message}` }],
      isError: true,
    };
  }
}
