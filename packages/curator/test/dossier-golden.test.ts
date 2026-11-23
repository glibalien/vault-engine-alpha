import { describe, expect, it } from 'vitest';
import { renderDossierEvidence } from '../src/dossier/evidence.js';
import { builtInDossierSections } from '../src/dossier/sections.js';
import { DOSSIER_GOLDEN_CASES, DOSSIER_GOLDEN_OWNER, goldenDossierInputs, type DossierGoldenCase } from '../src/eval/dossier-golden-cases.js';
import { runDossierCase } from '../src/eval/dossier-golden.js';
import { selectDossierCases } from '../src/eval-dossier.js';
import type { LlmClient, StructuredCallRequest } from '../src/llm/types.js';

// Fictional people and companies only (repository rule).

const USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
const POLICY = { model: 'home-model', maxTokens: 4000, configuration: {} } as never;

function fakeModel(page: unknown, check: unknown = { broken: [] }): LlmClient & { requests: StructuredCallRequest[] } {
  const requests: StructuredCallRequest[] = [];
  const client = {
    requests,
    structuredCall: async (request: StructuredCallRequest) => {
      requests.push(request);
      return { output: request.toolName === 'emit_dossier_rule_check' ? check : page, usage: USAGE };
    },
    withConfiguration: () => client,
  };
  return client as unknown as LlmClient & { requests: StructuredCallRequest[] };
}

const byId = (id: string): DossierGoldenCase => DOSSIER_GOLDEN_CASES.find(c => c.id === id)!;

describe('golden dossier cases (#721)', () => {
  it('each builds its evidence as a real build would, and checks only sections its kind has', () => {
    for (const c of DOSSIER_GOLDEN_CASES) {
      const inputs = goldenDossierInputs(c);
      const rendered = renderDossierEvidence({ ...inputs, owner: DOSSIER_GOLDEN_OWNER, meetingReads: 5, timeZone: 'UTC' });
      expect(rendered.text, c.id).toContain(`# Dossier subject: ${c.subject.title}`);
      for (const check of c.checks) if (check.section) expect(builtInDossierSections(c.kind).map(section => section.name), `${c.id}: ${check.why}`).toContain(check.section);
    }
    // A meeting body is read in full (#720), and the rule case has its rule.
    const company = renderDossierEvidence({ ...goldenDossierInputs(byId('company-people-and-bodies')), owner: DOSSIER_GOLDEN_OWNER, meetingReads: 5, timeZone: 'UTC' });
    expect(company.text).toContain('board approved the warehouse expansion');
    expect(goldenDossierInputs(byId('rule-kept')).memories.rules).toHaveLength(1);
  });

  it('passes a page that dates each line by its own entry and keeps a past deadline out of Open items', async () => {
    const model = fakeModel({ lines: [
      { section: 'Who', text: 'Leads procurement at [[Northwind]].', memory_ids: [101] },
      { section: 'Preferences', text: 'Prefers email over calls.', memory_ids: [102] },
      { section: 'History', text: 'The finance committee approved the renewal budget.', note_ids: ['n1'], day: '2026-04-15' },
      { section: 'History', text: 'Asked for the pilot report.', note_ids: ['n2'] },
      { section: 'Open items', text: 'Confirmed the site visit at the Rotterdam warehouse.', note_ids: ['n2'] },
    ] });
    const result = await runDossierCase(model, POLICY, byId('person-timeline-days'));
    expect(result.checks.filter(check => !check.passed)).toEqual([]);
    expect(result).toMatchObject({ passed: true, kept: 5, dropped: 0, calls: 1 });
    expect(result.costUsd).toBeNull(); // the fake model has no price
  });

  it('fails a page that takes a day from another entry, and one that leaves a passed deadline open', async () => {
    const model = fakeModel({ lines: [
      { section: 'History', text: 'The finance committee approved the renewal budget.', note_ids: ['n1'], day: '2026-02-10' },
      { section: 'Open items', text: 'Send the pilot report.', note_ids: ['n2'] },
      { section: 'Who', text: 'Works with Avery Stone.', memory_ids: [101] },
    ] });
    const result = await runDossierCase(model, POLICY, byId('person-timeline-days'));
    expect(result.passed).toBe(false);
    expect(result.checks.filter(check => !check.passed).map(check => check.why)).toEqual([
      'the renewal budget line is dated by its own timeline entry',
      'a deadline that has passed is not an open item',
      'the planned site visit, said in the note and the meeting, is on the page',
      'the owner is "you", never named',
    ]);
  });

  it('runs the rule check where the subject has rules: a breaking line left out passes, one kept fails', async () => {
    const lines = { lines: [
      { section: 'Who', text: 'Runs operations at [[Northwind]].', memory_ids: [303] },
      { section: 'Relationships', text: 'Leads the acquisition talks with Contoso.', memory_ids: [302] },
    ] };
    const checked = fakeModel(lines, { broken: [{ line: 2, rule: 1, words: 'acquisition talks' }] });
    const kept = await runDossierCase(checked, POLICY, byId('rule-kept'));
    expect(kept).toMatchObject({ passed: true, calls: 2, ruleDropped: 1 });
    expect(kept.output).toContain('## Rules on what to say'); // listed, and left out of the checks
    const missed = await runDossierCase(fakeModel(lines), POLICY, byId('rule-kept'));
    expect(missed).toMatchObject({ passed: false, ruleDropped: 0 });
  });

  it('reports a model call that fails as a failed case, not a crash', async () => {
    const model = { structuredCall: async () => { throw new Error('upstream 500'); }, withConfiguration: () => model } as unknown as LlmClient;
    const result = await runDossierCase(model, POLICY, byId('company-people-and-bodies'));
    expect(result).toMatchObject({ passed: false, error: 'upstream 500', calls: 1 });
  });

  it('selects cases by id and refuses an unknown one', () => {
    expect(selectDossierCases([]).length).toBe(DOSSIER_GOLDEN_CASES.length);
    expect(selectDossierCases(['rule-kept']).map(c => c.id)).toEqual(['rule-kept']);
    expect(() => selectDossierCases(['nope'])).toThrow('unknown case(s): nope');
  });
});
