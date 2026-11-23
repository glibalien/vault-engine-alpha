import { join } from 'node:path';
import { EngineToolError } from './engine-client.js';
import { connectAsInstaller, type EngineStageDeps } from './engine-stage.js';
import { EXIT_BLOCKED, EXIT_OK } from './exit.js';
import { revokeInstallerTokens } from './handoff.js';
import type { Host } from './host.js';
import { installerCommand } from './layout.js';
import { withSpinner, type Prompter } from './prompter.js';
import { plannedManager, startCommand } from './service-manager.js';
import { ENGINE_UNIT } from './units.js';
import { saveState, type InstallState } from './state.js';
import { count, shellCommand } from './text.js';

/** Engine keeps each operation this long before `undo-operations` refuses it. */
const UNDO_WINDOW_MS = 24 * 60 * 60_000;
/** Undoing rewrites every note adoption changed, which can take a while on a large vault. */
const UNDO_TIMEOUT_MS = 10 * 60_000;
const LISTED = 10;

export interface UndoDeps {
  host: Host;
  prompter: Prompter;
  /** Undo without asking (headless). */
  yes: boolean;
  now: Date;
  /** Test seam; production connects over MCP. */
  connect?: EngineStageDeps['connect'];
}

/** What Engine's `undo-operations` returns, dry run or not. */
interface UndoResult {
  operations: Array<{ operation_id: string; node_count: number; schema_count: number; global_field_count: number }>;
  conflicts: Array<{ node_id: string; file_path: string; reason: string }>;
  total_undone: number;
}

/**
 * `vault-installer undo`: revert what adoption changed, with Engine's `undo-operations`
 * and the operations recorded in `installer/state.json`. A dry run shows what would change
 * first; notes changed since adoption keep their current content. Engine must be running,
 * and keeps the operations for 24 hours; after that, or when Engine refuses, the backup is
 * the way back.
 */
export async function runUndo(deps: UndoDeps, state: InstallState, path: string): Promise<number> {
  const { host, prompter } = deps;
  prompter.intro('Vault Installer · undo organizing your notes');
  const adopt = state.stages.adopt;
  if (!adopt || adopt.operations.length === 0) {
    prompter.outro(adopt?.undone_at
      ? `The changes organizing your notes made were undone on ${adopt.undone_at}. Nothing was changed.`
      : 'Organizing your notes has changed nothing yet, so there is nothing to undo.');
    return EXIT_OK;
  }

  const port = state.plan.services.engine_port;
  if (await host.httpStatus(`http://127.0.0.1:${port}/mcp`, {}, 2000) !== 200) {
    prompter.outro([
      `Engine is not answering at http://127.0.0.1:${port}/mcp, and undo goes through it. Start it with \`${startCommand(plannedManager(state.plan.services), ENGINE_UNIT)}\` and run \`${installerCommand(host, 'undo', state.plan.data_dir)}\` again.`,
      ...backupAdvice(state, host),
    ].join('\n'));
    return EXIT_BLOCKED;
  }

  try {
    const call = await connectAsInstaller({ host, ...(deps.connect ? { connect: deps.connect } : {}) }, state.plan);
    const undo = (operations: string[], args: Record<string, unknown>) => call<UndoResult>('undo-operations',
      { operation_ids: operations, ...args }, args.dry_run === false ? { timeoutMs: UNDO_TIMEOUT_MS } : {});
    // Undoing a field definition keeps the values notes have for it (Engine #468, shipped
    // from the same checkout), so every operation adoption made is undone.
    const operations = adopt.operations;
    const preview = await undo(operations, { dry_run: true });
    const skipped = conflictedNotes(preview);
    prompter.note(describePreview(state, preview, skipped), 'Undo organizing your notes');

    const approved = prompter.interactive
      ? await prompter.confirm({ message: 'Undo these changes?', initialValue: false })
      : deps.yes;
    if (!approved) {
      prompter.outro(prompter.interactive ? 'Nothing was changed.' : 'Nothing was changed. Run again with --yes to undo these changes.');
      return EXIT_OK;
    }

    const result = await withSpinner(prompter, 'Undoing…', () => undo(operations, {
      dry_run: false,
      // A note changed since adoption keeps what it says now, rather than losing that change.
      ...(skipped.length > 0 ? { resolve_conflicts: skipped.map(note => ({ node_id: note.node_id, action: 'skip' })) } : {}),
    }), done => `Undid ${count(done.total_undone, 'note change')}.`);

    adopt.operations = [];
    adopt.undone_at = deps.now.toISOString();
    await saveState(path, state);
    const kept = conflictedNotes(result);
    prompter.outro([
      'The changes organizing your notes made are undone.',
      ...(kept.length > 0 ? [`${count(kept.length, 'note')} changed after organizing kept ${kept.length === 1 ? 'its' : 'their'} current content: ${listed(kept)}`] : []),
      'Engine wrote each note it reverted in its own layout; the backup has them exactly as they were.',
      `The settings and models the installer applied stay. To start over, run \`${installerCommand(host, 'uninstall', state.plan.data_dir)}\` next, then install again.`,
    ].join('\n'));
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof EngineToolError)) throw error;
    const adopted = adopt.started_at;
    prompter.outro([
      error.code === 'OPERATION_NOT_FOUND'
        ? `Engine no longer has these changes to undo. It keeps them for 24 hours (organizing started ${adopted}), and some may have been undone already.`
        : `Engine refused the undo: ${error.message}`,
      ...backupAdvice(state, host),
    ].join('\n'));
    return EXIT_BLOCKED;
  } finally {
    // A finished install keeps no installer token, as with `vault-installer status`.
    if (state.stages.handoff?.completed_at) await revokeInstallerTokens(host, state.plan);
  }
}

function describePreview(state: InstallState, preview: UndoResult, skipped: ReadonlyArray<{ file_path: string }>): string {
  const total = (key: 'node_count' | 'schema_count' | 'global_field_count') => preview.operations.reduce((sum, operation) => sum + operation[key], 0);
  const until = undoDeadline(state)?.toISOString();
  const types = total('schema_count');
  const definitions = total('global_field_count');
  return [
    `Engine would undo ${count(preview.operations.length, 'operation')} from organizing your notes:`,
    `- Notes: ${count(total('node_count'), 'note change')}, so each note gets back the types and values it had.`,
    ...(types > 0 ? [`- Types: ${count(types, 'change')}; types organizing created are removed.`] : []),
    ...(definitions > 0 ? [`- Fields: the ${count(definitions, 'field')} organizing defined are removed; notes keep their values for them, unmanaged again.`] : []),
    ...(skipped.length > 0
      ? [`${count(skipped.length, 'note')} changed after organizing ${skipped.length === 1 ? 'keeps its' : 'keep their'} current content: ${listed(skipped)}`]
      : []),
    ...(until ? [`Engine keeps these changes until about ${until}.`] : []),
  ].join('\n');
}

/**
 * About when Engine stops keeping adoption's operations, or null when none are left to
 * undo. Each expires 24 hours after it was made, so this counts from adoption's start.
 */
export function undoDeadline(state: InstallState): Date | null {
  const adopt = state.stages.adopt;
  if (!adopt || adopt.operations.length === 0) return null;
  return new Date(Date.parse(adopt.started_at) + UNDO_WINDOW_MS);
}

/** Notes Engine reports as changed since adoption, once each. */
function conflictedNotes(result: UndoResult): Array<{ node_id: string; file_path: string }> {
  const notes = new Map<string, string>();
  for (const conflict of result.conflicts) notes.set(conflict.node_id, conflict.file_path);
  return [...notes].map(([node_id, file_path]) => ({ node_id, file_path }));
}

function listed(notes: ReadonlyArray<{ file_path: string }>): string {
  const shown = notes.slice(0, LISTED).map(note => note.file_path).join(', ');
  return notes.length > LISTED ? `${shown}, and ${notes.length - LISTED} more.` : `${shown}.`;
}

/** Where the notes as they were before installing are, and how to put them back. */
export function backupAdvice(state: InstallState, host: Pick<Host, 'env' | 'homeDir'>): string[] {
  const backup = state.stages.backup;
  const vault = state.plan.vault?.path;
  if (!backup?.directory || !backup.completed_at || !vault) {
    return ['No backup of the notes was taken, so there is no copy from before installing to restore.'];
  }
  return [
    `Your notes as they were before installing are in ${join(backup.directory, 'vault')} (listed in ${join(backup.directory, 'manifest.json')}).`,
    `To put them back, stop Engine (\`${installerCommand(host, 'uninstall', state.plan.data_dir)}\` does), then copy the backup over the vault: ${shellCommand(['cp', '-a', `${join(backup.directory, 'vault')}/.`, `${vault}/`])}`,
    'That replaces every note changed since the backup, by you as well; notes added since stay.',
  ];
}
