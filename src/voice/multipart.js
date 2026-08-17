// src/voice/multipart.js
//
// Tenax Voice -- minimal multipart/form-data reader for POST /voice/transcribe
// (Specification Section 8.2).
//
// WHY NOT multer OR busboy
// ------------------------
// The connector carries no multipart dependency, and volume-snapshot.js states
// the discipline outright: "No npm dependencies are added." That route takes
// uploads through express.raw() for the same reason.
//
// Hand-rolled multipart parsing is a well-known source of security bugs, so the
// scope here is kept deliberately narrow. This is NOT a general parser:
//
//   - It reads an ALREADY-BUFFERED body. express.raw() has applied the size
//     limit before a byte reaches this code, so there is no streaming state
//     machine to get wrong and no unbounded growth.
//   - It extracts at most ONE file part and a handful of short text fields.
//     Nested multipart, base64 transfer-encoding and multi-file uploads are not
//     supported and are not silently half-handled -- they are rejected.
//   - Nothing it returns is ever used as a path. The filename is metadata only;
//     the STT engine writes to a name IT chooses in a directory IT owns, so a
//     traversal payload in the filename has nowhere to go.
//
// The boundary is taken from the Content-Type header and matched literally.

/** Text fields longer than this are refused: they are `language`, not prose. */
const MAX_FIELD_BYTES = 1024;

/**
 * Pull the boundary token out of a Content-Type header.
 *
 * @param {string} contentType
 * @returns {string|null}
 */
export function parseBoundary(contentType) {
  const ct = String(contentType || '');
  if (!/^multipart\/form-data/i.test(ct.trim())) return null;

  // Quoted form first: boundary="..." may legally contain characters that the
  // unquoted form cannot, and stripping the quotes afterwards would keep them.
  const quoted = ct.match(/boundary="([^"]+)"/i);
  if (quoted) return quoted[1];

  const bare = ct.match(/boundary=([^;\s]+)/i);
  return bare ? bare[1] : null;
}

/**
 * Split part headers from the part body.
 *
 * @param {Buffer} part
 * @returns {{headers: object, body: Buffer}|null}
 */
function splitPart(part) {
  const sep = part.indexOf('\r\n\r\n');
  if (sep === -1) return null;

  const headers = {};
  const raw = part.slice(0, sep).toString('utf8');
  for (const line of raw.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body: part.slice(sep + 4) };
}

/**
 * Read the name and filename out of a Content-Disposition header.
 *
 * @param {string} disposition
 * @returns {{name: string|null, filename: string|null}}
 */
function parseDisposition(disposition) {
  const d = String(disposition || '');
  const name = d.match(/\bname="([^"]*)"/i) || d.match(/\bname=([^;\s]+)/i);
  const file = d.match(/\bfilename="([^"]*)"/i) || d.match(/\bfilename=([^;\s]+)/i);
  return { name: name ? name[1] : null, filename: file ? file[1] : null };
}

/**
 * Parse a buffered multipart/form-data body.
 *
 * @param {Buffer} body
 * @param {string} contentType
 * @returns {{ok: boolean, reason?: string, message?: string,
 *            fields?: object, file?: {field: string, filename: string|null,
 *            contentType: string|null, data: Buffer}|null}}
 */
export function parseMultipart(body, contentType) {
  const boundary = parseBoundary(contentType);
  if (!boundary) {
    return {
      ok: false, reason: 'not_multipart',
      message: 'Send the audio as multipart/form-data with a boundary.',
    };
  }
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return { ok: false, reason: 'empty_body', message: 'The request body was empty.' };
  }

  const delimiter = Buffer.from('--' + boundary);
  const fields = {};
  let file = null;

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) {
    return {
      ok: false, reason: 'boundary_not_found',
      message: 'The declared multipart boundary does not appear in the body.',
    };
  }

  while (cursor !== -1) {
    const partStart = cursor + delimiter.length;

    // "--" immediately after the delimiter marks the final boundary.
    if (body.slice(partStart, partStart + 2).toString('ascii') === '--') break;

    const next = body.indexOf(delimiter, partStart);
    if (next === -1) break;

    // Skip the CRLF after the delimiter; drop the CRLF before the next one.
    const part = body.slice(partStart + 2, next - 2);
    cursor = next;

    const split = splitPart(part);
    if (!split) continue;

    const { name, filename } = parseDisposition(split.headers['content-disposition']);
    if (!name) continue;

    // base64 and quoted-printable parts are refused rather than passed through
    // undecoded, which would hand the decoder a body that is not audio at all.
    const encoding = String(split.headers['content-transfer-encoding'] || '').toLowerCase();
    if (encoding && encoding !== 'binary' && encoding !== '7bit' && encoding !== '8bit') {
      return {
        ok: false, reason: 'unsupported_transfer_encoding',
        message: `Content-Transfer-Encoding "${encoding}" is not supported; send the audio as binary.`,
      };
    }

    if (filename !== null) {
      // One file only. A second is a different request from the one the caller
      // thinks they are making, so it is refused rather than silently ignored.
      if (file) {
        return {
          ok: false, reason: 'multiple_files',
          message: 'Send exactly one audio file per request.',
        };
      }
      file = {
        field: name,
        filename,
        contentType: split.headers['content-type'] || null,
        data: split.body,
      };
      continue;
    }

    if (split.body.length > MAX_FIELD_BYTES) {
      return {
        ok: false, reason: 'field_too_large',
        message: `Form field "${name}" is too large.`,
      };
    }
    fields[name] = split.body.toString('utf8').trim();
  }

  return { ok: true, fields, file };
}

export default { parseBoundary, parseMultipart };
