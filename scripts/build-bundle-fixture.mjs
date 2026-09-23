#!/usr/bin/env node
// scripts/build-bundle-fixture.mjs  v13.29.0
//
// Builds fixture-gateway.zip for SPEC-SOURCE-BUNDLE-001 s14, and the small
// archives the s12 refusal pairs use. Constructed by script, never committed as
// a binary, so the expected listing is DERIVED from FIXTURE_ENTRIES at test time
// rather than remembered.
//
// The zip writer here is deliberately independent of src/bundles/zip-archive.js:
// a fixture written by the reader under test would agree with it by
// construction. It can also write what ordinary zip tools refuse to: a symlink
// entry, a central directory that lies about a size, a path containing ../, an
// encryption flag, and a cp437 (non-EFS) name.
//
// CLI:  node scripts/build-bundle-fixture.mjs [out.zip]
//       (default: ./fixture-gateway.zip)

import { deflateRawSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

/**
 * Write a zip archive.
 *
 * @param {Array<{ name: string|Buffer, data?: Buffer|string, method?: 0|8, mode?: number,
 *                 efs?: boolean, encrypted?: boolean, declared_size?: number, dir?: boolean }>} entries
 *   name: a string is written as UTF-8 bytes (set efs for non-ASCII); a Buffer
 *   is written verbatim (for cp437 names). declared_size overrides the size the
 *   central and local headers state, to fabricate a size mismatch.
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const raw = e.dir ? Buffer.alloc(0) : (Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8'));
    const method = e.dir ? 0 : (e.method ?? 8);
    const stored = method === 8 ? deflateRawSync(raw, { level: 9 }) : raw;
    const crc = crc32(raw) >>> 0;
    const declared = e.declared_size ?? raw.length;
    const flags = (e.encrypted ? 0x0001 : 0) | (e.efs ? 0x0800 : 0);
    const mode = e.mode ?? (e.dir ? (S_IFDIR | 0o755) : (S_IFREG | 0o644));

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(stored.length, 18);
    lfh.writeUInt32LE(declared, 22);
    lfh.writeUInt16LE(nameBytes.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBytes, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4);          // made by: unix, so mode bits count
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(stored.length, 20);
    cd.writeUInt32LE(declared, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE((mode << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBytes);

    offset += 30 + nameBytes.length + stored.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** A minimal PNG: signature, IHDR chunk header, then NUL-bearing data. */
export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]),
  Buffer.from('IHDR', 'ascii'), Buffer.alloc(40, 0),
]);

/** UTF-16LE with a byte-order mark. */
export const UTF16LE_BYTES = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Written on Windows.\r\nSecond line.\r\n', 'utf16le')]);

/** 21 MiB of zeros: above the 20 MiB per-entry bound, deflates at ~1000:1. */
export const BOMB_SIZE = 21 * 1024 * 1024;

/** cp437 byte 0x82 is é. */
export const CP437_NAME = Buffer.concat([Buffer.from('docs/r', 'ascii'), Buffer.from([0x82]), Buffer.from('sum', 'ascii'), Buffer.from([0x82]), Buffer.from('.txt', 'ascii')]);
export const CP437_NAME_DECODED = 'docs/résumé.txt';

/** A zip holding one text file. */
const innerZip = (name, text) => writeZip([{ name, data: text }]);

/**
 * The fixture's entries, each with the outcome the spec requires of it.
 * `expect` is one of: { class }, { excluded: rule }, { refused: code }.
 * `path` is the path the manifest must report (differs from name only for the
 * cp437 entry, and for refused unsafe paths it is the raw name).
 */
export const FIXTURE_ENTRIES = [
  { name: 'src/', dir: true, expect: { excluded: 'directory entry' } },
  { name: 'src/index.js', data: "import { util } from './lib/util.mjs';\nconsole.log(util());\n", expect: { class: 'text' } },
  { name: 'src/lib/util.mjs', data: 'export function util() {\n  return 42;\n}\n', expect: { class: 'text' } },
  { name: 'src/cjs/legacy.cjs', data: "module.exports = { legacy: true };\n", expect: { class: 'text' } },
  { name: 'src/types.ts', data: 'export type Id = string;\n', expect: { class: 'text' } },
  { name: 'package.json', data: '{\n  "name": "fixture-gateway",\n  "type": "module"\n}\n', expect: { class: 'text' } },
  { name: 'Dockerfile', data: 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]\n', expect: { class: 'text' } },
  { name: 'Makefile', data: 'test:\n\tnode --test\n', expect: { class: 'text' } },
  { name: 'LICENSE', data: 'MIT License\n\nCopyright (c) 2026\n', expect: { class: 'text' } },
  { name: 'Procfile', data: 'web: node server.js\n', expect: { class: 'text' } },
  { name: '.dockerignore', data: 'node_modules\n.git\n', expect: { class: 'text' } },
  { name: '.gitignore', data: 'node_modules/\ndist/\n', expect: { class: 'text' } },
  { name: '.env.example', data: 'DATABASE_URL=\nPORT=3000\n', expect: { class: 'text' } },
  { name: '.dockerfile', data: 'FROM node:22\n', expect: { class: 'text' } },
  { name: 'Dockerfile.prod', data: 'FROM node:22-alpine AS prod\n', expect: { class: 'text' } },
  { name: 'docker-compose.yml', data: 'services:\n  app:\n    build: .\n', expect: { class: 'text' } },
  { name: 'docs/café.md', efs: true, data: '# Café\n\nUTF-8 name, EFS flag set.\n', expect: { class: 'text' } },
  { name: CP437_NAME, path: CP437_NAME_DECODED, data: 'cp437 name, EFS flag clear.\n', expect: { class: 'text' } },
  { name: 'scripts/crlf.txt', data: 'line one\r\nline two\r\n', expect: { class: 'text' } },
  { name: 'scripts/lf.txt', data: 'line one\nline two\n', expect: { class: 'text' } },
  { name: 'notes/latin1.txt', data: Buffer.from([0x63, 0x61, 0x66, 0xE9, 0x0A]), expect: { class: 'text-uncertain' } },
  { name: 'assets/logo.png', data: PNG_BYTES, method: 0, expect: { class: 'binary' } },
  { name: 'docs/utf16.txt', data: UTF16LE_BYTES, expect: { class: 'text' } },
  { name: 'misnamed/notes.txt', data: innerZip('inside.md', 'hidden\n'), method: 0, expect: { class: 'archive' } },
  { name: 'misnamed/really-text.zip', data: 'this is plain text\n', expect: { class: 'text' } },
  { name: 'nested/one-level.zip', data: innerZip('inner/a.js', 'export const a = 1;\n'), method: 0, expect: { class: 'archive' } },
  { name: 'nested/three-levels.zip', method: 0,
    data: writeZip([{ name: 'level2.zip', method: 0,
      data: writeZip([{ name: 'level3.zip', method: 0, data: innerZip('deep.txt', 'too deep\n') }]) }]),
    expect: { class: 'archive' } },
  { name: '../escape.txt', data: 'zip slip\n', expect: { refused: 'entry_path_unsafe' } },
  { name: 'link-to-etc', data: '/etc/passwd', mode: S_IFLNK | 0o777, expect: { refused: 'entry_symlink_refused' } },
  { name: 'sizes/mismatch.txt', data: 'the central directory says this is shorter\n', declared_size: 10, expect: { refused: 'entry_size_mismatch' } },
  { name: 'bomb/zeros.bin', data: Buffer.alloc(BOMB_SIZE), expect: { refused: 'archive_entry_too_large' } },
  { name: 'node_modules/left-pad/index.js', data: 'module.exports = 1;\n', expect: { excluded: 'node_modules/' } },
  { name: '.git/HEAD', data: 'ref: refs/heads/main\n', expect: { excluded: '.git/' } },
  { name: 'dist/bundle.js', data: 'built\n', expect: { excluded: 'dist/' } },
  { name: '.DS_Store', data: Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]), expect: { excluded: '.DS_Store' } },
];

/**
 * The entries inside accepted nested archives, which the manifest must also
 * report. Derived from the construction above, and kept beside it.
 */
export const FIXTURE_NESTED_ENTRIES = [
  { path: 'misnamed/notes.txt!/inside.md', expect: { class: 'text' } },
  { path: 'nested/one-level.zip!/inner/a.js', expect: { class: 'text' } },
  { path: 'nested/three-levels.zip!/level2.zip', expect: { class: 'archive' } },
  { path: 'nested/three-levels.zip!/level2.zip!/level3.zip', expect: { refused: 'archive_too_deep' } },
];

/** @returns {Buffer} fixture-gateway.zip */
export function buildFixtureGatewayZip() {
  return writeZip(FIXTURE_ENTRIES);
}

/** The manifest path an entry must appear under. */
export function expectedPath(e) {
  if (e.path) return e.path;
  const n = Buffer.isBuffer(e.name) ? e.name.toString('latin1') : e.name;
  return e.dir ? n.replace(/\/$/, '') : n;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] || 'fixture-gateway.zip';
  const buf = buildFixtureGatewayZip();
  writeFileSync(out, buf);
  console.log(`wrote ${out}: ${buf.length} bytes, ${FIXTURE_ENTRIES.length} top-level entries`);
}
