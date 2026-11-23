import { SEED_MODELS } from '@vault/settings-registry';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalyzerCommand } from '../src/analyzer.js';
import type { AnswerId } from '../src/answers.js';
import { EngineToolError, type EngineCall } from '../src/engine-client.js';
import { createSystemHost, type Host } from '../src/host.js';
import type { Prompter, SecretAnswer } from '../src/prompter.js';
import type { ServicePlan } from '../src/review.js';

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** Runs Vault Analyzer from Engine's TypeScript source, so tests need no Engine build. */
export const SOURCE_ANALYZER: AnalyzerCommand = {
  executable: process.execPath,
  args: ['--import', 'tsx', join(REPO_ROOT, 'packages', 'engine', 'src', 'analyzer', 'cli.ts')],
};

/** The services as a test host would run them. */
export const TEST_SERVICES: ServicePlan = {
  repoRoot: '/repo',
  user: 'tester',
  nodePath: '/opt/node-24/bin/node',
  enginePort: 3334,
  curatorPort: 3335,
  manager: 'systemd',
  serviceDir: '/etc/systemd/system',
};

const roots: string[] = [];

export async function makeTree(files: Record<string, string>): Promise<string> {
  // The real path: macOS's temporary folder is reached through a symlink (/var is
  // /private/var), and the installer resolves the paths it is given.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vault-installer-')));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    if (path.endsWith('/')) await mkdir(target, { recursive: true });
    else await writeFile(target, content);
  }
  return root;
}

export async function removeTrees(): Promise<void> {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
}

/** A healthy Linux host; override any probe per test. */
export function fakeHost(overrides: Partial<Host> = {}): Host {
  return {
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '24.21.0',
    execPath: '/opt/node-24/bin/node',
    homeDir: '/srv/tester',
    username: 'tester',
    uid: 1000,
    timeZone: 'UTC',
    env: () => undefined,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    runAttached: async () => 0,
    readText: async () => null,
    memAvailableBytes: async () => 8 * 1024 ** 3,
    freeDiskBytes: async () => 100 * 1024 ** 3,
    isPortFree: async () => true,
    canReach: async () => true,
    httpStatus: async () => 200,
    pathExists: async path => path === '/run/systemd/system' || path.endsWith('/dist/analyzer/cli.js'),
    inspectDirectory: async () => ({ exists: true, directory: true, readable: true, writable: true }),
    realPath: async path => path,
    makeDirectory: async () => { throw new Error('tests create folders only through realFilesystemHost'); },
    copyDirectory: async () => { throw new Error('tests copy folders only through realFilesystemHost'); },
    ...overrides,
  };
}

/**
 * The real filesystem, with machine-specific probes pinned so results are stable. The
 * environment and HTTP are pinned too, so no test reads a real key or calls a provider.
 */
export function realFilesystemHost(overrides: Partial<Host> = {}): Host {
  const system = createSystemHost();
  return {
    ...system,
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '24.21.0',
    execPath: '/opt/node-24/bin/node',
    homeDir: '/srv/tester',
    username: 'tester',
    uid: 1000,
    timeZone: 'UTC',
    env: () => undefined,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    // Nothing a test runs may reach the real terminal or sudo.
    runAttached: async () => { throw new Error('tests never run commands on the terminal'); },
    memAvailableBytes: async () => 8 * 1024 ** 3,
    freeDiskBytes: async () => 100 * 1024 ** 3,
    isPortFree: async () => true,
    canReach: async () => true,
    httpStatus: async () => 200,
    // Tests run the Analyzer from source, so the built CLI counts as present.
    pathExists: async path => path === '/run/systemd/system'
      || path.endsWith('/dist/analyzer/cli.js')
      || system.pathExists(path),
    ...overrides,
  };
}

export function fm(data: Record<string, string>): string {
  return `---\n${Object.entries(data).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n`;
}

/**
 * An interactive prompter that replays scripted answers per question id, in order, and
 * falls back to each question's default. Confirmations, which have no id, replay in order. Rejections are recorded, not thrown, so a test
 * can watch a stage ask again.
 */
export function replayPrompter(script: Partial<Record<AnswerId, unknown[]>>, confirms: boolean[] = []) {
  const queues = new Map(Object.entries(script).map(([id, values]) => [id, [...(values ?? [])]]));
  const next = (id: AnswerId): { found: boolean; value?: unknown } => {
    const queue = queues.get(id);
    return queue && queue.length > 0 ? { found: true, value: queue.shift() } : { found: false };
  };
  const rejections: string[] = [];
  const asked: AnswerId[] = [];
  /** Every note shown, and every confirmation's message, in order. */
  const notes: Array<{ title?: string; message: string }> = [];
  const confirmed: string[] = [];
  const spinners = { started: 0, stopped: 0 };
  const prompter: Prompter = {
    interactive: true,
    intro() {},
    welcome() {},
    step() {},
    success() {},
    outro() {},
    note(message, title) {
      notes.push({ message, ...(title !== undefined ? { title } : {}) });
    },
    info() {},
    warn() {},
    async text(question) {
      asked.push(question.id);
      const answer = next(question.id);
      return answer.found ? answer.value as string : question.defaultValue ?? '';
    },
    async select(question) {
      asked.push(question.id);
      const answer = next(question.id);
      return (answer.found ? answer.value : question.initialValue) as typeof question.initialValue;
    },
    async confirm(question) {
      confirmed.push(question.message);
      return confirms.length > 0 ? confirms.shift() as boolean : question.initialValue;
    },
    async multiselect(question) {
      asked.push(question.id);
      const answer = next(question.id);
      return answer.found ? answer.value as string[] : question.initialValues;
    },
    async secret(question) {
      asked.push(question.id);
      const answer = next(question.id);
      return answer.found ? answer.value as SecretAnswer : null;
    },
    decide: question => question.ask(),
    rejectAnswer(_id, reason) {
      rejections.push(reason);
    },
    spinner() {
      spinners.started++;
      return { stop() { spinners.stopped++; } };
    },
  };
  return { prompter, rejections, asked, notes, confirmed, spinners };
}

interface FakeNote {
  id: string;
  file_path: string;
  types: string[];
  fields: Record<string, unknown>;
}

/**
 * Engine's MCP tools as adoption uses them, over in-memory fields, schemas, and notes.
 * `refuse` lists note paths Engine's validation would reject.
 */
export function fakeEngineTools(notes: Array<{ file_path: string; types?: string[]; fields?: Record<string, unknown> }> = [], refuse: string[] = []) {
  const fields = new Map<string, Record<string, unknown>>();
  /** `overrides` sets a claim's `required` and `default_value`, as update-schema can. */
  const schemas = new Map<string, {
    default_directory: string | null;
    claims: string[];
    overrides?: Record<string, { required?: boolean; default_value?: unknown }>;
  }>();
  const store: FakeNote[] = notes.map((note, index) => ({
    id: `n${index + 1}`,
    file_path: note.file_path,
    types: [...(note.types ?? [])],
    fields: { ...note.fields },
  }));
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  /** Each domain's applied settings; `domain.key` names in `rejectSettings` are refused. */
  const settings = new Map<string, Record<string, unknown>>();
  const rejectSettings = new Set<string>();
  const catalog: Array<{ title: string; provider: string; model: string; enabled: boolean }> = [];
  /** Which providers' keys Engine reports having. */
  const engineKeys: Record<string, boolean> = { anthropic: true, fireworks: true, openrouter: true, gemini: true };
  /** Engine's extractors, every one available unless a test says otherwise. */
  const extractors = {
    active: ['gemini-vision-image', 'claude-vision-image', 'openai-compat-vision-image', 'deepgram-nova-3'].map(id => ({ id })),
    unavailable: [] as Array<{ id: string; missingKey: string }>,
    /** Kept off by extractionEnabled; a test fills it to model a restart that missed it. */
    disabled: [] as Array<{ id: string }>,
  };
  let operations = 0;
  const operation = () => `op${++operations}`;
  /** What survey-nodes returns; by default the untyped notes, none of them embedded. */
  const survey: { result: unknown } = { result: null };

  const call: EngineCall = async <T>(tool: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ tool, args });
    switch (tool) {
      case 'vault-stats':
        return {
          node_count: store.length,
          schema_count: schemas.size,
          extractors,
          search_index: { status: 'ready', nodes_total: store.length, nodes_indexed: store.length, pending: 0, terminal_failures: 0 },
        } as T;
      case 'survey-nodes':
        return (survey.result ?? {
          scope: { notes: store.filter(note => note.types.length === 0).length, surveyed: 0, not_indexed: 0, truncated: false },
          groups: [],
          ungrouped: { notes: 0 },
        }) as T;
      case 'vault-doctor':
        return { integrity: { check: 'quick_check', ok: true, messages: [] }, invariants: [] } as T;
      case 'list-global-fields':
        return [...fields.values()].map(field => ({ name: field.name, field_type: field.field_type })) as T;
      case 'describe-global-field': {
        const field = fields.get(args.name as string);
        if (!field) throw new EngineToolError('NOT_FOUND', `Global field '${String(args.name)}' not found`);
        return {
          ...field,
          list_item_type: field.list_item_type ?? null,
          enum_values: field.enum_values ?? null,
          reference_target: field.reference_target ?? null,
          required: field.required ?? false,
          default_value: field.default_value ?? null,
        } as T;
      }
      case 'create-global-field':
        if (fields.has(args.name as string)) throw new EngineToolError('INVALID_PARAMS', 'exists');
        fields.set(args.name as string, { ...args });
        return { ...args, operation_id: operation() } as T;
      case 'list-schemas':
        return [...schemas].map(([name, schema]) => ({ name, default_directory: schema.default_directory })) as T;
      case 'describe-schema': {
        const schema = schemas.get(args.name as string);
        if (!schema) throw new EngineToolError('NOT_FOUND', `Schema '${String(args.name)}' not found`);
        const resolved = (name: string) => ({ ...fields.get(name), ...schema.overrides?.[name] });
        return {
          name: args.name,
          default_directory: schema.default_directory,
          fields: schema.claims.map(name => ({ name, required: resolved(name).required ?? false, default_value: resolved(name).default_value ?? null })),
        } as T;
      }
      case 'create-schema': {
        const claims = (args.field_claims as Array<{ field: string }>).map(claim => claim.field);
        const unknown = claims.filter(field => !fields.has(field));
        if (unknown.length > 0) throw new EngineToolError('INVALID_PARAMS', `unknown fields: ${unknown.join(', ')}`);
        schemas.set(args.name as string, { default_directory: (args.default_directory as string | undefined) ?? null, claims });
        return { name: args.name, operation_id: operation() } as T;
      }
      case 'get-settings': {
        // Engine seeds its catalog on first start; `catalog` holds the models added since.
        const models = {
          catalog: [...SEED_MODELS.map(entry => ({ title: entry.title, provider: entry.provider, model: entry.model, enabled: true })), ...catalog],
          providers: { ...engineKeys },
        };
        const domain = (name: string) => ({ effective: { ...settings.get(name) }, issues: [] });
        if (args.domain === 'models') return { domains: { models: { ...models, catalog: catalog.map(entry => ({ ...entry })) } } } as T;
        if (typeof args.domain === 'string') return { domains: { [args.domain]: domain(args.domain) } } as T;
        return { domains: { engine: domain('engine'), wiki: domain('wiki'), chat: domain('chat'), curator: domain('curator'), models } } as T;
      }
      case 'add-model':
        catalog.push({ title: args.title as string, provider: args.provider as string, model: args.model as string, enabled: true });
        return { title: args.title } as T;
      case 'update-settings': {
        const domain = args.domain as string;
        const patch = args.patch as Record<string, unknown>;
        const applied = Object.keys(patch).filter(key => !rejectSettings.has(`${domain}.${key}`));
        settings.set(domain, { ...settings.get(domain), ...Object.fromEntries(applied.map(key => [key, patch[key]])) });
        return { domain, applied, effective: { ...settings.get(domain) } } as T;
      }
      case 'update-schema': {
        // Only `add_field_claims`, which adoption uses for chosen fields.
        const schema = schemas.get(args.name as string);
        if (!schema) throw new EngineToolError('NOT_FOUND', `Schema '${String(args.name)}' not found`);
        const added = (args.add_field_claims as Array<{ field: string }>).map(claim => claim.field);
        const unknown = added.filter(field => !fields.has(field) || schema.claims.includes(field));
        if (unknown.length > 0) throw new EngineToolError('INVALID_PARAMS', `cannot add: ${unknown.join(', ')}`);
        schema.claims.push(...added);
        return { name: args.name, operation_id: operation() } as T;
      }
      case 'query-nodes': {
        const offset = (args.offset as number | undefined) ?? 0;
        const limit = (args.limit as number | undefined) ?? 50;
        // Only the `fields: { name: { exists: true } }` filter adoption uses.
        const present = Object.keys((args.fields as Record<string, unknown> | undefined) ?? {});
        const matching = store.filter(note => present.every(field => field in note.fields));
        const sorted = matching.sort((left, right) => left.file_path.localeCompare(right.file_path));
        return {
          nodes: sorted.slice(offset, offset + limit).map(note => ({ id: note.id, file_path: note.file_path, types: [...note.types] })),
          total: matching.length,
        } as T;
      }
      case 'update-node': {
        const ids = (args.query as { node_ids: string[] }).node_ids;
        const add = (args.add_types as string[] | undefined) ?? [];
        const remove = (args.remove_types as string[] | undefined) ?? [];
        const unknown = add.filter(type => !schemas.has(type));
        if (unknown.length > 0) throw new EngineToolError('UNKNOWN_TYPE', `Unknown type(s): ${unknown.join(', ')}`);
        const set = (args.set_fields as Record<string, unknown> | undefined) ?? {};
        const matched = store.filter(note => ids.includes(note.id));
        const next = (note: FakeNote) => [...note.types, ...add.filter(type => !note.types.includes(type))].filter(type => !remove.includes(type));
        const nextFields = (note: FakeNote) => Object.fromEntries(Object.entries({ ...note.fields, ...set }).filter(([, value]) => value !== null));
        const changed = matched.filter(note => JSON.stringify(next(note)) !== JSON.stringify(note.types)
          || JSON.stringify(nextFields(note)) !== JSON.stringify(note.fields));
        const failing = changed.filter(note => refuse.includes(note.file_path));
        if (args.dry_run !== false) {
          return {
            dry_run: true,
            matched: matched.length,
            would_update: changed.length - failing.length,
            would_skip: matched.length - changed.length,
            would_fail: failing.length,
            preview: changed.slice(0, 20).map(note => ({ node_id: note.id, file_path: note.file_path, changes: { would_fail: failing.includes(note) } })),
          } as T;
        }
        for (const note of changed.filter(note => !failing.includes(note))) {
          note.types = next(note);
          note.fields = nextFields(note);
        }
        return {
          dry_run: false,
          matched: matched.length,
          updated: changed.length - failing.length,
          skipped: matched.length - changed.length,
          errors: failing.map(note => ({ node_id: note.id, file_path: note.file_path, error: 'Validation failed' })),
          operation_id: operation(),
        } as T;
      }
      default:
        return {} as T;
    }
  };
  return { call, fields, schemas, notes: store, calls, settings, rejectSettings, catalog, extractors, engineKeys, survey };
}
