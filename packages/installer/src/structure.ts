import {
  AnalyzerError,
  type AnalyzeReport,
  type AnalyzeSpec,
  type AnalyzerRunner,
  type DiscoverReport,
  type FieldTypeChoice,
  typeKeyOf,
} from './analyzer.js';
import { AnswersError, type AnswerId } from './answers.js';
import { chooseJournalType } from './curator-plan.js';
import { FIELD_OFF_WORDS, KIND_OFF_WORDS, KIND_USES, renderMapScreen, STATUS_OFF_WORDS } from './map-screen.js';
import { createDefaultsPrompter, withSpinner, type Prompter } from './prompter.js';
import {
  ROLES,
  STARTER_FIELD_NAMES,
  STARTER_STATUS_VALUES,
  STARTER_TYPE_FIELDS,
  starterFieldDefinition,
  starterStatusDefinition,
  type FieldDefinition,
  type Role,
} from './starter-types.js';
import { count } from './text.js';
import { isTypeName, portableTypeKey, suggestTypeName } from './type-names.js';
import {
  detectActiveStatuses,
  detectJournalType,
  detectStatusField,
  detectMapFields,
  detectStatusGroups,
  fieldNamesOf,
  fieldNameTaken,
  MAP_FIELD_LABELS,
  MAP_FIELDS,
  mapFieldCandidates,
  NO_STATUS,
  proposeVaultMap,
  type MapField,
  STATUS_GROUPS,
  STATUS_KINDS,
  statusFieldCandidates,
  statusValues,
  type StatusFieldChoice,
  type StatusGroups,
  type StatusKind,
  type StatusPlan,
} from './vault-map.js';
import type { VaultPlan } from './vault.js';

/** How notes get their kinds. `tags` is never asked for: it is a run with no line or folders to go by, whose notes' #tags gave them kinds (#650). */
export type TypingSource = 'field' | 'folders' | 'both' | 'tags' | 'none';
export type ReviewFieldChoice = 'unmanaged' | 'text' | 'dominant';

export interface StarterType {
  name: string;
  /** The kind it holds; a starter type exists only because the user asked for one. */
  role: Role;
  claims: string[];
}

export interface StructurePlan {
  source: TypingSource;
  /** The final Analyzer input; adoption reruns it to check the source fingerprint. */
  spec: AnalyzeSpec;
  /** The final Analyzer report, or null when notes are not typed from the vault. */
  analysis: AnalyzeReport | null;
  /** The type each kind designates, or null for none. A name not in the analysis is a starter type. */
  roles: Record<Role, string | null>;
  starterTypes: StarterType[];
  /** Global fields to create beyond the Analyzer's proposal. */
  starterFields: FieldDefinition[];
  /** Claims to add to proposed schemas, such as the designated status field. */
  extraClaims: Array<{ schema: string; field: string }>;
  /** The status field of projects and of tasks and what its values mean; none for a kind that is none. */
  status: Record<StatusKind, StatusPlan>;
  /** The map's other field names (due date, people, …): a field the notes have or a new type adds, or null for none. */
  fields: Record<MapField, string | null>;
  /**
   * The kind Curator's journal writes; the map designates it only when Curator is
   * installed. An interactive run settles it on the notes step's map (`journalSettled`);
   * otherwise it is the detected kind, and the Curator step asks about it.
   */
  journalType: string;
  journalSettled: boolean;
  /** Fields whose shape needs review; they stay as unmanaged (orphan) fields. */
  unmanagedFields: Array<{ name: string; reasons: string[] }>;
  /**
   * Remove the old type field from notes once they have their types; only for a plan
   * whose type field is not the type key (one saved before the type field was designated).
   */
  removeTypeField: boolean;
  warnings: string[];
}

export interface StructureStageDeps {
  prompter: Prompter;
  analyzer: AnalyzerRunner;
  vault: VaultPlan;
}

const CONVENTIONAL_TYPE_KEYS = new Set(['types', 'type', 'kind', 'entity']);
const MAX_ANALYSIS_ROUNDS = 6;
/** Analyzer refusals caused by the chosen type field or rules, which the user can fix. */
const CHOICE_REFUSALS = new Set([
  'TYPE_FIELD_NOT_FOUND', 'NO_USABLE_TYPE_VALUES', 'TYPE_FIELD_TARGET_COLLISION', 'TYPE_KEY_RESERVED', 'TYPE_KEY_VALUE_UNSUPPORTED',
]);
const MAX_TYPE_FIELD_CHOICES = 8;
const OTHER_STATUSES = '\u0000other';
/**
 * Fields the plan may add itself: a starter type's fields, and the `status` field a new type
 * starts with. None can be the type key (#445).
 */
const PLAN_FIELD_NAMES: ReadonlySet<string> = new Set([...STARTER_FIELD_NAMES, 'status']);
const NEW_CHOICE = '\u0000new';
const NONE_CHOICE = '\u0000none';

/** The question under the map: "Looks good" takes it, "Adjust" opens the questions. */
export const MAP_QUESTION = { message: 'How does this look?', initialValue: true, active: 'Looks good', inactive: 'Adjust' } as const;

/**
 * Stage 3, the notes step. Interactively it opens with one screen: the map Vault detected
 * from the notes (`detectStructure`), in plain words. "Looks good" takes it; "Adjust"
 * asks the step's questions (`planStructure`), each starting from what was detected, and
 * shows the map again. A headless run asks the questions from the answers file, with no
 * screen. Read-only: everything here is a plan for the adoption and settings stages.
 */
export async function runStructureStage(deps: StructureStageDeps): Promise<StructurePlan> {
  const { prompter } = deps;
  if (!prompter.interactive) return planStructure(deps);
  const plan = await detectStructure(deps);
  prompter.note(renderMapScreen(deps.vault, plan), 'What Vault found in your notes');
  return await prompter.confirm(MAP_QUESTION) ? plan : adjustStructure(deps);
}

/**
 * "Adjust": the step's questions, each starting from what was detected, then the map
 * again ("Your notes, as you set them") until the user takes it. Quick setup opens this
 * from its review.
 */
export async function adjustStructure(deps: StructureStageDeps): Promise<StructurePlan> {
  const { prompter } = deps;
  for (;;) {
    prompter.info('Each question starts from what Vault found; press Enter to keep it.');
    const plan = await planStructure(deps);
    prompter.note(renderMapScreen(deps.vault, plan), 'Your notes, as you set them');
    if (await prompter.confirm(MAP_QUESTION)) return plan;
  }
}

/**
 * The map detected from the notes, taking every default a headless run without
 * structure answers takes, with no question asked, except those no default can answer:
 * kind names that differ only by case, and how notes are typed when the Analyzer refuses
 * the detected type field or folders.
 *
 * Quick setup passes `sortByFolders: false`: where a headless run would sort notes by
 * their folders (no line in the notes says what kind they are), the notes stay without
 * kinds instead, since sorting by folder would write a kind into every note of every
 * top-level folder that the notes themselves never stated.
 */
export function detectStructure(deps: StructureStageDeps, options: { sortByFolders?: boolean } = {}): Promise<StructurePlan> {
  const defaults = createDefaultsPrompter(deps.prompter, {
    'structure.type_field': ['structure.source'],
    'structure.folder_rules': ['structure.source'],
  });
  const prompter: Prompter = options.sortByFolders === false
    ? {
      ...defaults,
      select: question => defaults.select(question.id === 'structure.source' && question.initialValue === 'folders'
        ? { ...question, initialValue: 'none' as typeof question.initialValue }
        : question),
    }
    : defaults;
  return planStructure({ ...deps, prompter });
}

/**
 * Decide how notes are typed, run Vault Analyzer on that choice, resolve name collisions
 * and renames, and settle the vocabulary map: the type each kind of note designates, the
 * status field of projects and of tasks with what its values mean, the other field
 * names, and (interactively) the journal kind. Each starts from what the notes say
 * (`proposeVaultMap`); with nothing detected it is none, and a new type or status field
 * is planned only when the user asks for one.
 */
export async function planStructure(deps: StructureStageDeps): Promise<StructurePlan> {
  const { prompter } = deps;
  const warnings: string[] = [];

  let { source, spec, analysis } = await chooseTyping(deps);
  ({ source, analysis } = await applyTagRules(deps, spec, source, analysis));
  const history = new TypeNameHistory(analysis);
  if (analysis !== null) {
    const edits = await prompter.decide<Record<string, string | null>>({
      id: 'structure.type_renames',
      ask: () => askTypeEdits(prompter, analysis as AnalyzeReport, spec),
      defaultValue: () => ({}),
    });
    if (Object.keys(edits).length > 0) {
      applyTypeEdits(spec, analysis, edits, prompter, history);
      analysis = await analyzeAfterEdits(deps, spec);
    }
    if (analysis !== null) analysis = await resolveCollisions(deps, spec, analysis, history);
    if (analysis !== null) analysis = await chooseFieldTypes(deps, spec, analysis);
    if (analysis === null || analysis.proposal.schemas.length === 0) {
      warnings.push('No note ends up with a kind.');
      if (analysis === null) source = 'none';
    }
  }

  const removeTypeField = analysis !== null && await chooseTypeFieldRemoval(prompter, spec);
  const typeNames = analysis ? analysis.proposal.schemas.map(schema => schema.name) : [];
  const proposed = proposeVaultMap({ analysis, renames: history.renames() });
  const { roles, starters } = await chooseKinds(prompter, analysis, proposed.kinds, warnings);
  const statusFields = await chooseStatusFields(prompter, analysis, roles, starters, typeKeyOf(spec), warnings);
  const status: Record<StatusKind, StatusPlan> = {
    project: await chooseStatusMeanings(prompter, 'project', analysis, statusFields.project, warnings),
    task: await chooseStatusMeanings(prompter, 'task', analysis, statusFields.task, warnings),
  };
  const additions = planAdditions(analysis, roles, starters, status, warnings);
  // A new type's own fields count as present: the plan creates them.
  const fields = await chooseMapFields(prompter, fieldNamesOf(analysis, additions.starterFields.map(field => field.name)));

  for (const claim of analysis?.needs_review.ambiguous_claims ?? []) {
    warnings.push(`The ${claim.field} line appears only on notes of more than one kind (${claim.candidate_types.join(', ')}), so Vault ties it to no kind yet; the notes keep it.`);
  }

  // Interactively the journal kind is part of the map, asked (under Adjust) before Curator
  // is chosen; a headless run keeps asking it in the Curator step, only with Curator.
  const plannedTypes = [...typeNames, ...additions.starterTypes.map(type => type.name)];
  const detectedJournal = detectJournalType(plannedTypes);
  return {
    source,
    spec,
    analysis,
    roles,
    starterTypes: additions.starterTypes,
    starterFields: additions.starterFields,
    extraClaims: additions.extraClaims,
    status,
    fields,
    journalType: prompter.interactive ? await chooseJournalType(prompter, plannedTypes, detectedJournal) : detectedJournal,
    journalSettled: prompter.interactive,
    unmanagedFields: (analysis?.needs_review.ambiguous_fields ?? []).map(field => ({ name: field.name, reasons: field.reasons })),
    removeTypeField,
    warnings,
  };
}

/** Every type the plan creates or uses: the vault's and the starter types. */
export function plannedTypeNames(plan: Pick<StructurePlan, 'analysis' | 'starterTypes'>): string[] {
  return [...(plan.analysis?.proposal.schemas.map(schema => schema.name) ?? []), ...plan.starterTypes.map(type => type.name)];
}

/** Ask how notes are typed and run the first analysis, asking again after a refusal. */
async function chooseTyping(deps: StructureStageDeps): Promise<{
  source: TypingSource;
  spec: AnalyzeSpec;
  analysis: AnalyzeReport | null;
}> {
  const { prompter, vault } = deps;
  for (;;) {
    let source = await prompter.select<TypingSource>({
      id: 'structure.source',
      message: 'How can Vault tell what kind of note each one is (a meeting, a person, a project…)?',
      options: [
        { value: 'field', label: 'A line at the top of each note', hint: 'a property such as type: meeting' },
        { value: 'folders', label: 'The folder each note is in', hint: 'such as Meetings/ and People/' },
        { value: 'both', label: 'Both', hint: 'the line at the top wins; folders fill the gaps' },
        { value: 'none', label: 'Neither, or I\'m not sure', hint: 'your notes stay as they are, without kinds' },
      ],
      initialValue: defaultSource(vault.discovery),
    });
    const spec: AnalyzeSpec = { type_field: null, folder_rules: [], type_renames: {}, exclude: vault.analyzerExclusions };
    if (source === 'field' || source === 'both') {
      spec.type_field = await chooseTypeField(prompter, vault.discovery);
      // The type field becomes Engine's type key (VAULT_TYPE_KEY, #445): notes keep it, and
      // no second `types` key is added. A starter field of the same name could then never
      // be created, so such a field cannot hold types.
      if (PLAN_FIELD_NAMES.has(spec.type_field)) {
        prompter.rejectAnswer('structure.type_field', `The ${spec.type_field} field cannot hold note types: Vault gives some kinds of notes a ${spec.type_field} field of their own. Choose another field, or type notes by their folders.`);
        continue;
      }
      spec.type_key = spec.type_field;
    }
    if (source === 'folders' || source === 'both') spec.folder_rules = await chooseFolderRules(prompter, vault.discovery);
    if (spec.type_field === null && !spec.folder_rules.some(rule => rule.type !== null)) source = 'none';
    if (source === 'none') return { source, spec, analysis: null };

    try {
      return { source, spec, analysis: await analyze(deps, spec) };
    } catch (error) {
      if (!(error instanceof AnalyzerError) || !CHOICE_REFUSALS.has(error.code)) throw error;
      // Interactive runs ask again; headless runs stop with an answers error.
      prompter.rejectAnswer(spec.type_field !== null ? 'structure.type_field' : 'structure.folder_rules', typingRefusal(error, spec));
    }
  }
}

/**
 * Usual kind words (owner, 2026-11-19): a tag naming one of these, or a kind the notes
 * already have, starts ticked, and quick setup and headless installs take it. Any other
 * tag is offered unticked: #todo or #important would make poor kinds.
 */
export const USUAL_KIND_TAGS: ReadonlySet<string> = new Set([
  'meeting', 'project', 'task', 'person', 'company', 'contact', 'book', 'recipe', 'journal',
  'article', 'idea', 'event', 'call', 'interview', 'course', 'movie', 'trip', 'goal',
]);
const MAX_TAG_CHOICES = 20;

/** The kind a tag names: a kind the plan has already, matched without case, else the tag in the singular. */
export function tagKindName(tag: string, kinds: readonly string[]): string {
  const suggested = suggestTypeName(tag);
  return kinds.find(kind => kind.toLowerCase() === tag || kind.toLowerCase() === suggested) ?? suggested;
}

/** Whether a tag starts ticked: it names a usual kind, or a kind the notes already have. */
export function tagStartsTicked(tag: string, kinds: readonly string[]): boolean {
  const suggested = suggestTypeName(tag);
  return USUAL_KIND_TAGS.has(suggested) || kinds.some(kind => kind.toLowerCase() === tag || kind.toLowerCase() === suggested);
}

/**
 * Ask which #tags name a kind, and analyze again with them (#650). The tags offered are those
 * on notes the type line leaves without a kind (every note's, when nothing types them yet). A
 * note gets the kind of every ticked tag it carries, ahead of its folder; the tag text stays.
 */
async function applyTagRules(
  deps: StructureStageDeps,
  spec: AnalyzeSpec,
  source: TypingSource,
  analysis: AnalyzeReport | null,
): Promise<{ source: TypingSource; analysis: AnalyzeReport | null }> {
  const { prompter } = deps;
  const offered = (analysis?.tags ?? deps.vault.discovery.tags).candidates.slice(0, MAX_TAG_CHOICES);
  const kinds = analysis?.proposal.schemas.map(schema => schema.name) ?? [];
  const ticked = offered.filter(candidate => tagStartsTicked(candidate.tag, kinds));
  for (;;) {
    const rules = await prompter.decide<NonNullable<AnalyzeSpec['tag_rules']>>({
      id: 'structure.tag_rules',
      async ask() {
        if (offered.length === 0) return [];
        const chosen = await prompter.multiselect({
          id: 'structure.tag_rules',
          message: 'Some notes carry #tags. Which tags say what kind of note it is? Tick them with Space. (A tag wins over the folder; you can rename kinds next.)',
          options: offered.map(candidate => ({
            value: candidate.tag,
            label: `#${candidate.tag}`,
            hint: `${count(candidate.documents, 'note')} → ${tagKindName(candidate.tag, kinds)}`,
          })),
          initialValues: ticked.map(candidate => candidate.tag),
        });
        return chosen.map(tag => ({ tag, type: tagKindName(tag, kinds) }));
      },
      defaultValue: () => ticked.map(candidate => ({ tag: candidate.tag, type: tagKindName(candidate.tag, kinds) })),
    });
    const bad = rules.find(rule => rule.type !== null && !isTypeName(rule.type));
    if (bad !== undefined) {
      prompter.rejectAnswer('structure.tag_rules', `"${bad.type}" cannot be the name of a kind.`);
      continue;
    }
    if (!rules.some(rule => rule.type !== null)) {
      delete spec.tag_rules;
      return { source, analysis };
    }
    spec.tag_rules = rules;
    try {
      return { source: source === 'none' ? 'tags' : source, analysis: await analyze(deps, spec) };
    } catch (error) {
      if (!(error instanceof AnalyzerError) || !CHOICE_REFUSALS.has(error.code)) throw error;
      delete spec.tag_rules;
      // Interactive runs ask again; headless runs stop with an answers error.
      prompter.rejectAnswer('structure.tag_rules', error.code === 'TYPE_FIELD_TARGET_COLLISION'
        ? `Some notes with these tags already have a "${typeKeyOf(spec)}" line, so Vault cannot also sort them by their tags.`
        : typingRefusal(error, spec));
    }
  }
}

/** Why the Analyzer cannot sort the notes this way, in plain words. */
function typingRefusal(error: AnalyzerError, spec: AnalyzeSpec): string {
  const line = spec.type_field === null ? null : `"${spec.type_field}"`;
  switch (error.code) {
    case 'TYPE_FIELD_NOT_FOUND':
      return `No note has a ${line} line at the top, so Vault cannot tell kinds apart by it.`;
    case 'TYPE_FIELD_TARGET_COLLISION':
      return `Some of these notes already have a "types" line, so Vault cannot also sort them by ${line ?? 'folder'}.`;
    case 'NO_USABLE_TYPE_VALUES':
      return line !== null && spec.folder_rules.length === 0
        ? `The ${line} line holds no value Vault can use as a kind.`
        : 'This way of sorting gives no note a kind.';
    default:
      return error.message;
  }
}

/** How a run that takes the defaults types notes: a conventional type line, else top-level folders, else neither. */
export function defaultSource(discovery: DiscoverReport): TypingSource {
  if (discovery.candidates.some(candidate => CONVENTIONAL_TYPE_KEYS.has(candidate.key))) return 'field';
  return discovery.folders.some(folder => !folder.path.includes('/')) ? 'folders' : 'none';
}

async function chooseTypeField(prompter: Prompter, discovery: DiscoverReport): Promise<string> {
  const candidates = discovery.candidates.slice(0, MAX_TYPE_FIELD_CHOICES);
  const fallback = candidates[0]?.key;
  const typeField = await prompter.decide<string>({
    id: 'structure.type_field',
    async ask() {
      const other = '\u0000other';
      const choice = await prompter.select<string>({
        id: 'structure.type_field',
        message: 'Which line at the top of your notes says what kind each note is?',
        options: [
          ...candidates.map(candidate => ({
            value: candidate.key,
            label: candidate.key,
            hint: `${count(candidate.documents_with_key, 'note')}, e.g. ${candidate.sample_values.slice(0, 3).join(', ')}`,
          })),
          { value: other, label: 'Another line…' },
        ],
        initialValue: fallback ?? other,
      });
      if (choice !== other) return choice;
      return prompter.text({
        id: 'structure.type_field',
        message: 'Type the name before the colon, exactly as in your notes (for "category: book", type category):',
      });
    },
    defaultValue() {
      if (fallback === undefined) throw new AnswersError('missing answer: structure.type_field (no candidate field was found)');
      return fallback;
    },
  });
  if (typeField.trim() === '') throw new AnswersError('answer structure.type_field must not be empty');
  return typeField;
}

async function chooseFolderRules(
  prompter: Prompter,
  discovery: DiscoverReport,
): Promise<AnalyzeSpec['folder_rules']> {
  const topLevel = discovery.folders.filter(folder => !folder.path.includes('/'));
  return prompter.decide<AnalyzeSpec['folder_rules']>({
    id: 'structure.folder_rules',
    async ask() {
      const chosen = await prompter.multiselect({
        id: 'structure.folder_rules',
        message: 'Which folders hold just one kind of note? Tick them with Space.',
        options: topLevel.map(folder => ({ value: folder.path, label: folder.path, hint: count(folder.subtree_markdown_files, 'note') })),
        initialValues: topLevel.map(folder => folder.path),
      });
      const rules: AnalyzeSpec['folder_rules'] = [];
      for (const directory of chosen) {
        for (;;) {
          const name = (await prompter.text({
            id: 'structure.folder_rules',
            message: `What kind are the notes in ${directory}/? (a short name, such as meeting)`,
            defaultValue: suggestTypeName(directory),
          })).trim();
          if (isTypeName(name)) {
            rules.push({ directory, type: name });
            break;
          }
          prompter.rejectAnswer('structure.folder_rules', `"${name}" cannot be the name of a kind.`);
        }
      }
      return rules;
    },
    defaultValue: () => topLevel.map(folder => ({ directory: folder.path, type: suggestTypeName(folder.path) }))
      .filter(rule => isTypeName(rule.type)),
  });
}

function analyze(deps: StructureStageDeps, spec: AnalyzeSpec): Promise<AnalyzeReport> {
  return withSpinner(
    deps.prompter,
    'Reading your notes (nothing is changed)…',
    () => deps.analyzer.analyze(deps.vault.path, spec),
    report => `${count(report.coverage.typed_files, 'note')} sorted into ${count(report.proposal.schemas.length, 'kind')}.`,
  );
}

/** Reanalyze after renames; dropping every proposed type leaves no types from the vault. */
async function analyzeAfterEdits(deps: StructureStageDeps, spec: AnalyzeSpec): Promise<AnalyzeReport | null> {
  try {
    return await analyze(deps, spec);
  } catch (error) {
    if (error instanceof AnalyzerError && error.code === 'NO_USABLE_TYPE_VALUES') return null;
    throw error;
  }
}

async function askTypeEdits(
  prompter: Prompter,
  analysis: AnalyzeReport,
  spec: AnalyzeSpec,
): Promise<Record<string, string | null>> {
  // With a type field and folder rules, the Analyzer lets a folder rule type any note
  // whose field yields no type, including notes whose value was dropped.
  const folderFallback = spec.type_field !== null && spec.folder_rules.some(rule => rule.type !== null);
  const schemas = analysis.proposal.schemas;
  if (schemas.length === 0) return {};
  const chosen = await prompter.multiselect({
    id: 'structure.type_renames',
    message: 'These are the kinds of notes Vault found. Tick any you want to rename, merge, or remove. (Most people tick none.)',
    options: schemas.map(schema => ({ value: schema.name, label: schema.name, hint: count(schema.evidence.typed_documents, 'note') })),
    initialValues: [],
  });
  const edits: Record<string, string | null> = {};
  for (const from of chosen) {
    for (;;) {
      const to = (await prompter.text({
        id: 'structure.type_renames',
        message: folderFallback
          ? `New name for ${from}? Its notes take the new name. (Give another kind's name to merge them. Leave empty to remove it: its notes in a folder you chose take that folder's kind, and the rest are left without one.)`
          : `New name for ${from}? Its notes take the new name. (Give another kind's name to merge them. Leave empty to remove it: its notes are left without a kind.)`,
        allowEmpty: true,
      })).trim();
      if (to === '') {
        edits[from] = null;
        break;
      }
      if (isTypeName(to)) {
        edits[from] = to;
        break;
      }
      prompter.rejectAnswer('structure.type_renames', `"${to}" cannot be the name of a kind.`);
    }
  }
  return edits;
}

/**
 * Apply edits keyed by proposed type name. A type comes from type-field values (renamed
 * through the Analyzer's `type_renames`) or from folder rules (whose type is edited).
 */
/**
 * Where each type first proposed by the Analyzer ended up, across the user's renames,
 * collision merges, and the `note` rename, so roles follow the final names.
 */
export class TypeNameHistory {
  private readonly current = new Map<string, string | null>();

  constructor(initial: AnalyzeReport | null) {
    const names = [
      ...(initial?.proposal.schemas.map(schema => schema.name) ?? []),
      ...(initial?.needs_review.type_name_collisions.flatMap(collision => collision.names) ?? []),
    ];
    for (const name of names) this.current.set(name, name);
  }

  record(edits: ReadonlyMap<string, string | null>): void {
    for (const [original, name] of this.current) {
      if (name !== null && edits.has(name)) this.current.set(original, edits.get(name) ?? null);
    }
  }

  /** Original name -> final name (or null when dropped), for types that changed. */
  renames(): Record<string, string | null> {
    return Object.fromEntries([...this.current].filter(([original, name]) => original !== name));
  }
}

export function applyTypeEdits(
  spec: AnalyzeSpec,
  analysis: AnalyzeReport,
  edits: Record<string, string | null>,
  prompter: Pick<Prompter, 'rejectAnswer'>,
  history?: TypeNameHistory,
): void {
  const known = new Set(analysis.proposal.schemas.map(schema => schema.name));
  for (const name of analysis.needs_review.type_name_collisions.flatMap(collision => collision.names)) known.add(name);
  const accepted = new Map<string, string | null>();
  for (const [from, to] of Object.entries(edits)) {
    if (!known.has(from)) {
      prompter.rejectAnswer('structure.type_renames', `${from} is not one of the proposed types.`);
    } else if (to !== null && !isTypeName(to)) {
      prompter.rejectAnswer('structure.type_renames', `"${to}" cannot be a type name.`);
    } else {
      accepted.set(from, to);
    }
  }
  // Every replacement is looked up from the type before any edit, so edits that swap or
  // chain names (a -> b, b -> a) do not depend on their order.
  for (const value of analysis.proposal.type_assignment.type_field_values) {
    if (value.type !== null && accepted.has(value.type)) {
      spec.type_renames[value.value] = accepted.get(value.type) as string | null;
    }
  }
  for (const rule of spec.folder_rules) {
    if (rule.type !== null && accepted.has(rule.type)) rule.type = accepted.get(rule.type) as string | null;
  }
  for (const rule of spec.tag_rules ?? []) {
    if (rule.type !== null && accepted.has(rule.type)) rule.type = accepted.get(rule.type) as string | null;
  }
  history?.record(accepted);
}

async function resolveCollisions(
  deps: StructureStageDeps,
  spec: AnalyzeSpec,
  initial: AnalyzeReport,
  history: TypeNameHistory,
): Promise<AnalyzeReport> {
  const { prompter } = deps;
  let analysis = initial;
  for (let round = 0; analysis.needs_review.type_name_collisions.length > 0; round++) {
    const collisions = analysis.needs_review.type_name_collisions;
    if (!prompter.interactive || round >= MAX_ANALYSIS_ROUNDS) {
      const groups = collisions.map(collision => collision.names.join(' / ')).join('; ');
      throw new AnswersError(`type names differ only by case or Unicode form (${groups}); merge them with structure.type_renames`);
    }
    const edits: Record<string, string> = {};
    for (const collision of collisions) {
      const keep = await prompter.select<string>({
        id: 'structure.type_renames',
        message: `Your notes use ${collision.names.join(' and ')} as kinds (${count(collision.documents, 'note')}). Vault cannot keep two kinds whose names differ only in capital letters, so they become one. Which name should it have?`,
        options: collision.names.map(name => ({ value: name, label: name })),
        initialValue: collision.names.find(name => name === name.toLowerCase()) ?? collision.names[0] as string,
        mustAsk: true,
      });
      for (const name of collision.names) if (name !== keep) edits[name] = keep;
    }
    applyTypeEdits(spec, analysis, edits, prompter, history);
    analysis = await analyze(deps, spec);
  }
  return analysis;
}

/**
 * A field whose values have more than one shape stays unmanaged unless the user stores it
 * as text or in its most common shape, each offered only when every value converts. The
 * choice goes into the Analyzer spec, so this analysis and adoption's rerun propose and
 * claim the field like any other.
 */
async function chooseFieldTypes(deps: StructureStageDeps, spec: AnalyzeSpec, analysis: AnalyzeReport): Promise<AnalyzeReport> {
  const { prompter } = deps;
  const fields = analysis.needs_review.ambiguous_fields;
  const choices = await prompter.decide<Record<string, ReviewFieldChoice>>({
    id: 'structure.review_fields',
    async ask() {
      const chosen: Record<string, ReviewFieldChoice> = {};
      for (const field of fields) {
        const options = field.options.filter(option => option.unconverted === 0);
        if (options.length === 0) continue;
        const samples = field.evidence.sample_values.slice(0, 3).map(value => JSON.stringify(value)).join(', ');
        chosen[field.name] = await prompter.select<ReviewFieldChoice>({
          id: 'structure.review_fields',
          message: `Your notes use the ${field.name} line in more than one way${samples ? ` (for example ${samples})` : ''}. How should Vault treat it?`,
          options: [
            { value: 'unmanaged', label: 'Leave it as it is', hint: 'notes keep these values untouched; Vault does not check or sort them' },
            ...options.map(option => ({
              value: option.option,
              label: `As ${describeFieldType(option)}`,
              hint: 'every value fits; Vault rewrites each in that form and checks new ones',
            })),
          ],
          initialValue: 'unmanaged',
        });
      }
      return chosen;
    },
    defaultValue: () => ({}),
  });

  const fieldTypes: Record<string, FieldTypeChoice> = {};
  for (const [name, choice] of Object.entries(choices)) {
    const field = fields.find(candidate => candidate.name === name);
    const option = field?.options.find(candidate => candidate.option === choice);
    if (!field) {
      prompter.rejectAnswer('structure.review_fields', `${name} is not a field that needs review.`);
    } else if (choice === 'unmanaged') {
      continue;
    } else if (!option) {
      prompter.rejectAnswer('structure.review_fields', `${name} has no common shape other than text to store it as.`);
    } else if (option.unconverted > 0) {
      prompter.rejectAnswer('structure.review_fields', `${name} cannot be stored as ${describeFieldType(option)}: ${count(option.unconverted, 'value')} would not convert.`);
    } else {
      fieldTypes[name] = { field_type: option.field_type, ...(option.list_item_type ? { list_item_type: option.list_item_type } : {}) };
    }
  }
  if (Object.keys(fieldTypes).length === 0) return analysis;
  spec.field_types = fieldTypes;
  return analyze(deps, spec);
}

const FIELD_TYPE_WORDS: Record<FieldTypeChoice['field_type'], string> = {
  string: 'text',
  number: 'a number',
  date: 'a date',
  boolean: 'yes or no',
  reference: 'a link to a note',
  enum: 'one of a set of values',
  list: 'a list',
};
const LIST_ITEM_WORDS: Record<NonNullable<FieldTypeChoice['list_item_type']>, string> = {
  string: 'text',
  number: 'numbers',
  date: 'dates',
  boolean: 'yes-or-no values',
  reference: 'links to notes',
  enum: 'values from a set',
  list: 'lists',
};

export function describeFieldType(type: FieldTypeChoice): string {
  return type.field_type === 'list' && type.list_item_type
    ? `a list of ${LIST_ITEM_WORDS[type.list_item_type]}`
    : FIELD_TYPE_WORDS[type.field_type];
}

/**
 * Adoption keeps each typed note's types in the type key. A type field is that key, so
 * there is nothing to remove; a plan whose type field is another key (none is, since the
 * type field became the type key) keeps it by default as an unmanaged field, and removing
 * it takes it only from notes that get a type.
 */
async function chooseTypeFieldRemoval(prompter: Prompter, spec: AnalyzeSpec): Promise<boolean> {
  const field = spec.type_field;
  if (field === null || field === typeKeyOf(spec)) return false;
  return prompter.decide<boolean>({
    id: 'structure.remove_type_field',
    ask: () => prompter.confirm({
      message: `Remove the ${field} field from each note once it has its types? Notes that end up without a type keep it.`,
      initialValue: false,
    }),
    defaultValue: () => false,
  });
}

/** A kind's answer: a type the notes have, `{ starter: name }` for a new type, or null for none. */
export type KindAnswer = string | null | { starter: string };
/** A status field's answer: a text field the notes have, `{ starter: name }` for a new one, or null for none. */
export type StatusFieldAnswer = string | null | { starter: string };

const PLURALS: Record<Role, string> = {
  project: 'projects',
  task: 'tasks',
  meeting: 'meetings',
  person: 'people',
  company: 'companies',
};

/**
 * Which type holds each kind of note. Each starts from the type detected by name, or none;
 * a new (starter) type is planned only when the user asks for one, under any name.
 */
async function chooseKinds(
  prompter: Prompter,
  analysis: AnalyzeReport | null,
  detected: Record<Role, string | null>,
  warnings: string[],
): Promise<{ roles: Record<Role, string | null>; starters: Set<Role> }> {
  const typeNames = analysis ? analysis.proposal.schemas.map(schema => schema.name) : [];
  const noteCount = (name: string) => count(analysis?.proposal.schemas.find(schema => schema.name === name)?.evidence.typed_documents ?? 0, 'note');
  const answered = await prompter.decide<Partial<Record<Role, KindAnswer>>>({
    id: 'structure.roles',
    async ask() {
      prompter.note([
        'Vault and Curator give extra help with these five kinds of notes.',
        'Here is how your notes match up:',
        '',
        ...ROLES.map(role => `${PLURALS[role]}: ${detected[role] ?? 'none'}`),
      ].join('\n'), 'Kinds Vault gives extra help');
      const accept = await prompter.confirm({ message: 'Keep these?', initialValue: true, active: 'Keep', inactive: 'Change' });
      if (accept) return detected;
      const chosen: Partial<Record<Role, KindAnswer>> = {};
      const newNames: string[] = [];
      for (const role of ROLES) {
        const value = await prompter.select<string>({
          id: 'structure.roles',
          message: `Which kind of note are your ${PLURALS[role]}? (${KIND_USES[role]})`,
          options: [
            ...typeNames.map(name => ({ value: name, label: name, hint: noteCount(name) })),
            { value: NEW_CHOICE, label: 'Add a starter kind…', hint: 'a new kind under a name you choose; Vault creates it, with a few optional lines' },
            { value: NONE_CHOICE, label: 'None', hint: KIND_OFF_WORDS[role] },
          ],
          initialValue: detected[role] ?? NONE_CHOICE,
        });
        if (value === NONE_CHOICE) {
          chosen[role] = null;
        } else if (value === NEW_CHOICE) {
          const name = await askNewName(prompter, 'structure.roles', `Name for the new kind of note for your ${PLURALS[role]}:`, { placeholder: role }, candidate =>
            !isTypeName(candidate)
              ? `"${candidate}" cannot be the name of a kind.`
              : newNames.some(other => portableTypeKey(other) === portableTypeKey(candidate))
                ? `${candidate} is already the new kind for another; give each its own.`
                : null);
          newNames.push(name);
          chosen[role] = { starter: name };
        } else {
          chosen[role] = value;
        }
      }
      return chosen;
    },
    defaultValue: () => detected,
  });
  return settleKinds({ ...detected, ...answered }, typeNames, prompter, warnings);
}

/**
 * Check each kind's answer. A new type is `{ starter: name }`, or the kind's own name (as
 * answers files had it before new types could take any name). A new name that differs
 * from an existing type only by case would share its schema file, so the kind uses that
 * type instead.
 */
function settleKinds(
  answers: Partial<Record<Role, KindAnswer>>,
  typeNames: readonly string[],
  prompter: Pick<Prompter, 'rejectAnswer'>,
  warnings: string[],
): { roles: Record<Role, string | null>; starters: Set<Role> } {
  const roles = Object.fromEntries(ROLES.map(role => [role, null])) as Record<Role, string | null>;
  const starters = new Set<Role>();
  for (const role of ROLES) {
    const answer = answers[role] ?? null;
    if (answer === null) continue;
    if (typeof answer === 'string' && typeNames.includes(answer)) {
      roles[role] = answer;
      continue;
    }
    if (typeof answer === 'string' && answer !== role) {
      throw new AnswersError(`answer structure.roles.${role}: ${answer} is neither a proposed type nor the kind's own name; to add a new type named ${answer}, answer {"starter": ${JSON.stringify(answer)}}`);
    }
    const name = typeof answer === 'string' ? answer : answer.starter;
    if (!isTypeName(name)) {
      prompter.rejectAnswer('structure.roles', `${role}: "${name}" cannot be a type name.`);
      continue;
    }
    const existing = typeNames.find(type => portableTypeKey(type) === portableTypeKey(name));
    if (existing !== undefined) {
      roles[role] = existing;
      warnings.push(`Your ${PLURALS[role]} are your ${existing} notes: a new "${name}" kind would differ from ${existing} only in capital letters.`);
      continue;
    }
    const shared = ROLES.find(other => starters.has(other) && portableTypeKey(roles[other] as string) === portableTypeKey(name));
    if (shared !== undefined) {
      prompter.rejectAnswer('structure.roles', `${role}: ${name} is already the new ${shared} type; give each kind its own.`);
      continue;
    }
    roles[role] = name;
    starters.add(role);
  }
  return { roles, starters };
}

/** Ask for a name until `problem` finds none; a placeholder only suggests one, a default is taken on Enter. */
async function askNewName(
  prompter: Prompter,
  id: AnswerId,
  message: string,
  suggestion: { defaultValue: string } | { placeholder: string },
  problem: (name: string) => string | null,
): Promise<string> {
  for (;;) {
    const name = (await prompter.text({ id, message, ...suggestion })).trim();
    const reason = problem(name);
    if (reason === null) return name;
    prompter.rejectAnswer(id, reason);
  }
}

/**
 * The status field of projects and of tasks, for each kind that is not none. Each starts
 * from a text field named like a status (or none); a new type the user asked for starts
 * with a new `status` field. A new field is planned only when chosen, and never under the
 * type key's name (`typeKey`).
 */
async function chooseStatusFields(
  prompter: Prompter,
  analysis: AnalyzeReport | null,
  roles: Record<Role, string | null>,
  starters: ReadonlySet<Role>,
  typeKey: string,
  warnings: string[],
): Promise<Record<StatusKind, StatusFieldChoice>> {
  const detected = Object.fromEntries(STATUS_KINDS.map(kind =>
    [kind, detectStatusField(analysis, roles[kind], starters.has(kind))])) as Record<StatusKind, StatusFieldChoice>;
  const kinds = STATUS_KINDS.filter(kind => roles[kind] !== null);
  const chosen: Record<StatusKind, StatusFieldChoice> = { project: null, task: null };
  if (kinds.length === 0) return chosen;

  const answered = await prompter.decide<Partial<Record<StatusKind, StatusFieldAnswer>>>({
    id: 'structure.status_fields',
    async ask() {
      prompter.note([
        'Vault tells open work from finished work by a status line in the notes.',
        '',
        ...kinds.map(kind => `${PLURALS[kind]} (${roles[kind]}): ${describeStatusField(detected[kind])}`),
      ].join('\n'), 'Status lines');
      if (await prompter.confirm({ message: 'Keep these?', initialValue: true, active: 'Keep', inactive: 'Change' })) return answersOf(detected);
      const answers: Partial<Record<StatusKind, StatusFieldAnswer>> = {};
      for (const kind of kinds) {
        const current = detected[kind];
        const value = await prompter.select<string>({
          id: 'structure.status_fields',
          message: `Which line in your ${PLURALS[kind]} holds their status?`,
          options: [
            ...statusFieldCandidates(analysis, roles[kind]).map(name => ({ value: name, label: name, hint: sampleHint(analysis, name) })),
            {
              value: NEW_CHOICE,
              label: 'Add a new status line…',
              hint: `values ${STARTER_STATUS_VALUES.join(', ')}; no note changes until you set one`,
            },
            { value: NONE_CHOICE, label: 'None', hint: STATUS_OFF_WORDS[kind] },
          ],
          initialValue: current === null ? NONE_CHOICE : current.starter ? NEW_CHOICE : current.field,
        });
        answers[kind] = value === NONE_CHOICE
          ? null
          : value === NEW_CHOICE
            ? { starter: await askNewName(prompter, 'structure.status_fields', `Name for the new status line of your ${PLURALS[kind]}:`, { defaultValue: 'status' }, name => newStatusFieldProblem(analysis, name, typeKey)) }
            : value;
      }
      return answers;
    },
    defaultValue: () => answersOf(detected),
  });

  for (const kind of kinds) {
    chosen[kind] = answered[kind] === undefined ? detected[kind] : settleStatusField(kind, answered[kind], analysis, typeKey, prompter);
  }
  if (kinds.some(kind => chosen[kind] === null)) {
    const problem = statusShapeProblem(analysis);
    if (problem !== null) warnings.push(problem);
  }
  return chosen;
}

function answersOf(choices: Record<StatusKind, StatusFieldChoice>): Partial<Record<StatusKind, StatusFieldAnswer>> {
  return Object.fromEntries(STATUS_KINDS.map(kind => {
    const choice = choices[kind];
    return [kind, choice === null ? null : choice.starter ? { starter: choice.field } : choice.field];
  }));
}

function describeStatusField(choice: StatusFieldChoice): string {
  if (choice === null) return 'none';
  return choice.starter ? `a new ${choice.field} line (${STARTER_STATUS_VALUES.join(', ')})` : choice.field;
}

function sampleHint(analysis: AnalyzeReport | null, name: string): string | undefined {
  const field = analysis?.proposal.global_fields.find(candidate => candidate.name === name);
  const samples = (field?.enum_values ?? field?.evidence.sample_values ?? []).filter(value => typeof value === 'string').slice(0, 4);
  return samples.length > 0 ? `e.g. ${samples.join(', ')}` : undefined;
}

/** Text fields of the notes, which can hold a status. */
function textFieldNames(analysis: AnalyzeReport | null): string[] {
  return (analysis?.proposal.global_fields ?? [])
    .filter(field => field.field_type === 'string' || field.field_type === 'enum')
    .map(field => field.name);
}

function settleStatusField(
  kind: StatusKind,
  answer: StatusFieldAnswer | undefined,
  analysis: AnalyzeReport | null,
  typeKey: string,
  prompter: Pick<Prompter, 'rejectAnswer'>,
): StatusFieldChoice {
  if (answer === null || answer === undefined) return null;
  const name = typeof answer === 'string' ? answer : answer.starter;
  if (textFieldNames(analysis).includes(name)) return { field: name, starter: false };
  if (typeof answer === 'string') {
    prompter.rejectAnswer('structure.status_fields', `${kind}: ${name} is not a text field your notes have; to add a new status field, answer {"starter": ${JSON.stringify(name)}}.`);
    return null;
  }
  const problem = newStatusFieldProblem(analysis, name, typeKey);
  if (problem !== null) {
    prompter.rejectAnswer('structure.status_fields', `${kind}: ${problem}`);
    return null;
  }
  return { field: name, starter: true };
}

/**
 * Why a new status field cannot take `name`; a text field the notes have is reused. The
 * type key holds each note's types, and Engine refuses a field of its name (#445).
 */
function newStatusFieldProblem(analysis: AnalyzeReport | null, name: string, typeKey: string): string | null {
  if (!isTypeName(name)) return `"${name}" cannot be a field name.`;
  if (name === typeKey) return `${name} is the field that holds each note's types; choose another name.`;
  if (textFieldNames(analysis).includes(name)) return null;
  if (STARTER_FIELD_NAMES.has(name)) return `${name} is a field new types use for something else; choose another name.`;
  if (fieldNameTaken(analysis, name)) return `your notes already use ${name} for values that are not plain text; choose another name.`;
  return null;
}

/** A field named status whose values cannot hold a status, as a warning. */
function statusShapeProblem(analysis: AnalyzeReport | null): string | null {
  const review = analysis?.needs_review.ambiguous_fields.find(field => field.name === 'status');
  if (review) return 'Your notes use the status line in more than one way, so Vault leaves it as it is and reads no status from it until that is fixed.';
  const other = analysis?.proposal.global_fields.find(field => field.name === 'status' && field.field_type !== 'string' && field.field_type !== 'enum');
  if (other) return `Your status line holds ${describeFieldType(other)}, so Vault reads no status from it: a status is text.`;
  return null;
}

/** The questions about what a kind's status values mean. */
const MEANING_QUESTIONS: Record<StatusKind, {
  active: AnswerId;
  groups: AnswerId;
  activeMessage: string;
  groupsTitle: string;
  groupsMessage: string;
}> = {
  project: {
    active: 'structure.active_statuses',
    groups: 'structure.status_groups',
    activeMessage: 'Which project statuses mean "still active"? Curator keeps wikis current only for active projects.',
    groupsTitle: 'Other project statuses',
    groupsMessage: 'Keep these meanings for the other project statuses?',
  },
  task: {
    active: 'structure.task_active_statuses',
    groups: 'structure.task_status_groups',
    activeMessage: 'Which task statuses mean "still open"? Wikis list these tasks as open work.',
    groupsTitle: 'Other task statuses',
    groupsMessage: 'Keep these meanings for the other task statuses?',
  },
};

const STATUS_GROUP_LABELS: Record<keyof StatusGroups, string> = {
  done: 'done (finished)',
  blocked: 'blocked (waiting on something)',
  backlog: 'backlog (not started)',
  ignored: 'dropped (left out of wikis)',
};

/**
 * Which values of a kind's status field mean active, and how the others group. An enum
 * field (including a new one) rejects other values, so these must be among its values.
 * When the field has more values than the Analyzer samples, others can be typed in.
 */
async function chooseStatusMeanings(
  prompter: Prompter,
  kind: StatusKind,
  analysis: AnalyzeReport | null,
  choice: StatusFieldChoice,
  warnings: string[],
): Promise<StatusPlan> {
  if (choice === null) return NO_STATUS;
  const questions = MEANING_QUESTIONS[kind];
  const { values, restricted, incomplete } = statusValues(analysis, choice);
  if (incomplete) {
    warnings.push(`Your ${choice.field} line has more than ${count(values.length, 'value')}; Vault looked at only those, so check which ${kind} statuses mean active.`);
  }
  const preselected = detectActiveStatuses(values, kind);
  const statuses = await prompter.decide<string[]>({
    id: questions.active,
    async ask() {
      const chosen = await prompter.multiselect({
        id: questions.active,
        message: questions.activeMessage,
        options: [
          ...values.map(value => ({ value, label: value })),
          ...(incomplete ? [{ value: OTHER_STATUSES, label: 'Other values…', hint: 'not among those sampled' }] : []),
        ],
        initialValues: preselected,
      });
      const statuses = chosen.filter(value => value !== OTHER_STATUSES);
      if (chosen.includes(OTHER_STATUSES)) {
        const typed = await prompter.text({
          id: questions.active,
          message: 'Other active statuses, separated by commas:',
          allowEmpty: true,
        });
        for (const value of typed.split(',').map(part => part.trim()).filter(Boolean)) {
          if (!statuses.includes(value)) statuses.push(value);
        }
      }
      return statuses;
    },
    defaultValue: () => preselected,
  });
  const unsupported = restricted ? statuses.filter(status => !values.includes(status)) : [];
  if (unsupported.length > 0) {
    prompter.rejectAnswer(
      questions.active,
      `${unsupported.join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} not among the status values (${values.join(', ')}).`,
    );
  }
  const active = statuses.filter(status => !unsupported.includes(status));
  return { field: choice.field, starter: choice.starter, active, groups: await chooseStatusGroups(prompter, questions, values, active, restricted) };
}

/**
 * Group the other status values, detected by name. An enum status rejects other values,
 * so the groups must use its values; no value is both active and in a group.
 */
async function chooseStatusGroups(
  prompter: Prompter,
  questions: typeof MEANING_QUESTIONS[StatusKind],
  values: readonly string[],
  active: readonly string[],
  restricted: boolean,
): Promise<StatusGroups> {
  const others = values.filter(value => !active.includes(value));
  const detected = detectStatusGroups(values, active);
  const answered = await prompter.decide<Partial<StatusGroups>>({
    id: questions.groups,
    async ask() {
      if (others.length === 0) return detected;
      prompter.note(STATUS_GROUPS.map(group => `${STATUS_GROUP_LABELS[group]}: ${detected[group].join(', ') || 'none'}`).join('\n'), questions.groupsTitle);
      if (await prompter.confirm({ message: questions.groupsMessage, initialValue: true, active: 'Keep', inactive: 'Change' })) return detected;
      const chosen: Partial<StatusGroups> = {};
      for (const group of STATUS_GROUPS) {
        chosen[group] = await prompter.multiselect({
          id: questions.groups,
          message: `Which status values mean ${STATUS_GROUP_LABELS[group]}?`,
          options: others.map(value => ({ value, label: value })),
          initialValues: detected[group],
        });
      }
      return chosen;
    },
    defaultValue: () => detected,
  });
  const groups = { ...detected, ...answered };
  for (const group of STATUS_GROUPS) {
    const invalid = groups[group].filter(value => active.includes(value) || (restricted && !values.includes(value)));
    if (invalid.length > 0) {
      prompter.rejectAnswer(questions.groups, `${group}: ${invalid.join(', ')} ${invalid.length === 1 ? 'is' : 'are'} active or not among the status values (${values.join(', ')}).`);
      groups[group] = groups[group].filter(value => !invalid.includes(value));
    }
  }
  return groups;
}

/**
 * The map's other field names (due date, date, people, company, priority, scheduled date),
 * each a line among `names` (the notes' own and those the plan adds) found by name, or
 * none. Each can be changed to any of those lines, or to none.
 */
async function chooseMapFields(prompter: Prompter, names: readonly string[]): Promise<Record<MapField, string | null>> {
  const detected = detectMapFields(names);
  const answered = await prompter.decide<Partial<Record<MapField, string | null>>>({
    id: 'structure.fields',
    async ask() {
      if (names.length === 0) return detected;
      prompter.note(MAP_FIELDS.map(field => `${MAP_FIELD_LABELS[field]}: ${detected[field] ?? 'none'}`).join('\n'), 'Other lines Vault reads');
      if (await prompter.confirm({ message: 'Keep these?', initialValue: true, active: 'Keep', inactive: 'Change' })) return detected;
      const chosen: Partial<Record<MapField, string | null>> = {};
      for (const field of MAP_FIELDS) {
        const value = await prompter.select<string>({
          id: 'structure.fields',
          message: `Which line holds ${FIELD_QUESTIONS[field]}?`,
          options: [
            ...mapFieldCandidates(field, names).map(name => ({ value: name, label: name })),
            { value: NONE_CHOICE, label: 'None', hint: FIELD_OFF_WORDS[field] },
          ],
          initialValue: detected[field] ?? NONE_CHOICE,
        });
        chosen[field] = value === NONE_CHOICE ? null : value;
      }
      return chosen;
    },
    defaultValue: () => detected,
  });
  const fields = { ...detected };
  for (const field of MAP_FIELDS) {
    const answer = answered[field];
    if (answer === undefined) continue;
    if (answer !== null && !names.includes(answer)) {
      prompter.rejectAnswer('structure.fields', `${field}: ${answer} is not a field your notes have or a new type adds.`);
      continue;
    }
    fields[field] = answer;
  }
  return fields;
}

/** What each of the map's other lines holds, as a question names it. */
const FIELD_QUESTIONS: Record<MapField, string> = {
  due: 'the date a task is due',
  date: 'the date of a meeting or a note',
  people: 'the people a note involves (links to their notes)',
  company: 'the company a note is about (a link to its note)',
  priority: 'a task\'s priority',
  scheduled: 'the date a task is scheduled for',
};

interface Additions {
  starterTypes: StarterType[];
  starterFields: FieldDefinition[];
  extraClaims: Array<{ schema: string; field: string }>;
}

/**
 * The types and fields the map needs beyond the Analyzer's proposal: each new type the
 * user asked for, with its fields; each new status field the user chose; and a claim of
 * each kind's status field on its type. Nothing is added for a kind that is none.
 */
function planAdditions(
  analysis: AnalyzeReport | null,
  roles: Record<Role, string | null>,
  starters: ReadonlySet<Role>,
  status: Record<StatusKind, StatusPlan>,
  warnings: string[],
): Additions {
  const proposedFields = new Set(analysis?.proposal.global_fields.map(field => field.name) ?? []);
  const reviewFields = new Set(analysis?.needs_review.ambiguous_fields.map(field => field.name) ?? []);
  const starterTypes: StarterType[] = [];
  const starterFields = new Map<string, FieldDefinition>();
  const extraClaims: Additions['extraClaims'] = [];

  for (const role of ROLES) {
    const name = roles[role];
    if (name === null) continue;
    const statusField = (STATUS_KINDS as readonly string[]).includes(role) ? status[role as StatusKind] : NO_STATUS;
    if (statusField.field !== null && statusField.starter && !starterFields.has(statusField.field)) {
      starterFields.set(statusField.field, starterStatusDefinition(statusField.field));
    }
    if (!starters.has(role)) {
      const schema = analysis?.proposal.schemas.find(candidate => candidate.name === name);
      const field = statusField.field;
      if (field !== null && schema && !schema.field_claims.some(claim => claim.field === field)
        && !extraClaims.some(claim => claim.schema === name && claim.field === field)) {
        extraClaims.push({ schema: name, field });
      }
      continue;
    }
    const claims = statusField.field !== null ? [statusField.field] : [];
    for (const field of STARTER_TYPE_FIELDS[role]) {
      if (reviewFields.has(field)) {
        warnings.push(`The new ${name} kind does not get a ${field} line, because your notes use ${field} in more than one way.`);
        continue;
      }
      if (!proposedFields.has(field) && !starterFields.has(field)) {
        const definition = starterFieldDefinition(field, roles);
        if (definition) starterFields.set(field, definition);
      }
      claims.push(field);
    }
    starterTypes.push({ name, role, claims });
  }
  return { starterTypes, starterFields: [...starterFields.values()], extraClaims };
}
