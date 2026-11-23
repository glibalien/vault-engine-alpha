/**
 * Notes the suite writes about itself are never evidence (#600). They carry this frontmatter field:
 * the memory note (`vault_engine_projection: memories`) and the Curator Journal (`journal`).
 *
 * - The semantic index drops a marked note's vectors (`search/indexer.ts`), so no similarity
 *   search returns it.
 * - Project evidence and field-guess candidates leave marked notes out (`notSuiteNoteSql`).
 * - The Curator's own reads filter on the same field (`without_fields`).
 *
 * The Engine also renders a marked note as its own output: canonical frontmatter order, and no
 * link rewriting after a rename (`pipeline/execute.ts`).
 */
export const SUITE_NOTE_FIELD = 'vault_engine_projection';

/** SQL condition: the node aliased `alias` carries no suite marker. */
export function notSuiteNoteSql(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM node_fields suite_nf WHERE suite_nf.node_id = ${alias}.id AND suite_nf.field_name = '${SUITE_NOTE_FIELD}')`;
}
