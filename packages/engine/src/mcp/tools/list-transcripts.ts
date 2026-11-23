import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, type Issue } from './errors.js';
import type { TranscriptStore } from '../../extraction/transcript-store.js';

/**
 * Total budget for inlined transcript text across the whole `include_text`
 * response (~50K tokens). Without this cap, `include_text:true` with a high
 * `limit` could return multiple MB of text in one tool result, which — once
 * persisted in a conversation and re-sent every turn — blows past the LLM
 * provider's context window and hard-fails every subsequent call.
 */
export const DEFAULT_MAX_INLINE_TEXT_CHARS = 200_000;

export interface ListTranscriptsOptions {
  /** Override the total inlined-text budget (default DEFAULT_MAX_INLINE_TEXT_CHARS). */
  maxInlineTextChars?: number;
}

export function registerListTranscripts(
  server: McpServer,
  transcriptStore: TranscriptStore,
  options?: ListTranscriptsOptions,
): void {
  const maxInlineTextChars = options?.maxInlineTextChars ?? DEFAULT_MAX_INLINE_TEXT_CHARS;
  server.tool(
    'list-transcripts',
    'List retained transcripts of embedded files. Filter source_deleted:true to find transcripts whose source file was deleted from the vault.',
    {
      source_deleted: z.boolean().optional().describe('Only transcripts whose source file was deleted'),
      include_text: z.boolean().optional().describe('Include transcript text (default false). Total inlined text is capped across the response; oversized results are truncated/omitted (see the TEXT_BUDGET_EXCEEDED warning) — use read-embedded or materialize-transcript for one transcript’s full text.'),
      limit: z.number().int().positive().max(1000).optional().describe('Max rows (default 200)'),
    },
    async (params) => {
      const rows = transcriptStore.list({ sourceDeleted: params.source_deleted, limit: params.limit });
      // Track how much inlined text we've emitted so a single call can never
      // return an unbounded (multi-MB) payload that would poison a conversation.
      let textBudgetRemaining = maxInlineTextChars;
      let rowsTruncated = 0;
      let rowsOmitted = 0;
      const transcripts = rows.map(r => {
        const base = {
          embed_ref: r.embed_ref,
          vault_path: r.vault_path,
          media_type: r.media_type,
          extractor_id: r.extractor_id,
          source_deleted: r.source_deleted === 1,
          captured_at: r.captured_at,
          deleted_at: r.deleted_at,
          materialized_node_id: r.materialized_node_id,
          text_length: r.extracted_text.length,
        };
        if (!params.include_text) return base;
        const full = r.extracted_text;
        if (textBudgetRemaining <= 0) {
          rowsOmitted++;
          return { ...base, text_omitted: true };
        }
        if (full.length <= textBudgetRemaining) {
          textBudgetRemaining -= full.length;
          return { ...base, text: full };
        }
        // This row crosses the budget boundary: serve a prefix, then close it out.
        const text = full.slice(0, textBudgetRemaining);
        textBudgetRemaining = 0;
        rowsTruncated++;
        return { ...base, text, text_truncated: true };
      });
      const effectiveLimit = params.limit ?? 200;
      const warnings: Issue[] = [];
      if (rowsTruncated + rowsOmitted > 0) {
        warnings.push({
          code: 'TEXT_BUDGET_EXCEEDED',
          severity: 'warning',
          message: `Inlined transcript text capped at ${maxInlineTextChars} chars (${rowsTruncated} truncated, ${rowsOmitted} omitted). Use \`read-embedded\` or \`materialize-transcript\` to get a specific transcript's full text.`,
          details: { text_budget_chars: maxInlineTextChars, rows_truncated: rowsTruncated, rows_omitted: rowsOmitted },
        });
      }
      if (transcripts.length === effectiveLimit) {
        warnings.push({
          code: 'RESULT_TRUNCATED',
          severity: 'warning',
          message: `Result capped at limit (${effectiveLimit} rows). Raise \`limit\` or narrow \`source_deleted\` to see more.`,
          details: { count: transcripts.length, limit: effectiveLimit },
        });
      }
      return ok({ transcripts, count: transcripts.length }, warnings);
    },
  );
}
