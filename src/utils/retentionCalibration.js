// src/utils/retentionCalibration.js  v1.0.0   (claude-connector v13.37.0)
// ---------------------------------------------------------------------------
// The ordering the downloads reaper and the signed-link lifetime must keep:
// reaper >= link. TENAX-2026-10-09-01, C-CALIBRATION and C-NEG-STALE-LINK.
//
// The reaper (DOWNLOADS_TTL_HOURS, server-http.js) keys off file mtime and a
// link (LINK_EXPIRY_SECONDS, signedUrls.js) is minted when the file is
// written. A reaper shorter than the link deletes a file while its link still
// verifies, and the user gets a 404 on a link that looks valid instead of the
// intended "link expired". Until v13.37.0 that ordering was a docblock: an
// operator who set DOWNLOADS_TTL_HOURS=24 against the 3-day link got exactly
// that 404 and no warning.
//
// From v13.37.0 it is enforced. The reaper runs at the larger of the two, so
// a configured value below the link lifetime is raised to it, and the
// connector says so at boot. Raising rather than refusing to boot: the
// misconfiguration is in a retention window, and taking the whole service
// down over it would be the larger harm.
// ---------------------------------------------------------------------------

/**
 * The reaper window, in hours, that keeps a file for at least as long as its
 * link verifies.
 *
 * @param {number} configuredHours DOWNLOADS_TTL_HOURS as configured.
 * @param {number} linkSeconds The signed-link lifetime (linkExpirySeconds()).
 * @returns {{ hours: number, raised: boolean, configuredHours: number, linkHours: number, message: string|null }}
 */
export function calibrateDownloadsTtl( configuredHours, linkSeconds ) {
  const linkHours = Number.isFinite( linkSeconds ) && linkSeconds > 0 ? Math.ceil( linkSeconds / 3600 ) : 0;
  const configured = Number.isFinite( configuredHours ) && configuredHours > 0 ? configuredHours : 0;
  if ( configured >= linkHours ) {
    return { hours: configured, raised: false, configuredHours: configured, linkHours, message: null };
  }
  return {
    hours: linkHours,
    raised: true,
    configuredHours: configured,
    linkHours,
    message: `DOWNLOADS_TTL_HOURS=${ configured } is shorter than the ${ linkHours }h signed-link lifetime `
      + `(LINK_EXPIRY_SECONDS=${ linkSeconds }), which would delete files whose links still verify. `
      + `The downloads reaper runs at ${ linkHours }h instead. Set DOWNLOADS_TTL_HOURS to at least ${ linkHours }.`,
  };
}

/**
 * Would a file written now still exist when its link stops verifying? The
 * falsifiable form of the rule, for the tests and the boot check.
 *
 * @param {number} reaperHours
 * @param {number} linkSeconds
 * @returns {boolean}
 */
export function fileOutlivesLink( reaperHours, linkSeconds ) {
  return reaperHours * 3600 >= linkSeconds;
}

export default { calibrateDownloadsTtl, fileOutlivesLink };
