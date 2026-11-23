import { z } from 'zod';
import { followRenamedTitle, type CoreDeps } from '../core.js';
import { withScope, type ToolHandler, type ToolResult } from '../auth/with-scope.js';
import { setPaused, addCorrection, resolveCorrection, controlState } from '../db/control.js';
import { stampPause } from '../wiki-status.js';

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const NO_DB: ToolResult = jsonResult(
  { ok: false, error: { code: 'NO_DB', message: 'control state requires the curator DB (server mode)' } }, true,
);

function stateResult(deps: CoreDeps, project: string): ToolResult {
  return jsonResult({ ok: true, ...controlState(deps.db!, project) });
}

/** set-wiki-paused — pause or resume a wiki. */
export const setWikiPausedInput = {
  project: z.string().min(1).describe('Project title, or a topic wiki\'s name, whose wiki to pause/resume'),
  paused: z.boolean().describe('true = pause (scheduled sweeps skip this wiki, and it only changes when someone asks for a rebuild); false = resume'),
};
type SetPausedArgs = { project: string; paused: boolean };
export function makeSetWikiPausedHandler(deps: CoreDeps): ToolHandler<SetPausedArgs> {
  return withScope<SetPausedArgs>('curate:trigger', async (args, extra) => {
    if (!deps.db) return NO_DB;
    await followRenamedTitle(deps, args.project);
    setPaused(deps.db, args.project, args.paused, extra.authInfo?.clientId ?? null, new Date().toISOString());
    // The home shows it (#547). Best-effort: the pause above stands whatever this does.
    const wikiStatus = await stampPause(deps, args.project, args.paused);
    return jsonResult({ ok: true, ...controlState(deps.db, args.project), wiki_status: wikiStatus });
  });
}

/** add-wiki-correction — attach a standing steering note. */
export const addWikiCorrectionInput = {
  project: z.string().min(1).describe('Project title whose wiki the correction steers'),
  note: z.string().min(1).describe('A standing steering note injected into every run until resolved (e.g. "stop surfacing X; it is done")'),
};
type AddCorrectionArgs = { project: string; note: string };
export function makeAddWikiCorrectionHandler(deps: CoreDeps): ToolHandler<AddCorrectionArgs> {
  return withScope<AddCorrectionArgs>('curate:trigger', async (args, extra) => {
    if (!deps.db) return NO_DB;
    await followRenamedTitle(deps, args.project);
    addCorrection(deps.db, {
      project_title: args.project, note: args.note,
      created_by: extra.authInfo?.clientId ?? null, created_at: new Date().toISOString(),
    });
    return stateResult(deps, args.project);
  });
}

/** resolve-wiki-correction — remove a standing correction (soft-resolve). */
export const resolveWikiCorrectionInput = {
  project: z.string().min(1).describe('Project title the correction belongs to'),
  correction_id: z.number().int().positive().describe('The id of the correction to resolve (from curator-status control.corrections)'),
};
type ResolveCorrectionArgs = { project: string; correction_id: number };
export function makeResolveWikiCorrectionHandler(deps: CoreDeps): ToolHandler<ResolveCorrectionArgs> {
  return withScope<ResolveCorrectionArgs>('curate:trigger', async (args) => {
    if (!deps.db) return NO_DB;
    await followRenamedTitle(deps, args.project);
    const resolved = resolveCorrection(deps.db, args.correction_id, new Date().toISOString());
    if (!resolved) {
      return jsonResult({ ok: false, error: { code: 'NOT_FOUND', message: `no active correction with id ${args.correction_id}` } }, true);
    }
    return stateResult(deps, args.project);
  });
}
