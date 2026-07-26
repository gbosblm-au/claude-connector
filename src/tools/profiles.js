// src/tools/profiles.js  v10.8.0
// Two tools for Ava PROFILES.md management on Railway persistent volume.
//
// profile_read         - Read PROFILES.md at session start. Returns full content
//                        plus a structured persons list with style signals for
//                        session-start anomaly detection. Called after skill_read.
// profile_write_person - Write or update a specific person's full profile section.
//                        Creates a new section if the person is not yet in the file.
//                        Called after substantive turns when new profile-relevant
//                        information has emerged, and when a new person is confirmed
//                        following a style-anomaly check.
//
// File location on Railway volume:
//   Derived from SKILL_FILE_PATH: /data/skill/PROFILES.md
//   Override via PROFILES_FILE_PATH env var.
//
// File format (PROFILES.md):
//   # Ava User Profiles
//   <header paragraph>
//
//   ---
//
//   ## [Person Name]
//
//   **Relationship:** [primary operator | occasional user | other]
//   **First observed:** YYYY-MM-DD
//   **Last updated:** YYYY-MM-DD
//   **Session count:** N
//
//   ### Communication style
//   ...
//   ### Cognitive style
//   ...
//   ### Emotional patterns
//   ...
//   ### Challenges and recurring themes
//   ...
//   ### Personal context
//   ...
//   ### Ava interaction preferences
//   ...
//   ### Style anomaly baseline
//   ...
//   ### Reliability flags
//   ...
//
//   ---
//
// Person section parsing:
//   Sections are delimited by lines containing only "---".
//   The first section is the file header (no ## heading).
//   Subsequent sections begin with "## [Person Name]".
//
// Anomaly detection:
//   The style_signals object returned by profile_read is a structured extract
//   of the Style anomaly baseline section for each known person. Ava compares
//   the first 3-5 exchanges of a session against these signals. Significant
//   deviation (2+ dimensions clearly off) triggers a single check-in question.
//   Tool does not enforce this - it is a SKILL.md behavioural discipline.
//
// WordPress backup:
//   Non-blocking push to POST /wp-json/ava-skill/v1/profiles after every
//   profile_write_person call. Uses WP_SKILL_URL + WP_SKILL_KEY env vars.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { log } from '../utils/logger.js';
import {
  resolveSessionIdentity,
  gatewayConfigured,
  profileReadRemote,
  profileWriteRemote,
} from './ti-tools-client.js';

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

function getProfilesPaths() {
  const skillPath  = process.env.SKILL_FILE_PATH   || '/data/skill/SKILL.md';
  const filePath   = process.env.PROFILES_FILE_PATH || skillPath.replace(/SKILL\.md$/, 'PROFILES.md');
  const wpUrl      = (process.env.WP_SKILL_URL || '').replace(/\/$/, '');
  const wpKey      = process.env.WP_SKILL_KEY  || '';
  return { filePath, wpUrl, wpKey };
}

function ensureDir(filePath) {
  const dir = filePath.replace(/[/\\][^/\\]+$/, '');
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Initial file content (used when PROFILES.md does not yet exist)
// ---------------------------------------------------------------------------

const PROFILES_HEADER = `# Ava User Profiles

Autonomous psychometric and behavioural profiles for individuals Ava interacts with on this deployment. Built and updated from observed conversation patterns across sessions. All observations are dated. Observations that have not been confirmed for 90+ days should be treated as potentially stale and noted accordingly.

These profiles inform calibration silently. They are internal context, not conversational material. Ava does not cite the profile in conversation unless explicitly asked. The profile shapes how Ava reads the room, not what she says about having read it.

`;

// ---------------------------------------------------------------------------
// Section parsing utilities
// ---------------------------------------------------------------------------

// Split PROFILES.md into sections. Returns an array of section strings.
// The first element is the header block (no ## heading).
// Subsequent elements are person blocks starting with ## [Name].
function splitSections(content) {
  // Normalise line endings
  const normalised = content.replace(/\r\n/g, '\n');
  // Split on lines that are exactly "---" (with optional surrounding whitespace)
  const parts = normalised.split(/\n---\n/);
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

// Reassemble sections back into PROFILES.md content.
function joinSections(sections) {
  if (sections.length === 0) return PROFILES_HEADER.trimEnd() + '\n';
  return sections.join('\n\n---\n\n') + '\n\n---\n';
}

// Extract the person name from a section string (first ## heading).
// Returns null if the section has no ## heading (i.e. it is the file header).
function extractPersonName(section) {
  const match = section.match(/^##\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

// Case-insensitive name comparison helper.
function namesMatch(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Build a flat list of persons and their key style signals for anomaly detection.
// Returns an array of { name, relationship, first_observed, last_updated, session_count, style_signals }
function extractPersonsList(sections) {
  const persons = [];
  for (const section of sections) {
    const name = extractPersonName(section);
    if (!name) continue; // skip file header

    const rel       = extractField(section, 'Relationship');
    const firstObs  = extractField(section, 'First observed');
    const lastUpd   = extractField(section, 'Last updated');
    const sessCount = extractField(section, 'Session count');
    const baseline  = extractSubsection(section, 'Style anomaly baseline');

    persons.push({
      name,
      relationship:    rel      || 'unknown',
      first_observed:  firstObs || null,
      last_updated:    lastUpd  || null,
      session_count:   sessCount ? parseInt(sessCount, 10) || 0 : 0,
      style_signals:   baseline ? baseline.trim() : null,
    });
  }
  return persons;
}

// Extract a bold-label field value from a person section.
// Matches "**Label:** value" pattern.
function extractField(section, label) {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)$`, 'm');
  const m  = section.match(re);
  return m ? m[1].trim() : null;
}

// Extract the text content of a ### subsection.
function extractSubsection(section, heading) {
  const re = new RegExp(`###\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n###|$)`, 'i');
  const m  = section.match(re);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// WordPress backup (non-blocking)
// ---------------------------------------------------------------------------

async function pushProfilesToWordPress(content, personCount, wpUrl, wpKey) {
  if (!wpUrl || !wpKey) return { skipped: true, reason: 'WP_SKILL_URL or WP_SKILL_KEY not configured' };
  try {
    const res = await fetch(`${wpUrl}/profiles`, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Ava-Skill-Key': wpKey,
        'User-Agent':      'claude-connector/10.8.0 (ava-profiles-sync)',
      },
      body: JSON.stringify({
        content,
        person_count: personCount,
        timestamp:    new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: t.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function formatWpResult(r) {
  if (r.skipped) return 'not configured';
  if (r.ok)      return 'ok';
  return `failed: ${r.error || String(r.status || 'unknown')}`;
}

// ---------------------------------------------------------------------------
// WordPress restore handler
// Called by POST /restore-profiles in server-http.js.
// Accepts a parsed request body from the WordPress admin "Push to Railway" action.
// ---------------------------------------------------------------------------

export async function handleProfilesRestoreFromWp(body) {
  const { filePath } = getProfilesPaths();
  const content       = typeof body.content        === 'string' ? body.content        : '';
  const changeSummary = typeof body.change_summary === 'string' ? body.change_summary : 'WordPress admin restore push';

  if (!content.trim()) {
    return { success: false, error: 'content is required and must not be empty.' };
  }

  ensureDir(filePath);

  try {
    writeFileSync(filePath, content, 'utf8');
    const sections    = splitSections(content);
    const persons     = extractPersonsList(sections);
    const personCount = persons.length;
    log('info', `restore-profiles: wrote ${content.split('\n').length} lines, ${personCount} person(s) from WordPress push`);
    return { success: true, person_count: personCount, persons: persons.map(p => p.name), change_summary: changeSummary };
  } catch (err) {
    log('error', `restore-profiles write failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const profileReadToolDefinition = {
  name: 'profile_read',
  description:
    'Read PROFILES.md from Railway persistent volume at session start. ' +
    'Returns the full profile content plus a structured persons list with ' +
    'style_signals for each known person. ' +
    'style_signals contains the Style anomaly baseline text used to compare ' +
    'against the current session\'s interaction pattern. ' +
    'Call this at session start immediately after skill_read. ' +
    'If no profile file exists yet, returns an empty persons list and a note ' +
    'to begin building the profile from this session.',
  inputSchema: {
    type: 'object',
    properties: {
      person_name: {
        type:        'string',
        description: 'Optional. If provided, returns only the section for this person. ' +
                     'Omit to return the full file and all persons.',
      },
    },
    required: [],
  },
};

export const profileWritePersonToolDefinition = {
  name: 'profile_write_person',
  description:
    'Write or update a specific person\'s profile section in PROFILES.md on ' +
    'Railway persistent volume. ' +
    'If the person already exists in the file, their section is fully replaced. ' +
    'If the person does not exist, a new section is appended. ' +
    'Call this: (a) after any substantive turn where new profile-relevant ' +
    'information has emerged (communication style, cognitive patterns, emotional ' +
    'signals, personal context, challenges, interaction preferences); ' +
    '(b) when a new person is confirmed following a style-anomaly check; ' +
    '(c) when existing profile information has become clearly obsolete. ' +
    'profile_content must be the full markdown block for this person — ' +
    'from "## [Name]" through the final section. ' +
    'Always increment session_count by 1 for the primary person at session close. ' +
    'Always update last_updated to today\'s date. ' +
    'Always update the Style anomaly baseline section with the most current signals. ' +
    'Add a reliability flag entry when an observation may have become stale.',
  inputSchema: {
    type: 'object',
    properties: {
      person_name: {
        type:        'string',
        description: 'Name of the person whose profile is being written or updated. ' +
                     'Must match the ## heading in profile_content exactly.',
      },
      profile_content: {
        type:        'string',
        description: 'Full markdown block for this person. Must start with ' +
                     '"## [Person Name]\\n\\n" and include all sections: ' +
                     'Relationship, First observed, Last updated, Session count, ' +
                     'Communication style, Cognitive style, Emotional patterns, ' +
                     'Challenges and recurring themes, Personal context, ' +
                     'Ava interaction preferences, Style anomaly baseline, ' +
                     'Reliability flags.',
      },
      change_note: {
        type:        'string',
        description: 'Brief note on what changed in this update (max 200 chars). ' +
                     'E.g. "Updated emotional patterns; added reliability flag for job situation".',
      },
    },
    required: ['person_name', 'profile_content', 'change_note'],
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Build the PROFILES.md (volume) read payload. Returns the payload object plus
// helpers for the Postgres-primary wrapper: `hasData` and `seedContent` (the
// specific person's section to seed into Postgres on a 404, when identifiable).
// ---------------------------------------------------------------------------
function readVolumePayload(args) {
  const { filePath } = getProfilesPaths();
  ensureDir(filePath);

  const personNameFilter = (args.person_name || '').trim();

  if (!existsSync(filePath)) {
    log('info', 'profile_read: PROFILES.md does not exist yet');
    return {
      payload: {
        content:      '',
        persons:      [],
        person_count: 0,
        note: 'PROFILES.md does not exist on Railway volume. ' +
              'Begin building a profile for this person from the current session. ' +
              'Call profile_write_person at session close with the first profile entry.',
      },
      hasData: false,
      seedContent: null,
    };
  }

  const content    = readFileSync(filePath, 'utf8');
  const sections   = splitSections(content);
  const allPersons = extractPersonsList(sections);

  let lastUpdated = null;
  try {
    const { mtimeMs } = statSync(filePath);
    lastUpdated = new Date(mtimeMs).toISOString();
  } catch { /* non-critical */ }

  if (personNameFilter) {
    const personSection = sections.find(s => {
      const n = extractPersonName(s);
      return n && namesMatch(n, personNameFilter);
    });
    if (!personSection) {
      return {
        payload: {
          content:      null,
          persons:      allPersons.map(p => p.name),
          person_count: allPersons.length,
          note:         `Person "${personNameFilter}" not found in PROFILES.md. ` +
                        `Known persons: ${allPersons.map(p => p.name).join(', ') || 'none yet'}.`,
        },
        hasData: false,
        seedContent: null,
      };
    }
    const person = allPersons.find(p => namesMatch(p.name, personNameFilter));
    return {
      payload: {
        content:      personSection,
        person:       person || null,
        person_count: allPersons.length,
        last_updated: lastUpdated,
      },
      hasData: true,
      seedContent: personSection,   // a single person's section -> safe to seed
    };
  }

  log('info', `profile_read: returned ${allPersons.length} person(s)`);
  return {
    payload: {
      content,
      persons:      allPersons,
      person_count: allPersons.length,
      last_updated: lastUpdated,
    },
    hasData: allPersons.length > 0,
    // Only a single-person file is safe to seed wholesale into one user's row.
    seedContent: allPersons.length === 1 ? content : null,
  };
}

function mcpText(payload, isError = false) {
  const out = { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  if (isError) out.isError = true;
  return out;
}

/**
 * profile_read -- Postgres-primary, PROFILES.md cache/fallback.
 *
 * @param {object} args     Tool args (may include person_name, tenant_id, user_id).
 * @param {object} [context] Per-call { tenant_id, user_id } from the gateway.
 */
export async function handleProfileRead(args = {}, context = null) {
  const volume = readVolumePayload(args);
  const { tenantId, userId } = resolveSessionIdentity(context, args);

  let profileSource = 'volume';
  let postgres = null;

  if (tenantId && userId && gatewayConfigured()) {
    try {
      const remote = await profileReadRemote(tenantId, userId);
      if (remote.existing) {
        postgres = {
          content:    remote.content,
          revision:   remote.revision,
          updated_at: remote.updated_at,
          source:     remote.source || null,
        };
        profileSource = 'postgres';
      } else {
        // 404: no Postgres profile yet. Seed from the volume when we can safely
        // identify this user's single section, then serve the volume payload.
        if (volume.seedContent) {
          try {
            await profileWriteRemote({
              tenantId, userId, mode: 'replace',
              content: volume.seedContent,
              reason: 'seed from PROFILES.md on first read',
              source: 'profile_sync',
            });
            log('info', `profile_read: seeded Postgres profile for tenant=${tenantId} user=${userId}`);
          } catch (seedErr) {
            log('warn', `profile_read: Postgres seed failed (non-fatal): ${seedErr.message}`);
          }
        }
        profileSource = 'volume';
      }
    } catch (err) {
      log('warn', `profile_read: gateway unavailable, using PROFILES.md: ${err.message}`);
      profileSource = 'volume';
    }
  }

  const payload = { ...volume.payload, profile_source: profileSource };
  if (postgres) {
    // Postgres is authoritative for the per-user personality content. Surface it
    // alongside the (backward-compatible) volume-derived fields.
    payload.personality_content    = postgres.content;
    payload.personality_revision   = postgres.revision;
    payload.personality_updated_at = postgres.updated_at;
    payload.personality_source     = postgres.source;
    payload.existing               = true;
  }
  return mcpText(payload);
}

/**
 * profile_write_person -- Postgres-primary write, PROFILES.md cache/fallback.
 *
 * Writes the person's profile section to Postgres first (best-effort), then
 * always writes the PROFILES.md cache and pushes to WordPress exactly as before.
 * If Postgres is unreachable, the volume write still succeeds (graceful degrade).
 *
 * @param {object} args      Tool args (person_name, profile_content, change_note, ...).
 * @param {object} [context] Per-call { tenant_id, user_id } from the gateway.
 */
export async function handleProfileWritePerson(args = {}, context = null) {
  const { filePath, wpUrl, wpKey } = getProfilesPaths();
  ensureDir(filePath);

  const personName     = (args.person_name     || '').trim();
  const profileContent = (args.profile_content || '').trim();
  const changeNote     = (args.change_note     || '').slice(0, 200);

  if (!personName)     return mcpText({ error: 'person_name is required.' }, true);
  if (!profileContent) return mcpText({ error: 'profile_content is required.' }, true);

  // Validate profile_content starts with the correct ## heading
  const headingRe = /^##\s+/m;
  if (!headingRe.test(profileContent)) {
    return mcpText({
      error: 'profile_content must start with "## [Person Name]". ' +
             'Ensure the content begins with the person\'s ## heading.',
    }, true);
  }

  // Verify the ## heading in profile_content matches person_name
  const headingMatch = profileContent.match(/^##\s+(.+)$/m);
  const headingName  = headingMatch ? headingMatch[1].trim() : '';
  if (!namesMatch(headingName, personName)) {
    return mcpText({
      error: `person_name "${personName}" does not match the ## heading "${headingName}" in profile_content. ` +
             'These must match exactly (case-insensitive).',
    }, true);
  }

  // --- Postgres primary write (best-effort) --------------------------------
  const { tenantId, userId } = resolveSessionIdentity(context, args);
  let postgres = { attempted: false };
  if (tenantId && userId && gatewayConfigured()) {
    postgres = { attempted: true, ok: false };
    try {
      const res = await profileWriteRemote({
        tenantId, userId, mode: 'replace',
        content: profileContent,
        reason: changeNote || 'profile_write_person',
        source: 'ai_auto',
      });
      postgres = { attempted: true, ok: true, changed: res.changed === true, revision: res.revision };
      log('info', `profile_write_person: Postgres write ok (user=${userId}, changed=${postgres.changed}, rev=${postgres.revision}).`);
    } catch (err) {
      postgres = { attempted: true, ok: false, error: err.message };
      log('warn', `profile_write_person: Postgres write failed, PROFILES.md fallback only: ${err.message}`);
    }
  }

  // --- PROFILES.md cache write (always; also the fallback store) ------------
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : PROFILES_HEADER;
  const sections = splitSections(existing);

  const headerSection  = sections.find(s => !extractPersonName(s)) || PROFILES_HEADER.trim();
  const personSections = sections.filter(s => extractPersonName(s) !== null);

  const existingIdx = personSections.findIndex(s => {
    const n = extractPersonName(s);
    return n && namesMatch(n, personName);
  });

  let isNew = false;
  if (existingIdx >= 0) {
    personSections[existingIdx] = profileContent;
  } else {
    personSections.push(profileContent);
    isNew = true;
  }

  const allSections    = [headerSection, ...personSections];
  const updatedContent = joinSections(allSections);
  writeFileSync(filePath, updatedContent, 'utf8');

  const personCount = personSections.length;
  const primaryStore = postgres.ok ? 'postgres' : 'volume';

  log('info', `profile_write_person: ${isNew ? 'created' : 'updated'} "${personName}" (${personCount} person(s)) primary=${primaryStore} - ${changeNote}`);

  // Non-blocking WordPress push
  let wpResult = { skipped: true };
  try {
    wpResult = await pushProfilesToWordPress(updatedContent, personCount, wpUrl, wpKey);
  } catch (err) {
    wpResult = { ok: false, error: err.message };
    log('warn', `profile_write_person: WP push failed: ${err.message}`);
  }

  return mcpText({
    success:          true,
    person_name:      personName,
    operation:        isNew ? 'created' : 'updated',
    person_count:     personCount,
    change_note:      changeNote,
    primary_store:    primaryStore,
    postgres,
    wordpress_backup: formatWpResult(wpResult),
  });
}
