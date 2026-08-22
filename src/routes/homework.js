// src/routes/homework.js
//
// Tutoring Homework Upload and Assessment Spec v1.0.0 — Section 6.
//
// ===========================================================================
// WHAT THIS ROUTE DOES, AND WHAT IT DELIBERATELY DOES NOT
// ===========================================================================
//
// It reads an uploaded .docx, extracts the text, aligns it to the registry
// questions it is HANDED, and returns the verdict per question.
//
// It does not:
//
//   - read the registry. The caller supplies the questions, because the
//     registry lives in Postgres on the gateway and giving the connector a
//     second route to that data would create a second thing to keep in step.
//   - write anything. The gateway persists, because the gateway owns the
//     database and a two-writer arrangement is how a set ends up half updated.
//   - call a model. Section 3 assigns this half to the deterministic layer, and
//     that is the entire reason its verdict can be trusted: the same bytes and
//     the same registry always produce the same alignment.
//
// So the contract is narrow on purpose: bytes and questions in, verdicts out.
//
// ===========================================================================
// WHY THE GATE IS ENFORCED HERE AND REPEATED THERE
// ===========================================================================
//
// `assessable` is computed here and returned, and the gateway is still expected
// to filter on `match_status` before it dispatches anything. That is not
// redundancy for its own sake: this route is the only place that knows WHY a
// question failed, and the gateway is the only place that can stop an
// assessment. Splitting the knowledge from the enforcement would mean either
// side could be changed without the other noticing.

'use strict';

import express from 'express';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';

import { docxToText } from '../homework/docx-text.js';
import { alignToRegistry, assessable } from '../homework/homework-extract.js';
import { resolveContained } from '../utils/pathContainment.js';
// REUSED, not reimplemented. voiceCredential verifies MCP_API_KEY or
// RAILWAY_RESTORE_TOKEN in constant time, which is exactly the credential the
// gateway holds and exactly the check every other gateway-called connector
// route already performs. A second implementation would be a second thing to
// get wrong, and the two could drift on which secrets they accept.
import { voiceCredential } from '../voice/voice-auth.js';

/** Where /data/upload stages a student's file. Same default as server-http.js. */
const UPLOAD_DIR = process.env.USER_DATA_UPLOAD_DIR || '/data/uploads/';

/**
 * The largest upload worth parsing.
 *
 * A homework docx is tens of kilobytes. Anything at this size is a scan, a
 * photograph series or a mistake, and inflating it would spend the connector's
 * memory on something that cannot contain markable text anyway.
 */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Register the homework routes.
 *
 * @param {import('express').Express} app
 * @returns {void}
 */
export function registerHomeworkRoutes( app ) {

  /**
   * POST /homework/parse-upload
   *
   * Body:
   *   { filepath, questions: [ { id, position, question_text } ] }
   *   or
   *   { content_base64, questions: [...] }
   *
   * 200 -> { ok, rows, extras, duplicates, summary, assessable_positions }
   */
  app.post( '/homework/parse-upload',
    // FIRST. /homework/parse-upload is listed in SELF_AUTHENTICATED_ROUTES so
    // the gateway's restore token reaches it at all -- that listing exempts it
    // from the MCP key gate, so this middleware is what actually verifies the
    // caller. Omitting it would leave the route open to anything that can
    // reach the connector.
    voiceCredential,
    express.json( { limit: '16mb' } ),
    async ( req, res ) => {
      const body = ( req.body && 'object' === typeof req.body ) ? req.body : {};

      const questions = Array.isArray( body.questions ) ? body.questions : null;
      if ( ! questions ) {
        return res.status( 422 ).json( {
          error: 'questions_required',
          message: 'Supply the registry questions to align against.',
        } );
      }

      // An EMPTY registry is refused rather than answered with an empty result.
      // Section 6 permits marking only against a canonical question, so a set
      // with no questions cannot produce a markable outcome -- and returning
      // "0 of 0 matched" would read to the caller as a successful parse.
      if ( 0 === questions.length ) {
        return res.status( 422 ).json( {
          error: 'empty_registry',
          message: 'This homework set has no registered questions, so nothing '
                 + 'can be marked against it.',
        } );
      }

      const malformed = questions.some( ( q ) => ! q || 'object' !== typeof q
        || ! Number.isFinite( Number( q.position ) )
        || 'string' !== typeof q.question_text || ! q.question_text.trim() );

      if ( malformed ) {
        // Refused loudly. A question with blank canonical text would be handed
        // to the gate as truth, and an empty truth matches nothing -- every
        // answer under it would be quarantined with no explanation a tutor
        // could act on.
        return res.status( 422 ).json( {
          error: 'malformed_questions',
          message: 'Every question needs a numeric position and non-empty text.',
        } );
      }

      let buffer = null;

      if ( 'string' === typeof body.content_base64 && body.content_base64 ) {
        try {
          buffer = Buffer.from( body.content_base64, 'base64' );
        } catch ( err ) {
          return res.status( 422 ).json( {
            error: 'bad_base64',
            message: 'The uploaded content could not be decoded.',
          } );
        }
      } else if ( 'string' === typeof body.filepath && body.filepath ) {
        // Containment, not string checks. `resolveContained` resolves symlinks
        // physically, so a staged file cannot be a link pointing at the
        // connector's own configuration.
        const full = resolveContained( UPLOAD_DIR, body.filepath );
        if ( ! full ) {
          return res.status( 400 ).json( {
            error: 'path_not_allowed',
            message: 'The file must be one staged by the upload endpoint.',
          } );
        }
        if ( ! existsSync( full ) ) {
          return res.status( 404 ).json( {
            error: 'file_not_found',
            message: 'That upload is no longer staged. Ask the student to '
                   + 'submit the file again.',
          } );
        }

        // Checked BEFORE reading. Reading first and measuring after would have
        // already spent the memory this limit exists to protect.
        const size = statSync( full ).size;
        if ( size > MAX_BYTES ) {
          return res.status( 413 ).json( {
            error: 'file_too_large',
            message: `That file is ${ Math.round( size / 1024 / 1024 ) } MB; the limit is `
                   + `${ MAX_BYTES / 1024 / 1024 } MB.`,
          } );
        }

        // The extension is a courtesy check only -- docxToText verifies the
        // actual signature -- but it produces a far better message than
        // "not_a_docx" for the common case of a student attaching a PDF.
        const ext = extname( full ).toLowerCase();
        if ( '.docx' !== ext ) {
          return res.status( 415 ).json( {
            error: 'unsupported_type',
            message: `Homework must be a .docx file; this one is ${ ext || 'unknown' }.`,
          } );
        }

        try {
          buffer = readFileSync( full );
        } catch ( err ) {
          return res.status( 500 ).json( {
            error: 'read_failed',
            message: 'The staged file could not be read.',
          } );
        }
      } else {
        return res.status( 422 ).json( {
          error: 'no_file',
          message: 'Supply either filepath or content_base64.',
        } );
      }

      if ( buffer.length > MAX_BYTES ) {
        return res.status( 413 ).json( {
          error: 'file_too_large',
          message: 'That file is larger than the 10 MB limit.',
        } );
      }

      const extracted = docxToText( buffer );
      if ( ! extracted.ok ) {
        // 422 rather than 500: the file is the problem, not the connector, and
        // the reason is one a tutor can act on ("that is not a Word document").
        return res.status( 422 ).json( {
          error: extracted.reason,
          message: describeExtractionFailure( extracted.reason ),
        } );
      }

      const normalisedQuestions = questions.map( ( q ) => ( {
        id: q.id,
        position: Number( q.position ),
        question_text: q.question_text,
        // v13.11.0. Optional. When present, correctness for this question is
        // decided by exact equality after normalisation rather than by a model.
        // Absent means free-text or working, which is what a model is for.
        answer_key: 'string' === typeof q.answer_key ? q.answer_key : null,
      } ) );

      const aligned = alignToRegistry( normalisedQuestions, extracted.text );

      // Counts and verdicts only. The student's answers are returned to the
      // caller that asked for them, but nothing here goes to the log: an
      // answer is the student's work, and a log line is the wrong place for it.
      console.log( `[homework] parsed upload: ${ aligned.summary.matched } matched, `
        + `${ aligned.summary.mismatched } mismatched, ${ aligned.summary.missing } missing, `
        + `${ aligned.extras.length } extra` );

      return res.status( 200 ).json( {
        ok: true,
        rows: aligned.rows,
        extras: aligned.extras,
        duplicates: aligned.duplicates,
        summary: aligned.summary,
        // Positions only. The gateway still filters on match_status itself; this
        // is the connector saying which rows IT believes are markable, so a
        // disagreement between the two layers is visible rather than silent.
        assessable_positions: assessable( aligned.rows ).map( ( r ) => r.position ),
      } );
    } );
}

/**
 * A human explanation for an extraction failure.
 *
 * Written for a tutor reading it in session, not for a developer reading a log.
 * "no_document_part" tells a tutor nothing; "this file is not a Word document"
 * tells them what to ask the student for.
 *
 * @param {string} reason
 * @returns {string}
 */
function describeExtractionFailure( reason ) {
  switch ( reason ) {
    case 'empty_file':
      return 'The uploaded file is empty.';
    case 'not_a_docx':
      return 'That file is not a Word document. Homework needs to be a .docx '
           + 'file rather than a PDF, a photo or a scan.';
    case 'no_document_part':
    case 'corrupt_archive':
      return 'That Word document could not be opened. Ask the student to '
           + 'save it again and re-upload.';
    case 'no_text':
      return 'That Word document has no text in it. If the work is a photo or '
           + 'a scan pasted into the page, the text cannot be read from it.';
    default:
      return 'That upload could not be read.';
  }
}

export default { registerHomeworkRoutes };
