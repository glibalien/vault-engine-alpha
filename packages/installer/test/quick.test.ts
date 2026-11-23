import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnswerId } from '../src/answers.js';
import { EXIT_OK, runCli, type CliDeps } from '../src/cli.js';
import type { Host } from '../src/host.js';
import { NO_MODEL_KEY_WARNING } from '../src/providers.js';
import { SETUP_MODE_QUESTION } from '../src/quick.js';
import { fm, makeTree, realFilesystemHost, removeTrees, replayPrompter, REPO_ROOT, SOURCE_ANALYZER } from './helpers.js';

afterEach(removeTrees);

/** The key quick setup finds on this computer in most tests. */
const ENV: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-ant-quick-0123456789' };
const FROM_ENV = { source: 'env', name: 'ANTHROPIC_API_KEY' };
const NONE = '\u0000none';
const SEVERAL = '\u0000several';

/** A vault whose notes say what kind they are, with a template folder and an untyped note. */
const TYPICAL = {
  'Projects/Alpha.md': fm({ type: 'project', status: 'active' }),
  'Projects/Beta.md': fm({ type: 'project', status: 'done' }),
  'Tasks/Write the outline.md': fm({ type: 'task', status: 'todo', due: '2026-11-20' }),
  'Meetings/Kickoff.md': fm({ type: 'meeting', date: '2026-11-01' }),
  'People/Avery.md': fm({ type: 'person' }),
  'Templates/Project.md': fm({ type: 'project' }),
  'Inbox.md': '# Inbox\n',
};

function deps(prompter: CliDeps['createInteractivePrompter'] | null, host: Partial<Host> = {}): CliDeps {
  return {
    host: realFilesystemHost({ env: name => ENV[name], ...host }),
    cwd: '/',
    repoRoot: REPO_ROOT,
    analyzerCommand: SOURCE_ANALYZER,
    createInteractivePrompter: prompter ?? (() => { throw new Error('headless'); }),
    now: () => new Date('2026-11-11T12:00:00Z'),
  };
}

function io(isInteractive: boolean) {
  const output = { stdout: '', stderr: '' };
  return {
    output,
    io: { stdout: (text: string) => { output.stdout += text; }, stderr: (text: string) => { output.stderr += text; }, isInteractive },
  };
}

/**
 * `plan` through quick setup: answers `script` per question id (anything else takes its
 * default, which a quick run never asks), and returns the plan it wrote and what it asked.
 */
async function quickPlan(
  root: string,
  script: Partial<Record<AnswerId, unknown[]>>,
  options: { host?: Partial<Host>; checkNetwork?: boolean } = {},
) {
  const replay = replayPrompter({ 'vault.path': [root], ...script });
  const infos: string[] = [];
  const warnings: string[] = [];
  // Messages come broken into lines for an 80-column terminal; compared as one line each.
  replay.prompter.info = message => { infos.push(message.replace(/\n/g, ' ')); };
  replay.prompter.warn = message => { warnings.push(message.replace(/\n/g, ' ')); };
  const out = join(await makeTree({}), 'plan.json');
  const run = io(true);
  const code = await runCli(
    ['plan', '--out', out, ...(options.checkNetwork ? [] : ['--skip-network-check'])],
    run.io,
    deps(() => replay.prompter, options.host),
  );
  expect({ code, stderr: run.output.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
  const map = replay.notes.find(note => note.title === 'What Vault found in your notes')?.message ?? '';
  return { report: JSON.parse(await readFile(out, 'utf8')), map, infos, warnings, ...replay };
}

/**
 * A plan without the attachment-extraction answer, which an interactive run (quick or
 * not) asks after adoption and a headless run settles while planning.
 */
function withoutExtraction(plan: { review: { paid_calls: string[] } }) {
  return {
    ...plan,
    extraction_approved: null,
    review: { ...plan.review, paid_calls: plan.review.paid_calls.filter(line => !line.startsWith('Attachment extraction')) },
  };
}

/** `plan --answers` with these answers: what a headless run plans. */
async function headlessPlan(answers: Record<string, unknown>) {
  const path = join(await makeTree({}), 'answers.json');
  await writeFile(path, JSON.stringify({ version: 1, ...answers }));
  const run = io(false);
  expect(await runCli(['plan', '--answers', path, '--json', '--skip-network-check'], run.io, deps(null))).toBe(EXIT_OK);
  return JSON.parse(run.output.stdout);
}

describe('quick setup', () => {
  it('asks only for the folder and one key, and plans what a headless run with just those answers plans', async () => {
    const root = await makeTree(TYPICAL);

    const { report, asked, confirmed, map, infos } = await quickPlan(root, { providers: ['anthropic'], 'providers.anthropic': [FROM_ENV] });

    // The welcome choice, the folder, which service, and its key (install adds the approval).
    // And the short review's "Show every file and command?" (#437).
    expect(confirmed).toEqual([SETUP_MODE_QUESTION.message, 'Show every file and command?']);
    expect(asked).toEqual(['vault.path', 'providers', 'providers.anthropic']);
    const headless = await headlessPlan({ vault: { path: root }, providers: { anthropic: 'env:ANTHROPIC_API_KEY' } });
    expect(withoutExtraction(report)).toEqual(withoutExtraction(headless));
    // The defaults a headless run takes: the template folder left out, the detected kinds
    // and fields with none where nothing was found, Curator at $1 a day at 05:00, the
    // balanced models, and a copy of the notes.
    expect(report.vault.exclusions).toEqual(['Templates']);
    expect(report.structure.roles).toEqual({ project: 'project', task: 'task', meeting: 'meeting', person: 'person', company: null });
    expect(report.structure.starter_types ?? []).toEqual([]);
    expect(report.curator).toMatchObject({ daily_budget_cents: 100, sweep_at: '05:00', tz: 'UTC', wiki_mode: 'live' });
    expect(report.models.preset).toBe('balanced');
    expect(report.backup).toMatchObject({ mode: 'markdown' });

    // The map is shown with no question, the folders left out on it.
    expect(map).toContain('  projects:  project (2 notes)');
    expect(map).toContain('  companies: none');
    expect(map).toContain('Folders\n  settings notes: Settings/   wiki pages: Wikis/\n  topic notes, if you install Curator: Topics/\n  left out (Vault does not read them): Templates/');
    expect(map).not.toContain('chosen in the last step');
    // Each step that took its defaults says what it took.
    expect(infos).toEqual([
      'To change how your notes are sorted, run this again and pick Choose everything.',
      'Curator: installed. It spends at most $1.00 a day on AI, and updates the wikis you create every day at 05:00 (UTC).',
      expect.stringMatching(/^AI models: the balanced choice, led by .+\. Images and scanned PDFs: read by Claude, but only once you approve it after setup\.$/),
      expect.stringMatching(/^Backup: a copy of your 7 Markdown files \(.+\), made before anything in your notes changes\.$/),
      expect.stringMatching(/^Plan written to /),
    ]);
  });

  it('plans everything as none for notes that say nothing about their kind', async () => {
    const root = await makeTree({ 'Note.md': '# Note\n', 'Other.md': '# Other\n' });

    const { report, asked, map } = await quickPlan(root, { providers: ['anthropic'], 'providers.anthropic': [FROM_ENV] });

    expect(asked).toEqual(['vault.path', 'providers', 'providers.anthropic']);
    expect(report.structure.source).toBe('none');
    expect(report.structure.types).toEqual([]);
    expect(report.structure.roles).toEqual({ project: null, task: null, meeting: null, person: null, company: null });
    expect(report.vault_map.status).toMatchObject({ project: { field: null }, task: { field: null } });
    expect(report.vault_map.fields).toEqual({ due: null, date: null, people: null, company: null, priority: null, scheduled: null });
    expect(map).toContain('What kind a note is\n  Not set: your notes stay as they are, without kinds.');
    expect(withoutExtraction(report)).toEqual(withoutExtraction(await headlessPlan({ vault: { path: root }, providers: { anthropic: 'env:ANTHROPIC_API_KEY' } })));
  });

  it('does not sort notes by folder unasked, and says how to', async () => {
    const root = await makeTree({ 'Recipes/Soup.md': '# Soup\n', 'Trips/Coast.md': '# Coast\n' });

    const { report, asked, infos } = await quickPlan(root, { providers: ['anthropic'], 'providers.anthropic': [FROM_ENV] });

    expect(asked).toEqual(['vault.path', 'providers', 'providers.anthropic']);
    // A headless run sorts these notes into recipe and trip; quick setup writes no kind into them.
    expect((await headlessPlan({ vault: { path: root } })).structure.types.map((type: { name: string }) => type.name)).toEqual(['recipe', 'trip']);
    expect(report.structure.source).toBe('none');
    expect(report.structure.types).toEqual([]);
    expect(infos[0]).toBe('No line in your notes says what kind each one is, so quick setup leaves them without kinds rather than sorting them by folder. To change how your notes are sorted, run this again and pick Choose everything.');
  });

  it('asks which name kinds that differ only by case share', async () => {
    const root = await makeTree({ 'A.md': fm({ types: 'Meeting' }), 'B.md': fm({ types: 'meeting' }) });

    const { report, asked } = await quickPlan(root, {
      'structure.type_renames': ['meeting'],
      providers: ['anthropic'],
      'providers.anthropic': [FROM_ENV],
    });

    expect(asked).toEqual(['vault.path', 'structure.type_renames', 'providers', 'providers.anthropic']);
    expect(report.structure.roles.meeting).toBe('meeting');
  });

  it('asks how notes are typed when the Analyzer refuses the type line', async () => {
    const root = await makeTree({ 'Drafts/A.md': fm({ type: '_draft' }), 'Drafts/B.md': fm({ type: '_draft' }) });

    const { report, asked, rejections } = await quickPlan(root, {
      'structure.source': ['none'],
      providers: ['anthropic'],
      'providers.anthropic': [FROM_ENV],
    });

    expect(rejections).toEqual(['The "type" line holds no value Vault can use as a kind.']);
    expect(asked).toEqual(['vault.path', 'structure.source', 'providers', 'providers.anthropic']);
    expect(report.structure.source).toBe('none');
  });

  it('asks for a usual folder the vault already has', async () => {
    const root = await makeTree({ ...TYPICAL, 'Wikis/Old page.md': '# Old page\n' });

    const { report, asked } = await quickPlan(root, { providers: ['anthropic'], 'providers.anthropic': [FROM_ENV] });

    // Its default is another name, offered as in the full flow; the other folders are not asked.
    expect(asked).toEqual(['vault.path', 'vault.wiki_dir', 'providers', 'providers.anthropic']);
    expect(report.vault_map.folders.wiki_dir).toBe('Vault Wikis');
  });

  it('goes on without a key, leaving Curator out', async () => {
    const root = await makeTree(TYPICAL);

    const { report, asked, warnings, infos } = await quickPlan(root, { providers: [NONE] }, { host: { env: () => undefined } });

    expect(asked).toEqual(['vault.path', 'providers']);
    expect(report.providers).toEqual([]);
    expect(report.curator).toBeNull();
    // The full step's warning (#436).
    expect(warnings).toContain(NO_MODEL_KEY_WARNING.replace(/\n/g, ' '));
    expect(infos).toContain('Curator: not installed. It needs a key from Anthropic, Fireworks, OpenRouter, or OpenAI.');
    expect(infos).toContain('AI models: none, since there is no AI key to use.');
  });

  it('asks for a key again when the provider refuses it', async () => {
    const root = await makeTree(TYPICAL);
    const statuses = [401, 200];

    const { report, asked, rejections } = await quickPlan(root, {
      providers: ['openrouter'],
      'providers.openrouter': [{ source: 'entered', value: 'sk-or-wrong' }, { source: 'entered', value: 'sk-or-right' }],
    }, { host: { env: () => undefined, httpStatus: async () => statuses.shift() ?? 200 }, checkNetwork: true });

    expect(rejections).toEqual(['OpenRouter refused this key (HTTP 401).']);
    expect(asked).toEqual(['vault.path', 'providers', 'providers.openrouter', 'providers.openrouter']);
    expect(report.providers).toEqual([expect.objectContaining({ provider: 'openrouter', check: 'valid' })]);
  });

  it('asks which service again when its key is skipped', async () => {
    const root = await makeTree(TYPICAL);

    const { report, asked } = await quickPlan(root, { providers: ['openai', NONE] }, { host: { env: () => undefined } });

    expect(asked).toEqual(['vault.path', 'providers', 'providers.openai', 'providers']);
    expect(report.providers).toEqual([]);
  });

  it('adds keys for several services without asking for all seven', async () => {
    const root = await makeTree(TYPICAL);

    const { report, asked } = await quickPlan(root, {
      providers: [SEVERAL, ['anthropic', 'exa']],
      'providers.anthropic': [FROM_ENV],
      'providers.exa': [{ source: 'entered', value: 'exa-key' }],
    });

    expect(asked).toEqual(['vault.path', 'providers', 'providers', 'providers.anthropic', 'providers.exa']);
    expect(report.providers.map((key: { provider: string }) => key.provider)).toEqual(['anthropic', 'exa']);
  });
});
