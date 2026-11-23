import { createHash } from 'node:crypto';

const START = /^<!-- ve:chat-curation:start id="([^"]+)" conversation="([^"]+)" transcript-hash="([^"]+)" -->$/;
const END = /^<!-- ve:chat-curation:end id="([^"]+)" -->$/;
const MARKER = '<!-- ve:chat-curation:';

export interface CaptureBlockInput {
  captureId: string;
  conversationId: string;
  transcriptHash: string;
  conversationTitle: string;
  capturedOn: string;
  title: string;
  markdown: string;
  sourceUrls: readonly string[];
  includeHeading: boolean;
}

export interface ParsedCaptureBlock {
  captureId: string;
  conversationId: string;
  transcriptHash: string;
  start: number;
  end: number;
  /** The exact host-stamped block, including both paired markers. */
  contentMarkdown: string;
}

export type ParseCaptureBlocksResult =
  | { ok: true; blocks: ParsedCaptureBlock[] }
  | { ok: false; diagnostic: string };

export type StripCaptureBlocksResult =
  | { ok: true; body: string; removed: number }
  | { ok: false; diagnostic: string };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function encodeCaptureMarkerAttribute(value: string): string {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error('capture marker attributes must not contain control characters');
  }
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}

export function decodeCaptureMarkerAttribute(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_match, entity: string) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'",
  }[entity] ?? _match));
}

function decodeCanonicalAttribute(value: string): string | null {
  const decoded = decodeCaptureMarkerAttribute(value);
  try {
    return encodeCaptureMarkerAttribute(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

export function captureIdMarkerQuery(captureIdValue: string): string {
  return `ve:chat-curation:start id="${encodeCaptureMarkerAttribute(captureIdValue)}"`;
}

export function conversationCaptureMarkerQuery(conversationIdValue: string): string {
  return `conversation="${encodeCaptureMarkerAttribute(conversationIdValue)}" transcript-hash=`;
}

function safeSourceUrl(value: string): string {
  return value.replace(/[<>\s]/g, (char) => encodeURIComponent(char));
}

/** Renders the host-owned provenance wrapper around already-sanitized composition Markdown. */
export function renderCaptureBlock(input: CaptureBlockInput): string {
  if (input.markdown.includes(MARKER) || /_Curated from .+ on \d{4}-\d{2}-\d{2}\._/.test(input.markdown)) {
    throw new Error('capture composition must not supply provenance markers or attribution');
  }

  const start = `<!-- ve:chat-curation:start id="${encodeCaptureMarkerAttribute(input.captureId)}" conversation="${encodeCaptureMarkerAttribute(input.conversationId)}" transcript-hash="${encodeCaptureMarkerAttribute(input.transcriptHash)}" -->`;
  const end = `<!-- ve:chat-curation:end id="${encodeCaptureMarkerAttribute(input.captureId)}" -->`;
  const content: string[] = [start];
  if (input.includeHeading) {
    content.push(`## From chat — ${encodeCaptureMarkerAttribute(normalizeWhitespace(input.title))}`, '');
  }
  content.push(input.markdown.trim());
  if (input.sourceUrls.length > 0) {
    content.push('', `**Sources:** ${input.sourceUrls.map((url) => `<${safeSourceUrl(url)}>`).join(', ')}`);
  }
  content.push('', `_Curated from “${encodeCaptureMarkerAttribute(normalizeWhitespace(input.conversationTitle))}” on ${input.capturedOn}._`, end);
  return content.join('\n');
}

/**
 * Validates the complete marker grammar in one pass. A marker-looking line which
 * is not part of one exact, non-nested pair makes the entire note untrusted.
 */
export function parseCaptureBlocks(body: string): ParseCaptureBlocksResult {
  const blocks: ParsedCaptureBlock[] = [];
  let open: { captureId: string; conversationId: string; transcriptHash: string; start: number } | null = null;
  let lineStart = 0;

  while (lineStart <= body.length) {
    const newline = body.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? body.length : newline;
    const rawLine = body.slice(lineStart, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const start = START.exec(line);
    const end = END.exec(line);

    if (line.includes(MARKER) && !start && !end) {
      return { ok: false, diagnostic: `malformed capture marker at offset ${lineStart}` };
    }
    if (start) {
      if (open !== null) return { ok: false, diagnostic: `nested capture marker at offset ${lineStart}` };
      const captureIdValue = decodeCanonicalAttribute(start[1] ?? '');
      const conversationIdValue = decodeCanonicalAttribute(start[2] ?? '');
      const transcriptHashValue = decodeCanonicalAttribute(start[3] ?? '');
      if (captureIdValue === null || conversationIdValue === null || transcriptHashValue === null) {
        return { ok: false, diagnostic: `non-canonical capture marker attribute at offset ${lineStart}` };
      }
      open = {
        captureId: captureIdValue,
        conversationId: conversationIdValue,
        transcriptHash: transcriptHashValue,
        start: lineStart,
      };
    } else if (end) {
      if (open === null) return { ok: false, diagnostic: `capture end without start at offset ${lineStart}` };
      const captureId = decodeCanonicalAttribute(end[1] ?? '');
      if (captureId === null) return { ok: false, diagnostic: `non-canonical capture marker attribute at offset ${lineStart}` };
      if (captureId !== open.captureId) {
        return { ok: false, diagnostic: `capture marker id mismatch at offset ${lineStart}` };
      }
      const endOffset = lineEnd;
      blocks.push({
        ...open,
        end: endOffset,
        contentMarkdown: body.slice(open.start, endOffset),
      });
      open = null;
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  if (open !== null) return { ok: false, diagnostic: `capture start without end at offset ${open.start}` };
  return { ok: true, blocks };
}

export function stripCaptureBlocksForMemory(body: string): StripCaptureBlocksResult {
  const parsed = parseCaptureBlocks(body);
  if (!parsed.ok) return parsed;
  let cursor = 0;
  const kept: string[] = [];
  for (const block of parsed.blocks) {
    kept.push(body.slice(cursor, block.start));
    cursor = block.end;
  }
  kept.push(body.slice(cursor));
  return {
    ok: true,
    body: kept.join('').replace(/\n{3,}/g, '\n\n').trim(),
    removed: parsed.blocks.length,
  };
}

export function captureCompositionHash(markdown: string): string {
  return sha256(markdown);
}

export function captureBlockHash(stampedMarkdown: string): string {
  return sha256(stampedMarkdown);
}

export function captureId(input: {
  conversationId: string;
  inputHash: string;
  destinationIdentity: string;
  compositionHash: string;
}): string {
  return `cap-${sha256(JSON.stringify({
    conversationId: input.conversationId,
    inputHash: input.inputHash,
    destinationIdentity: input.destinationIdentity,
    compositionHash: input.compositionHash,
  }))}`;
}

/** The date (YYYY-MM-DD) in a stamped block's attribution line, or null when it has none. */
export function captureBlockDate(stampedMarkdown: string): string | null {
  const lines = stampedMarkdown.split('\n');
  return /^_Curated from “.*” on (\d{4}-\d{2}-\d{2})\._$/.exec(lines[lines.length - 2] ?? '')?.[1] ?? null;
}

/** `capturedOn` (YYYY-MM-DD) is the date the capture's attribution line carries. */
export function captureTitleCandidates(plannedTitle: string, conversationTitle: string, capturedOn: string): string[] {
  const planned = normalizeWhitespace(plannedTitle);
  const conversation = normalizeWhitespace(conversationTitle);
  return [...new Set([
    planned,
    conversation.length > 0 && conversation !== planned ? `${planned} — ${conversation}` : '',
    `${planned} (from chat ${capturedOn})`,
  ].filter((title) => title.length > 0))];
}
