// tools/wordpress.js
//
// WordPress REST API publishing tools for claude-connector.
//
// AUTHENTICATION: Uses WordPress Application Passwords (built-in since WP 5.6).
// Setup: WordPress Admin > Users > Your Profile > Application Passwords
//        Create a password named "Claude Connector", copy the generated password.
//
// REQUIRED ENVIRONMENT VARIABLES (set in Railway Variables):
//   WP_URL              e.g. https://yoursite.com  (no trailing slash)
//   WP_USERNAME         your WordPress username (the one you log in with)
//   WP_APP_PASSWORD     the Application Password generated in WP admin
//
// MENU SUPPORT: Uses the WordPress REST API menus endpoint (available since WP 5.9).
// For older WordPress installations, the "WP REST API Menus" plugin provides this.
//
// TOOLS PROVIDED:
//   wordpress_site_info       - returns site title, tagline, URL, WP version
//   wordpress_list_posts      - lists recent published posts
//   wordpress_list_pages      - lists all pages with their status
//   wordpress_list_categories - lists all categories
//   wordpress_list_tags       - lists all tags
//   wordpress_list_menus      - lists all registered navigation menus
//   wordpress_list_menu_items - lists items in a specific menu
//   wordpress_create_post     - creates a new blog post (draft or publish)
//   wordpress_create_page     - creates a new page (draft or publish)
//   wordpress_add_menu_item   - adds a page/post/URL as a menu item in a named menu
//   wordpress_update_content  - updates an existing post or page by ID

import { log } from "../utils/logger.js";
import { truncate } from "../utils/helpers.js";
import { getWordPressCredentials } from "../utils/credentialStore.js";
import { CONNECTOR_USER_AGENT } from "../config.js";

// -----------------------------------------------------------------------
// Config helpers
// -----------------------------------------------------------------------

function getWpConfig() {
  // Credential resolution order:
  //   1. Runtime credentials stored via set_wordpress_credentials MCP tool
  //   2. Environment variables (WP_URL, WP_USERNAME, WP_APP_PASSWORD) — Railway
  // The credentialStore handles this priority internally.
  const creds = getWordPressCredentials();

  if (!creds) {
    throw new Error(
      "WordPress is not configured.\n\n" +
      "Option 1 — Set credentials from Claude (recommended):\n" +
      "  Call set_wordpress_credentials with:\n" +
      "    wp_url:      https://yoursite.com\n" +
      "    wp_username: your_wordpress_username\n" +
      "    wp_password: your Application Password\n\n" +
      "Option 2 — Set Railway environment variables:\n" +
      "  WP_URL          = https://yoursite.com\n" +
      "  WP_USERNAME     = your_wp_username\n" +
      "  WP_APP_PASSWORD = Application Password from WP Admin > Users > Profile\n\n" +
      "To create an Application Password in WordPress:\n" +
      "  1. Log into WordPress Admin\n" +
      "  2. Go to Users > Your Profile\n" +
      "  3. Scroll to 'Application Passwords'\n" +
      "  4. Enter name 'Claude Connector' and click 'Add New Application Password'\n" +
      "  5. Copy the generated password (shown only once)"
    );
  }

  return creds;
}

async function wpFetch(path, options = {}) {
  const { url, authHeader, baseApi } = getWpConfig();
  const fullUrl = path.startsWith("http") ? path : `${baseApi}${path}`;

  const resp = await fetch(fullUrl, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
      "User-Agent": CONNECTOR_USER_AGENT,
      ...(options.headers || {}),
    },
  });

  const body = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg =
      body?.message ||
      body?.error ||
      `HTTP ${resp.status} ${resp.statusText}`;
    throw new Error(`WordPress API error: ${msg}`);
  }

  return body;
}

function normalizeRequiredTrimmedString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`'${fieldName}' is required and must be a non-empty string.`);
  }

  const normalized = value.trim();
  if (normalized.length > 200) {
    throw new Error(`'${fieldName}' must be 200 characters or fewer.`);
  }

  return normalized;
}

function normalizeOptionalTrimmedString(value, fieldName, maxLength = 400) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`'${fieldName}' must be a string when provided.`);
  }

  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw new Error(`'${fieldName}' must be ${maxLength} characters or fewer.`);
  }

  return normalized;
}

function normalizeOptionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`'${fieldName}' must be a positive integer when provided.`);
  }

  return parsed;
}

async function findExistingTerm(endpoint, { name, slug, parentId }) {
  const params = new URLSearchParams({
    per_page: "100",
    _fields: "id,name,slug,parent,count,description",
  });

  if (slug) {
    params.set("slug", slug);
  } else {
    params.set("search", name);
  }

  const terms = await wpFetch(`/${endpoint}?${params}`);
  if (!Array.isArray(terms) || terms.length === 0) return null;

  const normalizedName = name.trim().toLowerCase();
  const normalizedSlug = slug?.trim().toLowerCase();

  return (
    terms.find((term) => {
      const termName = (term.name || "").trim().toLowerCase();
      const termSlug = (term.slug || "").trim().toLowerCase();

      if (normalizedSlug && termSlug === normalizedSlug) return true;
      if (termName !== normalizedName) return false;
      if (endpoint === "categories" && Number.isInteger(parentId)) {
        return Number(term.parent || 0) === parentId;
      }
      return true;
    }) || null
  );
}

function formatTermSummaryLine(term, index) {
  const parts = [
    `[${index}] ID: ${term.id}`,
    `Name: ${term.name || "(no name)"}`,
    `Slug: ${term.slug || "(none)"}`,
  ];

  if (term.parent) parts.push(`Parent: ${term.parent}`);
  if (term.description) parts.push(`Description: ${truncate(term.description, 120)}`);

  return `  ${parts.join("  |  ")}`;
}

function normalizeTagRequests(args) {
  const requests = [];

  if (typeof args?.name === "string" && args.name.trim()) {
    requests.push({
      name: args.name,
      slug: args.slug,
      description: args.description,
    });
  }

  if (Array.isArray(args?.names)) {
    for (const name of args.names) {
      requests.push({ name });
    }
  }

  if (Array.isArray(args?.tags)) {
    for (const tag of args.tags) {
      requests.push(tag);
    }
  }

  if (requests.length === 0) {
    throw new Error("Provide at least one tag using 'name', 'names', or 'tags'.");
  }

  if (requests.length > 50) {
    throw new Error("A maximum of 50 tags can be processed in one call.");
  }

  const seen = new Set();
  const normalized = [];

  requests.forEach((request, index) => {
    const entry = typeof request === "string" ? { name: request } : request;

    if (!entry || typeof entry !== "object") {
      throw new Error(`tags[${index}] must be an object with at least a 'name' field.`);
    }

    const name = normalizeRequiredTrimmedString(entry.name, `tags[${index}].name`);
    const slug = normalizeOptionalTrimmedString(entry.slug, `tags[${index}].slug`, 200);
    const description = normalizeOptionalTrimmedString(entry.description, `tags[${index}].description`, 500);
    const dedupeKey = (slug || name).toLowerCase();

    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    normalized.push({ name, slug, description });
  });

  return normalized;
}

// -----------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------

export const wpSiteInfoToolDefinition = {
  name: "wordpress_site_info",
  description:
    "Returns information about the connected WordPress site: title, tagline, " +
    "URL, WordPress version, timezone, and available post types. " +
    "Call this first to confirm the WordPress connection is working.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const wpListPostsToolDefinition = {
  name: "wordpress_list_posts",
  description:
    "Lists recent posts from the WordPress site. " +
    "Returns post ID, title, status, date, author, and URL for each post. " +
    "Useful for finding the ID of a post you want to update.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Filter by status: 'publish', 'draft', 'pending', 'private', or 'any'. Defaults to 'any'.",
        enum: ["publish", "draft", "pending", "private", "any"],
      },
      per_page: {
        type: "number",
        description: "Number of posts to return (1-100, default 20).",
        minimum: 1,
        maximum: 100,
      },
    },
    required: [],
  },
};

export const wpListPagesToolDefinition = {
  name: "wordpress_list_pages",
  description:
    "Lists all pages from the WordPress site. " +
    "Returns page ID, title, status, parent, menu order, and URL. " +
    "Useful for finding page IDs when adding menu items.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Filter by status: 'publish', 'draft', 'pending', 'private', or 'any'. Defaults to 'any'.",
        enum: ["publish", "draft", "pending", "private", "any"],
      },
    },
    required: [],
  },
};

export const wpListCategoriesToolDefinition = {
  name: "wordpress_list_categories",
  description:
    "Lists all categories available on the WordPress site with their IDs. " +
    "Use the category ID when creating a post with wordpress_create_post.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const wpListTagsToolDefinition = {
  name: "wordpress_list_tags",
  description:
    "Lists all tags available on the WordPress site with their IDs. " +
    "Use tag IDs when creating a post with wordpress_create_post.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const wpCreateCategoryToolDefinition = {
  name: "wordpress_create_category",
  description:
    "Creates a new WordPress category and returns the new category ID. " +
    "Supports optional slug, description, and parent category assignment. " +
    "If an exact matching category already exists, the existing category is returned by default.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The category name to create.",
      },
      slug: {
        type: "string",
        description: "Optional URL slug for the category. If omitted, WordPress generates one.",
      },
      description: {
        type: "string",
        description: "Optional category description.",
      },
      parent_id: {
        type: "number",
        description: "Optional parent category ID for nested categories.",
      },
      return_existing_if_duplicate: {
        type: "boolean",
        description: "Defaults to true. When true, an existing exact-match category is returned instead of failing.",
      },
    },
    required: ["name"],
  },
};

export const wpCreateTagsToolDefinition = {
  name: "wordpress_create_tags",
  description:
    "Creates one or more WordPress tags and returns the created or matched tag IDs. " +
    "Supports single-tag input or batch tag creation. Exact duplicate tags are returned by default instead of failing.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Create a single tag with this name.",
      },
      slug: {
        type: "string",
        description: "Optional slug for the single tag created via 'name'.",
      },
      description: {
        type: "string",
        description: "Optional description for the single tag created via 'name'.",
      },
      names: {
        type: "array",
        items: { type: "string" },
        description: "Simple batch mode. Provide an array of tag names to create.",
      },
      tags: {
        type: "array",
        description: "Advanced batch mode. Each item can include name, slug, and description.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The tag name.",
            },
            slug: {
              type: "string",
              description: "Optional slug for the tag.",
            },
            description: {
              type: "string",
              description: "Optional tag description.",
            },
          },
          required: ["name"],
        },
      },
      return_existing_if_duplicate: {
        type: "boolean",
        description: "Defaults to true. When true, existing exact-match tags are returned instead of failing.",
      },
    },
    required: [],
  },
};

export const wpListMenusToolDefinition = {
  name: "wordpress_list_menus",
  description:
    "Lists all navigation menus registered on the WordPress site, including their names, " +
    "slugs, IDs, and the theme location they are assigned to (e.g. 'Primary Menu', 'Footer Menu'). " +
    "Use this to find the correct menu name or ID before calling wordpress_add_menu_item.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const wpListMenuItemsToolDefinition = {
  name: "wordpress_list_menu_items",
  description:
    "Lists all items currently in a specific WordPress navigation menu. " +
    "Returns item ID, title, URL, type, and order for each item.",
  inputSchema: {
    type: "object",
    properties: {
      menu_id: {
        type: "number",
        description: "The numeric ID of the menu (from wordpress_list_menus).",
      },
    },
    required: ["menu_id"],
  },
};

export const wpCreatePostToolDefinition = {
  name: "wordpress_create_post",
  description:
    "Creates a new blog post on the WordPress site. " +
    "Can publish immediately or save as a draft. " +
    "Supports title, content (HTML allowed), excerpt, categories, tags, featured image URL, " +
    "and sticky flag. Returns the new post ID and URL on success. " +
    "ONLY call this when the user explicitly requests creating a WordPress post.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "The post title.",
      },
      content: {
        type: "string",
        description:
          "The post body content. HTML is supported. " +
          "Use paragraph tags <p> for paragraphs, <h2>/<h3> for headings, <ul>/<li> for lists.",
      },
      status: {
        type: "string",
        description: "'publish' to make it live immediately, 'draft' to save as draft. Defaults to 'draft'.",
        enum: ["publish", "draft", "pending", "private"],
      },
      excerpt: {
        type: "string",
        description: "Optional short summary/excerpt for the post.",
      },
      category_ids: {
        type: "array",
        items: { type: "number" },
        description: "Array of category IDs to assign. Use wordpress_list_categories to find IDs.",
      },
      tag_ids: {
        type: "array",
        items: { type: "number" },
        description: "Array of tag IDs to assign. Use wordpress_list_tags to find IDs.",
      },
      slug: {
        type: "string",
        description: "URL slug for the post (e.g. 'my-new-post'). Auto-generated from title if omitted.",
      },
      sticky: {
        type: "boolean",
        description: "Whether to pin this post to the top of the blog. Defaults to false.",
      },
      comment_status: {
        type: "string",
        description: "'open' to allow comments, 'closed' to disable. Defaults to site setting.",
        enum: ["open", "closed"],
      },
    },
    required: ["title", "content"],
  },
};

export const wpCreatePageToolDefinition = {
  name: "wordpress_create_page",
  description:
    "Creates a new page on the WordPress site. " +
    "After creating a published page, Claude will ask the user whether to add a menu link " +
    "and, if so, which menu to add it to and where (top-level or under a parent item). " +
    "Supports title, content (HTML), page template, parent page, and menu order. " +
    "Returns the new page ID and URL on success. " +
    "ONLY call this when the user explicitly requests creating a WordPress page.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "The page title.",
      },
      content: {
        type: "string",
        description:
          "The page body content. HTML is supported. " +
          "Use paragraph tags <p> for paragraphs, <h2>/<h3> for headings, <ul>/<li> for lists.",
      },
      status: {
        type: "string",
        description: "'publish' to make it live immediately, 'draft' to save as draft. Defaults to 'draft'.",
        enum: ["publish", "draft", "pending", "private"],
      },
      excerpt: {
        type: "string",
        description: "Optional short summary for the page.",
      },
      parent_id: {
        type: "number",
        description: "Parent page ID if this is a sub-page. Use wordpress_list_pages to find parent IDs.",
      },
      menu_order: {
        type: "number",
        description: "Numeric order for the page in page lists (lower = earlier). Defaults to 0.",
      },
      slug: {
        type: "string",
        description: "URL slug (e.g. 'about-us'). Auto-generated from title if omitted.",
      },
      template: {
        type: "string",
        description: "Page template filename if your theme supports custom templates (e.g. 'full-width.php'). Leave blank for default.",
      },
      comment_status: {
        type: "string",
        description: "'open' to allow comments, 'closed' to disable.",
        enum: ["open", "closed"],
      },
    },
    required: ["title", "content"],
  },
};

export const wpAddMenuItemToolDefinition = {
  name: "wordpress_add_menu_item",
  description:
    "Adds a navigation menu item to a WordPress menu. " +
    "Can add a link to an existing page, post, or any custom URL. " +
    "Use wordpress_list_menus to find the menu ID, and wordpress_list_pages to find page IDs. " +
    "ONLY call this when the user explicitly confirms they want a menu item added.",
  inputSchema: {
    type: "object",
    properties: {
      menu_id: {
        type: "number",
        description: "The numeric ID of the menu to add the item to (from wordpress_list_menus).",
      },
      title: {
        type: "string",
        description: "The label/text for the menu item as it will appear in the navigation.",
      },
      type: {
        type: "string",
        description:
          "The type of menu item: " +
          "'page' (link to a WordPress page), " +
          "'post' (link to a WordPress post), " +
          "'custom' (any custom URL). " +
          "Defaults to 'custom'.",
        enum: ["page", "post", "custom"],
      },
      object_id: {
        type: "number",
        description:
          "The ID of the page or post to link to. Required when type is 'page' or 'post'. " +
          "Use wordpress_list_pages or wordpress_list_posts to find the ID.",
      },
      url: {
        type: "string",
        description:
          "The URL for a custom menu item. Required when type is 'custom'. " +
          "Also used to override the URL for page/post items.",
      },
      parent_menu_item_id: {
        type: "number",
        description:
          "The ID of an existing menu item to nest this item under (creates a dropdown sub-item). " +
          "Use wordpress_list_menu_items to find existing menu item IDs. " +
          "Leave empty for a top-level menu item.",
      },
      menu_order: {
        type: "number",
        description: "Position of this item in the menu (lower = earlier). Defaults to last position.",
      },
    },
    required: ["menu_id", "title"],
  },
};

export const wpUpdateContentToolDefinition = {
  name: "wordpress_update_content",
  description:
    "Updates an existing WordPress post or page by its ID. " +
    "Only the fields you provide will be updated - omitted fields are left unchanged. " +
    "Use wordpress_list_posts or wordpress_list_pages to find the content ID. " +
    "ONLY call this when the user explicitly requests updating existing WordPress content.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The numeric ID of the post or page to update.",
      },
      content_type: {
        type: "string",
        description: "'post' or 'page'. Determines the API endpoint used.",
        enum: ["post", "page"],
      },
      title: {
        type: "string",
        description: "New title (leave blank to keep existing).",
      },
      content: {
        type: "string",
        description: "New body content in HTML (leave blank to keep existing).",
      },
      status: {
        type: "string",
        description: "New status: 'publish', 'draft', 'pending', or 'private'.",
        enum: ["publish", "draft", "pending", "private"],
      },
      excerpt: {
        type: "string",
        description: "New excerpt/summary.",
      },
      slug: {
        type: "string",
        description: "New URL slug.",
      },
    },
    required: ["id", "content_type"],
  },
};

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleWpSiteInfo(_args) {
  try {
    const { url, baseApi } = getWpConfig();

    // Fetch general site settings
    const [settings, types] = await Promise.all([
      wpFetch("/settings"),
      wpFetch("/types"),
    ]);

    const typeNames = Object.keys(types || {}).filter(
      (t) => !["attachment", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_global_styles", "wp_font_family", "wp_font_face"].includes(t)
    );

    const lines = [
      "WordPress Site Information",
      "==========================",
      `Title:       ${settings.title || "(not set)"}`,
      `Tagline:     ${settings.description || "(not set)"}`,
      `URL:         ${url}`,
      `Admin Email: ${settings.email || "(not set)"}`,
      `Timezone:    ${settings.timezone_string || settings.gmt_offset || "(not set)"}`,
      `Language:    ${settings.language || "en"}`,
      `Date Format: ${settings.date_format || "(not set)"}`,
      `Post Types:  ${typeNames.join(", ")}`,
      ``,
      `REST API Base: ${baseApi}`,
      ``,
      "Connection: OK",
    ].join("\n");

    return { content: [{ type: "text", text: lines }] };
  } catch (err) {
    log("error", `wordpress_site_info: ${err.message}`);
    return {
      content: [{ type: "text", text: `WordPress connection error: ${err.message}` }],
      isError: true,
    };
  }
}

// -----------------------------------------------------------------------

export async function handleWpListPosts(args) {
  const status = args?.status || "any";
  const perPage = Math.min(Math.max(Number(args?.per_page) || 20, 1), 100);

  const params = new URLSearchParams({
    per_page: String(perPage),
    orderby: "date",
    order: "desc",
    _fields: "id,title,status,date,modified,link,author,categories,tags,slug,excerpt",
  });
  if (status !== "any") params.set("status", status);

  const posts = await wpFetch(`/posts?${params}`);

  if (!posts || posts.length === 0) {
    return { content: [{ type: "text", text: `No posts found (status: ${status}).` }] };
  }

  const lines = posts.map((p, i) => {
    const parts = [`[${i + 1}] ID: ${p.id}  |  "${p.title?.rendered || "(no title)"}"`];
    parts.push(`  Status:   ${p.status}`);
    parts.push(`  Date:     ${p.date?.slice(0, 10) || ""}`);
    parts.push(`  Slug:     ${p.slug || ""}`);
    parts.push(`  URL:      ${p.link || ""}`);
    const excerpt = p.excerpt?.rendered?.replace(/<[^>]*>/g, "").trim();
    if (excerpt) parts.push(`  Excerpt:  ${truncate(excerpt, 120)}`);
    return parts.join("\n");
  });

  return {
    content: [
      {
        type: "text",
        text: `WordPress Posts (${posts.length} results, status: ${status})\n\n${lines.join("\n\n")}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleWpListPages(args) {
  const status = args?.status || "any";

  const params = new URLSearchParams({
    per_page: "100",
    orderby: "menu_order",
    order: "asc",
    _fields: "id,title,status,slug,link,parent,menu_order,date,modified",
  });
  if (status !== "any") params.set("status", status);

  const pages = await wpFetch(`/pages?${params}`);

  if (!pages || pages.length === 0) {
    return { content: [{ type: "text", text: `No pages found (status: ${status}).` }] };
  }

  const lines = pages.map((p, i) => {
    const parts = [`[${i + 1}] ID: ${p.id}  |  "${p.title?.rendered || "(no title)"}"`];
    parts.push(`  Status:     ${p.status}`);
    parts.push(`  Slug:       ${p.slug || ""}`);
    parts.push(`  URL:        ${p.link || ""}`);
    if (p.parent) parts.push(`  Parent ID:  ${p.parent}`);
    if (p.menu_order) parts.push(`  Menu Order: ${p.menu_order}`);
    return parts.join("\n");
  });

  return {
    content: [
      {
        type: "text",
        text: `WordPress Pages (${pages.length} total, status: ${status})\n\n${lines.join("\n\n")}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleWpListCategories(_args) {
  const categories = await wpFetch("/categories?per_page=100&_fields=id,name,slug,count,parent");

  if (!categories || categories.length === 0) {
    return { content: [{ type: "text", text: "No categories found." }] };
  }

  const lines = categories.map(
    (c) => `  ID: ${String(c.id).padEnd(6)} | ${c.name}${c.parent ? ` (parent: ${c.parent})` : ""}  [${c.count} posts]  slug: ${c.slug}`
  );

  return {
    content: [
      {
        type: "text",
        text: `WordPress Categories (${categories.length})\n\n${lines.join("\n")}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleWpListTags(_args) {
  const tags = await wpFetch("/tags?per_page=100&_fields=id,name,slug,count");

  if (!tags || tags.length === 0) {
    return { content: [{ type: "text", text: "No tags found." }] };
  }

  const lines = tags.map(
    (t) => `  ID: ${String(t.id).padEnd(6)} | ${t.name}  [${t.count} posts]  slug: ${t.slug}`
  );

  return {
    content: [
      {
        type: "text",
        text: `WordPress Tags (${tags.length})\n\n${lines.join("\n")}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleWpCreateCategory(args) {
  const name = normalizeRequiredTrimmedString(args?.name, "name");
  const slug = normalizeOptionalTrimmedString(args?.slug, "slug", 200);
  const description = normalizeOptionalTrimmedString(args?.description, "description", 500);
  const parentId = normalizeOptionalPositiveInteger(args?.parent_id, "parent_id");
  const returnExisting = args?.return_existing_if_duplicate !== false;

  if (Number.isInteger(parentId)) {
    await wpFetch(`/categories/${parentId}?_fields=id,name,parent`);
  }

  const existing = await findExistingTerm("categories", { name, slug, parentId });
  if (existing) {
    if (!returnExisting) {
      throw new Error(`Category '${name}' already exists with ID ${existing.id}.`);
    }

    const existingLines = [
      "WordPress Category Already Exists",
      "===============================",
      `Name:        ${existing.name}`,
      `ID:          ${existing.id}`,
      `Slug:        ${existing.slug || "(none)"}`,
      `Parent ID:   ${existing.parent || 0}`,
      `Description: ${existing.description || "(none)"}`,
      "",
      "No new category was created because an exact match already exists.",
    ].join("\n");

    return { content: [{ type: "text", text: existingLines }] };
  }

  const payload = { name };
  if (slug) payload.slug = slug;
  if (description) payload.description = description;
  if (Number.isInteger(parentId)) payload.parent = parentId;

  log("info", `Creating WordPress category: "${name}"`);

  const category = await wpFetch("/categories", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const lines = [
    "WordPress Category Created",
    "==========================",
    `Name:        ${category.name || name}`,
    `ID:          ${category.id}`,
    `Slug:        ${category.slug || slug || "(none)"}`,
    `Parent ID:   ${category.parent || 0}`,
    `Description: ${category.description || description || "(none)"}`,
    "",
    "You can now use this category ID with wordpress_create_post.",
  ].join("\n");

  return { content: [{ type: "text", text: lines }] };
}

// -----------------------------------------------------------------------

export async function handleWpCreateTags(args) {
  const requests = normalizeTagRequests(args);
  const returnExisting = args?.return_existing_if_duplicate !== false;
  const created = [];
  const existing = [];
  const failed = [];

  for (const request of requests) {
    try {
      const matched = await findExistingTerm("tags", request);
      if (matched) {
        if (!returnExisting) {
          failed.push({ name: request.name, error: `Tag already exists with ID ${matched.id}.` });
          continue;
        }

        existing.push(matched);
        continue;
      }

      const payload = { name: request.name };
      if (request.slug) payload.slug = request.slug;
      if (request.description) payload.description = request.description;

      const tag = await wpFetch("/tags", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      created.push(tag);
    } catch (err) {
      failed.push({ name: request.name, error: err.message });
    }
  }

  const lines = [
    "WordPress Tags Processed",
    "========================",
    `Requested: ${requests.length}`,
    `Created:   ${created.length}`,
    `Existing:  ${existing.length}`,
    `Failed:    ${failed.length}`,
  ];

  if (created.length > 0) {
    lines.push("", "Created Tags", "------------");
    created.forEach((tag, index) => lines.push(formatTermSummaryLine(tag, index + 1)));
  }

  if (existing.length > 0) {
    lines.push("", "Existing Tags", "-------------");
    existing.forEach((tag, index) => lines.push(formatTermSummaryLine(tag, index + 1)));
  }

  if (failed.length > 0) {
    lines.push("", "Failed Tags", "-----------");
    failed.forEach((item, index) => lines.push(`  [${index + 1}] ${item.name}: ${item.error}`));
  }

  lines.push("", "You can now use the returned tag IDs with wordpress_create_post.");

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: failed.length > 0,
  };
}

// -----------------------------------------------------------------------

export async function handleWpListMenus(_args) {
  let menus;
  try {
    // WordPress 5.9+ built-in menus endpoint
    menus = await wpFetch("/menus?per_page=100");
  } catch (err) {
    // Fallback: try the navigation endpoint (block-based themes)
    try {
      const navs = await wpFetch("/navigation?per_page=100&_fields=id,title,status,slug");
      if (navs && navs.length > 0) {
        const lines = navs.map((n, i) =>
          `[${i + 1}] ID: ${n.id}  |  "${n.title?.rendered || n.title?.raw || "(untitled)"}"\n` +
          `  Status: ${n.status}\n  Slug: ${n.slug}`
        );
        return {
          content: [
            {
              type: "text",
              text:
                `WordPress Navigation Menus (${navs.length}) - Block-based theme detected\n\n` +
                lines.join("\n\n") +
                `\n\nNote: This site uses a block-based theme. Menu items can be added via the site editor.`,
            },
          ],
        };
      }
    } catch (_) { /* ignore */ }

    return {
      content: [
        {
          type: "text",
          text:
            `Could not list menus: ${err.message}\n\n` +
            `This can happen if:\n` +
            `  1. Your WordPress version is older than 5.9 (menus API requires WP 5.9+)\n` +
            `  2. Your theme uses the Full Site Editor (block-based menus)\n` +
            `  3. The Application Password lacks sufficient permissions\n\n` +
            `If on WP < 5.9, install the "WP REST API Menus" plugin to enable this feature.`,
        },
      ],
      isError: true,
    };
  }

  if (!menus || menus.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            "No navigation menus found.\n\n" +
            "To create a menu: WordPress Admin > Appearance > Menus > Create a new menu.",
        },
      ],
    };
  }

  const lines = menus.map((m, i) => {
    const parts = [`[${i + 1}] ID: ${m.id}  |  "${m.name || m.title?.rendered || "(unnamed)"}" `];
    if (m.slug) parts.push(`  Slug:      ${m.slug}`);
    if (m.locations?.length) parts.push(`  Locations: ${m.locations.join(", ")}`);
    if (m.items_count !== undefined) parts.push(`  Items:     ${m.items_count}`);
    return parts.join("\n");
  });

  return {
    content: [
      {
        type: "text",
        text: `WordPress Navigation Menus (${menus.length})\n\n${lines.join("\n\n")}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleWpListMenuItems(args) {
  const menuId = Number(args?.menu_id);
  if (!menuId) throw new Error("menu_id is required. Use wordpress_list_menus to find the menu ID.");

  const items = await wpFetch(
    `/menu-items?menus=${menuId}&per_page=100&_fields=id,title,url,type,type_label,object_id,parent,menu_order,status`
  );

  if (!items || items.length === 0) {
    return { content: [{ type: "text", text: `Menu ${menuId} has no items yet.` }] };
  }

  // Sort by menu_order
  items.sort((a, b) => (a.menu_order || 0) - (b.menu_order || 0));

  const lines = items.map((item, i) => {
    const parts = [
      `[${i + 1}] Item ID: ${item.id}  |  "${item.title?.rendered || "(no title)"}"`
    ];
    parts.push(`  URL:        ${item.url || ""}`);
    parts.push(`  Type:       ${item.type_label || item.type || ""}`);
    if (item.object_id) parts.push(`  Object ID:  ${item.object_id}`);
    if (item.parent) parts.push(`  Parent ID:  ${item.parent}`);
    parts.push(`  Order:      ${item.menu_order || 0}`);
    return parts.join("\n");
  });

  return {
    content: [
      {
        type: "text",
        text: `Menu ${menuId} Items (${items.length})\n\n${lines.join("\n\n")}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleWpCreatePost(args) {
  if (!args?.title) throw new Error("'title' is required.");
  if (!args?.content) throw new Error("'content' is required.");

  const payload = {
    title: args.title,
    content: args.content,
    status: args.status || "draft",
  };

  if (args.excerpt) payload.excerpt = args.excerpt;
  if (args.slug) payload.slug = args.slug;
  if (args.category_ids?.length) payload.categories = args.category_ids;
  if (args.tag_ids?.length) payload.tags = args.tag_ids;
  if (typeof args.sticky === "boolean") payload.sticky = args.sticky;
  if (args.comment_status) payload.comment_status = args.comment_status;

  log("info", `Creating WordPress post: "${args.title}" (status: ${payload.status})`);

  const post = await wpFetch("/posts", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const statusEmoji = payload.status === "publish" ? "Published" : "Saved as Draft";
  const lines = [
    `WordPress Post ${statusEmoji}`,
    "=".repeat(30),
    `Title:   ${post.title?.rendered || args.title}`,
    `ID:      ${post.id}`,
    `Status:  ${post.status}`,
    `Slug:    ${post.slug}`,
    `URL:     ${post.link}`,
    `Date:    ${post.date?.slice(0, 10) || ""}`,
    ``,
    `Edit URL: ${post.guid?.rendered?.replace(/\?p=\d+/, `?p=${post.id}`).replace(post.slug, `wp-admin/post.php?post=${post.id}&action=edit`) || "Log into WordPress Admin to edit"}`,
  ].join("\n");

  return { content: [{ type: "text", text: lines }] };
}

// -----------------------------------------------------------------------

export async function handleWpCreatePage(args) {
  if (!args?.title) throw new Error("'title' is required.");
  if (!args?.content) throw new Error("'content' is required.");

  const payload = {
    title: args.title,
    content: args.content,
    status: args.status || "draft",
  };

  if (args.excerpt) payload.excerpt = args.excerpt;
  if (args.slug) payload.slug = args.slug;
  if (args.parent_id) payload.parent = args.parent_id;
  if (args.menu_order !== undefined) payload.menu_order = args.menu_order;
  if (args.template) payload.template = args.template;
  if (args.comment_status) payload.comment_status = args.comment_status;

  log("info", `Creating WordPress page: "${args.title}" (status: ${payload.status})`);

  const page = await wpFetch("/pages", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const statusLabel = payload.status === "publish" ? "Published" : "Saved as Draft";

  const lines = [
    `WordPress Page ${statusLabel}`,
    "=".repeat(30),
    `Title:   ${page.title?.rendered || args.title}`,
    `ID:      ${page.id}`,
    `Status:  ${page.status}`,
    `Slug:    ${page.slug}`,
    `URL:     ${page.link}`,
    `Date:    ${page.date?.slice(0, 10) || ""}`,
    ``,
  ];

  // If the page is published, prompt about adding a menu item
  if (page.status === "publish") {
    lines.push("--- Menu Link ---");
    lines.push(`Page ID ${page.id} is now live at: ${page.link}`);
    lines.push("");
    lines.push(
      "Would you like to add this page to a navigation menu?\n" +
      "If yes, please tell me:\n" +
      "  1. Which menu to add it to (call wordpress_list_menus to see available menus)\n" +
      "  2. What label the menu item should have (default: page title)\n" +
      "  3. Whether it should be top-level or nested under an existing menu item\n\n" +
      "I will then call wordpress_add_menu_item to add the link."
    );
  } else {
    lines.push(
      `This page is saved as a draft. Once you publish it, you can add it to a ` +
      `navigation menu using wordpress_add_menu_item.`
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// -----------------------------------------------------------------------

export async function handleWpAddMenuItem(args) {
  const menuId = Number(args?.menu_id);
  if (!menuId) throw new Error("'menu_id' is required. Use wordpress_list_menus to find menu IDs.");
  if (!args?.title) throw new Error("'title' is required - the label shown in the menu.");

  const itemType = args.type || "custom";

  // Validate required fields per type
  if ((itemType === "page" || itemType === "post") && !args.object_id) {
    throw new Error(
      `'object_id' is required when type is '${itemType}'. ` +
      `Use wordpress_list_pages or wordpress_list_posts to find the ID.`
    );
  }
  if (itemType === "custom" && !args.url) {
    throw new Error("'url' is required when type is 'custom'.");
  }

  // Determine menu order - append to end by default
  let menuOrder = args.menu_order;
  if (menuOrder === undefined) {
    try {
      const existing = await wpFetch(
        `/menu-items?menus=${menuId}&per_page=100&_fields=menu_order`
      );
      const maxOrder = existing?.reduce(
        (max, item) => Math.max(max, item.menu_order || 0),
        0
      ) || 0;
      menuOrder = maxOrder + 10;
    } catch {
      menuOrder = 10;
    }
  }

  const payload = {
    title: args.title,
    menus: menuId,
    menu_order: menuOrder,
    status: "publish",
    type: itemType,
  };

  if (itemType === "page")  { payload.object = "page";  payload.object_id = args.object_id; }
  if (itemType === "post")  { payload.object = "post";  payload.object_id = args.object_id; }
  if (itemType === "custom") {
    payload.object = "custom";
    payload.url = args.url;
  }

  // If a page/post type but url override provided, use it
  if (args.url && itemType !== "custom") payload.url = args.url;

  // Parent menu item for dropdowns
  if (args.parent_menu_item_id) payload.parent = args.parent_menu_item_id;

  log("info", `Adding menu item "${args.title}" to menu ${menuId}`);

  const item = await wpFetch("/menu-items", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const lines = [
    `Menu Item Added`,
    "===============",
    `Label:      ${item.title?.rendered || args.title}`,
    `Item ID:    ${item.id}`,
    `Menu ID:    ${menuId}`,
    `Type:       ${item.type_label || itemType}`,
    `URL:        ${item.url || ""}`,
    `Order:      ${item.menu_order}`,
    item.parent ? `Parent:     ${item.parent} (nested under that item)` : `Position:   Top-level`,
    ``,
    `The menu item is now live. Visit your site to confirm it appears correctly.`,
  ].join("\n");

  return { content: [{ type: "text", text: lines }] };
}

// -----------------------------------------------------------------------

export async function handleWpUpdateContent(args) {
  const id = Number(args?.id);
  if (!id) throw new Error("'id' is required.");
  if (!args?.content_type) throw new Error("'content_type' must be 'post' or 'page'.");

  const endpoint = args.content_type === "page" ? "/pages" : "/posts";
  const payload = {};

  if (args.title)   payload.title   = args.title;
  if (args.content) payload.content = args.content;
  if (args.status)  payload.status  = args.status;
  if (args.excerpt) payload.excerpt = args.excerpt;
  if (args.slug)    payload.slug    = args.slug;

  if (Object.keys(payload).length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No fields to update were provided. Include at least one of: title, content, status, excerpt, slug.",
        },
      ],
    };
  }

  log("info", `Updating WordPress ${args.content_type} ID ${id}`);

  const updated = await wpFetch(`${endpoint}/${id}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const lines = [
    `WordPress ${args.content_type === "page" ? "Page" : "Post"} Updated`,
    "=".repeat(30),
    `ID:      ${updated.id}`,
    `Title:   ${updated.title?.rendered || "(unchanged)"}`,
    `Status:  ${updated.status}`,
    `Slug:    ${updated.slug}`,
    `URL:     ${updated.link}`,
    `Modified: ${updated.modified?.slice(0, 16) || ""}`,
  ].join("\n");

  return { content: [{ type: "text", text: lines }] };
}

// =======================================================================
// NEW: wordpress_get_content  (fetch post or page by ID)
// =======================================================================

export const wpGetContentToolDefinition = {
  name: "wordpress_get_content",
  description:
    "Fetch the full content of a single WordPress post or page by its numeric ID. " +
    "Returns title, slug, status, HTML content (rendered), excerpt, categories, tags, " +
    "featured media ID, modified date, and the edit link. " +
    "Use this before calling wordpress_update_content to inspect existing content.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "WordPress post or page numeric ID.",
      },
      content_type: {
        type: "string",
        enum: ["post", "page"],
        description: "Whether the ID refers to a post or a page. Default 'post'.",
      },
    },
    required: ["id"],
  },
};

export async function handleWpGetContent(args) {
  const id = Number(args?.id);
  if (!id) throw new Error("'id' is required and must be a non-zero number.");

  const contentType = (args?.content_type || "post").toLowerCase();
  if (contentType !== "post" && contentType !== "page") {
    throw new Error("'content_type' must be 'post' or 'page'.");
  }

  const endpoint = contentType === "page" ? "/pages" : "/posts";

  log("info", `wordpress_get_content: fetching ${contentType} ID ${id}`);

  const item = await wpFetch(`${endpoint}/${id}?context=edit`);

  const categories = Array.isArray(item.categories)
    ? item.categories.join(", ")
    : "";
  const tags = Array.isArray(item.tags) ? item.tags.join(", ") : "";

  const lines = [
    `WordPress ${contentType === "page" ? "Page" : "Post"} - ID ${item.id}`,
    "=".repeat(40),
    `Title:          ${item.title?.raw || item.title?.rendered || ""}`,
    `Slug:           ${item.slug}`,
    `Status:         ${item.status}`,
    `Date:           ${item.date?.slice(0, 16) || ""}`,
    `Modified:       ${item.modified?.slice(0, 16) || ""}`,
    `URL:            ${item.link || ""}`,
    categories ? `Categories:     ${categories}` : null,
    tags ? `Tags:           ${tags}` : null,
    item.featured_media ? `Featured Media: ${item.featured_media}` : null,
    item.excerpt?.raw ? `Excerpt:        ${item.excerpt.raw.slice(0, 200)}` : null,
    ``,
    `--- CONTENT (raw) ---`,
    item.content?.raw || item.content?.rendered || "(empty)",
  ].filter((l) => l !== null);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
