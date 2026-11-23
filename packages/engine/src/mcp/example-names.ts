import type Database from 'better-sqlite3';
import { vaultSettingsFrom, type VaultSettings } from '@vault/settings-registry';
import { getVaultSettings } from '../settings/vault.js';

/**
 * The names that tool descriptions use in their examples, taken from the vault map
 * (`Settings/Vault.md`), so an example query names the vault's own kinds, fields and
 * statuses. A kind or field the map sets to none, or a status list it leaves empty, becomes a
 * neutral placeholder such as `<task type>`; a default name never stands in for it.
 *
 * Descriptions are built when a session's tools are registered: over HTTP every MCP session
 * builds its own, so a map change shows from the next session on (stdio: after a restart).
 */
export interface ExampleNames {
  /** The map the names come from, for a description that leaves a sentence out when a name is none. */
  vault: VaultSettings;
  task: string;
  project: string;
  /** The general-purpose note kind (`journalType`). */
  note: string;
  taskStatus: string;
  projectStatus: string;
  due: string;
  /** The first active task status. */
  open: string;
  /** The first done task status. */
  done: string;
  /** The first done project status. */
  projectDone: string;
  /** Two task statuses, for a one_of example. */
  statusPair: [string, string];
}

/** A designated name, or the placeholder when the map says none. */
function named(value: string | null | undefined, placeholder: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : placeholder;
}

function statuses(...lists: Array<readonly string[] | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const status of Array.isArray(list) ? list : []) {
      if (typeof status === 'string' && status.trim() !== '' && !out.includes(status)) out.push(status);
    }
  }
  return out;
}

export function exampleNames(vault: VaultSettings): ExampleNames {
  const taskStatuses = statuses(vault.taskActiveStatuses, vault.taskBlockedStatuses,
    vault.taskBacklogStatuses, vault.taskDoneStatuses, vault.taskIgnoredStatuses);
  return {
    vault,
    task: named(vault.taskType, '<task type>'),
    project: named(vault.projectType, '<project type>'),
    note: named(vault.journalType, '<note type>'),
    taskStatus: named(vault.taskStatusField, '<status field>'),
    projectStatus: named(vault.projectStatusField, '<status field>'),
    due: named(vault.dueField, '<due field>'),
    open: named(statuses(vault.taskActiveStatuses)[0], '<open status>'),
    done: named(statuses(vault.taskDoneStatuses)[0], '<done status>'),
    projectDone: named(statuses(vault.projectDoneStatuses)[0], '<done status>'),
    statusPair: [named(taskStatuses[0], '<status>'), named(taskStatuses[1], '<other status>')],
  };
}

const DEFAULT_VAULT = vaultSettingsFrom({});

/** The example names with every vault map default, as a vault that never edits the map has them. */
export const DEFAULT_EXAMPLE_NAMES: ExampleNames = exampleNames(DEFAULT_VAULT);

/**
 * The example names for this vault. Never throws: if the map cannot be read, the descriptions
 * use the default names, as they did before the map existed, so every tool still registers.
 */
export function exampleNamesFor(db: Database.Database): ExampleNames {
  try {
    return exampleNames(vaultSettingsFrom({ vault: { effective: getVaultSettings(db) } }));
  } catch (err) {
    console.warn(`[mcp] tool descriptions use the default vault names; the vault map could not be read: ${
      err instanceof Error ? err.message : String(err)}`);
    return DEFAULT_EXAMPLE_NAMES;
  }
}

/** A name as a key in a JavaScript-style example (`{fields:{status:…}}`): bare when it can be, else quoted. */
export function exampleKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Swap parameter descriptions in an advertised JSON schema: each `description` equal to a key
 * of `replacements` becomes its value. A shared zod schema validates with the default
 * descriptions; this gives one session's advertised copy the vault's own names.
 */
export function replaceDescriptions(schema: unknown, replacements: ReadonlyMap<string, string>): void {
  if (Array.isArray(schema)) {
    for (const item of schema) replaceDescriptions(item, replacements);
    return;
  }
  if (schema === null || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') node[key] = replacements.get(value) ?? value;
    else replaceDescriptions(value, replacements);
  }
}
