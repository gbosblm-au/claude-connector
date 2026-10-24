// src/utils/skillExport.js  (claude-connector v13.41.0)
// ---------------------------------------------------------------------------
// The content of GET /skill-export: every non-personal skill file of the ava
// content directory, relative to it, plus, on a tenant-mode connector, the
// same for the CLIENT directory the compile actually reads.
//
// WHY THE CLIENT DIRECTORY (Gateway 2.277.0, TENAX-2026-10-23-01, the
// administrator's decision of 2026-10-24)
// ----------------------------------------------------------------------
// In tenant mode (TS_CLIENT_MODE=tenant, TS_TENANT_ID set) skill_compile and
// skill_load_specialist read the manifest AND the module bodies from
// /data/clients/{tenant}/ (src/tools/skill-modular.js getModularPaths: avaDir,
// and `paths.avaDir + module.path`). /skill-export exported only the owner's
// ava/ directory, so the gateway's random module draw, which derives its pool
// from this export, registered and budgeted modules against the owner's
// manifest rather than the tenant's. `client` carries the tenant's own
// directory, walked with the same rules, so the draw can derive its pool from
// what that tenant's compile would load. `files` is unchanged: existing
// consumers (the gateway's /restore-modules backup) read it as before.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync } from 'fs';

/** Files never exported: per-person content. */
export const PERSONAL_FILES = new Set( [ 'PERSONALITY.md', 'PROFILES.md' ] );

/** Extensions exported. */
export const EXPORTABLE = /\.(md|json|py|sh|js|ts|txt)$/i;

/**
 * Every exportable file under `rootDir`, keyed by its path relative to it
 * (forward slashes, no leading slash). Unreadable directories and files are
 * skipped and reported through `warn`.
 *
 * @param {string} rootDir
 * @param {( msg: string ) => void} [warn]
 * @returns {Record<string, string>}
 */
export function walkExportable( rootDir, warn = () => {} ) {
  const base = String( rootDir ).replace( /\/+$/, '' );
  const files = {};
  const walk = ( absDir ) => {
    if ( ! existsSync( absDir ) ) return;
    let entries;
    try {
      entries = readdirSync( absDir, { withFileTypes: true } );
    } catch ( e ) {
      warn( `skill-export: cannot read dir ${ absDir }: ${ e.message }` );
      return;
    }
    for ( const entry of entries ) {
      const absPath = `${ absDir }/${ entry.name }`;
      if ( entry.isDirectory() ) {
        walk( absPath );
      } else if ( entry.isFile() ) {
        const relPath = absPath.slice( base.length ).replace( /^\//, '' );
        if ( PERSONAL_FILES.has( entry.name ) ) continue;
        if ( entry.name.startsWith( '.' ) ) continue;
        if ( ! EXPORTABLE.test( entry.name ) ) continue;
        try {
          files[ relPath ] = readFileSync( absPath, 'utf8' );
        } catch ( e ) {
          warn( `skill-export: cannot read file ${ absPath }: ${ e.message }` );
        }
      }
    }
  };
  walk( base );
  return files;
}

/**
 * The /skill-export response body.
 *
 * @param {{ avaDir: string, tenant?: { isTenantMode: boolean, tenantId: string, clientDir: string }, warn?: Function }} o
 * @returns {{ files: Record<string, string>, file_count: number, ava_dir: string,
 *             client?: { tenant_id: string, dir: string, files: Record<string, string>, file_count: number } }}
 */
export function buildSkillExport( o ) {
  const files = walkExportable( o.avaDir, o.warn );
  const out = { files, file_count: Object.keys( files ).length, ava_dir: o.avaDir };
  const t = o.tenant;
  if ( t && t.isTenantMode && t.tenantId && t.clientDir && existsSync( t.clientDir ) ) {
    const clientFiles = walkExportable( t.clientDir, o.warn );
    out.client = { tenant_id: t.tenantId, dir: t.clientDir, files: clientFiles, file_count: Object.keys( clientFiles ).length };
  }
  return out;
}

export default { walkExportable, buildSkillExport, PERSONAL_FILES, EXPORTABLE };
