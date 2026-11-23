import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonicalJson, digestText, digestJson } from './canonical.js';
import { bundleSchema, inputDigest, selectedSpan } from './validation.js';
import { ProvenanceError } from './limits.js';
import type { InputTextData, InputTextRequest } from './types.js';

const attributionSchema = bundleSchema.omit({ provider_payload: true });
const cursorSchema = z
  .object({
    scope: z.string(),
    span: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .strict();
const unavailable = (): never => {
  throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
};

/** The owning inspector supplies one read transaction for availability and bytes. */
export function readInputText(
  db: Database.Database,
  request: InputTextRequest,
): InputTextData {
  const row = db
    .prepare(
      `SELECT d.availability,i.item_key,i.spans,i.input_digest,i.retained_bytes,
    p.text,p.digest FROM provenance_outputs o
    JOIN provenance_derivations d ON d.id=o.derivation_id
    JOIN provenance_inputs i ON i.derivation_id=d.id AND i.id=?
    LEFT JOIN provenance_payloads p ON p.derivation_id=d.id AND p.kind='attribution'
    WHERE o.id=?`,
    )
    .get(request.input_id, request.output_revision_id) as
    | {
        availability: InputTextData['availability'];
        item_key: string | null;
        spans: string | null;
        input_digest: string | null;
        retained_bytes: number | null;
        text: string | null;
        digest: string | null;
      }
    | undefined;
  if (!row) return unavailable();
  const result: InputTextData = {
    select: 'input_text',
    output_revision_id: request.output_revision_id,
    input_id: request.input_id,
    availability: row.availability,
    input_digest: null,
    segments: [],
    next_cursor: null,
  };
  if (row.availability !== 'retained') {
    if (request.cursor) throw new ProvenanceError('PROVENANCE_REVOKED');
    return result;
  }
  // Retained payloads are immutable. Validate the bytes and their attribution before exposing any fragment.
  const retained = (() => {
    try {
      if (
        row.text === null ||
        digestText(row.text) !== row.digest ||
        !row.spans ||
        !row.input_digest
      )
        return unavailable();
      const bundle = attributionSchema.parse(JSON.parse(row.text));
      const matches = bundle.items.filter((item) => item.key === row.item_key);
      if (matches.length !== 1) return unavailable();
      const item = matches[0]!;
      if (
        canonicalJson(item.spans) !== canonicalJson(JSON.parse(row.spans)) ||
        item.input_digest !== row.input_digest ||
        inputDigest(item.spans, bundle.decoded_fields) !== row.input_digest ||
        item.retained_bytes !== row.retained_bytes ||
        item.spans.reduce(
          (n, s) =>
            n + Buffer.byteLength(selectedSpan(s, bundle.decoded_fields)),
          0,
        ) !== row.retained_bytes
      )
        return unavailable();
      return { item, fields: bundle.decoded_fields };
    } catch {
      return unavailable();
    }
  })();
  const scope = digestJson([
    request.output_revision_id,
    request.input_id,
    row.digest,
    row.input_digest,
  ]);
  let spanIndex = 0;
  let offset = retained.item.spans[0]!.start;
  if (request.cursor) {
    try {
      const cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')),
      );
      if (cursor.scope !== scope) throw Error('scope');
      const span = retained.item.spans[cursor.span];
      if (!span || cursor.offset < span.start || cursor.offset > span.end)
        throw Error('position');
      const bytes = Buffer.from(retained.fields[span.field]!, 'utf8');
      if (
        cursor.offset < bytes.length &&
        (bytes[cursor.offset]! & 0xc0) === 0x80
      )
        throw Error('boundary');
      spanIndex = cursor.span;
      offset = cursor.offset;
    } catch {
      throw new ProvenanceError('PROVENANCE_LIMIT');
    }
  }
  result.input_digest = row.input_digest;
  let remaining = request.max_bytes ?? 16384;
  while (
    spanIndex < retained.item.spans.length &&
    result.segments.length < 64
  ) {
    const span = retained.item.spans[spanIndex]!;
    const bytes = Buffer.from(retained.fields[span.field]!, 'utf8');
    let end = Math.min(span.end, offset + remaining);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end === offset && offset < span.end) break;
    result.segments.push({
      span_index: spanIndex,
      field: span.field,
      span_start: span.start,
      span_end: span.end,
      start: offset,
      end,
      text: bytes.subarray(offset, end).toString('utf8'),
    });
    remaining -= end - offset;
    if (end < span.end) {
      offset = end;
      break;
    }
    spanIndex++;
    offset = retained.item.spans[spanIndex]?.start ?? 0;
  }
  if (spanIndex < retained.item.spans.length) {
    result.next_cursor = Buffer.from(
      JSON.stringify({ scope, span: spanIndex, offset }),
    ).toString('base64url');
  }
  return result;
}
