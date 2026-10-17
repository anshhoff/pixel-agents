/**
 * The working directory a session transcript records.
 *
 * Claude Code stamps a `cwd` string on its transcript records. It is the only
 * faithful source of a session's directory when no hook delivered one: the
 * encoded project dir (`-tmp-hobbyfi-blog-automation`) has replaced every
 * separator with a dash, so it can't tell `hobbyfi-blog-automation` from
 * `.../blog/automation`.
 */

import * as fs from 'fs';

/** How much of a transcript's head is searched for a cwd. Every user/assistant
 *  record carries one, so it turns up within the first few records; the cap
 *  keeps a long-running session's transcript from being read whole. */
export const TRANSCRIPT_CWD_HEAD_BYTES = 64 * 1024;

/**
 * The first non-empty string `cwd` among the transcript's leading records, or
 * undefined (missing/unreadable file, no record within the head carries one).
 * Malformed lines are skipped — the transcript is appended to live, so a
 * partial write is normal — and a head that filled the buffer drops its last,
 * cut-off line instead of parsing it.
 */
export function cwdFromTranscript(jsonlFile: string): string | undefined {
  let text: string;
  let truncated: boolean;
  try {
    const fd = fs.openSync(jsonlFile, 'r');
    try {
      const buf = Buffer.alloc(TRANSCRIPT_CWD_HEAD_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, TRANSCRIPT_CWD_HEAD_BYTES, 0);
      text = buf.toString('utf-8', 0, bytesRead);
      truncated = bytesRead === TRANSCRIPT_CWD_HEAD_BYTES;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }

  const lines = text.split('\n');
  if (truncated) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { cwd?: unknown } | null;
      if (rec && typeof rec.cwd === 'string' && rec.cwd.length > 0) return rec.cwd;
    } catch {
      /* partial or malformed line: keep looking */
    }
  }
  return undefined;
}
