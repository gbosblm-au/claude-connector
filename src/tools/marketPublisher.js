// tools/marketPublisher.js
//
// WordPress SEO meta and Elementor-compatible page publishing tools.
//
// These tools extend the core wordpress.js tools with:
//   1. wordpress_set_seo_meta  — writes Yoast SEO / RankMath meta on any post/page
//   2. wordpress_create_service_page — creates a fully-structured HTML service page
//      in the TrueSource brand style (CSS class names match the attached stylesheet)
//      and publishes it via the REST API as Elementor-compatible HTML content.
//
// ELEMENTOR COMPATIBILITY NOTE:
//   Pages created here use clean semantic HTML with the site's own CSS classes.
//   Elementor stores its layout in the _elementor_data meta field (JSON).
//   This tool writes both the standard content field (for fallback rendering) and
//   a valid minimal Elementor data structure so the page is editable in Elementor.
//
// SEO SUPPORT:
//   Supports Yoast SEO (most common) and RankMath. Falls back gracefully if neither
//   plugin is active by storing the values in both sets of meta keys.
//   WordPress's native SEO title can also be set via the `title` field directly.

import { log } from "../utils/logger.js";
import { getWordPressCredentials } from "../utils/credentialStore.js";

// -----------------------------------------------------------------------
// Config helper (mirrors wordpress.js)
// -----------------------------------------------------------------------

function getWpConfig() {
  const creds = getWordPressCredentials();
  if (!creds) {
    throw new Error(
      "WordPress is not configured.\n" +
        "Call set_wordpress_credentials with wp_url, wp_username, and wp_password.\n" +
        "Or set WP_URL, WP_USERNAME, WP_APP_PASSWORD in Railway environment variables."
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
      ...(options.headers || {}),
    },
  });

  const body = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg =
      body?.message || body?.error || `HTTP ${resp.status} ${resp.statusText}`;
    throw new Error(`WordPress API error: ${msg}`);
  }

  return body;
}

// -----------------------------------------------------------------------
// Tool 1: wordpress_set_seo_meta
// -----------------------------------------------------------------------

export const wpSetSeoMetaToolDefinition = {
  name: "wordpress_set_seo_meta",
  description:
    "Sets SEO meta title and meta description on an existing WordPress page or post. " +
    "Supports Yoast SEO (most common) and RankMath. " +
    "The seo_title should be 50-60 characters and include the primary keyword. " +
    "The meta_description should be 150-160 characters, include the primary keyword, and contain a clear call to action. " +
    "Call this immediately after wordpress_create_page or wordpress_create_post to ensure the page has correct SEO metadata. " +
    "Returns confirmation of which SEO plugin fields were set.",
  inputSchema: {
    type: "object",
    properties: {
      post_id: {
        type: "number",
        description:
          "The WordPress post or page ID (returned by wordpress_create_page / wordpress_create_post).",
      },
      content_type: {
        type: "string",
        description: "Whether this is a 'page' or a 'post'.",
        enum: ["page", "post"],
      },
      seo_title: {
        type: "string",
        description:
          "The custom SEO title tag (50-60 characters recommended). Appears in Google search results as the clickable headline.",
      },
      meta_description: {
        type: "string",
        description:
          "The meta description (150-160 characters recommended). Appears in Google search results beneath the title.",
      },
      focus_keyword: {
        type: "string",
        description:
          "Primary keyword for Yoast SEO focus keyphrase field (optional but recommended).",
      },
    },
    required: ["post_id", "content_type", "seo_title", "meta_description"],
  },
};

export async function handleWpSetSeoMeta(args) {
  const id = Number(args?.post_id);
  if (!id) throw new Error("'post_id' is required.");
  if (!args?.seo_title) throw new Error("'seo_title' is required.");
  if (!args?.meta_description) throw new Error("'meta_description' is required.");

  const endpoint = args.content_type === "post" ? "/posts" : "/pages";

  // Build meta object covering both Yoast SEO and RankMath fields so the
  // tool works regardless of which SEO plugin is active.
  const meta = {
    // Yoast SEO fields
    _yoast_wpseo_title: args.seo_title,
    _yoast_wpseo_metadesc: args.meta_description,
    // RankMath fields
    rank_math_title: args.seo_title,
    rank_math_description: args.meta_description,
  };

  if (args.focus_keyword) {
    meta._yoast_wpseo_focuskw = args.focus_keyword;
    meta.rank_math_focus_keyword = args.focus_keyword;
  }

  log("info", `Setting SEO meta on ${args.content_type} ID ${id}`);

  let updated;
  let pluginsSet = [];

  // Attempt to update meta fields.
  // WordPress REST API only exposes custom meta fields if the plugin registers them.
  // We try to set all and let WordPress silently ignore unknown keys.
  try {
    updated = await wpFetch(`${endpoint}/${id}`, {
      method: "POST",
      body: JSON.stringify({ meta }),
    });
    pluginsSet = ["Yoast SEO", "RankMath"];
  } catch (err) {
    // Some hardened WordPress configs disallow unknown meta via REST.
    // In that case, report the limitation and what the user should do manually.
    const lines = [
      "SEO Meta — Manual Setup Required",
      "=================================",
      `Could not set meta via REST API: ${err.message}`,
      "",
      "Please set the following manually in WordPress Admin:",
      "",
      `Page ID:          ${id}`,
      `SEO Title:        ${args.seo_title}`,
      `Meta Description: ${args.meta_description}`,
      args.focus_keyword ? `Focus Keyword:    ${args.focus_keyword}` : "",
      "",
      "In Yoast SEO: Edit the page > Yoast SEO panel (bottom of editor) > SEO tab.",
      "In RankMath: Edit the page > RankMath sidebar > General tab.",
    ]
      .filter(Boolean)
      .join("\n");

    return { content: [{ type: "text", text: lines }] };
  }

  const lines = [
    "SEO Meta Set Successfully",
    "=========================",
    `Page/Post ID:     ${id}`,
    `Content Type:     ${args.content_type}`,
    `SEO Title:        ${args.seo_title} (${args.seo_title.length} chars)`,
    `Meta Description: ${args.meta_description} (${args.meta_description.length} chars)`,
    args.focus_keyword ? `Focus Keyword:    ${args.focus_keyword}` : "",
    "",
    `SEO fields written for: ${pluginsSet.join(", ")}`,
    "(Unused plugin fields are silently ignored by WordPress.)",
    "",
    "Title length check: " +
      (args.seo_title.length >= 50 && args.seo_title.length <= 60
        ? "GOOD (50-60 chars)"
        : args.seo_title.length < 50
        ? "SHORT — consider expanding to 50+ chars"
        : "LONG — consider trimming to under 60 chars"),
    "Description length check: " +
      (args.meta_description.length >= 140 && args.meta_description.length <= 160
        ? "GOOD (140-160 chars)"
        : args.meta_description.length < 140
        ? "SHORT — consider expanding to 140+ chars"
        : "LONG — consider trimming to under 160 chars"),
  ]
    .filter(Boolean)
    .join("\n");

  return { content: [{ type: "text", text: lines }] };
}

// -----------------------------------------------------------------------
// Tool 2: wordpress_create_service_page
// -----------------------------------------------------------------------

export const wpCreateServicePageToolDefinition = {
  name: "wordpress_create_service_page",
  description:
    "Creates a fully structured, brand-consistent HTML service page in the TrueSource style " +
    "and publishes it to WordPress as an Elementor-compatible page. " +
    "The HTML output uses the TrueSource CSS class system (Navy #002B47, Gold #C19D55, Poppins headings, Open Sans body). " +
    "Use this instead of wordpress_create_page when creating a new service offering page. " +
    "Accepts all content sections as structured parameters and returns the page ID and URL. " +
    "After calling this, always call wordpress_set_seo_meta with the returned page ID.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "The page title (used as H1 on the page and the WordPress page title).",
      },
      slug: {
        type: "string",
        description:
          "URL slug for the page, e.g. 'data-analytics-consulting'. Lowercase, hyphens only.",
      },
      status: {
        type: "string",
        description:
          "Publishing status: 'publish' to go live immediately, 'draft' to save for review.",
        enum: ["publish", "draft"],
      },
      hero_subtitle: {
        type: "string",
        description:
          "The subtitle/tagline shown beneath the H1 in the hero section (1-3 sentences).",
      },
      hero_cta_primary_text: {
        type: "string",
        description: "Label for the primary CTA button in the hero, e.g. 'Engage a Specialist'.",
      },
      hero_cta_primary_url: {
        type: "string",
        description:
          "URL for the primary CTA button, e.g. 'https://truesourceconsulting.com.au/Contractor-Request/'.",
      },
      hero_cta_secondary_text: {
        type: "string",
        description: "Label for the secondary CTA button, e.g. 'View Capabilities'.",
      },
      hero_cta_secondary_anchor: {
        type: "string",
        description: "Anchor ID for the secondary button to scroll to, e.g. 'capabilities'.",
      },
      intro_heading: {
        type: "string",
        description: "H2 heading for the introduction / value proposition section.",
      },
      intro_body: {
        type: "string",
        description:
          "Body copy for the introduction section (2-4 paragraphs of HTML or plain text).",
      },
      outcomes: {
        type: "array",
        description: "List of 3-6 quantified outcome bullet points shown in the intro section.",
        items: {
          type: "object",
          properties: {
            metric: { type: "string", description: "The bold metric/number, e.g. '$2.9M'." },
            description: { type: "string", description: "What was achieved, e.g. 'cost reduction in 2 months'." },
          },
          required: ["metric", "description"],
        },
      },
      capabilities_heading: {
        type: "string",
        description: "H2 heading for the capabilities grid section.",
      },
      capabilities: {
        type: "array",
        description: "List of 4-8 capability cards shown in the capabilities grid.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Capability card title." },
            description: { type: "string", description: "1-2 sentence description of the capability." },
          },
          required: ["title", "description"],
        },
      },
      faqs: {
        type: "array",
        description: "List of 3-5 frequently asked questions with answers.",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The FAQ question." },
            answer: { type: "string", description: "The answer (1-3 sentences)." },
          },
          required: ["question", "answer"],
        },
      },
      cta_heading: {
        type: "string",
        description: "H2 heading for the final CTA section, e.g. 'Ready to Drive Results?'.",
      },
      cta_body: {
        type: "string",
        description: "Supporting text beneath the final CTA heading (1-2 sentences).",
      },
      cta_primary_text: {
        type: "string",
        description: "Label for the primary CTA button in the final section.",
      },
      cta_primary_url: {
        type: "string",
        description: "URL for the primary CTA button in the final section.",
      },
      cta_secondary_text: {
        type: "string",
        description: "Label for the secondary CTA button in the final section (optional).",
      },
      cta_secondary_url: {
        type: "string",
        description: "URL for the secondary CTA button in the final section (optional).",
      },
      parent_id: {
        type: "number",
        description:
          "Optional parent page ID. For service pages, use the Services page ID (find with wordpress_list_pages).",
      },
      custom_css_overrides: {
        type: "string",
        description:
          "Optional inline CSS overrides to append inside a <style> block on the page. " +
          "Use for page-specific colour, spacing, or layout adjustments. " +
          "Leave empty to use the site's global stylesheet unchanged.",
      },
    },
    required: [
      "title",
      "slug",
      "status",
      "hero_subtitle",
      "intro_heading",
      "intro_body",
      "capabilities_heading",
      "capabilities",
      "cta_heading",
      "cta_body",
      "cta_primary_text",
      "cta_primary_url",
    ],
  },
};

export async function handleWpCreateServicePage(args) {
  if (!args?.title) throw new Error("'title' is required.");
  if (!args?.slug) throw new Error("'slug' is required.");
  if (!args?.hero_subtitle) throw new Error("'hero_subtitle' is required.");
  if (!args?.intro_heading) throw new Error("'intro_heading' is required.");
  if (!args?.intro_body) throw new Error("'intro_body' is required.");
  if (!args?.capabilities_heading) throw new Error("'capabilities_heading' is required.");
  if (!args?.capabilities?.length) throw new Error("At least one 'capabilities' item is required.");
  if (!args?.cta_heading) throw new Error("'cta_heading' is required.");
  if (!args?.cta_body) throw new Error("'cta_body' is required.");
  if (!args?.cta_primary_text) throw new Error("'cta_primary_text' is required.");
  if (!args?.cta_primary_url) throw new Error("'cta_primary_url' is required.");

  // ---- Build HTML sections ----

  const heroPrimary = args.hero_cta_primary_text && args.hero_cta_primary_url
    ? `<a href="${args.hero_cta_primary_url}" class="btn btn-secondary">${args.hero_cta_primary_text}</a>`
    : "";

  const heroSecondary = args.hero_cta_secondary_text
    ? `<a href="#${args.hero_cta_secondary_anchor || "capabilities"}" class="btn btn-ghost-light">${args.hero_cta_secondary_text}</a>`
    : "";

  const heroButtons = heroPrimary || heroSecondary
    ? `<div class="btn-group" style="justify-content:center;margin-top:32px;">${heroPrimary}${heroSecondary}</div>`
    : "";

  // Outcomes list
  const outcomesHtml = args.outcomes?.length
    ? `<div style="margin-top:32px;">
<h3 style="color:var(--navy-blue);font-family:'Poppins',sans-serif;margin-bottom:16px;">Outcomes Delivered in Our Network</h3>
<ul style="list-style:none;padding:0;margin:0;">
${args.outcomes
  .map(
    (o) =>
      `<li style="padding-left:1.75em;position:relative;margin-bottom:10px;">` +
      `<span style="position:absolute;left:0;top:0;color:var(--gold-yellow);font-weight:700;">&#10003;</span>` +
      `<strong>${o.metric}</strong> ${o.description}</li>`
  )
  .join("\n")}
</ul>
</div>`
    : "";

  // Intro body — wrap plain text paragraphs if not already HTML
  const introBodyHtml = args.intro_body.includes("<p")
    ? args.intro_body
    : args.intro_body
        .split(/\n\n+/)
        .map((p) => `<p>${p.trim()}</p>`)
        .join("\n");

  // Capabilities grid
  const capabilityCards = args.capabilities
    .map(
      (c) =>
        `<div class="capability-card">
<div class="capability-title">${c.title}</div>
<p style="font-size:14px;color:var(--dark-gray);line-height:1.5;margin-top:8px;">${c.description}</p>
</div>`
    )
    .join("\n");

  // FAQs
  const faqsHtml = args.faqs?.length
    ? `<!-- FAQ Section -->
<div class="section section-light" id="faq" style="padding:60px 0;">
<div class="container">
<h2 class="text-center" style="margin-bottom:40px;">Frequently Asked Questions</h2>
${args.faqs
  .map(
    (f) =>
      `<div style="margin-bottom:28px;border-bottom:1px solid var(--medium-gray);padding-bottom:24px;">
<h4 style="font-family:'Poppins',sans-serif;color:var(--navy-blue);margin-bottom:10px;">${f.question}</h4>
<p style="color:var(--dark-gray);line-height:1.7;margin:0;">${f.answer}</p>
</div>`
  )
  .join("\n")}
</div>
</div>`
    : "";

  // Final CTA secondary
  const ctaSecondary = args.cta_secondary_text && args.cta_secondary_url
    ? `<a href="${args.cta_secondary_url}" class="btn btn-ghost-light" style="margin-top:8px;">${args.cta_secondary_text}</a>`
    : "";

  // Custom CSS
  const customCssBlock = args.custom_css_overrides
    ? `<style>\n${args.custom_css_overrides}\n</style>\n`
    : "";

  // ---- Assemble full page HTML ----

  const html = `${customCssBlock}<!-- Hero Section -->
<div class="hero" id="hero">
<div class="container">
<div class="hero-content">
<h1>${args.title}</h1>
<p>${args.hero_subtitle}</p>
${heroButtons}
</div>
</div>
</div>

<!-- Introduction / Value Proposition -->
<div class="section" id="intro">
<div class="container">
<h2>${args.intro_heading}</h2>
${introBodyHtml}
${outcomesHtml}
</div>
</div>

<!-- Capabilities Grid -->
<div class="section section-light" id="capabilities">
<div class="container">
<h2 class="text-center" style="margin-bottom:40px;">${args.capabilities_heading}</h2>
<div class="capabilities-grid">
${capabilityCards}
</div>
</div>
</div>

${faqsHtml}

<!-- Final CTA Section -->
<div class="section section-dark" id="cta">
<div class="container text-center">
<h2>${args.cta_heading}</h2>
<p style="font-size:18px;opacity:0.9;max-width:640px;margin:0 auto 32px;">${args.cta_body}</p>
<div class="btn-group" style="justify-content:center;">
<a href="${args.cta_primary_url}" class="btn btn-secondary">${args.cta_primary_text}</a>
${ctaSecondary}
</div>
</div>
</div>`;

  // ---- Build Elementor-compatible meta ----
  // Elementor stores layout in _elementor_data (JSON array of sections).
  // When we write a minimal valid structure Elementor recognises the page
  // as Elementor-built and will not overwrite the content on next save.
  // We use a single "section > column > widget" structure with the widget
  // type "html" so Elementor renders our raw HTML block.
  const elementorData = JSON.stringify([
    {
      id: "ts-service-section",
      elType: "section",
      settings: { layout: "full_width" },
      elements: [
        {
          id: "ts-service-col",
          elType: "column",
          settings: { _column_size: 100 },
          elements: [
            {
              id: "ts-service-html",
              elType: "widget",
              widgetType: "html",
              settings: { html: html },
              elements: [],
            },
          ],
        },
      ],
    },
  ]);

  // ---- Publish the page via REST API ----

  const payload = {
    title: args.title,
    content: html,
    slug: args.slug,
    status: args.status || "draft",
    comment_status: "closed",
  };

  if (args.parent_id) payload.parent = args.parent_id;

  // Elementor meta — set _elementor_data and mark as Elementor-built
  payload.meta = {
    _elementor_data: elementorData,
    _elementor_edit_mode: "builder",
    _elementor_template_type: "wp-page",
    _elementor_version: "3.0.0",
  };

  log("info", `Creating service page: "${args.title}" (status: ${payload.status})`);

  const page = await wpFetch("/pages", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const statusLabel = payload.status === "publish" ? "Published Live" : "Saved as Draft";

  const lines = [
    `WordPress Service Page ${statusLabel}`,
    "=".repeat(40),
    `Title:    ${page.title?.rendered || args.title}`,
    `ID:       ${page.id}`,
    `Status:   ${page.status}`,
    `Slug:     ${page.slug}`,
    `URL:      ${page.link}`,
    "",
    "NEXT STEPS:",
    "1. Call wordpress_set_seo_meta with this page ID to add SEO title and meta description.",
    "2. Call wordpress_list_menus to find the Services menu ID.",
    "3. Call wordpress_add_menu_item to add this page to the Services navigation dropdown.",
    "",
    "To edit in Elementor: Log into WordPress Admin > Pages > find this page > Edit with Elementor.",
  ].join("\n");

  return { content: [{ type: "text", text: lines }] };
}
