// src/tests/skill-export-client.test.js  (claude-connector v13.41.0)
// ---------------------------------------------------------------------------
// GET /skill-export's body (src/utils/skillExport.js): the ava directory as
// before, and on a tenant-mode connector the client directory its compile
// reads, as `client` (Gateway 2.277.0, TENAX-2026-10-23-01).
// ---------------------------------------------------------------------------

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSkillExport, walkExportable } from '../utils/skillExport.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );
let root;
let ava;
let client;

const put = ( base, rel, content ) => {
  mkdirSync( dirname( join( base, rel ) ), { recursive: true } );
  writeFileSync( join( base, rel ), content );
};

before( () => {
  root = mkdtempSync( join( tmpdir(), 'skill-export-' ) );
  ava = join( root, 'skill', 'ava' );
  client = join( root, 'clients', 't-demo' );
  put( ava, 'MANIFEST.json', '{"modules":[{"id":"owner-mod","path":"modules/a/owner-mod.md"}]}' );
  put( ava, 'modules/a/owner-mod.md', '# owner' );
  put( ava, 'PERSONALITY.md', 'the owner, never exported' );
  put( ava, 'PROFILES.md', 'people, never exported' );
  put( ava, '.hidden.md', 'never exported' );
  put( ava, 'modules/a/image.png', 'not an exported type' );
  put( client, 'MANIFEST.json', '{"modules":[{"id":"client-mod","path":"modules/philosophy/client-mod.md"}]}' );
  put( client, 'modules/philosophy/client-mod.md', '# client' );
  put( client, 'references/manifest/10-x.json', '{"modules":[]}' );
  put( client, 'PERSONALITY.md', 'the tenant\'s person, never exported' );
} );

after( () => rmSync( root, { recursive: true, force: true } ) );

describe( 'C-EXPORT-CLIENT: the client directory a tenant-mode compile reads', () => {
  test( 'owner mode: the ava directory only, exactly as before', () => {
    const b = buildSkillExport( { avaDir: ava, tenant: { isTenantMode: false, tenantId: '', clientDir: ava } } );
    assert.deepEqual( Object.keys( b.files ).sort(), [ 'MANIFEST.json', 'modules/a/owner-mod.md' ] );
    assert.equal( b.file_count, 2 );
    assert.equal( b.ava_dir, ava );
    assert.equal( b.client, undefined );
  } );

  test( 'tenant mode: `files` unchanged, and `client` carries the tenant directory under the same rules', () => {
    const b = buildSkillExport( { avaDir: ava, tenant: { isTenantMode: true, tenantId: 't-demo', clientDir: client } } );
    assert.deepEqual( Object.keys( b.files ).sort(), [ 'MANIFEST.json', 'modules/a/owner-mod.md' ] );
    assert.equal( b.client.tenant_id, 't-demo' );
    assert.equal( b.client.dir, client );
    assert.deepEqual( Object.keys( b.client.files ).sort(), [ 'MANIFEST.json', 'modules/philosophy/client-mod.md', 'references/manifest/10-x.json' ] );
    assert.match( b.client.files[ 'MANIFEST.json' ], /client-mod/ );
    assert.equal( b.client.file_count, 3 );
  } );

  test( 'tenant mode with no client directory yet: no `client`', () => {
    const b = buildSkillExport( { avaDir: ava, tenant: { isTenantMode: true, tenantId: 't-none', clientDir: join( root, 'clients', 't-none' ) } } );
    assert.equal( b.client, undefined );
  } );

  test( 'personal files, dotfiles and other types are never exported, from either directory', () => {
    const f = walkExportable( client );
    assert.ok( ! Object.keys( f ).some( ( k ) => /PERSONALITY|PROFILES|^\.|\.png$/.test( k ) ) );
  } );

  test( 'the route builds its body with buildSkillExport and the connector\'s own client directory', () => {
    const src = readFileSync( join( HERE, '..', 'server-http.js' ), 'utf8' );
    const route = src.slice( src.indexOf( 'app.get("/skill-export"' ), src.indexOf( '\n});', src.indexOf( 'app.get("/skill-export"' ) ) );
    assert.match( route, /buildSkillExport\(\{/ );
    assert.match( route, /tenant: \{ isTenantMode: mp\.isTenantMode, tenantId: mp\.tenantId, clientDir: mp\.avaDir/ );
    assert.match( route, /return res\.json\(body\);/ );
  } );
} );
