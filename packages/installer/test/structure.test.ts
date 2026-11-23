import { afterEach, describe, expect, it } from 'vitest';
import { createAnalyzerRunner } from '../src/analyzer.js';
import { AnswersError, type StructureAnswers } from '../src/answers.js';
import { createScriptedPrompter, type Prompter } from '../src/prompter.js';
import { runModelsStage } from '../src/models.js';
import { buildPlanReport, renderStructure } from '../src/report.js';
import { buildReview } from '../src/review.js';
import { detectStructure, MAP_QUESTION, runStructureStage, type StructurePlan } from '../src/structure.js';
import { detectRole, NO_STATUS } from '../src/vault-map.js';
import { isTypeName, suggestTypeName } from '../src/type-names.js';
import { runVaultStage } from '../src/vault.js';
import { fm, makeTree, realFilesystemHost, removeTrees, replayPrompter, REPO_ROOT, SOURCE_ANALYZER, TEST_SERVICES } from './helpers.js';

afterEach(removeTrees);

const analyzer = createAnalyzerRunner(SOURCE_ANALYZER);

async function headless(files: Record<string, string>, structure?: StructureAnswers) {
  const root = await makeTree(files);
  const lines: string[] = [];
  const prompter = createScriptedPrompter(
    { version: 1, vault: { path: root }, ...(structure ? { structure } : {}) },
    line => lines.push(line),
  );
  return { plan: await stages(prompter, root), lines };
}

async function stages(prompter: Prompter, root: string) {
  const vault = await runVaultStage({ host: realFilesystemHost(), prompter, analyzer, cwd: '/', dataDir: '/srv/tester/vault-suite-data', repoRoot: REPO_ROOT });
  return runStructureStage({ prompter, analyzer, vault });
}

/** The answer to the map screen that opens the step's questions. */
const ADJUST = false;

const TYPED_VAULT = {
  'Projects/Alpha.md': fm({ type: 'project', status: 'open' }),
  'Projects/Beta.md': fm({ type: 'project', status: 'done' }),
  'Meetings/Kickoff.md': fm({ type: 'meeting' }),
  'People/Avery.md': fm({ type: 'person' }),
  'Loose.md': '# Loose\n',
};

describe('runStructureStage', () => {
  it('types notes by a frontmatter field and designates what the notes say', async () => {
    const { plan } = await headless(TYPED_VAULT, { source: 'field' });

    expect(plan.spec).toMatchObject({ type_field: 'type', folder_rules: [], type_renames: {} });
    expect(plan.analysis?.proposal.schemas.map(schema => schema.name)).toEqual(['meeting', 'person', 'project']);
    expect(plan.roles).toEqual({ project: 'project', task: null, meeting: 'meeting', person: 'person', company: null });
    // Nothing is added: no note type, no project field on it, no starter types.
    expect(plan.starterTypes).toEqual([]);
    expect(plan.starterFields).toEqual([]);
    expect(plan.extraClaims).toEqual([]);
    expect(plan.status.project).toEqual({
      field: 'status', starter: false, active: ['open'], groups: { done: ['done'], blocked: [], backlog: [], ignored: [] },
    });
    expect(plan.status.task).toEqual(NO_STATUS);
    // Curator would create its journal kind when it first writes.
    expect(plan.journalType).toBe('note');
    expect(plan.warnings).toEqual([]);
  });

  it('types notes by folder when no field looks like a type, adding no status field', async () => {
    const { plan } = await headless({
      'Projects/Alpha.md': '# Alpha\n',
      'People/Avery.md': '# Avery\n',
    });

    expect(plan.source).toBe('folders');
    expect(plan.spec.folder_rules).toEqual([
      { directory: 'People', type: 'person' },
      { directory: 'Projects', type: 'project' },
    ]);
    expect(plan.roles).toMatchObject({ project: 'project', person: 'person' });
    expect(plan.extraClaims).toEqual([]);
    expect(plan.starterFields).toEqual([]);
    expect(plan.status.project).toEqual(NO_STATUS);
    expect(plan.warnings).toEqual([]);
  });

  it('plans no types when notes are not typed from the vault and none are asked for', async () => {
    const { plan } = await headless({ 'Note.md': '# Note\n' }, { source: 'none' });

    expect(plan.analysis).toBeNull();
    expect(plan.roles).toEqual({ project: null, task: null, meeting: null, person: null, company: null });
    expect(plan.starterTypes).toEqual([]);
    expect(plan.starterFields).toEqual([]);
    expect(plan.status).toEqual({ project: NO_STATUS, task: NO_STATUS });
  });

  it('plans new types and status fields only as asked, under the names given', async () => {
    const { plan } = await headless({ 'Note.md': '# Note\n' }, {
      source: 'none',
      roles: { project: { starter: 'initiative' }, task: 'task', person: { starter: 'contact' } },
      status_fields: { task: { starter: 'state' } },
    });

    expect(plan.roles).toEqual({ project: 'initiative', task: 'task', meeting: null, person: 'contact', company: null });
    expect(plan.starterTypes).toEqual([
      // A new type comes with a new status field unless the answers say otherwise.
      { name: 'initiative', role: 'project', claims: ['status', 'due', 'people involved', 'company'] },
      { name: 'task', role: 'task', claims: ['state', 'due', 'project'] },
      { name: 'contact', role: 'person', claims: ['company'] },
    ]);
    expect(plan.starterFields.map(field => field.name)).toEqual(['status', 'due', 'people involved', 'company', 'state', 'project']);
    expect(plan.starterFields.find(field => field.name === 'project')).toMatchObject({ reference_target: 'initiative' });
    expect(plan.starterFields.find(field => field.name === 'people involved')).toMatchObject({ reference_target: 'contact' });
    expect(plan.starterFields.find(field => field.name === 'state')).toMatchObject({ field_type: 'enum' });
    expect(plan.status.project).toMatchObject({ field: 'status', starter: true, active: ['open', 'in-progress'] });
    expect(plan.status.task).toMatchObject({ field: 'state', starter: true, active: ['open', 'in-progress'], groups: { done: ['done'] } });
  });

  it('designates the fields and task statuses the answers name', async () => {
    const { plan } = await headless({
      'Projects/Alpha.md': fm({ type: 'project', stage: 'live', status: 'x' }),
      'Projects/Beta.md': fm({ type: 'project', stage: 'shelved', status: 'y' }),
      'Tasks/One.md': fm({ type: 'task', state: 'todo' }),
      'Tasks/Two.md': fm({ type: 'task', state: 'finished' }),
    }, {
      source: 'field',
      status_fields: { project: 'stage', task: 'state' },
      active_statuses: ['live'],
      status_groups: { ignored: ['shelved'] },
      task_active_statuses: ['todo'],
    });

    expect(plan.status.project).toEqual({
      field: 'stage', starter: false, active: ['live'], groups: { done: [], blocked: [], backlog: [], ignored: ['shelved'] },
    });
    expect(plan.status.task).toEqual({
      field: 'state', starter: false, active: ['todo'], groups: { done: ['finished'], blocked: [], backlog: [], ignored: [] },
    });
    expect(plan.extraClaims).toEqual([]);
  });

  it('designates no status field when the answers say none, and turns down bad ones', async () => {
    const files = {
      'Projects/Alpha.md': fm({ type: 'project', status: 'open', due: '2026-01-01' }),
      'Tasks/One.md': fm({ type: 'task', status: 'open' }),
    };
    const { plan } = await headless(files, { source: 'field', status_fields: { project: null } });

    expect(plan.status.project).toEqual(NO_STATUS);
    expect(plan.status.task.field).toBe('status');
    await expect(headless(files, { source: 'field', status_fields: { project: 'due' } }))
      .rejects.toThrow(/structure\.status_fields: project: due is not a text field your notes have/);
    await expect(headless(files, { source: 'field', status_fields: { project: { starter: 'due' } } }))
      .rejects.toThrow(/structure\.status_fields: project: due is a field new types use/);
    await expect(headless({ 'Note.md': '# Note\n' }, { source: 'none', roles: { task: 'task' }, task_active_statuses: ['doing'] }))
      .rejects.toThrow(/structure\.task_active_statuses: doing is not among the status values/);
  });

  it('turns down a new status field named like the type key', async () => {
    // Typed by its `type` field, the vault keeps types under `type` (VAULT_TYPE_KEY), and
    // Engine refuses a field of that name; typed by folder, the type key is `types`.
    await expect(headless(TYPED_VAULT, { source: 'field', status_fields: { project: { starter: 'type' } } }))
      .rejects.toThrow(/structure\.status_fields: project: type is the field that holds each note's types/);
    await expect(headless({ 'Projects/Alpha.md': '# Alpha\n' }, { source: 'folders', status_fields: { project: { starter: 'types' } } }))
      .rejects.toThrow(/structure\.status_fields: project: types is the field that holds each note's types/);
  });

  it('refuses two kinds sharing one new type', async () => {
    await expect(headless({ 'Note.md': '# Note\n' }, { source: 'none', roles: { project: { starter: 'item' }, task: { starter: 'Item' } } }))
      .rejects.toThrow(/structure\.roles: task: Item is already the new project type/);
  });

  it('plans every kind none for an empty folder', async () => {
    const { plan } = await headless({});

    expect(plan.source).toBe('none');
    expect(plan.analysis).toBeNull();
    // No starter kind is created unless asked for (#451).
    expect(plan.starterTypes).toEqual([]);
    expect(plan.starterFields).toEqual([]);
    expect(plan.roles).toEqual({ project: null, task: null, meeting: null, person: null, company: null });
    expect(plan.status).toEqual({ project: NO_STATUS, task: NO_STATUS });
  });

  it('gives a starter meeting type a plain date field', async () => {
    const { plan } = await headless({ 'Note.md': '# Note\n' }, { source: 'none', roles: { meeting: 'meeting' } });

    expect(plan.starterTypes.find(type => type.name === 'meeting'))
      .toEqual({ name: 'meeting', role: 'meeting', claims: ['project', 'people involved', 'date'] });
    expect(plan.starterFields.find(field => field.name === 'date')).toEqual({ name: 'date', field_type: 'date' });
  });

  it('refuses unresolved name collisions in a headless run, and merges them with renames', async () => {
    const files = {
      'A.md': fm({ type: 'Meeting' }),
      'B.md': fm({ type: 'meeting' }),
    };

    await expect(headless(files, { source: 'field', type_field: 'type' }))
      .rejects.toThrow(/Meeting \/ meeting.*structure\.type_renames/);
    const { plan } = await headless(files, { source: 'field', type_field: 'type', type_renames: { Meeting: 'meeting' } });

    expect(plan.analysis?.proposal.schemas).toEqual([expect.objectContaining({
      name: 'meeting',
      evidence: expect.objectContaining({ typed_documents: 2 }),
    })]);
    expect(plan.spec.type_renames).toEqual({ Meeting: 'meeting' });
  });

  it('renames and drops proposed types from fields and folder rules', async () => {
    const { plan } = await headless({
      ...TYPED_VAULT,
      'Clips/Article.md': '# Article\n',
    }, {
      source: 'both',
      type_field: 'type',
      folder_rules: [{ directory: 'Clips', type: 'clipping' }],
      type_renames: { meeting: 'call', person: null, clipping: 'clip' },
      roles: { meeting: 'call', person: null },
    });

    expect(plan.analysis?.proposal.schemas.map(schema => schema.name)).toEqual(['call', 'clip', 'project']);
    expect(plan.spec.type_renames).toEqual({ meeting: 'call', person: null });
    expect(plan.spec.folder_rules).toEqual([{ directory: 'Clips', type: 'clip' }]);
  });

  it.each([
    ['a rename of a type that does not exist', { source: 'field' as const, type_renames: { nope: 'x' } }, /nope is not one of the proposed types/],
    ['a rename to an unsafe name', { source: 'field' as const, type_renames: { meeting: '_m' } }, /"_m" cannot be a type name/],
    ['a role that is neither a proposed type nor its starter', { source: 'field' as const, roles: { project: 'nope' } }, /structure\.roles\.project/],
    ['a type field that is not in the notes', { source: 'field' as const, type_field: 'kind' }, /structure\.type_field: No note has a "kind" line/],
  ])('refuses %s', async (_label, structure, message) => {
    const run = headless(TYPED_VAULT, structure);

    await expect(run).rejects.toThrow(AnswersError);
    await expect(run).rejects.toThrow(message);
  });

  it('keeps fields that need review unmanaged and skips their starter claims', async () => {
    const { plan } = await headless({
      'Projects/Alpha.md': fm({ type: 'project', status: 'open', due: '2026-01-01' }),
      'Projects/Beta.md': fm({ type: 'project', status: '3', due: '7' }),
    }, { source: 'field', roles: { task: 'task' } });

    expect(plan.unmanagedFields.map(field => field.name)).toEqual(['due', 'status']);
    // The new task type gets no status field: the notes use the name in mixed shapes.
    expect(plan.starterTypes.find(type => type.name === 'task')?.claims).toEqual(['project']);
    expect(plan.status).toEqual({ project: NO_STATUS, task: NO_STATUS });
    expect(plan.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('new task kind does not get a due line'),
      expect.stringContaining('use the status line in more than one way'),
    ]));
  });

  it('stores a review field as chosen, claimed like any other field', async () => {
    const { plan } = await headless({
      'Projects/Alpha.md': fm({ type: 'project', status: 'open', due: '2026-01-01' }),
      'Projects/Beta.md': fm({ type: 'project', status: '3', due: '7' }),
    }, { source: 'field', review_fields: { status: 'text' } });

    expect(plan.spec.field_types).toEqual({ status: { field_type: 'string' } });
    expect(plan.unmanagedFields.map(field => field.name)).toEqual(['due']);
    expect(plan.analysis?.proposal.global_fields).toEqual([expect.objectContaining({ name: 'status', field_type: 'string' })]);
    expect(plan.analysis?.proposal.schemas[0]?.field_claims.map(claim => claim.field)).toEqual(['status']);
    expect(plan.status.project.active).toEqual(['open']);
  });

  it.each([
    ['a field that does not need review', { nope: 'text' as const }, /nope is not a field that needs review/],
    ['a shape some values do not convert to', { due: 'dominant' as const }, /due cannot be stored as a date: 1 value would not convert/],
  ])('refuses %s', async (_label, reviewFields, message) => {
    await expect(headless({
      'Projects/Alpha.md': fm({ type: 'project', due: '2026-01-01' }),
      'Projects/Beta.md': fm({ type: 'project', due: '7' }),
    }, { source: 'field', review_fields: reviewFields })).rejects.toThrow(message);
  });

  it('designates the type field as Engine\'s type key, so notes keep it and get no second key (#445)', async () => {
    const kept = await headless(TYPED_VAULT, { source: 'field' });
    const folders = await headless({ 'Projects/Alpha.md': '# Alpha\n' }, { source: 'folders', remove_type_field: true });
    const root = await makeTree(TYPED_VAULT);
    // An answers file from before the designation may still ask to remove the field; there is nothing to remove.
    const prompter = createScriptedPrompter({ version: 1, vault: { path: root }, structure: { source: 'field', remove_type_field: true } }, () => {});
    const vault = await runVaultStage({ host: realFilesystemHost(), prompter, analyzer, cwd: '/', dataDir: '/srv/tester/vault-suite-data', repoRoot: REPO_ROOT });
    const structure = await runStructureStage({ prompter, analyzer, vault });
    const models = await runModelsStage({ prompter, keys: [], curatorInstalled: false });
    const review = buildReview({ dataDir: '/data', services: TEST_SERVICES, vault, structure, keys: [], models, curator: null, backup: null });
    const report = buildPlanReport({
      repoRoot: '/repo', dataDir: '/data', services: TEST_SERVICES, preflight: [], vault, structure, keys: [], models, curator: null,
      backup: null, review, now: new Date(0),
    });

    expect([kept.plan.spec.type_key, folders.plan.spec.type_key, structure.spec.type_key]).toEqual(['type', undefined, 'type']);
    expect([kept.plan.removeTypeField, folders.plan.removeTypeField, structure.removeTypeField]).toEqual([false, false, false]);
    // The analysis maps the field onto itself, so nothing else is written into the notes.
    expect(structure.analysis?.proposal.type_field_mapping).toEqual({ source: 'type', target: 'type' });
    expect(report.structure?.analyzer_spec.type_key).toBe('type');
    expect(report.structure?.remove_type_field).toBe(false);
    expect(renderStructure(report.structure!)).toContain('Engine keeps each note\'s types in its type field (VAULT_TYPE_KEY); no types field is added.');
    expect(review.vault_changes).toContainEqual(expect.stringContaining('their types in the type field, which Engine reads and writes them in (VAULT_TYPE_KEY)'));
    expect(review.vault_changes.join('\n')).not.toMatch(/Remove the type field|a types field/);
  });

  it('keeps a types type field as the default key, with nothing written for it', async () => {
    const { plan } = await headless({
      'Projects/Alpha.md': '---\ntypes:\n  - project\n---\n',
      'Meetings/Sync.md': '---\ntypes:\n  - meeting\n---\n',
    }, { source: 'field', type_field: 'types' });
    expect(plan.spec).toMatchObject({ type_field: 'types', type_key: 'types' });
    expect(plan.removeTypeField).toBe(false);
  });

  it.each(['status', 'project'])('asks again when the chosen field is %s, a field the plan may add itself', async field => {
    await expect(headless({ 'Projects/A.md': fm({ [field]: 'meeting' }), 'Projects/B.md': fm({ [field]: 'task' }) }, { source: 'field', type_field: field }))
      .rejects.toThrow(new RegExp(`structure\\.type_field.*The ${field} field cannot hold note types`));
  });

  it('asks again when the chosen field holds a value Engine could not keep as a type', async () => {
    await expect(headless({ 'A.md': fm({ kind: 'meeting' }), 'B.md': '---\nkind:\n  category: meeting\n---\n' }, { source: 'field', type_field: 'kind' }))
      .rejects.toThrow(/structure\.type_field.*Engine could not keep every value of "kind"/);
  });

  it('asks again when the chosen field is one Engine writes in its own notes', async () => {
    await expect(headless({ 'Clips/A.md': fm({ source: 'book' }), 'Clips/B.md': fm({ source: 'web' }) }, { source: 'field', type_field: 'source' }))
      .rejects.toThrow(/structure\.type_field.*Engine writes "source" in its own notes/);
  });

  it('groups the other status values for project wikis by name', async () => {
    const files: Record<string, string> = {};
    for (const [index, status] of ['open', 'open', 'complete', 'cancelled', 'waiting', 'someday', 'misc'].entries()) {
      files[`Projects/P${index}.md`] = fm({ type: 'project', status });
    }
    const { plan } = await headless(files, { source: 'field' });
    const starter = await headless({ 'Note.md': '# Note\n' }, { source: 'none', roles: { project: 'project' } });

    expect(plan.status.project.active).toEqual(['open']);
    expect(plan.status.project.groups).toEqual({ done: ['complete'], blocked: ['waiting'], backlog: ['someday'], ignored: ['cancelled'] });
    // A new status field's own values.
    expect(starter.plan.status.project.groups).toEqual({ done: ['done'], blocked: ['blocked'], backlog: ['backlog'], ignored: ['dropped'] });
  });

  it('takes status groups from the answers, refusing an active or unknown value', async () => {
    const starter = { source: 'none' as const, roles: { project: 'project' } };
    const answered = await headless({ 'Note.md': '# Note\n' }, { ...starter, status_groups: { done: ['done', 'dropped'], ignored: [] } });

    expect(answered.plan.status.project.groups).toEqual({ done: ['done', 'dropped'], blocked: ['blocked'], backlog: ['backlog'], ignored: [] });
    await expect(headless({ 'Note.md': '# Note\n' }, { ...starter, status_groups: { done: ['open'] } }))
      .rejects.toThrow(/done: open is active or not among the status values/);
    await expect(headless({ 'Note.md': '# Note\n' }, { ...starter, status_groups: { blocked: ['stuck'] } }))
      .rejects.toThrow(/blocked: stuck is active or not among the status values/);
  });

  it('claims an existing status field for the project type and offers its values', async () => {
    const { plan } = await headless({
      'Projects/Alpha.md': fm({ type: 'project' }),
      'Tasks/One.md': fm({ type: 'task', status: 'doing' }),
      'Tasks/Two.md': fm({ type: 'task', status: 'waiting' }),
    }, { source: 'field', active_statuses: ['doing', 'waiting'] });

    expect(plan.extraClaims).toEqual([{ schema: 'project', field: 'status' }]);
    expect(plan.status.project.active).toEqual(['doing', 'waiting']);
    // Tasks use the same field, with their own meanings.
    expect(plan.status.task).toMatchObject({ field: 'status', active: ['doing'], groups: { blocked: ['waiting'] } });
    expect(plan.starterFields).toEqual([]);
  });

  it('swaps folder types regardless of rename order', async () => {
    const { plan } = await headless({ 'A/One.md': '# One\n', 'B/Two.md': '# Two\n', 'B/Three.md': '# Three\n' }, {
      source: 'folders',
      folder_rules: [{ directory: 'A', type: 'a' }, { directory: 'B', type: 'b' }],
      type_renames: { a: 'b', b: 'a' },
    });

    expect(plan.spec.folder_rules).toEqual([{ directory: 'A', type: 'b' }, { directory: 'B', type: 'a' }]);
    expect(plan.analysis?.proposal.schemas.map(schema => [schema.name, schema.evidence.typed_documents]))
      .toEqual([['a', 2], ['b', 1]]);
  });

  it('plans no types when every proposed type is dropped', async () => {
    const { plan } = await headless({ 'Clips/A.md': fm({ type: 'clipping' }) }, {
      source: 'field',
      type_renames: { clipping: null },
    });

    expect(plan.source).toBe('none');
    expect(plan.analysis).toBeNull();
    expect(plan.starterTypes).toEqual([]);
    expect(plan.warnings).toEqual(['No note ends up with a kind.']);
  });

  it('lets active statuses go beyond the sampled status values', async () => {
    const files: Record<string, string> = {};
    for (let index = 1; index <= 10; index++) {
      files[`Projects/P${String(index).padStart(2, '0')}.md`] = fm({ type: 'project', status: `stage${index}` });
    }
    files['Projects/P11.md'] = fm({ type: 'project', status: 'active' });

    const defaulted = await headless(files, { source: 'field' });
    const answered = await headless(files, { source: 'field', active_statuses: ['active'] });

    expect(defaulted.plan.status.project.active).toEqual([]);
    expect(defaulted.plan.warnings).toEqual([expect.stringContaining('Vault looked at only those')]);
    expect(answered.plan.status.project.active).toEqual(['active']);
  });

  it('lets each role follow its own rename before matching names', async () => {
    const { plan } = await headless({
      ...TYPED_VAULT,
      'Tasks/One.md': fm({ type: 'task' }),
    }, { source: 'field', type_renames: { project: 'initiative', task: 'project' } });

    expect(plan.roles).toMatchObject({ project: 'initiative', task: 'project' });
    expect(plan.status.project.active).toEqual(['open']);
    // The task kind's type (renamed to project) has no status of its own, so it claims
    // the status field the project kind's type uses.
    expect(plan.status.task.field).toBe('status');
    expect(plan.extraClaims).toEqual([{ schema: 'project', field: 'status' }]);
  });

  it('types notes of a dropped field type by their folder in both mode', async () => {
    const { plan } = await headless({
      'Projects/Alpha.md': fm({ type: 'project' }),
      'Projects/Clip.md': fm({ type: 'clipping' }),
    }, {
      source: 'both',
      type_field: 'type',
      folder_rules: [{ directory: 'Projects', type: 'project' }],
      type_renames: { clipping: null },
    });

    expect(plan.analysis?.proposal.schemas.map(schema => [schema.name, schema.evidence.typed_documents]))
      .toEqual([['project', 2]]);
  });

  it('counts every note as untyped in a starter-only plan', async () => {
    const root = await makeTree({ 'A.md': '# A\n', 'B.md': '# B\n' });
    const prompter = createScriptedPrompter({ version: 1, vault: { path: root }, structure: { source: 'none' } }, () => {});
    const vault = await runVaultStage({ host: realFilesystemHost(), prompter, analyzer, cwd: '/', dataDir: '/srv/tester/vault-suite-data', repoRoot: REPO_ROOT });
    const structure = await runStructureStage({ prompter, analyzer, vault });

    const models = await runModelsStage({ prompter, keys: [], curatorInstalled: false });
    const review = buildReview({ dataDir: '/data', services: TEST_SERVICES, vault, structure, keys: [], models, curator: null, backup: null });
    const report = buildPlanReport({
      repoRoot: '/repo', dataDir: '/data', services: TEST_SERVICES, preflight: [], vault, structure, keys: [], models, curator: null,
      backup: null, review, now: new Date(0),
    });

    expect(report.structure).toMatchObject({ typed_notes: 0, untyped_notes: 2 });
  });

  it('keeps a Note type as it is and proposes it as the journal kind', async () => {
    const { plan } = await headless({
      'Projects/Alpha.md': fm({ type: 'project', status: 'open' }),
      'Notes/Idea.md': fm({ type: 'Note' }),
    }, { source: 'field' });

    expect(plan.analysis?.proposal.schemas.map(schema => schema.name)).toEqual(['Note', 'project']);
    expect(plan.spec.type_renames).toEqual({});
    expect(plan.journalType).toBe('Note');
    expect(plan.starterTypes).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('uses an existing type for a kind instead of a new type that differs only by case', async () => {
    const { plan } = await headless({
      ...TYPED_VAULT,
      'Tasks/One.md': fm({ type: 'Task' }),
    }, { source: 'field', roles: { task: 'task' } });

    expect(plan.roles.task).toBe('Task');
    expect(plan.starterTypes).toEqual([]);
    expect(plan.warnings).toEqual(['Your tasks are your Task notes: a new "task" kind would differ from Task only in capital letters.']);
  });

  it.each([
    ['a starter status enum', { 'Note.md': '# Note\n' }, { source: 'none' as const, roles: { project: 'project' } }],
    ['an enum inferred from the notes', Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
      `Projects/P${index}.md`, fm({ type: 'project', status: index % 2 === 0 ? 'open' : 'done' }),
    ])), { source: 'field' as const }],
  ])('refuses active statuses outside %s', async (_label, files, structure) => {
    const run = headless(files, { ...structure, active_statuses: ['active'] });

    await expect(run).rejects.toThrow(AnswersError);
    await expect(run).rejects.toThrow(/structure\.active_statuses: active is not among the status values/);
  });

  it('leaves projects none, with no status, when the answers say so', async () => {
    const { plan } = await headless(TYPED_VAULT, { source: 'field', roles: { project: null } });

    expect(plan.roles.project).toBeNull();
    expect(plan.status.project).toEqual(NO_STATUS);
    expect(plan.extraClaims).toEqual([]);
  });
});

describe('runStructureStage interactively, after Adjust', () => {
  it('asks which name colliding types should share', async () => {
    const root = await makeTree({ 'A.md': fm({ type: 'Meeting' }), 'B.md': fm({ type: 'meeting' }) });
    const { prompter, asked } = replayPrompter({
      'vault.path': [root],
      'structure.source': ['field'],
      'structure.type_field': ['type'],
      // Asked while detecting, then again under Adjust: no rename ticked, and the shared name.
      'structure.type_renames': ['meeting', [], 'Meeting'],
    }, [ADJUST]);

    const plan = await stages(prompter, root);

    expect(plan.analysis?.proposal.schemas.map(schema => schema.name)).toEqual(['Meeting']);
    expect(plan.spec.type_renames).toEqual({ meeting: 'Meeting' });
    expect(asked.filter(id => id === 'structure.type_renames')).toHaveLength(3);
  });

  it('asks again when the Analyzer refuses the chosen type field', async () => {
    const root = await makeTree(TYPED_VAULT);
    const { prompter, rejections, spinners } = replayPrompter({
      'vault.path': [root],
      'structure.source': ['field', 'field'],
      'structure.type_field': ['\u0000other', 'kind', 'type'],
    }, [ADJUST]);

    const plan = await stages(prompter, root);

    expect(rejections).toEqual(['No note has a "kind" line at the top, so Vault cannot tell kinds apart by it.']);
    expect(plan.spec.type_field).toBe('type');
    expect(spinners.stopped).toBe(spinners.started);
  });

  it('accepts active statuses typed beyond the sampled values', async () => {
    const files: Record<string, string> = {};
    for (let index = 1; index <= 11; index++) {
      files[`Projects/P${String(index).padStart(2, '0')}.md`] = fm({ type: 'project', status: `stage${index}` });
    }
    const root = await makeTree(files);
    const { prompter } = replayPrompter({
      'vault.path': [root],
      'structure.source': ['field'],
      'structure.type_field': ['type'],
      'structure.active_statuses': [['stage1', '\u0000other'], 'stage11, live'],
    }, [ADJUST]);

    const plan = await stages(prompter, root);

    expect(plan.status.project.active).toEqual(['stage1', 'stage11', 'live']);
  });

  it('keeps the project role on its notes when a rename is merged by a collision', async () => {
    const root = await makeTree({
      'Projects/Alpha.md': fm({ type: 'project', status: 'open' }),
      'Initiatives/Beta.md': fm({ type: 'initiative', status: 'open' }),
    });
    const { prompter } = replayPrompter({
      'vault.path': [root],
      'structure.source': ['field'],
      'structure.type_field': ['type'],
      'structure.type_renames': [['project'], 'Initiative', 'initiative'],
    }, [ADJUST]);

    const plan = await stages(prompter, root);

    expect(plan.analysis?.proposal.schemas.map(schema => [schema.name, schema.evidence.typed_documents]))
      .toEqual([['initiative', 2]]);
    expect(plan.roles.project).toBe('initiative');
    expect(plan.starterTypes).toEqual([]);
    expect(plan.status.project.active).toEqual(['open']);
  });

  it('offers only the shapes every value converts to for each review field', async () => {
    const root = await makeTree({
      'Projects/Alpha.md': fm({ type: 'project', owners: '"[[Avery]]"', due: '2026-01-01' }),
      'Projects/Beta.md': fm({ type: 'project', owners: '["[[Avery]]", "[[Blake]]"]', due: '7' }),
      'People/Avery.md': fm({ type: 'person' }),
      'People/Blake.md': fm({ type: 'person' }),
    });
    const offered: string[][] = [];
    const { prompter, asked } = replayPrompter({
      'vault.path': [root],
      'structure.source': ['field'],
      'structure.type_field': ['type'],
      'structure.review_fields': ['unmanaged', 'dominant'],
    }, [ADJUST]);
    const select = prompter.select.bind(prompter);
    prompter.select = async question => {
      if (question.id === 'structure.review_fields') offered.push(question.options.map(option => option.label));
      return select(question);
    };

    const plan = await stages(prompter, root);

    // due: a date would not take 7, so only text is offered. owners: a list of links takes
    // the single link too, but text would not take the list.
    expect(offered).toEqual([
      ['Leave it as it is', 'As text'],
      ['Leave it as it is', 'As a list of links to notes'],
    ]);
    expect(asked.filter(id => id === 'structure.review_fields')).toHaveLength(2);
    expect(plan.spec.field_types).toEqual({ owners: { field_type: 'list', list_item_type: 'reference' } });
    expect(plan.analysis?.proposal.global_fields).toEqual([
      expect.objectContaining({ name: 'owners', field_type: 'list', list_item_type: 'reference', reference_target: 'person' }),
    ]);
    expect(plan.unmanagedFields.map(field => field.name)).toEqual(['due']);
  });

  it('does not ask to remove the type field, which is now the type key (#445)', async () => {
    const root = await makeTree(TYPED_VAULT);
    const { prompter } = replayPrompter({
      'vault.path': [root],
      'structure.source': ['field'],
      'structure.type_field': ['type'],
    }, [ADJUST]);
    const confirmed: string[] = [];
    const confirm = prompter.confirm.bind(prompter);
    prompter.confirm = async question => { confirmed.push(question.message); return confirm(question); };

    const plan = await stages(prompter, root);

    expect(plan.removeTypeField).toBe(false);
    expect(plan.spec.type_key).toBe('type');
    expect(confirmed.filter(message => message.includes('field from each note'))).toEqual([]);
  });

  it('renames a type and drops another chosen in the review', async () => {
    const root = await makeTree(TYPED_VAULT);
    const { prompter } = replayPrompter({
      'vault.path': [root],
      'structure.source': ['field'],
      'structure.type_field': ['type'],
      'structure.type_renames': [['meeting', 'person'], 'call', ''],
    }, [ADJUST]);

    const plan = await stages(prompter, root);

    expect(plan.analysis?.proposal.schemas.map(schema => schema.name)).toEqual(['call', 'project']);
    expect(plan.roles).toMatchObject({ meeting: 'call', person: null });
  });
});

describe('runStructureStage interactively, designating the map', () => {
  it('adds a new type under a chosen name and leaves a status field out', async () => {
    const root = await makeTree(TYPED_VAULT);
    const { prompter, asked } = replayPrompter({
      'vault.path': [root],
      'structure.source': ['field'],
      'structure.type_field': ['type'],
      // project, task (a new type named action), meeting, person, company
      'structure.roles': ['project', '\u0000new', 'action', 'meeting', 'person', '\u0000none'],
      // project: none; task: a new field named state
      'structure.status_fields': ['\u0000none', '\u0000new', 'state'],
    }, [ADJUST, false, false, false]);

    const plan = await stages(prompter, root);

    expect(plan.roles).toEqual({ project: 'project', task: 'action', meeting: 'meeting', person: 'person', company: null });
    expect(plan.starterTypes).toEqual([{ name: 'action', role: 'task', claims: ['state', 'due', 'project'] }]);
    expect(plan.status.project).toEqual(NO_STATUS);
    expect(plan.status.task).toMatchObject({ field: 'state', starter: true, active: ['open', 'in-progress'] });
    // Task statuses are asked about as well as project ones.
    expect(asked).toContain('structure.task_active_statuses');
    expect(asked).not.toContain('structure.active_statuses');
  });

  it('asks again when a new status field is named like the type key', async () => {
    const root = await makeTree(TYPED_VAULT);
    const { prompter, rejections } = replayPrompter({
      'vault.path': [root],
      'structure.source': ['field'],
      'structure.type_field': ['type'],
      'structure.roles': ['project', '\u0000none', 'meeting', 'person', '\u0000none'],
      // project: a new field, first named type (the type key), then stage
      'structure.status_fields': ['\u0000new', 'type', 'stage'],
    }, [ADJUST, false, false, false]);

    const plan = await stages(prompter, root);

    expect(rejections).toEqual([expect.stringContaining('type is the field that holds each note\'s types')]);
    expect(plan.status.project).toMatchObject({ field: 'stage', starter: true });
  });
});

/** A vault typed by its `types` line, so no question about removing an old type field comes up. */
const TYPES_VAULT = {
  'Projects/Alpha.md': fm({ types: 'project', status: 'open', due: '2026-03-01' }),
  'Projects/Beta.md': fm({ types: 'project', status: 'done', due: '2026-04-01' }),
  'Tasks/One.md': fm({ types: 'task', status: 'open' }),
  'Meetings/Kickoff.md': fm({ types: 'meeting', 'people involved': '"[[Avery]]"' }),
  'People/Avery.md': fm({ types: 'person' }),
  'Loose.md': '# Loose\n',
};

/** Every line of a screen fits an 80-column terminal inside the note's frame. */
function expectFits(screen: string) {
  for (const line of screen.split('\n')) expect(line.length, line).toBeLessThanOrEqual(72);
}

/** The plan without the flag that says where the journal kind was settled. */
function comparable(plan: StructurePlan) {
  const { journalSettled: _settled, ...rest } = plan;
  return rest;
}

describe('the notes step\'s map screen', () => {
  it('opens with the map detected from the notes, and Looks good takes it without a question', async () => {
    // The settings folder is shared with an existing one: its notes are Engine's, so the screen does not count them.
    const root = await makeTree({ ...TYPES_VAULT, 'Settings/Old.md': '# Old\n' });
    const { prompter, asked, notes, confirmed } = replayPrompter({ 'vault.path': [root], 'vault.settings_dir': ['Settings'] });

    const plan = await stages(prompter, root);

    // No question of the step was asked: only the vault step's.
    expect(asked.filter(id => id.startsWith('structure.') || id.startsWith('curator.'))).toEqual([]);
    expect(confirmed).toEqual([MAP_QUESTION.message]);
    // What Looks good takes is exactly what a headless run without structure answers plans.
    const headlessPlan = await stages(createScriptedPrompter({ version: 1, vault: { path: root, settings_dir: 'Settings' } }, () => {}), root);
    expect(comparable(plan)).toEqual(comparable(headlessPlan));
    expect(plan.journalSettled).toBe(true);
    expect(headlessPlan.journalSettled).toBe(false);
    expect(plan.fields).toEqual({ due: 'due', date: null, people: 'people involved', company: null, priority: null, scheduled: null });

    const screen = notes.find(note => note.title === 'What Vault found in your notes')?.message ?? '';
    expectFits(screen);
    expect(screen).toContain('Vault read your 6 notes without changing them.');
    expect(screen).toContain('What kind a note is\n  The "types" line at the top of each note, such as types: ');
    expect(screen).toContain('Kinds found (4), with their number of notes\n  project (2), meeting (1), person (1), task (1).\n  1 note with no kind stays as it is.');
    // The note left without a kind is not the end of it (#650).
    expect(screen.replace(/\s+/g, ' ')).toContain('1 note with no kind stays as it is. Once Vault is installed, an AI assistant connected to it can sort it with you; the last screen says how.');
    expect(screen).toContain('  projects:  project (2 notes)\n             Curator can keep a wiki for each active project.');
    expect(screen).toContain('  companies: none\n             Off: project wikis list no companies.');
    expect(screen).toContain('Status of projects: the "status" line\n  still active: open; done: done; blocked: none; not started: none;\n  dropped: none');
    expect(screen).toContain('Status of tasks: the "status" line\n  still open: open;');
    expect(screen).toContain('  due date of a task:        due\n');
    expect(screen).toContain('  company a note is about:   none (project wikis list no companies\n');
    expect(screen).toContain('Daily notes: none. Change it later in Settings/Vault.md (dailyNoteType).');
    expect(screen).toContain('Curator\'s journal, if you install Curator: note, a new kind Curator');
    expect(screen).toContain('Folders (chosen in the last step)\n  settings notes: Settings/   wiki pages: Wikis/\n  topic notes, if you install Curator: Topics/');
    expect(screen).toContain('Nothing in your notes changes until you approve the plan at the end.');
  });

  it('opens the questions under Adjust, then shows the map again to confirm', async () => {
    const root = await makeTree(TYPES_VAULT);
    const { prompter, asked, notes, confirmed } = replayPrompter({
      'vault.path': [root],
      // project, task: a starter kind named action, meeting, person, company: none
      'structure.roles': ['project', '\u0000new', 'action', 'meeting', 'person', '\u0000none'],
      // due date: none; the rest as found
      'structure.fields': ['\u0000none', '\u0000none', 'people involved', '\u0000none', '\u0000none', '\u0000none'],
      'curator.journal_type': ['\u0000other', 'log'],
    }, [ADJUST, false, true, true, true, false, true]);

    const plan = await stages(prompter, root);

    expect(confirmed).toEqual([
      MAP_QUESTION.message,
      'Keep these?', // the kinds: Change
      'Keep these?', // the status lines: Keep
      'Keep these meanings for the other project statuses?',
      'Keep these meanings for the other task statuses?',
      'Keep these?', // the other lines: Change
      MAP_QUESTION.message,
    ]);
    expect(asked).toEqual(expect.arrayContaining(['structure.source', 'structure.roles', 'structure.fields', 'curator.journal_type']));
    expect(plan.roles).toEqual({ project: 'project', task: 'action', meeting: 'meeting', person: 'person', company: null });
    // The new kind uses the status and due lines the notes already have.
    expect(plan.starterTypes).toEqual([{ name: 'action', role: 'task', claims: ['status', 'due', 'project'] }]);
    expect(plan.fields).toEqual({ due: null, date: null, people: 'people involved', company: null, priority: null, scheduled: null });
    expect(plan.journalType).toBe('log');
    const again = notes.find(note => note.title === 'Your notes, as you set them')?.message ?? '';
    expectFits(again);
    expect(again).toContain('  tasks:     action (a new kind; Vault creates it, with no notes yet)');
    expect(again).toContain('  due date of a task:        none (wikis show no due dates)');
    expect(again).toContain('Curator\'s journal, if you install Curator: log, a new kind Curator');
  });

  it('adds a starter kind only when asked, under the name the user types', async () => {
    const root = await makeTree({ 'Note.md': '# Note\n' });
    const names: Array<{ placeholder?: string; defaultValue?: string }> = [];
    const { prompter } = replayPrompter({
      'vault.path': [root],
      'structure.roles': ['\u0000new', 'initiative', '\u0000none', '\u0000none', '\u0000none', '\u0000none'],
    }, [ADJUST, false]);
    const text = prompter.text.bind(prompter);
    prompter.text = async question => {
      if (question.id === 'structure.roles') names.push({ placeholder: question.placeholder, defaultValue: question.defaultValue });
      return text(question);
    };

    const plan = await stages(prompter, root);

    // The kind's name is suggested, never taken on Enter.
    expect(names).toEqual([{ placeholder: 'project', defaultValue: undefined }]);
    expect(plan.roles.project).toBe('initiative');
    expect(plan.starterTypes.map(type => type.name)).toEqual(['initiative']);
    expect(plan.status.project).toMatchObject({ field: 'status', starter: true });
  });

  it('asks only which name kinds that differ by case share, then shows the map', async () => {
    const root = await makeTree({ 'A.md': fm({ types: 'Meeting' }), 'B.md': fm({ types: 'meeting' }) });
    const { prompter, asked, notes } = replayPrompter({ 'vault.path': [root], 'structure.type_renames': ['Meeting'] });

    const plan = await stages(prompter, root);

    expect(asked.filter(id => id.startsWith('structure.'))).toEqual(['structure.type_renames']);
    expect(plan.roles.meeting).toBe('Meeting');
    expect(notes.find(note => note.title === 'What Vault found in your notes')?.message).toContain('  meetings:  Meeting (2 notes)');
  });

  it('asks how notes are typed when the Analyzer refuses the detected type field', async () => {
    const root = await makeTree({ 'Drafts/A.md': fm({ type: '_draft' }), 'Drafts/B.md': fm({ type: '_draft' }) });
    const { prompter, asked, rejections, notes } = replayPrompter({ 'vault.path': [root], 'structure.source': ['folders'] });

    const plan = await stages(prompter, root);

    expect(rejections).toEqual(['The "type" line holds no value Vault can use as a kind.']);
    // Only the refused question and how notes are typed are asked; the folders take their defaults.
    expect(asked.filter(id => id.startsWith('structure.'))).toEqual(['structure.source']);
    expect(plan.spec.folder_rules).toEqual([{ directory: 'Drafts', type: 'draft' }]);
    expect(notes.find(note => note.title === 'What Vault found in your notes')?.message)
      .toContain('What kind a note is\n  The folder a note is in: Drafts/ → draft.');
  });

  it('shows none everywhere, with what each none turns off, for notes without kinds', async () => {
    const root = await makeTree({ 'Note.md': '# Note\n', 'Other.md': '# Other\n' });
    const { prompter, notes } = replayPrompter({ 'vault.path': [root] });

    const plan = await stages(prompter, root);

    expect(plan.roles).toEqual({ project: null, task: null, meeting: null, person: null, company: null });
    expect(plan.fields).toEqual({ due: null, date: null, people: null, company: null, priority: null, scheduled: null });
    expect(plan.starterTypes).toEqual([]);
    const screen = notes.find(note => note.title === 'What Vault found in your notes')?.message ?? '';
    expectFits(screen);
    expect(screen).toContain('What kind a note is\n  Not set: your notes stay as they are, without kinds.');
    expect(screen).toContain('Kinds found: none, so no note gets a kind.');
    expect(screen.replace(/\s+/g, ' ')).toContain('no note gets a kind. Once Vault is installed, an AI assistant connected to it can sort them with you; the last screen says how.');
    expect(screen).toContain('  projects:  none\n             Off: Curator keeps no project wikis, and nothing is filed\n             under a project.');
    expect(screen).not.toContain('Status of');
    for (const words of ['wikis show no due dates', 'Vault reads no priority', 'Vault reads no scheduled date']) expect(screen).toContain(words);
  });

  it('stays readable for a vault with many kinds', async () => {
    const files: Record<string, string> = {};
    for (let index = 1; index <= 20; index++) {
      const kind = `collection of things number ${String(index).padStart(2, '0')}`;
      for (let note = 0; note < (index % 3) + 1; note++) files[`Kinds/${index}-${note}.md`] = fm({ types: `"${kind}"` });
    }
    const root = await makeTree(files);
    const { prompter, notes } = replayPrompter({ 'vault.path': [root] });

    await stages(prompter, root);

    const screen = notes.find(note => note.title === 'What Vault found in your notes')?.message ?? '';
    expectFits(screen);
    expect(screen).toContain('Kinds found (20), with their number of notes');
    expect(screen).toContain(', and 8 more.');
    expect(screen.split('\n').length).toBeLessThan(60);
  });
});

describe('detectStructure', () => {
  it('settles the map with no prompt when nothing needs an answer', async () => {
    const root = await makeTree(TYPES_VAULT);
    const { prompter, asked, confirmed } = replayPrompter({ 'vault.path': [root] });
    const vault = await runVaultStage({ host: realFilesystemHost(), prompter, analyzer, cwd: '/', dataDir: '/srv/tester/vault-suite-data', repoRoot: REPO_ROOT });

    const plan = await detectStructure({ prompter, analyzer, vault });

    expect(asked.filter(id => id !== 'vault.path' && !id.startsWith('vault.'))).toEqual([]);
    expect(confirmed).toEqual([]);
    expect(plan.roles).toMatchObject({ project: 'project', task: 'task', meeting: 'meeting', person: 'person', company: null });
  });
});

describe('the map\'s other fields, headless', () => {
  it('takes the fields the answers name, none included, and refuses one the notes lack', async () => {
    const { plan } = await headless(TYPES_VAULT, { fields: { due: null, priority: 'status' } });

    expect(plan.fields).toEqual({ due: null, date: null, people: 'people involved', company: null, priority: 'status', scheduled: null });
    await expect(headless(TYPES_VAULT, { fields: { company: 'organisation' } }))
      .rejects.toThrow(/structure\.fields: company: organisation is not a field your notes have or a new type adds/);
  });

  it('counts the fields a new type adds as present', async () => {
    const { plan } = await headless({ 'Note.md': '# Note\n' }, { source: 'none', roles: { meeting: { starter: 'meeting' } } });

    expect(plan.fields).toEqual({ due: null, date: 'date', people: 'people involved', company: null, priority: null, scheduled: null });
  });
});

describe('detectRole', () => {
  it('follows explicit renames and never takes another role\'s renamed type', () => {
    expect(detectRole('project', ['initiative', 'project'], { project: 'initiative', task: 'project' })).toBe('initiative');
    expect(detectRole('task', ['initiative', 'project'], { project: 'initiative', task: 'project' })).toBe('project');
    expect(detectRole('project', ['project'], { project: null, task: 'project' })).toBeNull();
    // With no type of its name, a kind is none: nothing is planned in its place.
    expect(detectRole('project', ['call'], {})).toBeNull();
    expect(detectRole('meeting', ['call'], { meeting: 'call' })).toBe('call');
    expect(detectRole('meeting', ['call'], {})).toBeNull();
  });
});

describe('type names', () => {
  it.each([
    ['Meetings', 'meeting'],
    ['People', 'person'],
    ['Companies', 'company'],
    ['Inboxes', 'inbox'],
    ['Status', 'status'],
    ['Daily Notes', 'daily note'],
  ])('suggests %j for the folder %j', (folder, expected) => {
    expect(suggestTypeName(folder)).toBe(expected);
  });

  it.each([
    ['meeting', true],
    ['daily note', true],
    ['', false],
    [' meeting', false],
    ['_fields', false],
    ['a/b', false],
    ['CON', false],
    ['[[meeting]]', false],
  ])('treats %j as a valid type name: %j', (name, valid) => {
    expect(isTypeName(name)).toBe(valid);
  });
});

describe('tags as kinds (#650)', () => {
  /** An export from one app: nothing typed, the kind in a #tag, all in one folder. */
  const TAGGED = {
    'Export/Kickoff.md': '# Kickoff\n\nAgenda. #meeting\n',
    'Export/Review.md': '# Review\n\nNotes. #meeting/review #todo\n',
    'Export/Sync.md': '---\ntags:\n  - meeting\n---\n# Sync\n',
    'Export/Soup.md': '# Soup\n\nLentils. #recipe #todo\n',
    'Export/Bread.md': '# Bread\n\nFlour. #recipe\n',
    'Export/Loose.md': '# Loose\n\nNothing to say. #todo\n',
  };

  it('types notes by the tags that name usual kinds, with no answer given', async () => {
    const root = await makeTree(TAGGED);
    const prompter = createScriptedPrompter({ version: 1, vault: { path: root }, structure: { source: 'none' } }, () => {});
    const vault = await runVaultStage({ host: realFilesystemHost(), prompter, analyzer, cwd: '/', dataDir: '/srv/tester/vault-suite-data', repoRoot: REPO_ROOT });
    const plan = await runStructureStage({ prompter, analyzer, vault });

    expect(plan.source).toBe('tags');
    expect(plan.spec.tag_rules).toEqual([{ tag: 'meeting', type: 'meeting' }, { tag: 'recipe', type: 'recipe' }]);
    expect(plan.analysis?.proposal.schemas.map(schema => schema.name)).toEqual(['meeting', 'recipe']);
    const files = Object.fromEntries(plan.analysis!.proposal.type_assignment.files.map(file => [file.path, file.types]));
    expect(files).toEqual({
      'Export/Bread.md': ['recipe'], 'Export/Kickoff.md': ['meeting'], 'Export/Loose.md': [],
      'Export/Review.md': ['meeting'], 'Export/Soup.md': ['recipe'], 'Export/Sync.md': ['meeting'],
    });
    const models = await runModelsStage({ prompter, keys: [], curatorInstalled: false });
    const review = buildReview({ dataDir: '/data', services: TEST_SERVICES, vault, structure: plan, keys: [], models, curator: null, backup: null });
    const report = buildPlanReport({
      repoRoot: '/repo', dataDir: '/data', services: TEST_SERVICES, preflight: [], vault, structure: plan, keys: [], models, curator: null,
      backup: null, review, now: new Date(0),
    });
    expect(renderStructure(report.structure!)).toContain('Typed by #tags in the notes');
    expect(report.structure?.analyzer_spec.tag_rules).toEqual(plan.spec.tag_rules);
  });

  it('takes the tags the answers name, none included', async () => {
    const named = await headless(TAGGED, { source: 'none', tag_rules: [{ tag: 'todo', type: 'task' }] });
    expect(named.plan.analysis?.proposal.schemas.map(schema => schema.name)).toEqual(['task']);

    const none = await headless(TAGGED, { source: 'none', tag_rules: [] });
    expect(none.plan.source).toBe('none');
    expect(none.plan.analysis).toBeNull();
    expect(none.plan.spec.tag_rules).toBeUndefined();

    await expect(headless(TAGGED, { source: 'none', tag_rules: [{ tag: 'meeting', type: 'bad/name' }] }))
      .rejects.toThrow(/structure\.tag_rules/);
  });

  it('beats the folder, and leaves notes the type line types alone', async () => {
    const { plan } = await headless({
      ...TAGGED,
      'Export/Typed.md': `${fm({ type: 'Meeting' })}A typed one. #recipe\n`,
      'Export/Typed2.md': fm({ type: 'Meeting' }),
    }, { source: 'both', type_field: 'type', folder_rules: [{ directory: 'Export', type: 'note' }] });

    const files = Object.fromEntries(plan.analysis!.proposal.type_assignment.files.map(file => [file.path, file.types]));
    expect(files['Export/Typed.md']).toEqual(['Meeting']);
    // The tag names the kind the type line already has, whatever its case.
    expect(files['Export/Kickoff.md']).toEqual(['Meeting']);
    expect(files['Export/Soup.md']).toEqual(['recipe']);
    // No ticked tag: the folder.
    expect(files['Export/Loose.md']).toEqual(['note']);
    expect(plan.spec.tag_rules).toEqual([{ tag: 'meeting', type: 'Meeting' }, { tag: 'recipe', type: 'recipe' }]);
  });

  it('is taken by quick setup with no question', async () => {
    const root = await makeTree(TAGGED);
    const { prompter, asked } = replayPrompter({ 'vault.path': [root] });
    const vault = await runVaultStage({ host: realFilesystemHost(), prompter, analyzer, cwd: '/', dataDir: '/srv/tester/vault-suite-data', repoRoot: REPO_ROOT });

    const plan = await detectStructure({ prompter, analyzer, vault }, { sortByFolders: false });

    expect(asked).not.toContain('structure.tag_rules');
    expect(plan.source).toBe('tags');
    expect(plan.analysis?.proposal.schemas.map(schema => schema.name)).toEqual(['meeting', 'recipe']);
  });

  it('asks with the usual kinds ticked, and renames a tag\'s kind like any other', async () => {
    const root = await makeTree(TAGGED);
    const { prompter } = replayPrompter({
      'vault.path': [root],
      'structure.source': ['none'],
      'structure.tag_rules': [['meeting', 'todo']],
      'structure.type_renames': [['todo'], 'task'],
    }, [ADJUST]);

    const plan = await stages(prompter, root);

    expect(plan.spec.tag_rules).toEqual([{ tag: 'meeting', type: 'meeting' }, { tag: 'todo', type: 'task' }]);
    expect(plan.analysis?.proposal.schemas.map(schema => schema.name)).toEqual(['meeting', 'task']);
  });
});

describe('the messy sample (#650)', () => {
  it('is sorted by its tags at quick setup, with the rest left for the organizing tools', async () => {
    const { cp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { MESSY_SAMPLE } = await import('../src/vault.js');
    const parent = await makeTree({ 'Keep.md': '# Keep\n' });
    const root = join(parent, 'Messy');
    await cp(join(REPO_ROOT, ...MESSY_SAMPLE), root, { recursive: true });
    const { prompter, asked } = replayPrompter({ 'vault.path': [root] });
    const vault = await runVaultStage({ host: realFilesystemHost(), prompter, analyzer, cwd: '/', dataDir: '/srv/tester/vault-suite-data', repoRoot: REPO_ROOT });

    const plan = await detectStructure({ prompter, analyzer, vault }, { sortByFolders: false });

    expect(asked.filter(id => id.startsWith('structure.'))).toEqual([]);
    expect(plan.source).toBe('tags');
    expect(plan.analysis?.proposal.schemas.map(schema => schema.name).sort()).toEqual(['book', 'journal', 'meeting', 'person', 'recipe']);
    // #imported, on every Bear note, names no kind.
    expect(plan.spec.tag_rules?.map(rule => rule.tag)).not.toContain('imported');
    const coverage = plan.analysis!.coverage;
    expect(coverage.typed_by_tag_rule).toBeGreaterThan(50);
    expect(coverage.untyped_files).toBeGreaterThan(50);
  });
});
