// src/homework/docx-text.js
//
// Tutoring Homework Upload and Assessment Spec v1.0.0 — Section 6, the
// deterministic half of upload parsing.
//
// ===========================================================================
// WHY THIS EXISTS RATHER THAN A DEPENDENCY
// ===========================================================================
//
// The connector has no docx-capable package, and adding one to read a single
// XML part out of a zip is a large surface for a small job: mammoth pulls in an
// HTML converter and a style mapper, neither of which this path wants.
//
// More importantly, a .docx IS a zip containing `word/document.xml`, and Node
// ships raw inflate in `zlib`. The whole reader is the zip central directory
// walk plus an XML-to-text pass, both of which are small enough to be read and
// audited by whoever next has to debug a student's upload.
//
// ===========================================================================
// WHY NOT A REGEX OVER THE RAW BYTES
// ===========================================================================
//
// The tempting shortcut is to inflate everything and regex for `<w:t>`. It
// fails on the documents that matter most: Word splits a single typed sentence
// across several runs whenever formatting, spell-check state or a language tag
// changes mid-word, so `18/24` can arrive as three `<w:t>` elements. Text
// pulled out without honouring paragraph boundaries then runs questions and
// answers together, and the agreement gate sees a question that does not match
// anything.
//
// So paragraphs are reconstructed explicitly: `<w:p>` opens one, runs inside it
// concatenate WITHOUT a separator, and the paragraph ends with a newline. That
// is the structure the extractor downstream relies on.

'use strict';

import { inflateRawSync } from 'node:zlib';

/** Zip signatures, little-endian. */
const EOCD_SIG = 0x06054b50;
const CD_SIG   = 0x02014b50;
const LFH_SIG  = 0x04034b50;

/** The part of a .docx that holds the body text. */
const DOCUMENT_PART = 'word/document.xml';

/**
 * Locate the End of Central Directory record.
 *
 * Scanned BACKWARDS from the end because the EOCD is last, and it carries a
 * variable-length comment, so its offset cannot be computed. The 22-byte
 * minimum plus a 64 KB maximum comment bounds the search; anything further back
 * is not an EOCD and the file is not a zip.
 *
 * @param {Buffer} buf
 * @returns {number} Offset, or -1.
 */
function findEocd( buf ) {
  const minimum = 22;
  if ( buf.length < minimum ) return -1;

  const earliest = Math.max( 0, buf.length - minimum - 0xFFFF );
  for ( let i = buf.length - minimum; i >= earliest; i -= 1 ) {
    if ( buf.readUInt32LE( i ) === EOCD_SIG ) return i;
  }
  return -1;
}

/**
 * Read one file out of a zip buffer.
 *
 * Walks the central directory rather than scanning for local headers. The
 * central directory is authoritative: a local header's size fields can be zeroed
 * when the entry was written with a streaming data descriptor, which Word does
 * for some parts. Trusting the local header there yields an empty document and
 * no error at all.
 *
 * @param {Buffer} buf
 * @param {string} wanted Exact entry name.
 * @returns {Buffer|null}
 */
function readZipEntry( buf, wanted ) {
  const eocd = findEocd( buf );
  if ( eocd < 0 ) return null;

  const entries = buf.readUInt16LE( eocd + 10 );
  let offset = buf.readUInt32LE( eocd + 16 );

  for ( let i = 0; i < entries; i += 1 ) {
    if ( offset + 46 > buf.length ) return null;
    if ( buf.readUInt32LE( offset ) !== CD_SIG ) return null;

    const method     = buf.readUInt16LE( offset + 10 );
    const compressed = buf.readUInt32LE( offset + 20 );
    const nameLen    = buf.readUInt16LE( offset + 28 );
    const extraLen   = buf.readUInt16LE( offset + 30 );
    const commentLen = buf.readUInt16LE( offset + 32 );
    const localAt    = buf.readUInt32LE( offset + 42 );

    const name = buf.toString( 'utf8', offset + 46, offset + 46 + nameLen );

    if ( name === wanted ) {
      if ( localAt + 30 > buf.length ) return null;
      if ( buf.readUInt32LE( localAt ) !== LFH_SIG ) return null;

      // The local header's OWN name and extra lengths, which differ from the
      // central directory's: zip writers routinely pad the local extra field
      // for alignment. Using the central values here reads from the wrong
      // offset and inflates garbage.
      const localNameLen  = buf.readUInt16LE( localAt + 26 );
      const localExtraLen = buf.readUInt16LE( localAt + 28 );
      const dataAt = localAt + 30 + localNameLen + localExtraLen;

      const data = buf.subarray( dataAt, dataAt + compressed );

      if ( 0 === method ) return Buffer.from( data );   // stored
      if ( 8 === method ) {
        try { return inflateRawSync( data ); }
        catch ( err ) { return null; }
      }
      return null;   // an encrypted or exotically compressed part
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return null;
}

/**
 * Decode the five XML entities plus numeric references.
 *
 * `&amp;` is unescaped LAST. Reversed, `&amp;lt;` decodes to `&lt;` and then to
 * `<`, inventing markup that was never in the document -- the classic
 * double-unescape defect.
 *
 * @param {string} s
 * @returns {string}
 */
function decodeEntities( s ) {
  return s
    .replace( /&lt;/g, '<' )
    .replace( /&gt;/g, '>' )
    .replace( /&quot;/g, '"' )
    .replace( /&apos;/g, "'" )
    .replace( /&#x([0-9a-fA-F]+);/g, ( _, h ) => safeCodePoint( parseInt( h, 16 ) ) )
    .replace( /&#(\d+);/g, ( _, d ) => safeCodePoint( parseInt( d, 10 ) ) )
    .replace( /&amp;/g, '&' );
}

/**
 * A code point, or the empty string when it is not representable.
 *
 * A malformed reference in a student's upload must not throw: the file still
 * has to be parsed, and one bad character is not a reason to reject their work.
 *
 * @param {number} n
 * @returns {string}
 */
function safeCodePoint( n ) {
  if ( ! Number.isFinite( n ) || n < 0 || n > 0x10FFFF ) return '';
  try { return String.fromCodePoint( n ); }
  catch ( err ) { return ''; }
}

/**
 * Turn WordprocessingML into plain text, one line per paragraph.
 *
 * @param {string} xml
 * @returns {string}
 */
export function documentXmlToText( xml ) {
  if ( 'string' !== typeof xml || ! xml ) return '';

  // ── mc:AlternateContent, resolved BEFORE anything else ──────────────────
  //
  // Word 2010+ writes a text box TWICE: once under <mc:Choice Requires="wps">
  // as a DrawingML shape, and again under <mc:Fallback> as legacy VML, with the
  // SAME text in both. A reader that scans every <w:t> in the file therefore
  // sees every text-box answer twice.
  //
  // This is not cosmetic. An answer written in a text box and labelled
  // "Answer: 36" survives by luck -- the second label overwrites the first with
  // the same value. An UNLABELLED one does not: the two runs concatenate into
  // "36 36", which is marked wrong, and the student is told their correct
  // answer was incorrect. Verified against a constructed fixture before this
  // was written.
  //
  // The OOXML rule is that a consumer which understands the Choice requirement
  // uses the Choice and ignores the Fallback. Text extraction understands both
  // equally, so Choice is preferred and Fallback dropped -- but only when a
  // Choice is actually present. An AlternateContent carrying only a Fallback
  // still has its content read, because dropping it would lose the answer
  // outright, which is the worse of the two failures.
  let s = xml.replace(
    /<mc:AlternateContent\b[^>]*>([\s\S]*?)<\/mc:AlternateContent>/g,
    ( whole, inner ) => {
      const choice = /<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>/.exec( inner );
      if ( choice ) return choice[ 1 ];
      const fallback = /<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/.exec( inner );
      return fallback ? fallback[ 1 ] : inner;
    } );

  // Deleted text next. `<w:delText>` is what tracked changes leaves behind for
  // a deletion the student made; it is NOT part of the document they submitted,
  // and including it would put text the student removed into the answer that
  // gets marked.
  //
  // REDUNDANT with the run extraction below, and knowingly so. The run regex
  // matches `<w:t\b`, which `<w:delText>` does not satisfy, so deleted text is
  // never captured even without this line -- mutation testing confirmed that
  // removing it changes no output, and no test can distinguish the two.
  //
  // Kept because the redundancy is one line and the failure it guards is
  // severe: if the run regex is ever broadened (to pick up `<w:tab>` inline, or
  // to tolerate a namespace prefix), deleted text starts flowing into marked
  // answers with nothing to stop it and no test that would notice.
  s = s.replace( /<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, '' );

  // Instruction text of a field (page numbers, cross-references). Machinery,
  // not content.
  s = s.replace( /<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '' );

  // Structure that must become whitespace BEFORE the tag strip, because after
  // it there is nothing left to tell one paragraph from the next.
  s = s.replace( /<w:tab\b[^>]*\/?>/g, '\t' );
  s = s.replace( /<w:br\b[^>]*\/?>/g, '\n' );
  s = s.replace( /<w:cr\b[^>]*\/?>/g, '\n' );

  // A table cell boundary reads as a column break. Without it, a question in
  // one cell and its answer in the next are concatenated into a single run of
  // words with nothing marking the join.
  s = s.replace( /<\/w:tc>/g, '\t' );
  s = s.replace( /<\/w:p>/g, '\n' );

  // Runs concatenate with NO separator: Word splits a single typed word across
  // several `<w:t>` elements whenever formatting or spell-check state changes
  // mid-word, so inserting a space here would break `18/24` into `18 / 24`.
  const text = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|(\n|\t)/g;
  let m;
  while ( ( m = re.exec( s ) ) !== null ) {
    if ( m[ 1 ] !== undefined ) text.push( decodeEntities( m[ 1 ] ) );
    else text.push( m[ 2 ] );
  }

  return text.join( '' )
    // Trailing spaces per line, then runs of blank lines. Word emits empty
    // paragraphs freely for spacing and they carry no meaning.
    .replace( /[ \t]+$/gm, '' )
    .replace( /\n{3,}/g, '\n\n' )
    .trim();
}

/**
 * Extract the body text of a .docx.
 *
 * Deterministic and offline: no model, no network, no clock. The same bytes
 * always yield the same text, which is what lets the agreement gate downstream
 * be reproducible.
 *
 * @param {Buffer} buffer Raw .docx bytes.
 * @returns {{ ok: boolean, text?: string, reason?: string }}
 */
export function docxToText( buffer ) {
  if ( ! Buffer.isBuffer( buffer ) || 0 === buffer.length ) {
    return { ok: false, reason: 'empty_file' };
  }

  // A .docx always begins `PK\x03\x04`. Checked up front so a .doc, a PDF or a
  // photograph of a worksheet is refused with a reason a tutor can act on,
  // rather than parsed into empty text and reported as a blank submission.
  if ( 0x50 !== buffer[ 0 ] || 0x4B !== buffer[ 1 ] ) {
    return { ok: false, reason: 'not_a_docx' };
  }

  let xml;
  try {
    xml = readZipEntry( buffer, DOCUMENT_PART );
  } catch ( err ) {
    return { ok: false, reason: 'corrupt_archive' };
  }

  if ( ! xml ) return { ok: false, reason: 'no_document_part' };

  const text = documentXmlToText( xml.toString( 'utf8' ) );
  if ( ! text ) return { ok: false, reason: 'no_text' };

  return { ok: true, text };
}

export default { docxToText, documentXmlToText };
