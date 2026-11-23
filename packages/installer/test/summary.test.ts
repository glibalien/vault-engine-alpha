import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { showPlan } from '../src/plan.js';
import { createScriptedPrompter, type Prompter } from '../src/prompter.js';
import {
  renderCurator,
  renderModels,
  renderProviders,
  renderStructure,
  renderSummary,
  renderVault,
  SUMMARY_WIDTH,
  type PlanReport,
} from '../src/report.js';
import { renderReview } from '../src/review.js';
import type { Host } from '../src/host.js';
import { renderVaultMap } from '../src/vault-map.js';
import { fm, makeTree, realFilesystemHost, removeTrees, REPO_ROOT, SOURCE_ANALYZER } from './helpers.js';

afterEach(removeTrees);

const KEYS = { TEST_ANTHROPIC: 'sk-ant-test-0123456789', TEST_GEMINI: 'gemini-test-0123456789' };
const DATA_DIR = '/srv/tester/vault-suite-data';

/** Notes typed by a `type` field: two projects, a task, a person, and one untyped note. */
async function notes(): Promise<string> {
  return makeTree({
    'Projects/Alpha.md': fm({ type: 'project', status: 'open' }),
    'Projects/Beta.md': fm({ type: 'project', status: 'done' }),
    'Tasks/One.md': fm({ type: 'task', status: 'open' }),
    'People/Someone.md': fm({ type: 'person' }),
    'Inbox.md': '# Inbox\n',
  });
}

/** The plan `plan --json` prints for these answers: the same report `install` approves and applies. */
async function planFor(answers: Record<string, unknown>, vault?: string, machine: Partial<Host> = {}): Promise<PlanReport> {
  const path = join(await makeTree({}), 'answers.json');
  await writeFile(path, JSON.stringify({
    version: 1,
    vault: { path: vault ?? await notes() },
    providers: { anthropic: 'env:TEST_ANTHROPIC' },
    ...answers,
  }));
  let stdout = '';
  const code = await runCli(['plan', '--answers', path, '--json', '--skip-network-check', '--data-dir', DATA_DIR], {
    stdout: text => { stdout += text; },
    stderr: () => {},
    isInteractive: false,
  }, {
    host: realFilesystemHost({ env: name => (KEYS as Record<string, string>)[name], ...machine }),
    cwd: '/',
    repoRoot: REPO_ROOT,
    analyzerCommand: SOURCE_ANALYZER,
    createInteractivePrompter: () => { throw new Error('tests never prompt interactively'); },
    now: () => new Date('2026-10-26T12:00:00Z'),
  });
  expect(code).toBe(0);
  return JSON.parse(stdout) as PlanReport;
}

/** An Apple Silicon Mac; every command answers, so `launchctl print gui/<uid>` finds the session. */
const MAC: Partial<Host> = { platform: 'darwin', arch: 'arm64' };

/** The plan as an interactive run has it: attachment reading is asked after adoption. */
function interactive(report: PlanReport): PlanReport {
  return { ...report, extraction_approved: null };
}

function expectFits(text: string): void {
  for (const line of text.split('\n')) expect(line.length, line).toBeLessThanOrEqual(SUMMARY_WIDTH);
}

describe('on macOS', () => {
  it('plans launchd agents in ~/Library/LaunchAgents that start at login, with no sudo', async () => {
    const report = interactive(await planFor({ curator: { install: true } }, undefined, MAC));
    const agents = '/srv/tester/Library/LaunchAgents';
    const staged = `${DATA_DIR}/installer/units`;

    expect(report.services).toMatchObject({ service_manager: 'launchd', service_dir: agents });
    expect(report.review.sudo_commands).toEqual([
      { command: `cp ${staged}/vault-engine.plist ${agents}/vault-engine.plist` },
      { command: `launchctl bootstrap gui/$(id -u) ${agents}/vault-engine.plist` },
      { command: 'launchctl kickstart -k gui/$(id -u)/vault-engine', when: 'only if you approve attachment extraction' },
      { command: `cp ${staged}/vault-curator.plist ${agents}/vault-curator.plist` },
      { command: `launchctl bootstrap gui/$(id -u) ${agents}/vault-curator.plist` },
    ]);
    expect(report.review.files.map(file => file.path)).toEqual(expect.arrayContaining([
      `${DATA_DIR}/logs/`,
      `${agents}/vault-engine.plist`,
      `${agents}/vault-curator.plist`,
    ]));
    expect(report.review.files.some(file => file.path.startsWith('/etc/systemd/'))).toBe(false);

    const summary = renderSummary(report, { sudo: true });
    expect(summary).toContain('Services    Engine and Curator run in the background and start when you\n            log in.');
    expect(summary).toContain('sudo        Not needed: the services run as you.');
    const details = renderReview(report.review, 'launchd');
    expect(details).toContain('Commands run as you (no sudo)');
    expect(details).not.toContain('sudo ');
  });

  it('reads a plan saved before macOS support as systemd\'s', async () => {
    const report = interactive(await planFor({ curator: { install: true } }));
    const { service_manager: _manager, service_dir: _dir, ...older } = report.services;

    expect(renderSummary({ ...report, services: older }, { sudo: true })).toContain('start at boot.');
  });
});

describe('renderSummary', () => {
  it('states the notes, the designations, the backup, the services, the spending and sudo in a dozen lines', async () => {
    const report = interactive(await planFor({ curator: { install: true } }));
    const text = renderSummary(report, { sudo: true });

    expect(text).toBe([
      // The type field is the type key (#445), so no key is added.
      'Your notes  4 notes get a type in the type key they have (no key is',
      '            added); 1 stays untyped. Engine rewrites the top of each note',
      '            it changes. It also rewrites links that use a note\'s alias.',
      'Kinds       projects: project, tasks: task, people: person, journal: note',
      '            (Curator creates it).',
      '            None: meetings, companies, so project wikis leave them out.',
      'Fields      project status: status; task status: status.',
      'New         Nothing beyond the types and fields your notes already use.',
      'Backup      5 Markdown files (131 bytes) to',
      '            /srv/tester/vault-suite-data/installer/backups/',
      'Services    Engine and Curator run in the background and start at boot.',
      'Spending    Curator: at most $1.00 a day. Chat and memory: only when used.',
      '            Reading attachments (paid) is asked about separately.',
      'sudo        6 commands; 1 more only if you approve attachment extraction.',
    ].join('\n'));
    expectFits(text);
  });

  it('reads every number from the plan', async () => {
    const report = interactive(await planFor({ curator: { install: true, daily_budget_cents: 250 }, backup: { mode: 'full' } }));
    const text = renderSummary(report, { sudo: true });

    expect(text).toContain(`${report.structure!.typed_notes} notes get a type`);
    expect(text).toContain(`${report.structure!.untyped_notes} stays untyped`);
    expect(text).toContain(`${report.backup!.files} files (`);
    expect(text).toContain('Curator: at most $2.50 a day.');
    const always = report.review.sudo_commands.filter(command => !command.when).length;
    expect(text).toContain(`sudo        ${always} commands;`);
  });

  it('says what is off when every kind is none, with no Curator and no backup', async () => {
    const report = interactive(await planFor({
      structure: { roles: { project: null, task: null, meeting: null, person: null, company: null } },
      curator: { install: false },
      backup: { mode: 'skip' },
    }));
    const text = renderSummary(report, { sudo: true });

    expect(text).toContain([
      'Kinds       None: projects, tasks, meetings, people, companies, so there',
      '            are no project wikis and nothing is filed under a project.',
      'Fields      project status: none; task status: none.',
    ].join('\n'));
    // No journal kind without Curator, and nothing created beyond the notes' own types.
    expect(text).not.toContain('journal');
    expect(text).toContain('New         Nothing beyond the types and fields your notes already use.');
    expect(text).toContain('Backup      None: you chose to skip it.');
    expect(text).toContain('Services    Engine runs in the background and starts at boot.');
    expect(text).toContain('Spending    Nothing spends on a schedule (no Curator).');
    expect(text).toContain('sudo        3 commands; 1 more only if you approve attachment extraction.');
    expectFits(text);
  });

  it('names the new types and fields the user picked, and what a missing status field turns off', async () => {
    const report = interactive(await planFor({
      structure: {
        source: 'folders',
        roles: { project: 'project', task: { starter: 'action item' }, meeting: null, person: 'person', company: { starter: 'organization' } },
        status_fields: { project: null },
      },
      curator: { install: true },
    }));
    const text = renderSummary(report, { sudo: true });

    // Typed by folder: every typed note gets the key.
    expect(text).toMatch(/^Your notes {2}4 notes get a type under a new types key; 1 stays untyped\./);
    expect(text).toContain('tasks: action item (new)');
    expect(text).toContain('companies: organization (new)');
    expect(text).toContain('None: meetings, so project wikis leave them out.');
    expect(text).toContain('project status: none (every project counts as active)');
    expect(text).toContain([
      'New         Only what you picked: the types action item, organization; the',
      '            fields due, project.',
    ].join('\n'));
    expectFits(text);
  });

  describe('the task checkbox (#488)', () => {
    /** Two projects and ten tasks whose `field` holds only `values`, so Vault Analyzer proposes an enum. */
    function tasksWith(values: string[], field = 'state'): Promise<string> {
      return makeTree({
        'Projects/Alpha.md': fm({ type: 'project', status: 'open' }),
        'Projects/Beta.md': fm({ type: 'project', status: 'done' }),
        ...Object.fromEntries(Array.from({ length: 10 }, (_, index) =>
          [`Tasks/T${index}.md`, fm({ type: 'task', [field]: values[index % values.length]! })])),
      });
    }

    it('says, next to the task status field, that a field with no done value gives List views no checkbox', async () => {
      const report = interactive(await planFor({ curator: { install: false } }, await tasksWith(['todo', 'waiting'])));
      const text = renderSummary(report, { sudo: true });

      expect(report.vault_map!.off).toContain(
        'The task status field state has no done value: a List view shows each task\'s status, with no checkbox to tick it off.');
      expect(text).toContain([
        'Fields      project status: status; task status: state (no done value, so',
        '            List views show no checkbox).',
        'New ',
      ].join('\n'));
      expectFits(text);
    });

    it('says it for an enum with no open value', async () => {
      const report = interactive(await planFor({ curator: { install: false } }, await tasksWith(['waiting', 'finished'])));
      const text = renderSummary(report, { sudo: true });

      // Unticking would write Engine's open, which the enum does not take.
      expect(report.vault_map!.status.task).toMatchObject({ field: 'state', active: [], done: ['finished'] });
      expect(report.vault_map!.off).toContain(
        'The task status field state has no open value: a List view shows each task\'s status, with no checkbox to tick it off.');
      expect(text).toContain('task status: state (no open value, so\n            List views show no checkbox).');
      expectFits(text);
    });

    it('grows the summary by at most two lines in the worst case, every line still fitting', async () => {
      const field = 'state-of-this-particular-item';
      const report = interactive(await planFor({
        structure: { status_fields: { project: null, task: field } },
        curator: { install: false },
      }, await tasksWith(['waiting', 'paused'], field)));
      const text = renderSummary(report, { sudo: true });
      const without = renderSummary({
        ...report,
        vault_map: { ...report.vault_map!, off: report.vault_map!.off.filter(line => !line.includes('checkbox')) },
      }, { sudo: true });

      expect(text).toContain([
        'Fields      project status: none (every project counts as active); task',
        `            status: ${field} (no done or open value,`,
        '            so List views show no checkbox).',
        'New ',
      ].join('\n'));
      expect(without).not.toContain('checkbox');
      expect(text.split('\n').length - without.split('\n').length).toBeLessThanOrEqual(2);
      expectFits(text);
    });

    it('says nothing about it for a default map, or with no task status field (which says what that turns off)', async () => {
      const ordinary = renderSummary(interactive(await planFor({ curator: { install: true } })), { sudo: true });
      const noField = renderSummary(interactive(await planFor({
        structure: { status_fields: { task: null } },
        curator: { install: false },
      }, await tasksWith(['todo', 'waiting']))), { sudo: true });

      expect(ordinary).toContain('Fields      project status: status; task status: status.\n');
      expect(ordinary).not.toContain('checkbox');
      expect(noField).toContain('task status: none (wikis cannot tell\n            open tasks from done ones).');
      expect(noField).not.toContain('checkbox');
      expectFits(noField);
    });
  });

  it('says no key is added when the notes already keep their types in the types key', async () => {
    const vault = await makeTree({
      'Projects/Alpha.md': fm({ types: 'project', status: 'open' }),
      'Inbox.md': '# Inbox\n',
    });
    const report = interactive(await planFor({ curator: { install: false } }, vault));

    expect(renderSummary(report, { sudo: true })).toMatch(
      /^Your notes {2}1 note gets a type in the types key they have \(no key is\n {12}added\); 1 stays untyped\./);
  });

  it('says who runs the root commands with --no-sudo', async () => {
    const report = interactive(await planFor({ curator: { install: true } }));

    expect(renderSummary(report, { sudo: false })).toContain([
      'sudo        Not used: you run 6 root commands yourself (--no-sudo); 1 more',
      '            only if you approve attachment extraction.',
    ].join('\n'));
  });

  it('follows an answers file\'s decision on attachment reading', async () => {
    const report = await planFor({ curator: { install: true } });

    expect(report.extraction_approved).toBe(false);
    expect(renderSummary(report, { sudo: true })).toContain('Reading attachments stays off, as your answers say.');
    expect(renderSummary({ ...report, extraction_approved: true }, { sudo: true }))
      .toContain('Reading attachments turns on after setup, as your answers say.');
    const noVision = await planFor({ models: { vision_provider: 'off' }, curator: { install: false } });
    expect(renderSummary(noVision, { sudo: true })).toContain('Reading attachments is off.');
    expect(renderSummary(noVision, { sudo: true })).toContain('sudo        3 commands.');
  });

  it('leaves the notes alone on a folder Vault already manages, and fits a long path into the column', async () => {
    const report = interactive(await planFor({ curator: { install: true } }));
    const managed = { ...report, structure: null, vault_map: null, data_dir: `/srv/${'a-long-folder-name/'.repeat(5)}data` };
    const text = renderSummary(managed, { sudo: true });

    expect(text).toMatch(/^Your notes {2}Left as they are: Vault has used this folder before\.\nBackup/);
    expectFits(text);
  });
});

/** Records what the review shows and asks; `details` answers "Show every file and command?". */
function recorder(details: boolean) {
  const notes: Array<{ title: string | undefined; message: string }> = [];
  const confirms: Array<{ message: string; initialValue: boolean }> = [];
  const prompter = {
    interactive: true,
    step() {},
    note: (message: string, title?: string) => { notes.push({ title, message }); },
    confirm: async (question: { message: string; initialValue: boolean }) => { confirms.push(question); return details; },
  } as unknown as Prompter;
  return { prompter, notes, confirms };
}

/** Today's six boxes, as a headless run has always printed them. */
function details(report: PlanReport): Array<{ title: string; message: string }> {
  return [
    { title: '1 · Your notes folder', message: renderVault(report.vault!) },
    { title: '2 · Kinds of notes', message: `${renderStructure(report.structure!)}\n${renderVaultMap(report.vault_map!)}` },
    { title: '3 · AI services', message: renderProviders(report.providers) },
    { title: '4 · Curator', message: renderCurator(report.curator, report.vault!.settings_dir) },
    { title: '5 · AI models', message: renderModels(report.models) },
    { title: '6 · The details: every file, service, and command', message: renderReview(report.review) },
  ];
}

describe('showPlan', () => {
  it('leads with the summary and shows the details only when asked, defaulting to no', async () => {
    const report = interactive(await planFor({ curator: { install: true } }));
    const declined = recorder(false);
    const accepted = recorder(true);

    await showPlan(declined.prompter, report, { sudo: true });
    await showPlan(accepted.prompter, report, { sudo: false });

    expect(declined.notes).toEqual([{ title: 'The plan in short', message: renderSummary(report, { sudo: true }) }]);
    expect(declined.confirms).toEqual([{ message: 'Show every file and command?', initialValue: false }]);
    expect(accepted.notes).toEqual([
      { title: 'The plan in short', message: renderSummary(report, { sudo: false }) },
      ...details(report),
    ]);
  });

  it('prints every detail headless, as before, and asks nothing', async () => {
    const report = await planFor({ curator: { install: true } });
    const lines: string[] = [];
    const prompter = createScriptedPrompter({ version: 1, vault: { path: '/unused' } }, line => lines.push(line));
    let asked = 0;
    prompter.confirm = async question => { asked++; return question.initialValue; };

    await showPlan(prompter, report);

    expect(asked).toBe(0);
    expect(lines).toEqual([
      '[Setup 8/8] Review the plan',
      ...details(report).map(({ title, message }) => `${title}\n${message}`),
    ]);
  });
});
