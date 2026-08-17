// src/voice/audio-validate.js
//
// Tenax Voice -- audio input validation. Specification Section 15:
// "Input validation: audio magic-byte and format checks, size and duration
// limits."
//
// ---------------------------------------------------------------------------
// WHY MAGIC BYTES AND NOT THE CONTENT-TYPE
// ---------------------------------------------------------------------------
//
// The multipart Content-Type is supplied by the caller and means nothing. A
// file claiming audio/wav can hold anything, and this payload is handed to a
// decoder in a child process. Sniffing the actual bytes is the difference
// between "we only decode audio" and "we decode whatever we were sent".
//
// The container is identified from its own header, and the declared type is
// then required to AGREE with it. A mismatch is rejected rather than resolved
// in favour of the bytes: a caller sending WAV bytes labelled MP3 has a bug,
// and quietly accepting it hides the bug until something downstream trips over
// it.
//
// ---------------------------------------------------------------------------
// DURATION IS ESTIMATED, NOT DECODED
// ---------------------------------------------------------------------------
//
// The duration ceiling exists so a caller cannot hand the CPU an hour of audio
// and occupy the single worker. Getting an exact duration means decoding, which
// is the very work being rationed -- so the check would cost what it protects.
//
// WAV is exact (the header carries the byte rate). Compressed formats are
// bounded instead: a floor bitrate gives a maximum possible duration for a
// given size, and anything that could not exceed the ceiling is admitted. The
// engine enforces the real limit once it has decoded. This rejects the obvious
// abuse cheaply and lets a borderline file through to a precise check.

/** Ceilings. Both overridable, both with defaults that fit the Section 12 budgets. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;   // 25 MB
const DEFAULT_MAX_SECONDS = 300;              // 5 minutes

/* Lowest bitrate worth considering for speech in a compressed container, in
 * bits per second. Used only to bound duration from file size. Deliberately
 * LOW: a low floor over-estimates duration, so the check errs toward rejecting
 * a file that might be too long rather than admitting one that is. */
const MIN_SPEECH_BITRATE = 8000;

export function maxBytes() {
  const n = parseInt(process.env.VOICE_MAX_UPLOAD_BYTES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

export function maxSeconds() {
  const n = parseInt(process.env.VOICE_MAX_AUDIO_SECONDS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SECONDS;
}

/** Containers accepted, keyed by the format name the STT helper is told. */
export const ACCEPTED_FORMATS = Object.freeze(['wav', 'mp3', 'ogg', 'webm', 'flac', 'm4a']);

const MIME_TO_FORMAT = Object.freeze({
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'audio/opus': 'ogg',
  'audio/webm': 'webm', 'video/webm': 'webm',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a',
});

function ascii(buf, start, len) {
  return buf.slice(start, start + len).toString('ascii');
}

/**
 * Identify the container from its own bytes.
 *
 * @param {Buffer} buf
 * @returns {string|null} A name from ACCEPTED_FORMATS, or null.
 */
export function sniffFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // RIFF....WAVE
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WAVE') return 'wav';

  // fLaC
  if (ascii(buf, 0, 4) === 'fLaC') return 'flac';

  // OggS -- Ogg Vorbis and Ogg Opus share the container.
  if (ascii(buf, 0, 4) === 'OggS') return 'ogg';

  // EBML header. WebM and Matroska share it; the STT helper handles both, and
  // distinguishing them here would mean parsing the DocType element for no gain.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';

  // ISO-BMFF: a size field then 'ftyp'. Covers m4a, mp4 and aac in MP4.
  if (ascii(buf, 4, 4) === 'ftyp') return 'm4a';

  // MP3: an ID3 tag, or a raw frame sync (11 set bits).
  if (ascii(buf, 0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';

  return null;
}

/**
 * Exact duration for a WAV, from its own header.
 *
 * Walks the RIFF chunk list rather than assuming the canonical 44-byte layout:
 * recorders routinely emit LIST or fact chunks before the data, and assuming
 * the fixed offset reads the wrong length for those files.
 *
 * @param {Buffer} buf
 * @returns {number|null} Seconds, or null if the header cannot be read.
 */
export function wavDurationSeconds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return null;
  if (ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 4) !== 'WAVE') return null;

  let offset = 12;
  let byteRate = 0;

  while (offset + 8 <= buf.length) {
    const id = ascii(buf, offset, 4);
    const size = buf.readUInt32LE(offset + 4);

    if (id === 'fmt ' && offset + 8 + 16 <= buf.length) {
      byteRate = buf.readUInt32LE(offset + 16);
    } else if (id === 'data') {
      if (!byteRate) return null;
      // The declared size can exceed what actually arrived on a truncated
      // upload. The smaller of the two is what is really present.
      const dataBytes = Math.min(size, Math.max(0, buf.length - (offset + 8)));
      return dataBytes / byteRate;
    }

    // Chunks are word-aligned: an odd size carries a pad byte.
    offset += 8 + size + (size % 2);
    if (size <= 0) break;   // malformed; stop rather than loop forever
  }
  return null;
}

/**
 * Upper bound on duration for any accepted container.
 *
 * Exact for WAV, bounded from size for everything else. The bound is
 * intentionally generous -- it exists to reject the obviously abusive, not to
 * measure.
 *
 * @param {Buffer} buf
 * @param {string} format
 * @returns {{seconds: number, exact: boolean}}
 */
export function estimateDuration(buf, format) {
  if (format === 'wav') {
    const exact = wavDurationSeconds(buf);
    if (exact !== null) return { seconds: exact, exact: true };
  }
  return { seconds: (buf.length * 8) / MIN_SPEECH_BITRATE, exact: false };
}

/**
 * Validate an uploaded audio buffer.
 *
 * Returns a status code alongside the reason, because Section 8.2 distinguishes
 * 413 (too large) from 415/422 (unsupported format) and the caller should not
 * have to re-derive which applies.
 *
 * @param {Buffer} buf
 * @param {{declaredType?: string, filename?: string}} [meta]
 * @returns {{ok: boolean, status?: number, reason?: string, message?: string,
 *            format?: string, duration_seconds?: number, duration_exact?: boolean}}
 */
export function validateAudio(buf, meta) {
  const m = meta || {};

  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, status: 422, reason: 'empty_audio', message: 'No audio was received.' };
  }

  // Size first: it is the cheapest check, and it bounds every check after it.
  const limit = maxBytes();
  if (buf.length > limit) {
    return {
      ok: false, status: 413, reason: 'audio_too_large',
      message: `Audio is ${(buf.length / 1048576).toFixed(1)} MB; the limit is `
        + `${(limit / 1048576).toFixed(0)} MB.`,
    };
  }

  const format = sniffFormat(buf);
  if (!format) {
    return {
      ok: false, status: 415, reason: 'unsupported_format',
      message: 'The upload is not a recognised audio container. Accepted: '
        + ACCEPTED_FORMATS.join(', ') + '.',
    };
  }

  // The declared type must agree with the bytes. Only checked when a type was
  // declared and is one we know -- an unknown or absent type is not evidence of
  // anything, and the bytes have already been identified.
  const declared = String(m.declaredType || '').split(';')[0].trim().toLowerCase();
  if (declared && MIME_TO_FORMAT[declared] && MIME_TO_FORMAT[declared] !== format) {
    return {
      ok: false, status: 415, reason: 'format_mismatch',
      message: `The upload is declared as ${declared} but its contents are ${format}.`,
    };
  }

  const { seconds, exact } = estimateDuration(buf, format);
  const secLimit = maxSeconds();
  if (seconds > secLimit) {
    return {
      ok: false, status: 413, reason: 'audio_too_long',
      message: exact
        ? `Audio is ${seconds.toFixed(1)}s; the limit is ${secLimit}s.`
        : `Audio could be up to ${seconds.toFixed(0)}s; the limit is ${secLimit}s. `
          + 'Send a shorter recording or a more compressed one.',
    };
  }

  return { ok: true, format, duration_seconds: seconds, duration_exact: exact };
}

export default {
  ACCEPTED_FORMATS, maxBytes, maxSeconds,
  sniffFormat, wavDurationSeconds, estimateDuration, validateAudio,
};
