import type { Engine } from './engine.js';

/*
 * The project-note field a person sets to ask for a project wiki (#385): `wiki: true` in the
 * note's frontmatter, the field the vault map names `wikiFlagField` (none turns the request off).
 * The Curator's wiki-field check (`wiki-field-check.ts`) registers a wiki for each project note
 * that has it and no wiki yet. Removing the field does nothing; `remove-wiki` is still how a wiki
 * is deregistered, and it clears this field first.
 */

/** True when a wiki request field's value asks for a wiki: YAML `true`, or the text "true" when
 *  a vault declares the field as text. */
export function asksForWiki(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

/** What remove-wiki did with a project note's wiki request field. */
export type WikiFieldClear =
  | { readonly outcome: 'cleared' }
  | { readonly outcome: 'not_set' }
  | { readonly outcome: 'not_cleared'; readonly reason: string };

/**
 * Remove `<field>: true` from a project note through the Engine's `update-node`, so the wiki-field
 * check doesn't register the wiki again after remove-wiki. `field` is the vault map's
 * `wikiFlagField`. Best-effort: never throws. A field that doesn't ask for a wiki (absent,
 * `false`, anything else) is left as it is.
 */
export async function clearWikiField(engine: Pick<Engine, 'readNodeField' | 'updateNodeFields'>,
  nodeId: string, title: string, field: string): Promise<WikiFieldClear> {
  try {
    if (!asksForWiki(await engine.readNodeField(nodeId, field))) return { outcome: 'not_set' };
    await engine.updateNodeFields(nodeId, { [field]: null }, title);
    return { outcome: 'cleared' };
  } catch (err) {
    return { outcome: 'not_cleared', reason: err instanceof Error ? err.message : String(err) };
  }
}
