import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdoptError, replacedTypes, runAdoptStage, typeChanges, type AdoptStageDeps } from '../src/adopt.js';
import { AnalyzerError, type AnalyzeReport, type AnalyzeSpec, type AnalyzerRunner } from '../src/analyzer.js';
import { createScriptedPrompter } from '../src/prompter.js';
import type { StructureSummary } from '../src/report.js';
import { loadState, saveState, type InstallState } from '../src/state.js';
import { EngineToolError } from '../src/engine-client.js';
import { fakeEngineTools, makeTree, removeTrees } from './helpers.js';

afterEach(removeTrees);

const FINGERPRINT = 'f'.repeat(64);

type Field = AnalyzeReport['proposal']['global_fields'][number];

function field(name: string, field_type: Field['field_type'], extra: Partial<Field> = {}): Field {
  return { name, field_type, evidence: { observations: 1, distinct_values: 1, sample_values: [], samples_truncated: false }, ...extra };
}

/** An Analyzer report with just what adoption reads. */
function report(input: {
  fingerprint?: string;
  types: Record<string, string[]>;
  fields?: Field[];
  files: Record<string, string[]>;
  collisions?: string[][];
}): AnalyzeReport {
  const files = Object.entries(input.files).map(([path, types]) => ({ path, types }));
  return {
    format_version: 2,
    analyzer_version: '2.0.0',
    source: { canonical_root: '/notes', confirmed_type_field: 'types', source_fingerprint: input.fingerprint ?? FINGERPRINT, exclusions: [] },
    inventory: { total_files: files.length, markdown_files: files.length, non_markdown_by_extension: {}, excluded_entries: { directories: 0, symlinks: 0 } },
    coverage: {
      files_with_frontmatter: files.length,
      typed_files: files.filter(file => file.types.length > 0).length,
      untyped_files: files.filter(file => file.types.length === 0).length,
      malformed_frontmatter_files: 0,
      typed_by_type_field: 0,
      typed_by_folder_rule: 0,
      typed_by_tag_rule: 0,
    },
    proposal: {
      type_field_mapping: null,
      type_assignment: { type_field_values: [], folder_rules: [], tag_rules: [], files },
      global_fields: input.fields ?? [],
      schemas: Object.entries(input.types).map(([name, claims]) => ({
        name,
        field_claims: claims.map(claim => ({ field: claim })),
        evidence: { typed_documents: files.filter(file => file.types.includes(name)).length, single_type_documents: 0 },
      })),
    },
    needs_review: {
      ambiguous_fields: [],
      ambiguous_claims: [],
      type_name_collisions: (input.collisions ?? []).map(names => ({ names, documents: 1 })),
    },
    tags: { candidates: [], truncated: false },
    issues: [],
  };
}

/** A `types`-keyed vault: Meeting merges into meeting, misc is dropped, status is a vault field. */
const SPEC: AnalyzeSpec = { type_field: 'types', folder_rules: [], type_renames: { Meeting: 'meeting', misc: null }, exclude: ['Settings'] };
const APPROVED = report({
  types: { meeting: ['status'], project: ['status'] },
  fields: [field('status', 'enum', { enum_values: ['open', 'done'] })],
  files: { 'A.md': ['meeting'], 'B.md': ['meeting'], 'C.md': [], 'P.md': ['project'], 'Q.md': ['project'] },
});
const STRUCTURE = {
  source: 'field',
  analyzer_spec: SPEC,
  source_fingerprint: FINGERPRINT,
  typed_notes: 4,
  untyped_notes: 1,
  types: [
    { name: 'meeting', from: 'vault', role: 'meeting', notes: 2, default_directory: null, fields: ['status'] },
    { name: 'project', from: 'vault', role: 'project', notes: 2, default_directory: 'Projects', fields: ['status'] },
    { name: 'note', from: 'starter', role: 'note', notes: 0, default_directory: null, fields: ['project'] },
  ],
  fields_from_vault: ['status'],
  starter_fields: [{ name: 'project', field_type: 'list', list_item_type: 'reference', reference_target: 'project' }],
  roles: { project: 'project', task: null, meeting: 'meeting', person: null, company: null },
  active_statuses: ['open'],
  status_groups: { done: [], blocked: [], backlog: [], ignored: [] },
  unmanaged_fields: [],
  remove_type_field: false,
  warnings: [],
} as StructureSummary;
/** Engine indexed the original `types` values. */
const INDEXED = [
  { file_path: 'A.md', types: ['meeting'] },
  { file_path: 'B.md', types: ['Meeting'] },
  { file_path: 'C.md', types: ['misc'] },
  { file_path: 'P.md', types: [] },
  { file_path: 'Q.md', types: ['project', '_legacy'] },
  { file_path: 'Settings/Engine.md', types: ['misc'] },
];

async function setup(structure: StructureSummary = STRUCTURE) {
  const dataDir = await makeTree({});
  await mkdir(join(dataDir, 'installer'), { recursive: true });
  const state = {
    format: 'vault-installer-state',
    version: 1,
    approved_at: '2026-10-26T12:00:00.000Z',
    plan: {
      format: 'vault-installer-plan',
      version: 1,
      data_dir: dataDir,
      repo_root: '/repo',
      services: { user: 'tester', node_path: '/opt/node', engine_port: 3334, curator_port: 3335 },
      vault: {
        path: '/notes',
        settings_dir: 'Settings',
        exclusions: [],
        analyzer_exclusions: ['Settings'],
        inventory: { total_files: 0, markdown_files: 0, non_markdown_by_extension: {}, excluded_entries: { directories: 0, symlinks: 0 } },
      },
      models: { preset: 'balanced', vision_provider: 'off', roles: [], models: [] },
      structure,
      curator: null,
      backup: { mode: 'skip', files: 0, bytes: 0 },
      review: {
        engine_database: '/notes/.vault-engine/vault.db',
        env_keys: { engine_first_boot: [], engine_after_extraction_off: [], curator: [] },
        extraction_seeded_off: false,
        engine_models_dir: null,
        settings: [],
      },
    },
    stages: {},
  } as unknown as InstallState;
  const path = join(dataDir, 'installer', 'state.json');
  await saveState(path, state);
  return { state, path };
}

function deps(engine: ReturnType<typeof fakeEngineTools>, analysis: AnalyzeReport | Error = APPROVED, batchSize?: number) {
  const lines: string[] = [];
  const analyzed: AnalyzeSpec[] = [];
  const analyzer: AnalyzerRunner = {
    discover: async () => { throw new Error('not used'); },
    analyze: async (_root, spec) => {
      analyzed.push(spec);
      if (analysis instanceof Error) throw analysis;
      return analysis;
    },
  };
  const adoptDeps: AdoptStageDeps = {
    host: { env: () => undefined, homeDir: '/srv/tester' },
    prompter: createScriptedPrompter({ version: 1, vault: { path: '/notes' } }, line => lines.push(line)),
    analyzer,
    engine: async () => engine.call,
    now: () => new Date('2026-10-26T13:00:00Z'),
    ...(batchSize ? { batchSize } : {}),
  };
  return { deps: adoptDeps, lines, analyzed };
}

const typesOf = (engine: ReturnType<typeof fakeEngineTools>) => Object.fromEntries(engine.notes.map(note => [note.file_path, note.types]));
const writes = (engine: ReturnType<typeof fakeEngineTools>) => engine.calls.filter(call => call.tool === 'update-node' && call.args.dry_run === false);

describe('runAdoptStage', () => {
  it('creates the approved fields and types, then gives each note its final types', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);
    const { deps: adoptDeps, analyzed, lines } = deps(engine);

    await runAdoptStage(adoptDeps, state, path);

    expect(analyzed).toEqual([SPEC]);
    expect([...engine.fields.values()]).toEqual([
      { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] },
      { name: 'project', field_type: 'list', list_item_type: 'reference', reference_target: 'project' },
    ]);
    expect(Object.fromEntries(engine.schemas)).toEqual({
      meeting: { default_directory: null, claims: ['status'] },
      project: { default_directory: 'Projects', claims: ['status'] },
      note: { default_directory: null, claims: ['project'] },
    });
    // Merged and dropped values go; a value the plan does not replace (_legacy) stays,
    // and Engine's own notes are left alone.
    expect(typesOf(engine)).toEqual({
      'A.md': ['meeting'],
      'B.md': ['meeting'],
      'C.md': [],
      'P.md': ['project'],
      'Q.md': ['project', '_legacy'],
      'Settings/Engine.md': ['misc'],
    });
    const saved = await loadState(path);
    expect(saved?.stages.adopt).toEqual({
      started_at: '2026-10-26T13:00:00.000Z',
      completed_at: '2026-10-26T13:00:00.000Z',
      operations: ['op1', 'op2', 'op3', 'op4', 'op5', 'op6', 'op7', 'op8'],
      targets: {
        fields: [{ name: 'status', field_type: 'enum', enum_values: ['open', 'done'] }],
        types: { 'A.md': ['meeting'], 'B.md': ['meeting'], 'C.md': [], 'P.md': ['project'], 'Q.md': ['project'] },
      },
    });
    expect(lines.join('\n')).not.toContain('changed after you approved');
  });

  it('only mentions a change that leaves the types and fields as approved', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);
    const { deps: adoptDeps, lines } = deps(engine, { ...APPROVED, source: { ...APPROVED.source, source_fingerprint: 'e'.repeat(64) } });

    await runAdoptStage(adoptDeps, state, path);

    expect(lines.filter(line => line.includes('changed after you approved'))).toEqual([
      'Some notes changed after you approved the plan (Engine rewrites links as it starts, too). Adoption uses what they say now, but creates only the approved types and fields.',
    ]);
    expect(typesOf(engine)['B.md']).toEqual(['meeting']);
  });

  it('repeats nothing on a rerun', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);
    await runAdoptStage(deps(engine).deps, state, path);
    delete state.stages.adopt;
    engine.calls.length = 0;

    await runAdoptStage(deps(engine).deps, state, path);

    expect(engine.calls.map(call => call.tool)).not.toContain('create-global-field');
    expect(engine.calls.map(call => call.tool)).not.toContain('create-schema');
    expect(writes(engine)).toEqual([]);
    expect((await loadState(path))?.stages.adopt?.operations).toEqual([]);
  });

  it('checks every batch before writing any, and changes nothing when Engine would refuse a note', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED, ['P.md']);

    const adoption = runAdoptStage(deps(engine, APPROVED, 1).deps, state, path);

    await expect(adoption).rejects.toThrow(AdoptError);
    await expect(adoption).rejects.toThrow(/Engine would refuse 1 note because their fields do not fit their new types, including P\.md/);
    expect(writes(engine)).toEqual([]);
    expect(state.stages.adopt?.completed_at).toBeNull();
  });

  it('applies notes in batches, dry-running all of them first', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);

    await runAdoptStage(deps(engine, APPROVED, 1).deps, state, path);

    const updates = engine.calls.filter(call => call.tool === 'update-node').map(call => call.args.dry_run);
    // B, C, and P change; A has its final types and Q keeps a value the plan does not replace.
    expect(updates).toEqual([true, true, true, false, false, false]);
    expect(writes(engine).every(call => (call.args.query as { node_ids: string[] }).node_ids.length === 1)).toBe(true);
  });

  it('stops on an existing field that differs from the plan', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);
    engine.fields.set('status', { name: 'status', field_type: 'string' });

    await expect(runAdoptStage(deps(engine).deps, state, path))
      .rejects.toThrow('Engine already has a global field status that differs from the plan (string; the plan needs enum, values open, done).');
    expect(engine.schemas.size).toBe(0);
  });

  it('stops on an existing type that differs from the plan', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);
    engine.schemas.set('meeting', { default_directory: 'Calls', claims: [] });

    await expect(runAdoptStage(deps(engine).deps, state, path))
      .rejects.toThrow('Engine already has a type meeting that differs from the plan (folder Calls, fields none; the plan has folder none, fields status, none required or with a default).');
  });

  it('stops on an existing field that is required or has a default', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);
    engine.fields.set('status', { name: 'status', field_type: 'enum', enum_values: ['open', 'done'], required: true, default_value: 'done' });

    await expect(runAdoptStage(deps(engine).deps, state, path))
      .rejects.toThrow('Engine already has a global field status that differs from the plan (enum, values open, done, required, default "done"; the plan needs enum, values open, done).');
    expect(engine.schemas.size).toBe(0);
  });

  it('stops on an existing type whose field is required with a default', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);
    // Engine would fill status from the default in every note given the type.
    engine.schemas.set('meeting', { default_directory: null, claims: ['status'], overrides: { status: { required: true, default_value: 'done' } } });

    await expect(runAdoptStage(deps(engine).deps, state, path))
      .rejects.toThrow('Engine already has a type meeting that differs from the plan (folder none, fields status (required, default "done"); the plan has folder none, fields status, none required or with a default).');
    expect(writes(engine)).toEqual([]);
  });

  it('reports notes Engine could not update after applying the rest', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);
    // Engine refuses at write time what its dry run accepted, as when a note changes in between.
    const call = engine.call;
    engine.call = async (tool, args, options) => {
      if (tool === 'update-node' && args?.dry_run === false && (args.query as { node_ids: string[] }).node_ids.includes('n2')) {
        return { updated: 0, errors: [{ file_path: 'B.md', error: 'Validation failed' }], operation_id: 'op-b' } as never;
      }
      return call(tool, args, options);
    };

    await expect(runAdoptStage(deps(engine, APPROVED, 1).deps, state, path))
      .rejects.toThrow('Engine could not update 1 note: B.md (Validation failed). The other notes are done; run the install again to retry.');
    expect(typesOf(engine)['P.md']).toEqual(['project']);
    expect(state.stages.adopt?.operations).toContain('op-b');
  });

  it('finishes a partial adoption with the types decided before its first write', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);
    const call = engine.call;
    engine.call = async (tool, args, options) => {
      if (tool === 'update-node' && args?.dry_run === false && (args.query as { node_ids: string[] }).node_ids.includes('n2')) {
        return { updated: 0, errors: [{ file_path: 'B.md', error: 'Validation failed' }] } as never;
      }
      return call(tool, args, options);
    };
    await expect(runAdoptStage(deps(engine, APPROVED, 1).deps, state, path)).rejects.toThrow(AdoptError);
    engine.call = call;

    // The notes now hold adoption's writes. Read again, they could be refused (a `types`
    // key beside another type field) or renamed twice; the rerun does not read them.
    const rerun = deps(engine, new AnalyzerError('TYPE_FIELD_TARGET_COLLISION', 'types already set'));
    await runAdoptStage(rerun.deps, (await loadState(path)) as InstallState, path);

    expect(rerun.analyzed).toEqual([]);
    expect(typesOf(engine)).toMatchObject({ 'A.md': ['meeting'], 'B.md': ['meeting'], 'C.md': [], 'P.md': ['project'] });
    expect((await loadState(path))?.stages.adopt?.completed_at).not.toBeNull();
  });

  it('replaces type values Engine indexed with the spaces or link the Analyzer ignored', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools([
      { file_path: 'A.md', types: [' meeting '] },
      { file_path: 'B.md', types: [' Meeting '] },
      { file_path: 'C.md', types: [' misc '] },
      { file_path: 'D.md', types: [' [[Meeting]] ', ' '] },
      // Engine indexes `'[[Meeting|Meetings]]'` without its brackets but with its alias.
      { file_path: 'E.md', types: ['Meeting|Meetings'] },
      { file_path: 'F.md', types: ['Other|Others'] },
    ]);
    const analysis = report({ types: { meeting: ['status'], project: ['status'] }, fields: APPROVED.proposal.global_fields,
      files: { 'A.md': ['meeting'], 'B.md': ['meeting'], 'C.md': [], 'D.md': ['meeting'], 'E.md': ['meeting'], 'F.md': [] } });

    await runAdoptStage(deps(engine, analysis).deps, state, path);

    expect(typesOf(engine)).toEqual({
      'A.md': ['meeting'],
      'B.md': ['meeting'],
      'C.md': [],
      'D.md': [' ', 'meeting'],
      'E.md': ['meeting'],
      'F.md': ['Other|Others'],
    });
  });

  it('leaves notes Vault Analyzer did not check as they are', async () => {
    const { state, path } = await setup();
    // N.md was added, or moved, after the Analyzer ran; it never had a final type decided.
    const engine = fakeEngineTools([...INDEXED, { file_path: 'N.md', types: ['Meeting'] }]);
    const { deps: adoptDeps, lines } = deps(engine);

    await runAdoptStage(adoptDeps, state, path);

    expect(typesOf(engine)['N.md']).toEqual(['Meeting']);
    expect(typesOf(engine)['B.md']).toEqual(['meeting']);
    expect(lines).toContainEqual(expect.stringContaining('1 note in Engine was added or moved after Vault Analyzer checked the notes, so adoption leaves it as it is: N.md'));
  });
});

describe('fields typed by choice', () => {
  // status was chosen; the types claim it only after they exist.
  const CHOSEN = { ...STRUCTURE, analyzer_spec: { ...SPEC, field_types: { status: { field_type: 'string' } } } } as StructureSummary;
  const schemaCalls = (engine: ReturnType<typeof fakeEngineTools>) => engine.calls
    .filter(call => call.tool === 'create-schema' || call.tool === 'update-schema')
    .map(call => [call.tool, call.args.name, call.args.field_claims ?? call.args.add_field_claims]);

  it('claims them with update-schema, so notes that already have the type are converted', async () => {
    const { state, path } = await setup(CHOSEN);
    const engine = fakeEngineTools(INDEXED);

    await runAdoptStage(deps(engine).deps, state, path);

    expect(schemaCalls(engine)).toEqual([
      ['create-schema', 'meeting', []],
      ['update-schema', 'meeting', [{ field: 'status' }]],
      ['create-schema', 'project', []],
      ['update-schema', 'project', [{ field: 'status' }]],
      ['create-schema', 'note', [{ field: 'project' }]],
    ]);
    expect(engine.schemas.get('project')?.claims).toEqual(['status']);
    expect(state.stages.adopt?.operations).toHaveLength(10);
  });

  it('claims them on a rerun that stopped after creating the type', async () => {
    const { state, path } = await setup(CHOSEN);
    const engine = fakeEngineTools(INDEXED);
    engine.fields.set('status', { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] });
    engine.schemas.set('meeting', { default_directory: null, claims: [] });

    await runAdoptStage(deps(engine).deps, state, path);

    expect(schemaCalls(engine).filter(([, name]) => name === 'meeting')).toEqual([['update-schema', 'meeting', [{ field: 'status' }]]]);
    expect(engine.schemas.get('meeting')?.claims).toEqual(['status']);
  });

  it('stops, with nothing changed, when Engine cannot convert a value', async () => {
    const { state, path } = await setup(CHOSEN);
    const engine = fakeEngineTools(INDEXED);
    const call = engine.call;
    engine.call = async (tool, args, options) => {
      if (tool === 'update-schema') throw new EngineToolError('VALIDATION_FAILED', 'Schema change rejected: 1 validation group(s).');
      return call(tool, args, options);
    };

    await expect(runAdoptStage(deps(engine).deps, state, path)).rejects.toThrow(
      'Engine could not convert every status value on your meeting notes to the type you chose, so it changed nothing: Schema change rejected: 1 validation group(s). Engine\'s validate-node shows each note\'s problem',
    );
    expect(writes(engine)).toEqual([]);
  });
});

describe('a vault keyed by its own type field (#445)', () => {
  /** A `kind`-keyed vault: kind is Engine's type key, so Engine indexed its values as types. */
  const OWN_KEY = {
    ...STRUCTURE,
    analyzer_spec: { ...SPEC, type_field: 'kind', type_key: 'kind' },
    // An answer from before the designation; with kind as the type key there is nothing to remove.
    remove_type_field: true,
  } as StructureSummary;
  const OWN_KEY_NOTES = [
    { file_path: 'A.md', types: ['meeting'], fields: { status: 'open' } },
    { file_path: 'B.md', types: ['Meeting'] },
    { file_path: 'C.md', types: ['misc'] },
    { file_path: 'P.md', types: ['project'] },
    { file_path: 'Q.md', types: [] },
  ];

  it('renames, merges and drops the values Engine indexed, and adds no second key', async () => {
    const { state, path } = await setup(OWN_KEY);
    const engine = fakeEngineTools(OWN_KEY_NOTES);
    const { deps: adoptDeps, analyzed, lines } = deps(engine);

    await runAdoptStage(adoptDeps, state, path);

    // The Analyzer reran with kind as the type key, as planned.
    expect(analyzed).toEqual([{ ...SPEC, type_field: 'kind', type_key: 'kind' }]);
    expect(typesOf(engine)).toEqual({ 'A.md': ['meeting'], 'B.md': ['meeting'], 'C.md': [], 'P.md': ['project'], 'Q.md': ['project'] });
    // Only type changes: no field is set or unset, and kind is never looked up as a field.
    expect(writes(engine).map(call => [call.args.add_types, call.args.remove_types, call.args.set_fields])).toEqual([
      [['meeting'], ['Meeting'], undefined],
      [undefined, ['misc'], undefined],
      [['project'], undefined, undefined],
    ]);
    expect(engine.calls.filter(call => call.tool === 'query-nodes' && call.args.fields !== undefined)).toEqual([]);
    expect(lines.join('\n')).not.toContain('field was removed');
  });

  it('survives a resume: the state file keeps the type key', async () => {
    const { path } = await setup(OWN_KEY);
    expect((await loadState(path))?.plan.structure?.analyzer_spec.type_key).toBe('kind');
  });
});

describe('removing the old type field (a plan saved before the type key was designated)', () => {
  /** A `kind`-keyed vault whose plan removes kind once notes have their types. */
  const KIND = { ...STRUCTURE, analyzer_spec: { ...SPEC, type_field: 'kind' }, remove_type_field: true } as StructureSummary;
  const KIND_NOTES = [
    { file_path: 'A.md', fields: { kind: 'meeting' } },
    { file_path: 'B.md', fields: { kind: 'Meeting' } },
    // A dropped value: C gets no type, so it keeps its kind.
    { file_path: 'C.md', fields: { kind: 'misc' } },
    // Typed in an earlier run, with its kind still there.
    { file_path: 'P.md', types: ['project'], fields: { kind: 'project' } },
    { file_path: 'Q.md', fields: {} },
  ];
  const fieldsOf = (engine: ReturnType<typeof fakeEngineTools>) => Object.fromEntries(engine.notes.map(note => [note.file_path, note.fields]));

  it('removes it from each note that gets a type, in the same call as its types', async () => {
    const { state, path } = await setup(KIND);
    const engine = fakeEngineTools(KIND_NOTES);
    const { deps: adoptDeps, lines } = deps(engine);

    await runAdoptStage(adoptDeps, state, path);

    expect(typesOf(engine)).toEqual({ 'A.md': ['meeting'], 'B.md': ['meeting'], 'C.md': [], 'P.md': ['project'], 'Q.md': ['project'] });
    expect(fieldsOf(engine)).toEqual({ 'A.md': {}, 'B.md': {}, 'C.md': { kind: 'misc' }, 'P.md': {}, 'Q.md': {} });
    expect(writes(engine).map(call => [call.args.add_types, call.args.set_fields])).toEqual([
      [['meeting'], { kind: null }],
      [undefined, { kind: null }],
      [['project'], undefined],
    ]);
    expect(lines).toContainEqual(expect.stringContaining('The kind field was removed from 3 notes.'));

    delete state.stages.adopt;
    engine.calls.length = 0;
    await runAdoptStage(deps(engine).deps, state, path);
    expect(writes(engine)).toEqual([]);
  });

  it('survives a resume: the state file keeps the field choices and the removal', async () => {
    const structure = { ...KIND, analyzer_spec: { ...KIND.analyzer_spec, field_types: { owners: { field_type: 'list', list_item_type: 'reference' } } } } as StructureSummary;
    const { path } = await setup(structure);

    const loaded = (await loadState(path))?.plan.structure;

    expect(loaded?.analyzer_spec.field_types).toEqual({ owners: { field_type: 'list', list_item_type: 'reference' } });
    expect(loaded?.remove_type_field).toBe(true);
  });

  it('keeps it for a plan saved before the choice existed', async () => {
    const { remove_type_field: _omitted, ...older } = KIND;
    const { path } = await setup(older as StructureSummary);

    expect((await loadState(path))?.plan.structure?.remove_type_field).toBe(false);
  });

  it('keeps it unless the plan removes it', async () => {
    const { state, path } = await setup({ ...KIND, remove_type_field: false } as StructureSummary);
    const engine = fakeEngineTools(KIND_NOTES);

    await runAdoptStage(deps(engine).deps, state, path);

    expect(typesOf(engine)['A.md']).toEqual(['meeting']);
    expect(fieldsOf(engine)['A.md']).toEqual({ kind: 'meeting' });
    expect(engine.calls.filter(call => call.tool === 'query-nodes' && call.args.fields !== undefined)).toEqual([]);
  });
});

describe('adoption after the notes changed', () => {
  it('creates only the approved types and fields, typing notes as the rules say now', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools([...INDEXED, { file_path: 'R.md', types: ['recipe'] }, { file_path: 'D.md', types: ['meeting'] }]);
    const changed = report({
      fingerprint: 'e'.repeat(64),
      types: { meeting: [], project: ['status'], recipe: ['serves'] },
      fields: [field('status', 'enum', { enum_values: ['open', 'done', 'blocked'] }), field('serves', 'number')],
      files: { 'A.md': ['meeting'], 'B.md': ['meeting'], 'C.md': [], 'D.md': ['meeting'], 'P.md': ['project'], 'Q.md': ['project'], 'R.md': ['recipe'] },
    });
    const { deps: adoptDeps, lines } = deps(engine, changed);

    await runAdoptStage(adoptDeps, state, path);

    const output = lines.join('\n');
    expect(output).toContain('Some notes changed after you approved the plan (Engine rewrites links as it starts, too). Adoption uses what they say now, but creates only the approved types and fields.');
    expect(output).toContain('Types not in the plan are not created, and their notes stay without them: recipe (1 note).');
    expect(output).toContain('New fields stay unmanaged: serves.');
    expect([...engine.schemas.keys()]).toEqual(['meeting', 'project', 'note']);
    expect(engine.fields.get('status')).toEqual({ name: 'status', field_type: 'enum', enum_values: ['open', 'done', 'blocked'] });
    expect(typesOf(engine)).toMatchObject({ 'D.md': ['meeting'], 'R.md': ['recipe'], 'B.md': ['meeting'] });
  });

  it('leaves a field that now needs review unmanaged and unclaimed', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);
    const changed = report({ ...{ fingerprint: 'e'.repeat(64) }, types: { meeting: [], project: [] }, files: { 'A.md': ['meeting'], 'P.md': ['project'] } });
    const { deps: adoptDeps, lines } = deps(engine, changed);

    await runAdoptStage(adoptDeps, state, path);

    expect(lines).toContainEqual(expect.stringContaining('Your notes now use status in shapes that need review, so it stays unmanaged and no type claims it.'));
    expect(engine.fields.has('status')).toBe(false);
    expect(engine.schemas.get('project')).toEqual({ default_directory: 'Projects', claims: [] });
  });

  it('stops when names now differ only by case', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);
    const changed = report({ fingerprint: 'e'.repeat(64), types: { project: [] }, files: { 'A.md': [] }, collisions: [['Project', 'project']] });

    await expect(runAdoptStage(deps(engine, changed).deps, state, path))
      .rejects.toThrow('Your notes now use type names that differ only by case or Unicode form (Project / project).');
    expect(engine.calls).toEqual([]);
  });

  it('explains an Analyzer refusal caused by the change, and passes other failures on', async () => {
    const { state, path } = await setup();
    const engine = fakeEngineTools(INDEXED);

    await expect(runAdoptStage(deps(engine, new AnalyzerError('NO_USABLE_TYPE_VALUES', 'Confirmed type field contains no usable type values')).deps, state, path))
      .rejects.toThrow('Vault Analyzer refused the notes as they are now: Confirmed type field contains no usable type values. They changed after you approved the plan');
    await expect(runAdoptStage(deps(engine, new AnalyzerError('ANALYZER_FAILED', 'Vault Analyzer could not run: boom')).deps, state, path))
      .rejects.toThrow(new AnalyzerError('ANALYZER_FAILED', 'Vault Analyzer could not run: boom'));
  });
});

describe('adoption without vault typing', () => {
  it('creates the starter types and runs no analysis', async () => {
    const structure = {
      ...STRUCTURE,
      source: 'none',
      analyzer_spec: { type_field: null, folder_rules: [], type_renames: {}, exclude: ['Settings'] },
      source_fingerprint: null,
      types: STRUCTURE.types.filter(type => type.from === 'starter'),
      fields_from_vault: [],
    } as StructureSummary;
    const { state, path } = await setup(structure);
    const engine = fakeEngineTools(INDEXED);
    const { deps: adoptDeps, analyzed, lines } = deps(engine);

    await runAdoptStage(adoptDeps, state, path);

    expect(analyzed).toEqual([]);
    expect([...engine.schemas.keys()]).toEqual(['note']);
    expect(writes(engine)).toEqual([]);
    expect(lines.join('\n')).not.toContain('added or moved');
  });

  it('still removes the values dropped when every vault type was dropped', async () => {
    // The structure stage saves no analysis when the drops leave no usable type, but keeps
    // the type field and the drops.
    const structure = {
      ...STRUCTURE,
      source: 'none',
      analyzer_spec: { ...SPEC, type_renames: { clipping: null, misc: null } },
      source_fingerprint: null,
      types: STRUCTURE.types.filter(type => type.from === 'starter'),
      fields_from_vault: [],
    } as StructureSummary;
    const { state, path } = await setup(structure);
    const engine = fakeEngineTools([{ file_path: 'X.md', types: ['clipping'] }, { file_path: 'Y.md', types: [' misc ', '_legacy'] }]);
    const { deps: adoptDeps, analyzed } = deps(engine);

    await runAdoptStage(adoptDeps, state, path);

    expect(analyzed).toEqual([]);
    expect(typesOf(engine)).toEqual({ 'X.md': [], 'Y.md': ['_legacy'] });
  });
});

describe('typeChanges', () => {
  it('groups notes by the exact types to add and remove', () => {
    const notes = [
      { id: '1', file_path: 'a.md', types: [] },
      { id: '2', file_path: 'b.md', types: [] },
      { id: '3', file_path: 'c.md', types: ['Meeting', 'x'] },
      { id: '4', file_path: 'd.md', types: ['meeting'] },
    ];
    // e.md is outside the assignment, so it is left alone.
    notes.push({ id: '5', file_path: 'e.md', types: ['Meeting'] });
    const assigned = new Map([['a.md', ['meeting']], ['b.md', ['meeting']], ['c.md', ['meeting']], ['d.md', ['meeting']]]);

    expect(typeChanges(notes, assigned, value => value === 'Meeting')).toEqual([
      { add: ['meeting'], remove: [], unset: [], notes: [notes[0], notes[1]] },
      { add: ['meeting'], remove: ['Meeting'], unset: [], notes: [notes[2]] },
    ]);
    // With the old type field removed, only notes that have it and get a type lose it.
    expect(typeChanges(notes, assigned, value => value === 'Meeting', { name: 'kind', ids: new Set(['1', '4', '5']) })).toEqual([
      { add: ['meeting'], remove: [], unset: ['kind'], notes: [notes[0]] },
      { add: ['meeting'], remove: [], unset: [], notes: [notes[1]] },
      { add: ['meeting'], remove: ['Meeting'], unset: [], notes: [notes[2]] },
      { add: [], remove: [], unset: ['kind'], notes: [notes[3]] },
    ]);
  });
});

describe('replacedTypes', () => {
  it('replaces renamed, dropped, and respelled values only when types is the type field', () => {
    const replaced = replacedTypes({ ...STRUCTURE, analyzer_spec: { ...SPEC, type_renames: { Meeting: 'meeting', misc: null, keep: 'keep' } } });
    const values = ['Meeting', ' Meeting ', '[[misc]]', ' meeting ', 'Meeting|Meetings', 'misc|x', 'meeting|M', 'meeting', 'keep', ' other ', 'other|x', '_legacy', ' '];

    expect(values.filter(value => replaced(value, ['meeting'])))
      .toEqual(['Meeting', ' Meeting ', '[[misc]]', ' meeting ', 'Meeting|Meetings', 'misc|x', 'meeting|M']);
    expect(replacedTypes({ ...STRUCTURE, analyzer_spec: { ...SPEC, type_field: 'kind' } })('Meeting', [])).toBe(false);
  });
});
