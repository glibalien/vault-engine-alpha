import type { TemplateCard } from '@vault/chat-core';
import type { BoardCardSpec, VizSpec } from '@vault/viz-ui';

/** A board-level plan after resolution: the target (if any) is already a concrete note;
 *  only the save/link writes remain. Produced by the pipeline, executed and undone by Boards.tsx. */
export interface BoardCreatePlan { kind: 'create'; name: string; cards: BoardCardSpec[]; linkNodeId?: string; summary: string }
export type BoardLevelPlan = BoardCreatePlan;

/** Deep-clone `value`, replacing {{title}}/{{id}} in every string. Non-strings pass through. */
export function substitute(value: unknown, hit: { id: string; title: string }): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('{{title}}', () => hit.title).replaceAll('{{id}}', () => hit.id);
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, hit));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, hit)]));
  }
  return value;
}

export function instantiateTemplateCards(cards: TemplateCard[], hit?: { id: string; title: string }): BoardCardSpec[] {
  return cards.map((t) => {
    if (t.kind === 'stats') return { kind: 'stats', title: t.title ?? 'Vault stats' };
    // chat-core's structural VizSpec mirrors viz-ui's (chat-core cannot depend on viz-ui) — cast across the mirror boundary.
    if (t.kind === 'viz') return (hit ? substitute(t.spec, hit) : t.spec) as unknown as VizSpec;
    if (!hit) throw new Error(`${t.kind} template card needs a target note`);
    return { kind: 'node', title: hit.title, node_id: hit.id };
  });
}
