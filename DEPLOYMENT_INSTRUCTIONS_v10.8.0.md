# Deployment Instructions — Claude Connector v10.8.0 + TS Ava Skill v1.6.0

## What this build adds

**Claude Connector v10.8.0:**
- NEW `profile_read` tool — reads PROFILES.md from Railway Volume at session start
- NEW `profile_write_person` tool — writes or updates a specific person's profile section
- NEW `POST /restore-profiles` endpoint — receives PROFILES.md push from WordPress admin
- FIXED `POST /restore-books` endpoint — was missing in v10.7.0 despite WP plugin expecting it
- Both new tools gated on `SKILL_FILE_PATH` (same condition as skill tools — no new env var needed)

**TS Ava Skill v1.6.0:**
- NEW Profiles tab in admin UI (seventh tab)
- NEW `POST /profiles` and `GET /profiles` REST endpoints
- NEW push-to-Railway button for PROFILES.md
- NEW Profiles Railway Restore URL setting
- Updated REST endpoints reference table and Railway Variables reference

---

## Deployment steps

### Phase A — Deploy connector

1. Stop your current Railway deployment (or let it redeploy on push).
2. Replace the following files in your connector source:
   - `src/server-http.js` (updated)
   - `src/tools/profiles.js` (new)
   - `src/tools/books.js` (updated — adds `handleBooksRestoreFromWp`)
3. Deploy to Railway. No new env vars are required — PROFILES.md will be stored at
   `/data/skill/PROFILES.md` (derived from `SKILL_FILE_PATH` automatically).
4. Verify startup log shows:
   ```
   claude-connector v10.8.0 on http://...
   Profiles: ENABLED (profile_read, profile_write_person)
   Profiles restore endpoint: ENABLED (POST /restore-profiles)
   Books restore endpoint: ENABLED (POST /restore-books)
   ```

### Phase B — Deploy WordPress plugin

1. In WordPress admin, go to Plugins > Add New > Upload Plugin.
2. Upload `ts-ava-skill-v1.6.0.zip` and activate (replacing v1.5.0).
3. Go to Ava Skill > Settings > Railway Push.
4. Add the new **Profiles Railway Restore URL**:
   `https://[your-railway-domain]/restore-profiles`
5. Save Railway Settings.
6. Verify the Profiles tab now appears in the Ava Skill admin menu.

### Phase C — Configure Books restore (fix the missing endpoint)

If you previously had `ava_skill_railway_books_url` set but the push was failing
(because the `/restore-books` endpoint didn't exist in the connector), it will now
work with the v10.8.0 connector. No settings change needed — it uses the same
RAILWAY_RESTORE_TOKEN.

---

## SKILL.md session protocol amendment

Add the following block to your SKILL.md **immediately after the `skill_read` session-start
instruction** (or in the Session protocol section, as a step 4):

```
Profile read. Call profile_read immediately after skill_read at every session start.
At session open: note the stored style_signals for the known person. Within the first
3-5 exchanges, assess whether the current interaction style matches the stored baseline
on: vocabulary register, question structure, emotional tone, and depth preference.
Significant deviation (2 or more dimensions clearly off profile) triggers one check-in:
"You are engaging quite differently to how you usually work with me - is everything all
right, or is there someone else at the keyboard?" Ask once only. Do not repeat.
Response paths: (a) same person, different day - acknowledge, continue, note as
contextual variation in next profile write; (b) confirmed different person - call
profile_write_person to create a new entry and begin building their profile;
(c) no acknowledgement or denial - continue, note the ambiguity in reliability flags.
Call profile_write_person after any substantive turn where new profile-relevant
information has emerged (communication style, cognitive patterns, emotional signals,
personal context, challenges, interaction preferences). At session close: increment
session_count by 1 for the primary person, update last_updated to today's date, and
refresh the Style anomaly baseline section with the most current signals observed.
Profile is internal calibration context only - never cite it in conversation
unless directly asked what you know about the person.
```

---

## New env vars (none required)

No new Railway Variables are needed. PROFILES.md path is derived automatically:

| Condition | PROFILES.md path |
|---|---|
| `PROFILES_FILE_PATH` set | Uses that value |
| Only `SKILL_FILE_PATH` set | Replaces `SKILL.md` with `PROFILES.md` in that path |
| Neither set | `/data/skill/PROFILES.md` (default) |

---

## PROFILES.md format reference

The connector creates this file automatically on first `profile_write_person` call.
Format per person section:

```markdown
## [Person Name]

**Relationship:** primary operator | occasional user | other
**First observed:** YYYY-MM-DD
**Last updated:** YYYY-MM-DD
**Session count:** N

### Communication style
[Direct/indirect, formal/casual, verbosity, depth preference, technical register]

### Cognitive style
[Linear vs associative, detail-first vs concept-first, problem structuring approach]

### Emotional patterns
[How they express frustration, enthusiasm, uncertainty; emotional baseline; sensitivities]

### Challenges and recurring themes
[What they work through repeatedly; active areas of inquiry; ongoing projects]

### Personal context
[What has been shared about life, work, circumstances — all observations dated]

### Ava interaction preferences
[What they respond well to; preferred pushback style; response format preferences]

### Style anomaly baseline
[Key observable signals: typical vocabulary register, typical question structure,
typical response length to Ava outputs, typical emotional tone, typical depth request]

### Reliability flags
[YYYY-MM-DD | observation that may be stale or has changed]
```

---

## File summary

| File | Type | Change |
|---|---|---|
| `src/server-http.js` | Replace | v10.8.0 — profiles import, PROFILES_ENABLED, dispatch, restore endpoints, startup log |
| `src/tools/profiles.js` | New | Two profile tools + restore handler |
| `src/tools/books.js` | Replace | Added `handleBooksRestoreFromWp` (fixes /restore-books gap) |
| `ts-ava-skill.php` | Replace | v1.6.0 — Profiles tab, endpoints, settings, push function |
