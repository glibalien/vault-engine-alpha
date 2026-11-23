import type { StructuredCallRequest } from './types.js';

/** Versioned page-only wire format: Markdown is never JSON-escaped. */
export function systemWithPageMarkdownOutput(req: Pick<StructuredCallRequest, 'system'>): string {
  return `${req.system}\n\n# Output transport: VAULT_PAGE_V1
Return exactly this envelope, with each marker on its own line:
<<<VAULT_PAGE_V1>>>
log_note: optional one-line change note, at most 500 characters, no date prefix
<<<VAULT_BODY>>>
The complete page body as raw Markdown
<<<END_VAULT_PAGE>>>
Leave the value after log_note: empty when no note is needed. Write actual newlines, quotes, and backslashes in the Markdown; do not JSON-encode or escape the body. Do not wrap the envelope in a code fence or add surrounding prose. The body must be nonempty. Never include any of these marker lines inside the body.`;
}

export function parsePageMarkdownOutput(content: string): { body: string; log_note?: string } {
  // Consume only framing newlines; preserve every interior body character.
  const match = /^<<<VAULT_PAGE_V1>>>\r?\nlog_note:[ \t]*([^\r\n]*)\r?\n<<<VAULT_BODY>>>\r?\n([\s\S]*?)\r?\n<<<END_VAULT_PAGE>>>$/.exec(content.trim());
  if (!match) throw new Error('invalid_page_envelope');
  const note = match[1]!.trim();
  const body = match[2]!;
  if (!body.trim() || note.length > 500
    || body.split(/\r?\n/).some(line => /^<<<(?:VAULT_PAGE_V1|VAULT_BODY|END_VAULT_PAGE)>>>$/.test(line.trim()))) {
    throw new Error('invalid_page_envelope');
  }
  return { body, ...(note ? { log_note: note } : {}) };
}

export const PAGE_ENVELOPE_ISSUES = ['empty', 'fenced', 'leading_text', 'missing_start_marker', 'missing_log_note',
  'missing_body_marker', 'missing_end_marker', 'trailing_text', 'marker_in_body', 'empty_body', 'log_note_too_long', 'other'] as const;
export type PageEnvelopeIssue = typeof PAGE_ENVELOPE_ISSUES[number];

const START = '<<<VAULT_PAGE_V1>>>';
const BODY = '<<<VAULT_BODY>>>';
const END = '<<<END_VAULT_PAGE>>>';

/** Why `parsePageMarkdownOutput` would reject `content`, as a closed code; null when it parses.
 *  Only the envelope's shape is inspected, so the code is safe to record without the content. */
export function pageEnvelopeIssue(content: string): PageEnvelopeIssue | null {
  try {
    parsePageMarkdownOutput(content);
    return null;
  } catch { /* classified below */ }
  const text = content.trim();
  if (text === '') return 'empty';
  if (text.startsWith('```')) return 'fenced';
  if (!text.startsWith(START)) return text.includes(START) ? 'leading_text' : 'missing_start_marker';
  const lines = text.split(/\r?\n/);
  if (!lines[1]?.startsWith('log_note:')) return 'missing_log_note';
  const bodyAt = lines.findIndex(line => line.trim() === BODY);
  if (bodyAt === -1) return 'missing_body_marker';
  const endAt = lines.findIndex(line => line.trim() === END);
  if (endAt === -1) return 'missing_end_marker';
  if (endAt !== lines.length - 1) return 'trailing_text';
  if (bodyAt !== 2) return 'other';
  const body = lines.slice(3, -1);
  if (body.some(line => [START, BODY, END].includes(line.trim()))) return 'marker_in_body';
  if (body.join('\n').trim() === '') return 'empty_body';
  if (lines[1].slice('log_note:'.length).trim().length > 500) return 'log_note_too_long';
  return 'other';
}
