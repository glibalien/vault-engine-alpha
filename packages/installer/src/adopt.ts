import { AnalyzerError, typeKeyOf, type AnalyzeReport, type AnalyzerRunner } from './analyzer.js';
import { EngineToolError, type EngineCall } from './engine-client.js';
import type { Host } from './host.js';
import { installerCommand } from './layout.js';
import { withSpinner, type Prompter } from './prompter.js';
import type { StructureSummary } from './report.js';
import type { FieldDefinition } from './starter-types.js';
import { saveState, StateError, type AdoptTargets, type InstallState } from './state.js';
import { count } from './text.js';

/** Notes per `update-node` call; Engine asks for confirmation above 1,000. */
const BATCH_SIZE = 200;
/** `query-nodes` returns at most 200 notes per page. */
const PAGE_SIZE = 200;
/** Applying a batch rewrites each of its notes' files. */
const WRITE_TIMEOUT_MS = 10 * 60_000;
const MAX_LISTED = 10;
/** Analyzer refusals that mean the notes no longer fit the approved spec. */
const NOTES_REFUSALS = new Set([
  'TYPE_FIELD_NOT_FOUND', 'NO_USABLE_TYPE_VALUES', 'TYPE_FIELD_TARGET_COLLISION', 'TYPE_KEY_VALUE_UNSUPPORTED', 'NO_MARKDOWN_FILES',
]);

/** Adoption stopped; what it already did stays, and a rerun continues from there. */
export class AdoptError extends Error {
  override readonly name = 'AdoptError';
}

export interface AdoptStageDeps {
  /** Names the undo command the way this run was started. */
  host: Pick<Host, 'env' | 'homeDir'>;
  prompter: Prompter;
  analyzer: AnalyzerRunner;
  /** Engine calls with the installer token; called only when there is work to do. */
  engine: () => Promise<EngineCall>;
  now: () => Date;
  batchSize?: number;
}

interface IndexedNote {
  id: string;
  file_path: string;
  types: string[];
}

interface TypeChange {
  add: string[];
  remove: string[];
  /** Fields to remove: the old type field, when the plan removes it. */
  unset: string[];
  notes: IndexedNote[];
}

/** The old type field and the notes that still have it. */
interface OldTypeField {
  name: string;
  ids: ReadonlySet<string>;
}

/**
 * Stage 9. Apply the approved structure over Engine MCP: global fields, then schemas,
 * then each note's final types. The Analyzer runs again first; when the notes changed
 * since the plan was approved, adoption still creates only the approved types and fields,
 * and gives notes their types as the approved rules assign them now. That decision is
 * saved before the first write, and each step compares with what Engine already has, so
 * a rerun repeats nothing.
 */
export async function runAdoptStage(deps: AdoptStageDeps, state: InstallState, path: string): Promise<void> {
  if (state.stages.adopt?.completed_at) return;
  const { prompter } = deps;
  const structure = state.plan.structure;
  const vault = state.plan.vault;
  if (!structure || !vault) throw new StateError('the saved plan has no structure to adopt');
  state.stages.adopt ??= { started_at: deps.now().toISOString(), completed_at: null, operations: [] };
  await saveState(path, state);
  const adopt = state.stages.adopt;
  const record = async (operationId: string | undefined) => {
    if (operationId === undefined || adopt.operations.includes(operationId)) return;
    adopt.operations.push(operationId);
    await saveState(path, state);
  };

  // After a partial adoption the notes hold the installer's own writes: the Analyzer would
  // refuse a type key it did not read types from, and would apply a rename twice.
  if (!adopt.targets) {
    adopt.targets = await decideTargets(deps, structure, vault.path);
    await saveState(path, state);
  }
  const targets = adopt.targets;
  const call = await deps.engine();

  const available = await ensureFields(call, prompter, structure, targets.fields, record);
  const created = await ensureSchemas(call, prompter, structure, available, record);

  const assigned = targets.types === null ? null : new Map(Object.entries(targets.types));
  const typed = [...(assigned ?? [])].filter(([, types]) => types.length > 0).map(([file]) => file);
  const notes = await withSpinner(prompter, 'Reading Engine\'s notes…', () => indexedNotes(call, vault.analyzer_exclusions),
    found => `Engine has ${count(found.length, 'note')} in scope.`);
  const indexed = new Set(notes.map(note => note.file_path));
  const missing = typed.filter(file => !indexed.has(file));
  if (missing.length > 0) {
    prompter.warn(`${count(missing.length, 'note')} the plan types ${missing.length === 1 ? 'is' : 'are'} not in Engine's index, so ${missing.length === 1 ? 'it stays' : 'they stay'} untyped: ${listed(missing)}`);
  }
  const unchecked = assigned === null ? [] : notes.filter(note => !assigned.has(note.file_path)).map(note => note.file_path);
  if (unchecked.length > 0) {
    prompter.warn(`${count(unchecked.length, 'note')} in Engine ${unchecked.length === 1 ? 'was' : 'were'} added or moved after Vault Analyzer checked the notes, so adoption leaves ${unchecked.length === 1 ? 'it' : 'them'} as ${unchecked.length === 1 ? 'it is' : 'they are'}: ${listed(unchecked)}`);
  }
  const oldField = await typeFieldToRemove(call, structure);
  const changes = typeChanges(notes, assigned, replacedTypes(structure), oldField);
  const unset = changes.filter(change => change.unset.length > 0).reduce((sum, change) => sum + change.notes.length, 0);
  const updated = await applyTypeChanges(deps, call, changes, record);

  adopt.completed_at = deps.now().toISOString();
  await saveState(path, state);
  prompter.note([
    `Types: ${count(structure.types.length, 'type')} (${created} created now).`,
    `Notes: ${count(updated, 'note')} given ${updated === 1 ? 'its' : 'their'} types; ${count(typed.length, 'note')} typed in all.`,
    ...(oldField ? [`The ${oldField.name} field was removed from ${count(unset, 'note')}.`] : []),
    `Undo within 24 hours: \`${installerCommand(deps.host, 'undo', state.plan.data_dir)}\` (${count(adopt.operations.length, 'operation')}, recorded in ${path}).`,
  ].join('\n'), 'Adoption');
}

/** The approved vault fields as the Analyzer defines them now, and each note's approved final types. */
async function decideTargets(deps: AdoptStageDeps, structure: StructureSummary, vaultPath: string): Promise<AdoptTargets> {
  const analysis = await currentAnalysis(deps, structure, vaultPath);
  // Without a vault typing, or with every type dropped, no note gets a vault type.
  if (!analysis) return { fields: [], types: null };
  if (analysis.source.source_fingerprint !== structure.source_fingerprint) {
    refuseNewCollisions(analysis);
    const [first, ...differences] = driftNote(structure, analysis);
    // Engine's startup link repair rewrites notes too; only a change to types or fields matters.
    if (differences.length === 0) deps.prompter.info(first as string);
    else deps.prompter.warn([first, ...differences].join('\n'));
  }
  const approved = new Set(structure.types.filter(type => type.from === 'vault').map(type => type.name));
  // Every checked note, typed or not, so a note added since stays apart from one with no types.
  const types: Record<string, string[]> = {};
  for (const file of analysis.proposal.type_assignment.files) types[file.path] = file.types.filter(type => approved.has(type));
  const fields = analysis.proposal.global_fields.filter(field => structure.fields_from_vault.includes(field.name)).map(definitionOf);
  return { fields, types };
}

/** The Analyzer's view of the notes now, under the approved spec; null without a vault typing. */
async function currentAnalysis(deps: AdoptStageDeps, structure: StructureSummary, vaultPath: string): Promise<AnalyzeReport | null> {
  if (structure.source_fingerprint === null) return null;
  try {
    return await withSpinner(
      deps.prompter,
      'Checking the notes again with Vault Analyzer (read-only)…',
      () => deps.analyzer.analyze(vaultPath, structure.analyzer_spec),
      report => `${count(report.coverage.typed_files, 'note')} typed into ${count(report.proposal.schemas.length, 'type')}.`,
    );
  } catch (error) {
    if (!(error instanceof AnalyzerError) || !NOTES_REFUSALS.has(error.code)) throw error;
    throw new AdoptError(`Vault Analyzer refused the notes as they are now: ${error.message}. They changed after you approved the plan; put that change back and run the install again.`);
  }
}

/** Names that differ only by case would be withheld from every note that uses them. */
function refuseNewCollisions(analysis: AnalyzeReport): void {
  const collisions = analysis.needs_review.type_name_collisions;
  if (collisions.length === 0) return;
  throw new AdoptError(`Your notes now use type names that differ only by case or Unicode form (${collisions.map(collision => collision.names.join(' / ')).join('; ')}). They changed after you approved the plan; make those names match and run the install again.`);
}

/**
 * What changed between the approved analysis and this one, and what adoption does about
 * it: a first line, then one line per difference in types or fields.
 */
export function driftNote(structure: StructureSummary, analysis: AnalyzeReport): string[] {
  const approvedTypes = new Set(structure.types.filter(type => type.from === 'vault').map(type => type.name));
  const approvedFields = new Set(structure.fields_from_vault);
  const lines = ['Some notes changed after you approved the plan (Engine rewrites links as it starts, too). Adoption uses what they say now, but creates only the approved types and fields.'];
  const newTypes = analysis.proposal.schemas.filter(schema => !approvedTypes.has(schema.name));
  if (newTypes.length > 0) {
    lines.push(`Types not in the plan are not created, and their notes stay without them: ${newTypes.map(schema => `${schema.name} (${count(schema.evidence.typed_documents, 'note')})`).join(', ')}.`);
  }
  const gone = [...approvedTypes].filter(name => !analysis.proposal.schemas.some(schema => schema.name === name));
  if (gone.length > 0) lines.push(`No notes are typed ${gone.join(', ')} any more; ${gone.length === 1 ? 'it is' : 'they are'} still created.`);
  const newFields = analysis.proposal.global_fields.filter(field => !approvedFields.has(field.name)).map(field => field.name);
  if (newFields.length > 0) lines.push(`New fields stay unmanaged: ${newFields.join(', ')}.`);
  return lines;
}

/**
 * Create each approved global field Engine lacks. Vault fields take their definition from
 * the targets; one the Analyzer no longer proposed (its values now need review) stays
 * unmanaged. Returns the names schemas may claim.
 */
async function ensureFields(
  call: EngineCall,
  prompter: Prompter,
  structure: StructureSummary,
  vaultFields: readonly FieldDefinition[],
  record: (operationId: string | undefined) => Promise<void>,
): Promise<Set<string>> {
  const definitions = new Map<string, FieldDefinition>();
  for (const field of [...vaultFields, ...structure.starter_fields]) definitions.set(field.name, definitionOf(field));

  const existing = new Set((await call<Array<{ name: string }>>('list-global-fields')).map(field => field.name));
  const available = new Set<string>();
  const unmanaged: string[] = [];
  let created = 0;
  for (const name of [...structure.fields_from_vault, ...structure.starter_fields.map(field => field.name)]) {
    if (available.has(name)) continue;
    const wanted = definitions.get(name);
    if (existing.has(name)) {
      if (wanted) await expectSameField(call, wanted);
      available.add(name);
    } else if (wanted) {
      const result = await call<{ operation_id?: string }>('create-global-field', { ...wanted });
      await record(result.operation_id);
      available.add(name);
      created++;
    } else {
      unmanaged.push(name);
    }
  }
  if (unmanaged.length > 0) {
    prompter.warn(`Your notes now use ${unmanaged.join(', ')} in shapes that need review, so ${unmanaged.length === 1 ? 'it stays' : 'they stay'} unmanaged and no type claims ${unmanaged.length === 1 ? 'it' : 'them'}.`);
  }
  if (created > 0) prompter.info(`Created ${count(created, 'global field')}.`);
  return available;
}

function definitionOf(field: FieldDefinition): FieldDefinition {
  return {
    name: field.name,
    field_type: field.field_type,
    ...(field.list_item_type !== undefined ? { list_item_type: field.list_item_type } : {}),
    ...(field.enum_values !== undefined ? { enum_values: field.enum_values } : {}),
    ...(field.reference_target !== undefined ? { reference_target: field.reference_target } : {}),
  };
}

async function expectSameField(call: EngineCall, wanted: FieldDefinition): Promise<void> {
  const field = await call<{
    field_type: string;
    list_item_type: string | null;
    enum_values: string[] | null;
    reference_target: string | null;
    required: boolean;
    default_value: unknown;
  }>('describe-global-field', { name: wanted.name });
  const same = field.field_type === wanted.field_type
    && (field.list_item_type ?? null) === (wanted.list_item_type ?? null)
    && (field.reference_target ?? null) === (wanted.reference_target ?? null)
    && sameMembers(field.enum_values ?? [], wanted.enum_values ?? [])
    && unconstrained(field);
  if (!same) {
    throw new AdoptError(`Engine already has a global field ${wanted.name} that differs from the plan (${describeField(field)}; the plan needs ${describeField(wanted)}). Change it with Engine's update-global-field, or delete it, and run the install again.`);
  }
}

/**
 * The plan makes no field required or gives it a default. Engine fills a missing required
 * field from its default when a type is added, which would write that value into notes.
 */
function unconstrained(field: { required?: boolean; default_value?: unknown }): boolean {
  return field.required !== true && (field.default_value ?? null) === null;
}

function describeField(field: {
  field_type: string;
  list_item_type?: string | null;
  enum_values?: string[] | null;
  reference_target?: string | null;
  required?: boolean;
  default_value?: unknown;
}): string {
  return [
    field.field_type === 'list' ? `list of ${field.list_item_type ?? 'values'}` : field.field_type,
    ...(field.enum_values?.length ? [`values ${field.enum_values.join(', ')}`] : []),
    ...(field.reference_target ? [`pointing to ${field.reference_target}`] : []),
    ...describeConstraints(field),
  ].join(', ');
}

function describeConstraints(field: { required?: boolean; default_value?: unknown }): string[] {
  return [
    ...(field.required === true ? ['required'] : []),
    ...((field.default_value ?? null) !== null ? [`default ${JSON.stringify(field.default_value)}`] : []),
  ];
}

/**
 * Create each approved type Engine lacks, with its claims; returns how many were created.
 * A field typed by the user's choice is claimed afterwards (see `claimChosenFields`).
 */
async function ensureSchemas(
  call: EngineCall,
  prompter: Prompter,
  structure: StructureSummary,
  available: ReadonlySet<string>,
  record: (operationId: string | undefined) => Promise<void>,
): Promise<number> {
  const chosen = new Set(Object.keys(structure.analyzer_spec.field_types ?? {}));
  const existing = new Set((await call<Array<{ name: string; has_schema?: boolean }>>('list-schemas'))
    .filter(schema => schema.has_schema !== false).map(schema => schema.name));
  let created = 0;
  for (const type of structure.types) {
    const claims = type.fields.filter(field => available.has(field));
    let unclaimed: string[];
    if (existing.has(type.name)) {
      unclaimed = await expectSameSchema(call, type.name, type.default_directory, claims, chosen);
    } else {
      unclaimed = claims.filter(field => chosen.has(field));
      const result = await call<{ operation_id?: string }>('create-schema', {
        name: type.name,
        ...(type.default_directory !== null ? { default_directory: type.default_directory } : {}),
        field_claims: claims.filter(field => !chosen.has(field)).map(field => ({ field })),
      });
      await record(result.operation_id);
      created++;
    }
    if (unclaimed.length > 0) await claimChosenFields(call, type.name, unclaimed, record);
  }
  if (created > 0) prompter.info(`Created ${count(created, 'type')}.`);
  return created;
}

/**
 * Claim fields typed by the user's choice with `update-schema`. Its propagation runs every
 * note that already has the type through Engine's pipeline, which converts their values to
 * the chosen type; adoption's own updates reach only notes whose types change. Engine
 * refuses the whole update, changing nothing, if a note would not validate.
 */
async function claimChosenFields(
  call: EngineCall,
  name: string,
  fields: readonly string[],
  record: (operationId: string | undefined) => Promise<void>,
): Promise<void> {
  try {
    const result = await call<{ operation_id?: string }>('update-schema', {
      name,
      add_field_claims: fields.map(field => ({ field })),
    }, { timeoutMs: WRITE_TIMEOUT_MS });
    await record(result.operation_id);
  } catch (error) {
    if (!(error instanceof EngineToolError) || error.code !== 'VALIDATION_FAILED') throw error;
    throw new AdoptError(`Engine could not convert every ${fields.join(', ')} value on your ${name} notes to the type you chose, so it changed nothing: ${error.message} Engine's validate-node shows each note's problem; fix those values and run the install again.`);
  }
}

/**
 * Check a type Engine already has against the plan. Each claim's `required` and
 * `default_value` are resolved from its override or the global field. Returns the chosen
 * fields it does not claim yet, as after a run that stopped before claiming them.
 */
async function expectSameSchema(
  call: EngineCall,
  name: string,
  directory: string | null,
  claims: string[],
  chosen: ReadonlySet<string>,
): Promise<string[]> {
  const schema = await call<{
    default_directory: string | null;
    fields: Array<{ name: string; required?: boolean; default_value?: unknown }>;
  }>('describe-schema', { name });
  const fields = schema.fields.map(field => field.name);
  const unclaimed = claims.filter(field => !fields.includes(field));
  const same = (schema.default_directory ?? null) === directory
    && fields.every(field => claims.includes(field))
    && unclaimed.every(field => chosen.has(field))
    && schema.fields.every(unconstrained);
  if (!same) {
    const described = schema.fields.map(field => {
      const constraints = describeConstraints(field);
      return constraints.length > 0 ? `${field.name} (${constraints.join(', ')})` : field.name;
    });
    throw new AdoptError(`Engine already has a type ${name} that differs from the plan (folder ${schema.default_directory ?? 'none'}, fields ${described.join(', ') || 'none'}; the plan has folder ${directory ?? 'none'}, fields ${claims.join(', ') || 'none'}, none required or with a default). Change it with Engine's update-schema, or delete it, and run the install again.`);
  }
  return unclaimed;
}

/**
 * Whether the plan replaces a type value Engine indexed, given the note's final types.
 * With the type key as the type field (the field the user chose, or `types`), Engine
 * indexed the original values, and the Analyzer read them its own way (see
 * `analyzerNames`). A value it renamed, merged, or dropped goes, and so does another
 * spelling of a type the note ends up with. Other type sources leave Engine's existing
 * types alone.
 */
export function replacedTypes(structure: StructureSummary): (value: string, final: readonly string[]) => boolean {
  const spec = structure.analyzer_spec;
  if (spec.type_field === null || spec.type_field !== typeKeyOf(spec)) return () => false;
  const superseded = new Set(Object.entries(spec.type_renames).filter(([from, to]) => to !== from).map(([from]) => from));
  return (value, final) => analyzerNames(value).some(name => superseded.has(name) || (name !== value && final.includes(name)));
}

/**
 * The names the Analyzer read for a value Engine indexed. Engine keeps surrounding spaces,
 * and reads an unpadded whole wiki-link as its target; an Engine before #482 kept a link's
 * alias under `types` (`[[Meeting|Meetings]]` was indexed as `Meeting|Meetings`). The
 * Analyzer trims, and reads a link as its target (its `normalizeTypeValue`). A type name
 * never contains `|`, so the part before one is the name the Analyzer read.
 */
function analyzerNames(value: string): string[] {
  const trimmed = value.trim();
  const link = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(trimmed);
  const name = (link?.[1] ?? trimmed).trim();
  const target = name.split('|')[0]?.trim() ?? '';
  return [...new Set([name, target])].filter(candidate => candidate.length > 0);
}

/** Every note Engine indexed outside the excluded folders. */
export async function indexedNotes(call: EngineCall, exclusions: readonly string[]): Promise<IndexedNote[]> {
  return (await queryNotes(call, {})).filter(note => !excluded(note.file_path, exclusions));
}

/**
 * When the plan removes the old type field, the notes that still have it; a rerun finds
 * none left on the notes it already finished.
 */
async function typeFieldToRemove(call: EngineCall, structure: StructureSummary): Promise<OldTypeField | null> {
  const name = structure.analyzer_spec.type_field;
  if (!structure.remove_type_field || name === null || name === typeKeyOf(structure.analyzer_spec)) return null;
  const notes = await queryNotes(call, { fields: { [name]: { exists: true } } });
  return { name, ids: new Set(notes.map(note => note.id)) };
}

/** Every note matching a `query-nodes` filter, read page by page. */
async function queryNotes(call: EngineCall, filter: Record<string, unknown>): Promise<IndexedNote[]> {
  const notes = new Map<string, IndexedNote>();
  let total = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await call<{ nodes: IndexedNote[]; total: number }>('query-nodes', {
      ...filter,
      select: ['id', 'file_path', 'types'],
      limit: PAGE_SIZE,
      offset,
    });
    total = page.total;
    for (const node of page.nodes) notes.set(node.id, { id: node.id, file_path: node.file_path, types: node.types ?? [] });
    if (page.nodes.length < PAGE_SIZE || offset + PAGE_SIZE >= total) break;
  }
  if (notes.size !== total) {
    throw new AdoptError('Engine\'s notes changed while the installer read them; run the install again.');
  }
  return [...notes.values()];
}

/** Engine's `excludeDirs` matching: whole path segments from the vault root. */
function excluded(file: string, exclusions: readonly string[]): boolean {
  const segments = file.split('/');
  return exclusions.some(directory => {
    const parts = directory.split('/');
    return parts.length <= segments.length && parts.every((part, index) => segments[index] === part);
  });
}

/**
 * Each note's difference from its final types, grouped by the exact (add, remove, unset)
 * change so one `update-node` call serves many notes. Types Engine indexed that the plan
 * does not replace stay, and a note outside the assignment (added or moved since the
 * Analyzer ran) is left alone. A null assignment gives every note no vault types, so with
 * `types` as the type field the dropped values still go. The old type field, when the
 * plan removes it, goes in the same call from each note that gets a type, so Engine
 * rewrites each note once.
 */
export function typeChanges(
  notes: readonly IndexedNote[],
  assigned: ReadonlyMap<string, readonly string[]> | null,
  replaced: (value: string, final: readonly string[]) => boolean,
  oldField: OldTypeField | null = null,
): TypeChange[] {
  const groups = new Map<string, TypeChange>();
  for (const note of notes) {
    const final = assigned === null ? [] : assigned.get(note.file_path);
    if (final === undefined) continue;
    const add = final.filter(type => !note.types.includes(type));
    const remove = note.types.filter(type => !final.includes(type) && replaced(type, final));
    const unset = oldField !== null && final.length > 0 && oldField.ids.has(note.id) ? [oldField.name] : [];
    if (add.length === 0 && remove.length === 0 && unset.length === 0) continue;
    const key = JSON.stringify([add, remove, unset]);
    const group = groups.get(key) ?? { add, remove, unset, notes: [] };
    group.notes.push(note);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Dry-run every batch before applying any, so a note Engine would refuse stops adoption
 * before it changes a file. Returns how many notes Engine updated.
 */
async function applyTypeChanges(
  deps: AdoptStageDeps,
  call: EngineCall,
  changes: readonly TypeChange[],
  record: (operationId: string | undefined) => Promise<void>,
): Promise<number> {
  const size = deps.batchSize ?? BATCH_SIZE;
  const batches = changes.flatMap(change => chunk(change.notes, size).map(notes => ({ ...change, notes })));
  if (batches.length === 0) return 0;
  const total = batches.reduce((sum, batch) => sum + batch.notes.length, 0);
  const args = (batch: TypeChange, dryRun: boolean) => ({
    query: { node_ids: batch.notes.map(note => note.id) },
    ...(batch.add.length > 0 ? { add_types: batch.add } : {}),
    ...(batch.remove.length > 0 ? { remove_types: batch.remove } : {}),
    ...(batch.unset.length > 0 ? { set_fields: Object.fromEntries(batch.unset.map(field => [field, null])) } : {}),
    dry_run: dryRun,
  });

  const refused: string[] = [];
  let refusedCount = 0;
  await withSpinner(deps.prompter, `Checking type changes for ${count(total, 'note')} with Engine (dry run)…`, async () => {
    for (const batch of batches) {
      const preview = await call<{
        would_fail: number;
        preview: Array<{ file_path: string; changes: { would_fail: boolean } }>;
      }>('update-node', args(batch, true));
      refusedCount += preview.would_fail;
      refused.push(...preview.preview.filter(entry => entry.changes.would_fail).map(entry => entry.file_path));
    }
  }, () => (refusedCount > 0 ? 'Engine would refuse some notes.' : 'Engine accepts every change.'));
  if (refusedCount > 0) {
    throw new AdoptError([
      `Engine would refuse ${count(refusedCount, 'note')} because their fields do not fit their new types${refused.length > 0 ? `, including ${listed(refused)}` : ''}.`,
      'Nothing was changed in your notes. Engine\'s validate-node shows each note\'s problem; fix those fields and run the install again.',
    ].join('\n'));
  }

  let updated = 0;
  const errors: Array<{ file_path: string; error: string }> = [];
  await withSpinner(deps.prompter, `Giving ${count(total, 'note')} ${total === 1 ? 'its' : 'their'} types…`, async () => {
    for (const batch of batches) {
      const result = await call<{ updated: number; errors: Array<{ file_path: string; error: string }>; operation_id?: string }>(
        'update-node', args(batch, false), { timeoutMs: WRITE_TIMEOUT_MS });
      await record(result.operation_id);
      updated += result.updated;
      errors.push(...result.errors);
    }
  }, () => `Updated ${count(updated, 'note')}.`);
  if (errors.length > 0) {
    throw new AdoptError(`Engine could not update ${count(errors.length, 'note')}: ${errors.slice(0, MAX_LISTED).map(error => `${error.file_path} (${error.error})`).join('; ')}${errors.length > MAX_LISTED ? '; …' : ''}. The other notes are done; run the install again to retry.`);
  }
  return updated;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(item => right.includes(item));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function listed(items: readonly string[]): string {
  return `${items.slice(0, MAX_LISTED).join(', ')}${items.length > MAX_LISTED ? `, and ${items.length - MAX_LISTED} more` : ''}`;
}

