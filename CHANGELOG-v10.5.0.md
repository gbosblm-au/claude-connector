# Changelog - claude-connector v10.5.0

## v10.5.0 - 2026-05-23

### New Feature: Incremental Skill Additions Architecture

Adds two new tools and extends `skill_read` to support append-only incremental
additions to SKILL.md without transmitting the full canonical file on every write.

**Problem solved:** Previously, every PF Session A addition and every book log
entry required a full canonical rewrite of the 590+ line SKILL.md via a bash POST.
In v10.5.0, incremental additions are staged as tiny append writes to a separate
`SKILL_ADDITIONS.md` file and merged into the canonical at OSC pre-step.

---

### New tool: `skill_write_addition`

Appends a single ADDITION block to `SKILL_ADDITIONS.md`. Tiny write - the full
canonical SKILL.md is NOT transmitted.

**Use for:**
- PF Session A Type 7 paragraph additions (every run in every PF queue)
- Book log entries (every new book read)
- Any other approved minor addition

**ADDITION block format stored in SKILL_ADDITIONS.md:**
```
## ADDITION: {session_id} {ISO_timestamp}
Change-summary: {text}
Location-type: insert_after | prepend_list
Location-anchor: {distinctive text on the insertion-point line}

{content to insert}

---
```

**Location types:**
- `insert_after` - inserts new content after the line containing the anchor text.
  Used for PF Session A paragraph additions (Type 7 blocks in the skill).
- `prepend_list` - finds the anchor line then locates the first `- ` list item
  after it, and inserts the new content before that item.
  Used for book log entries (new books prepend to top of the list).

**Parameters:** `content`, `location_type`, `location_anchor`, `session_id`, `change_summary`

---

### New tool: `skill_merge_additions`

Applies every ADDITION block in `SKILL_ADDITIONS.md` to the canonical `SKILL.md`,
writes the merged result as a new canonical version (with full versioning and WP
backup), and clears `SKILL_ADDITIONS.md`.

Called at OSC pre-step before prompt sampling to ensure the canonical is fully
current. Also callable on request mid-queue.

Returns: `blocks_found`, `blocks_applied`, `placement_warnings`, canonical result
(`version_id`, `line_count`), and `additions_cleared: true`.

**Placement failure handling:** If an anchor is not found in the canonical, the
addition content is appended to the end of the skill file with a visible HTML
comment marker, and the warning is included in the return value. Nothing is silently
lost.

---

### Modified tool: `skill_read`

Canonical read (default, no parameters) now also returns:
- `additions_content` - full content of `SKILL_ADDITIONS.md` (empty string if none)
- `additions_count` - number of pending staged additions
- `additions_note` - human-readable status summary

This means session start requires only **one** `skill_read()` call to get both the
canonical SKILL.md and any pending additions. Ava composes both as the working skill.

New parameter `additions=true` reads `SKILL_ADDITIONS.md` explicitly for inspection
without triggering a merge.

---

### New Railway volume file

`SKILL_ADDITIONS.md` - append-only incremental additions log. Auto-created on first
`skill_write_addition` call. Cleared on every `skill_merge_additions` call.

`additions_meta.json` - metadata for the additions file: count, last_updated,
last_session_id. Auto-created and maintained alongside `SKILL_ADDITIONS.md`.

No new environment variables are required. All paths are derived from `SKILL_FILE_PATH`.

---

### Volume file layout (updated)

```
/data/skill/
  SKILL.md                              <- live canonical file
  SKILL_PENDING.md                      <- structural amendment staging (unchanged)
  SKILL_ADDITIONS.md                    <- incremental additions log (NEW)
  skill_meta.json                       <- current version metadata
  additions_meta.json                   <- additions metadata (NEW)
  skill_history.json                    <- last 50 version headers
  versions/
    SKILL_YYYYMMDD_HHMMSS_vNNN.md
    ...
```

---

### Workflow change for PF sessions

**Before v10.5.0 (every PF Session A):**
1. Read 590+ line canonical via skill_read
2. Apply paragraph in Python script
3. Transmit full 590+ line file via bash POST
4. Receive version confirmation

**From v10.5.0 (every PF Session A):**
1. Call skill_write_addition with the new paragraph, location_type=insert_after,
   location_anchor=[last phrase of preceding paragraph], session_id=[e.g. PF10-1A]
2. Receive confirmation (additions_total count)

**At OSC pre-step (once per queue):**
1. Call skill_merge_additions with change_summary
2. One canonical write for all accumulated additions
3. Receive merged version_id and confirmation

**Book log entries:**
- Call skill_write_addition with location_type=prepend_list,
  location_anchor="**Books read.**", session_id="book-[title]"

---

### Upgrade path from v10.4.0

No breaking changes. All four existing tools (skill_read, skill_write,
skill_history, skill_rollback) behave identically to v10.4.0. The additions
architecture is additive.

`SKILL_ADDITIONS.md` and `additions_meta.json` are created on first use.
No manual file creation needed.

Update steps:
1. Deploy new connector code (replace src/tools/skill.js and src/server-http.js)
2. No new environment variables required
3. Verify startup log shows "v10.5.0"
4. Test with: call skill_write_addition with test content, verify SKILL_ADDITIONS.md
   created, call skill_read and confirm additions_count=1 in response
5. Call skill_merge_additions to apply and clear; verify new canonical version

---

### Other changes

- `CONNECTOR_USER_AGENT` in pushToWordPress updated to `claude-connector/10.5.0`
- `package.json` version bumped to `10.5.0`
- Startup log reports `v10.5.0`
