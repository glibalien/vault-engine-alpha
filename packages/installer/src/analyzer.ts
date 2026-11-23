import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The installer reaches Vault Analyzer only through its CLI (`vault-analyzer`), never by
 * import: the Analyzer lives in the Engine package, which installer code must not import.
 * These schemas cover just the report fields the installer reads.
 */
const FolderSchema = z.object({
  path: z.string(),
  markdown_files: z.number(),
  subtree_markdown_files: z.number(),
});

const InventorySchema = z.object({
  total_files: z.number(),
  markdown_files: z.number(),
  non_markdown_by_extension: z.record(z.string(), z.number()),
  excluded_entries: z.object({ directories: z.number(), symlinks: z.number() }),
});

const IssueSchema = z.object({ code: z.string(), count: z.number() });

/** Tags the Analyzer offers as kinds (#650): lowercase, without the `#`, the most used first. */
const TagCandidatesSchema = z.object({
  candidates: z.array(z.object({ tag: z.string(), documents: z.number() })),
  truncated: z.boolean(),
});
export type TagCandidates = z.infer<typeof TagCandidatesSchema>;

export const DiscoverReportSchema = z.object({
  format_version: z.literal(2),
  analyzer_version: z.string(),
  source: z.object({
    canonical_root: z.string(),
    source_fingerprint: z.string(),
    exclusions: z.array(z.string()),
  }),
  inventory: InventorySchema,
  folders: z.array(FolderSchema),
  folders_truncated: z.boolean(),
  candidates: z.array(z.object({
    key: z.string(),
    documents_with_key: z.number(),
    markdown_coverage: z.number(),
    distinct_values: z.number(),
    sample_values: z.array(z.string()),
    conventional_name: z.boolean(),
  })),
  candidates_truncated: z.boolean(),
  tags: TagCandidatesSchema,
  issues: z.array(IssueSchema),
});

export type DiscoverReport = z.infer<typeof DiscoverReportSchema>;
export type AnalyzerFolder = z.infer<typeof FolderSchema>;

const FIELD_TYPES = ['string', 'number', 'date', 'boolean', 'reference', 'enum', 'list'] as const;

const EvidenceSchema = z.object({
  observations: z.number(),
  distinct_values: z.number(),
  sample_values: z.array(z.unknown()),
  samples_truncated: z.boolean(),
});

const ProposedFieldSchema = z.object({
  name: z.string(),
  field_type: z.enum(FIELD_TYPES),
  list_item_type: z.enum(FIELD_TYPES).optional(),
  enum_values: z.array(z.string()).optional(),
  reference_target: z.string().optional(),
  evidence: EvidenceSchema,
});

const FieldTypeOptionSchema = z.object({
  /** `text` stores every value as a string; `dominant` is the most common value shape. */
  option: z.enum(['text', 'dominant']),
  field_type: z.enum(FIELD_TYPES),
  list_item_type: z.enum(FIELD_TYPES).optional(),
  /** Values Engine would refuse to store as this type; 0 when every value converts. */
  unconverted: z.number(),
});

export const AnalyzeReportSchema = z.object({
  format_version: z.literal(2),
  analyzer_version: z.string(),
  source: z.object({
    canonical_root: z.string(),
    confirmed_type_field: z.string().nullable(),
    source_fingerprint: z.string(),
    exclusions: z.array(z.string()),
  }),
  inventory: InventorySchema,
  coverage: z.object({
    files_with_frontmatter: z.number(),
    typed_files: z.number(),
    untyped_files: z.number(),
    malformed_frontmatter_files: z.number(),
    typed_by_type_field: z.number(),
    typed_by_folder_rule: z.number(),
    typed_by_tag_rule: z.number(),
  }),
  proposal: z.object({
    type_field_mapping: z.object({ source: z.string(), target: z.string() }).nullable(),
    type_assignment: z.object({
      type_field_values: z.array(z.object({ value: z.string(), type: z.string().nullable(), documents: z.number() })),
      folder_rules: z.array(z.object({
        directory: z.string(),
        type: z.string().nullable(),
        markdown_files: z.number(),
        documents: z.number(),
      })),
      tag_rules: z.array(z.object({ tag: z.string(), type: z.string().nullable(), documents: z.number() })),
      /** Every eligible Markdown file with its final types; what adoption applies. */
      files: z.array(z.object({ path: z.string(), types: z.array(z.string()) })),
    }),
    global_fields: z.array(ProposedFieldSchema),
    schemas: z.array(z.object({
      name: z.string(),
      default_directory: z.string().optional(),
      field_claims: z.array(z.object({ field: z.string() })),
      evidence: z.object({ typed_documents: z.number(), single_type_documents: z.number() }),
    })),
  }),
  needs_review: z.object({
    ambiguous_fields: z.array(z.object({
      name: z.string(),
      reasons: z.array(z.string()),
      evidence: EvidenceSchema,
      options: z.array(FieldTypeOptionSchema),
    })),
    ambiguous_claims: z.array(z.object({
      field: z.string(),
      candidate_types: z.array(z.string()),
      multi_type_documents: z.number(),
    })),
    type_name_collisions: z.array(z.object({ names: z.array(z.string()), documents: z.number() })),
  }),
  tags: TagCandidatesSchema,
  issues: z.array(IssueSchema),
});

export type AnalyzeReport = z.infer<typeof AnalyzeReportSchema>;
export type ProposedField = z.infer<typeof ProposedFieldSchema>;
export type FieldTypeOption = z.infer<typeof FieldTypeOptionSchema>;
/** A type chosen for a field whose values need review. */
export type FieldTypeChoice = Pick<FieldTypeOption, 'field_type' | 'list_item_type'>;

/** Engine's type key when none is designated: the frontmatter key `types`. */
export const DEFAULT_TYPE_KEY = 'types';

/** The Analyzer's `--spec` input. */
export interface AnalyzeSpec {
  type_field: string | null;
  /**
   * The frontmatter key Engine keeps types in (its VAULT_TYPE_KEY, #445): the type field,
   * when notes are typed by one. Absent means `types`, as in plans saved before it was
   * designated.
   */
  type_key?: string;
  folder_rules: Array<{ directory: string; type: string | null }>;
  /**
   * Tags that name a kind (#650): a note the type field leaves untyped gets the kind of every
   * one it carries, ahead of its folder. Absent in plans saved before tags were read.
   */
  tag_rules?: Array<{ tag: string; type: string | null }>;
  type_renames: Record<string, string | null>;
  exclude: string[];
  /** Fields that need review, typed as the user chose; the Analyzer then proposes them. */
  field_types?: Record<string, FieldTypeChoice>;
}

/** The frontmatter key Engine keeps types in under this spec. */
export function typeKeyOf(spec: Pick<AnalyzeSpec, 'type_key'>): string {
  return spec.type_key ?? DEFAULT_TYPE_KEY;
}

const EnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export class AnalyzerError extends Error {
  override readonly name = 'AnalyzerError';
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface AnalyzerRunner {
  discover(root: string, exclude: readonly string[]): Promise<DiscoverReport>;
  analyze(root: string, spec: AnalyzeSpec): Promise<AnalyzeReport>;
}

export interface AnalyzerCommand {
  executable: string;
  /** Arguments placed before the Analyzer operation, such as the CLI script path. */
  args: string[];
}

/** The built CLI inside a monorepo checkout. */
export function analyzerCommandForRepo(repoRoot: string): AnalyzerCommand {
  return {
    executable: process.execPath,
    args: [join(repoRoot, 'packages', 'engine', 'dist', 'analyzer', 'cli.js')],
  };
}

export function createAnalyzerRunner(command: AnalyzerCommand): AnalyzerRunner {
  return {
    async discover(root, exclude) {
      const args = ['discover', '--root', root, ...exclude.flatMap(directory => ['--exclude', directory])];
      return expectReport(DiscoverReportSchema, await runAnalyzer(command, args));
    },
    async analyze(root, spec) {
      // The CLI reads its spec from a file; use a private temporary one, removed right after.
      const directory = await mkdtemp(join(tmpdir(), 'vault-installer-spec-'));
      try {
        const specPath = join(directory, 'spec.json');
        await writeFile(specPath, JSON.stringify(spec), { mode: 0o600 });
        const args = ['analyze', '--root', root, '--spec', specPath];
        return expectReport(AnalyzeReportSchema, await runAnalyzer(command, args));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

function expectReport<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new AnalyzerError(
      'UNEXPECTED_REPORT',
      'Vault Analyzer returned a report this installer does not understand; rebuild the repository.',
    );
  }
  return parsed.data;
}

async function runAnalyzer(command: AnalyzerCommand, args: string[]): Promise<unknown> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(command.executable, [...command.args, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => reject(new AnalyzerError('ANALYZER_FAILED', `Vault Analyzer could not run: ${error.message}`)));
    child.on('close', code => {
      const text = Buffer.concat(out).toString('utf8');
      // Exit codes 1 and 2 still carry a JSON envelope on stdout.
      if (code !== 0 && !text.trim()) {
        const detail = Buffer.concat(err).toString('utf8').trim() || `exit code ${code}`;
        reject(new AnalyzerError('ANALYZER_FAILED', `Vault Analyzer could not run: ${detail}`));
        return;
      }
      resolve(text);
    });
  });
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new AnalyzerError('ANALYZER_FAILED', 'Vault Analyzer did not return JSON.');
  }
  const parsed = EnvelopeSchema.safeParse(envelope);
  if (!parsed.success) throw new AnalyzerError('ANALYZER_FAILED', 'Vault Analyzer returned an unexpected envelope.');
  if (!parsed.data.ok) throw new AnalyzerError(parsed.data.error.code, parsed.data.error.message);
  return parsed.data.data;
}
