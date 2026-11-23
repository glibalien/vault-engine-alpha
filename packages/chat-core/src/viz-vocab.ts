import { vaultSettingsFrom, type VaultSettings } from '@vault/settings-registry';
import { parseEnvelope, type EngineCall } from './tools.js';

export interface SchemaFieldVocab { name: string; type: string; enum_values?: string[]; reference_target?: string }
export interface TypeVocab { name: string; count: number; fields: SchemaFieldVocab[] }
export interface VizVocabulary {
  types: TypeVocab[];
  /** The vault map's names the prompt examples are built from (`vaultSettingsFrom`); absent:
   *  the map's defaults, today's names. The host reads them; chat-core never calls Engine for them. */
  vault?: VizVaultNames;
}

/** The names in Engine's vault map (`Settings/Vault.md`) the viz prompts and present-viz use.
 *  A kind or field that is null is none: no example names it. */
export type VizVaultNames = Pick<VaultSettings,
  'taskType' | 'taskStatusField' | 'taskActiveStatuses' | 'taskDoneStatuses' | 'taskTickStatus' | 'taskUntickStatus'
  | 'dueField' | 'dateField' | 'scheduledField'>;

/** The vault map at its defaults: the names the prompts used before the map existed. */
export const DEFAULT_VAULT_NAMES: VizVaultNames = vaultSettingsFrom(undefined);

/** The names a prompt example uses, each null when the vault has none (the example is then neutral). */
export interface VizExampleNames {
  /** The task kind, plural, for a card title ("tasks"). */
  tasks: string | null;
  /** The task status field: the kanban's default column field. */
  status: string | null;
  /** A done status (the first, else the tick value) and an active one (the first, else the untick value). */
  done: string;
  open: string;
  /** The first date field the vault has: due, date, scheduled. */
  date: string | null;
  due: string | null;
}

export function vizExampleNames(v: VizVaultNames = DEFAULT_VAULT_NAMES): VizExampleNames {
  return {
    tasks: v.taskType === null ? null : /s$/i.test(v.taskType) ? v.taskType : `${v.taskType}s`,
    status: v.taskStatusField,
    done: v.taskDoneStatuses[0] ?? v.taskTickStatus,
    open: v.taskActiveStatuses[0] ?? v.taskUntickStatus,
    date: v.dueField ?? v.dateField ?? v.scheduledField,
    due: v.dueField,
  };
}

/** Cap on described types — sorted by node count, so these are the biggest. */
export const MAX_VOCAB_TYPES = 16;

/** Render caps so one wide schema can't dominate the prompt (renderVocabulary). */
export const MAX_VOCAB_FIELDS_PER_TYPE = 32;
export const MAX_VOCAB_ENUM_VALUES_PER_FIELD = 20;

interface EnvelopeLike { ok?: boolean; data?: unknown; error?: { message?: string } }
interface TypeRow { name: string; node_count: number; has_schema: boolean }
interface SchemaFieldRow { name: string; type: string; enum_values?: string[]; reference_target?: string }

function unwrap(envelope: unknown, what: string): unknown {
  const e = (envelope ?? {}) as EnvelopeLike;
  if (!e.ok) throw new Error(e.error?.message ?? `${what} failed`);
  return e.data;
}

/**
 * Vault vocabulary for the board interpreter: every schema-bearing type (top
 * MAX_VOCAB_TYPES by node count) with its fields, enum spellings, and reference
 * targets — the same describe-schema data the viz chips render from.
 *
 * One failed describe-schema shouldn't kill the whole vocabulary (Promise.allSettled),
 * so a single corrupt/missing type just gets skipped. But if EVERY describe call
 * failed (and there was at least one schema-bearing type to describe), that's not
 * "one bad type" — it means the engine itself is broken, so this still throws,
 * carrying one of the failure messages. list-schemas failing is unrelated to this
 * and still throws immediately (unwrap), unchanged.
 */
export async function fetchVizVocabulary(call: EngineCall): Promise<VizVocabulary> {
  const rows = unwrap(parseEnvelope(await call('list-schemas', {})), 'list-schemas') as TypeRow[];
  const withSchema = (rows ?? [])
    .filter((r) => r.has_schema && r.node_count > 0)
    .sort((a, b) => b.node_count - a.node_count || a.name.localeCompare(b.name))
    .slice(0, MAX_VOCAB_TYPES);
  const settled = await Promise.allSettled(withSchema.map(async (r): Promise<TypeVocab> => {
    const schema = unwrap(parseEnvelope(await call('describe-schema', { name: r.name })), `describe-schema ${r.name}`) as { fields?: SchemaFieldRow[] };
    const fields = (schema.fields ?? []).map((f): SchemaFieldVocab => ({
      name: f.name,
      type: f.type,
      ...(f.enum_values?.length ? { enum_values: f.enum_values } : {}),
      ...(f.reference_target ? { reference_target: f.reference_target } : {}),
    }));
    return { name: r.name, count: r.node_count, fields };
  }));

  const types = settled
    .filter((s): s is PromiseFulfilledResult<TypeVocab> => s.status === 'fulfilled')
    .map((s) => s.value);

  if (withSchema.length > 0 && types.length === 0) {
    const firstFailure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    const reason = firstFailure?.reason;
    throw reason instanceof Error ? reason : new Error(String(reason ?? 'every describe-schema call failed'));
  }

  return { types };
}

/**
 * One line per type: `task (312): status: enum(open|done) · due: date · project: reference→project`.
 * Caps fields per type at MAX_VOCAB_FIELDS_PER_TYPE and enum values per field at
 * MAX_VOCAB_ENUM_VALUES_PER_FIELD so one unusually wide schema can't dominate the
 * prompt — truncation is marked with `|…` inside the enum parens and ` · …` at the
 * end of a type's field list.
 */
export function renderVocabulary(v: VizVocabulary): string {
  return v.types.map((t) => {
    const shownFields = t.fields.slice(0, MAX_VOCAB_FIELDS_PER_TYPE);
    const fields = shownFields.map((f) => {
      // `name: kind`, never `name kind`: the model read `due date` as a field named "due date" (#620).
      let s = `${f.name}: ${f.type}`;
      if (f.enum_values?.length) {
        const shownValues = f.enum_values.slice(0, MAX_VOCAB_ENUM_VALUES_PER_FIELD);
        const valuesTruncated = f.enum_values.length > MAX_VOCAB_ENUM_VALUES_PER_FIELD;
        s += `(${shownValues.join('|')}${valuesTruncated ? '|…' : ''})`;
      }
      if (f.reference_target) s += `→${f.reference_target}`;
      return s;
    }).join(' · ');
    const fieldsTruncated = t.fields.length > MAX_VOCAB_FIELDS_PER_TYPE;
    return `${t.name} (${t.count}): ${fields}${fieldsTruncated ? ' · …' : ''}`;
  }).join('\n');
}
