import { describe, expect, it } from 'vitest';
import { renderWikiMemories, withSourceLabels } from '../src/wiki-memories.js';
import { buildEvidence, homeEvidenceNodeIds, peopleBlocks, renderPeople, renderUnlinkedPeople } from '../src/evidence.js';
import { parseTopologyPlan } from '../src/topology.js';
import { buildTopologyPlanTool } from '../src/prompts/topology.js';
import type { Memory, ProjectEvidence } from '../src/types.js';

const memory = (id: number, content: string, extra: Partial<Memory> = {}): Memory => ({ id, source: 'curator', scope: 'vault', node_id: null,
  content, category: 'fact', created_at: '2026-11-01T12:00:00.000Z', updated_at: '2026-11-01T12:00:00.000Z', ...extra });
const day = (iso: string) => iso.slice(0, 10);

describe('memories in a project build (#474 idea 4)', () => {
  it('dates each memory and names where it came from, newest first; the owner\'s are left as they are', () => {
    const memories = withSourceLabels([
      memory(1, 'Older fact.', { valid_at: '2026-10-01T00:00:00.000Z', evidence_kind: 'note', evidence_node_id: 'n1' }),
      memory(2, 'Newer fact.', { valid_at: '2026-11-03T00:00:00.000Z', evidence_kind: 'note', evidence_node_id: 'gone' }),
      memory(3, 'Said in chat.', { valid_at: '2026-10-20T00:00:00.000Z', evidence_kind: 'conversation' }),
      memory(4, 'From a build.', { evidence_kind: 'curation-run' }),
      memory(5, 'Owner rule.', { source: 'owner', category: null }),
    ], new Map([['n1', 'Kickoff "call"']]), day);
    expect(renderWikiMemories(memories, 'project').lines).toEqual([
      '## OWNER MEMORIES (the owner\'s own standing notes: follow them)',
      '- Owner rule.',
      '',
      '## MEMORIES (durable facts about this project from earlier notes, conversations and wiki builds; newest first, each with the day it became true and where it came from)',
      '- [fact] 2026-11-03, from a note: Newer fact.',
      '- [fact] 2026-11-01, from a wiki build: From a build.',
      '- [fact] 2026-10-20, from a chat: Said in chat.',
      '- [fact] 2026-10-01, from "Kickoff \'call\'": Older fact.',
      '',
    ]);
  });

  it('keeps the old form for memories without labels', () => {
    expect(renderWikiMemories([memory(1, 'A fact.')], 'topic').lines[1]).toBe('- [fact] A fact.');
  });
});

describe('people and companies (#474 idea 4)', () => {
  const contacts: ProjectEvidence['contacts'] = {
    people: [{ id: 'p1', title: 'Dana Okafor', companies: ['Acme'], direct: true, meeting_count: 2, last_seen: null }],
    companies: [{ id: 'c1', title: 'Acme' }],
  };
  it('lists them by their note titles, a person with how they relate to the project', () => {
    expect(renderPeople({ ...contacts, people: [...contacts.people,
      { id: 'p2', title: 'Lee Park', companies: [], direct: false, meeting_count: 1, last_seen: null },
      { id: 'p3', title: 'Ola Berg', companies: [], direct: false, meeting_count: 0, last_seen: null }] })).toEqual({ ids: ['p1', 'p2', 'p3', 'c1'], lines: [
      '## PEOPLE AND COMPANIES ON THIS PROJECT (each has a note under this exact title; link them by it. In brackets: their company, "project contact" when the project lists them, and the project meetings they attended)',
      '- Dana Okafor (Acme; project contact; 2 project meetings)', '- Lee Park (1 project meeting)', '- Ola Berg', '- Acme (company)'] });
    expect(renderPeople({ people: [], companies: [] }).lines).toEqual([]);
  });
  it('lists people named without a note, to be written as plain text', () => {
    const withUnlinked: ProjectEvidence['contacts'] = { ...contacts, unlinked: [
      { name: 'Sam Rivera', direct: true, meeting_count: 0 }, { name: 'Kit Moss', direct: false, meeting_count: 3 }] };
    const unlinkedLines = [
      '## PEOPLE NAMED WITHOUT A NOTE (the project or its meetings name them, but no note exists: write each name as plain text, never as a link)',
      '- Sam Rivera (project contact)', '- Kit Moss (3 project meetings)'];
    expect(renderUnlinkedPeople(withUnlinked)).toEqual(unlinkedLines);
    // An Engine before the field sends none.
    expect(renderUnlinkedPeople(contacts)).toEqual([]);
    expect(peopleBlocks(withUnlinked)).toEqual([...renderPeople(contacts).lines, '', ...unlinkedLines]);
    expect(peopleBlocks({ people: [], companies: [], unlinked: withUnlinked.unlinked })).toEqual(unlinkedLines);
    const digest = { project: { id: 'root', title: 'Atlas', status: null }, tasks: {}, notes: [], signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
      existing_wiki: { home_id: null, subpages: [] }, synthesis_hints: { suggested_reads: [] }, contacts: withUnlinked } as unknown as ProjectEvidence;
    expect(buildEvidence({ id: 'root', title: 'Atlas', file_path: 'Atlas.md', status: null }, digest, [], null))
      .toContain(`${unlinkedLines.join('\n')}\n`);
  });
  it('reads their observations with the home\'s, since the block attributes each of them', () => {
    const digest = { project: { id: 'root', title: 'Atlas', status: null }, tasks: {}, notes: [], signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
      existing_wiki: { home_id: null, subpages: [] }, synthesis_hints: { suggested_reads: [] }, contacts } as unknown as ProjectEvidence;
    expect(homeEvidenceNodeIds(digest)).toEqual(expect.arrayContaining(['p1', 'c1']));
  });
  it('shows them to the home', () => {
    const digest = { project: { id: 'root', title: 'Atlas', status: null }, tasks: {}, notes: [], signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
      existing_wiki: { home_id: null, subpages: [] }, synthesis_hints: { suggested_reads: [] }, contacts } as unknown as ProjectEvidence;
    expect(buildEvidence({ id: 'root', title: 'Atlas', file_path: 'Atlas.md', status: null }, digest, [], null))
      .toContain('## PEOPLE AND COMPANIES ON THIS PROJECT');
  });
});

describe('the planner marks each page\'s rules (#474 idea 4)', () => {
  const scope = { v: 1, subject: 'Atlas', facet: 'Messaging' };
  it('keeps rule_ids through parsing', () => {
    const parsed = parseTopologyPlan({ reviewed_page_ids: [], actions: [
      { op: 'create', plan_key: 'k', title: 'Atlas — Messaging', kind: 'freeform', scope, synthesis_brief: 'B', rule_ids: [7, 9] },
    ] });
    expect(parsed.ok && parsed.plan.actions[0]).toMatchObject({ rule_ids: [7, 9] });
    expect(parseTopologyPlan({ reviewed_page_ids: [], actions: [
      { op: 'create', plan_key: 'k', title: 'Atlas — Messaging', kind: 'freeform', scope, synthesis_brief: 'B', rule_ids: ['7'] },
    ] }).ok).toBe(false);
  });
  it('offers rule_ids only when the build has memories to mark', () => {
    const wiki = { home_id: null, home: null, topology_hash: 't', catalog_valid: true, subpages: [] };
    expect(JSON.stringify(buildTopologyPlanTool(wiki, true).schema)).not.toContain('rule_ids');
    expect(JSON.stringify(buildTopologyPlanTool(wiki, true, true).schema)).toContain('rule_ids');
  });
});
