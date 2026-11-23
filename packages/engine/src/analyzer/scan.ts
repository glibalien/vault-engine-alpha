import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { isInExcludedDir, shouldIgnoreBuiltIn } from '../indexer/ignore.js';
import { parseFrontmatterMapping } from '../parser/frontmatter.js';
import { noteTags } from './tags.js';
import type { YamlRecord } from '../parser/types.js';
import { FingerprintAccumulator } from './fingerprint.js';
import { isPlainAnalyzerMapping, sanitizeAnalyzerMapping } from './json-safety.js';
import {
  refusal,
  type AnalyzerFolder,
  type AnalyzerInventory,
  type AnalyzerIssue,
  type AnalyzerIssueCode,
  type AnalyzerResult,
} from './report.js';

const MAX_ISSUE_EXAMPLES = 10;
const MAX_FOLDERS = 1000;
const UNREADABLE_CONTENT_HASH = createHash('sha256').update('UNREADABLE').digest('hex');

export interface ScannedMarkdownFile {
  relativePath: string;
  title: string;
  contentHash: string;
  frontmatter: {
    hasFrontmatter: boolean;
    data: YamlRecord;
    parseError: string | null;
  } | null;
  unreadable: boolean;
  /** Its tags, inline and in frontmatter, with the parents of nested ones (`tags.ts`); none when unreadable or malformed. */
  tags: string[];
}

export interface ScanSnapshot {
  canonicalRoot: string;
  exclusions: string[];
  files: ScannedMarkdownFile[];
  inventory: AnalyzerInventory;
  folders: AnalyzerFolder[];
  foldersTruncated: boolean;
  issues: AnalyzerIssue[];
  sourceFingerprint: string;
}

interface ScanState {
  canonicalRoot: string;
  exclusions: readonly string[];
  files: ScannedMarkdownFile[];
  markdownPaths: Array<{ absolutePath: string; relativePath: string; filename: string }>;
  inventory: AnalyzerInventory;
  directMarkdownByFolder: Map<string, number>;
  issues: Map<AnalyzerIssueCode, AnalyzerIssue>;
  fingerprint: FingerprintAccumulator;
}

export interface ScanRootHooks {
  /** @internal Deterministic seam for exercising directory replacement races. */
  afterDirectoryPreflight?: (directory: {
    absolutePath: string;
    relativePath: string;
  }) => Promise<void>;
}

export interface ScanRootOptions extends ScanRootHooks {
  /**
   * Normalized vault-relative directories to leave out entirely, as returned by
   * `parseExclusions`. Excluded files are not inventoried, read, or fingerprinted.
   */
  exclude?: readonly string[];
  /**
   * Report a root with no eligible Markdown instead of refusing it with
   * `NO_MARKDOWN_FILES`. Discovery describes an empty folder; analysis still refuses it.
   */
  allowEmpty?: boolean;
}

export async function scanRoot(
  root: string,
  options: ScanRootOptions = {},
): Promise<AnalyzerResult<ScanSnapshot>> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
    if (!(await stat(canonicalRoot)).isDirectory()) {
      return refusal('INVALID_ROOT', 'Analyzer root must be a directory');
    }
  } catch (error) {
    return refusal('INVALID_ROOT', 'Analyzer root does not exist or cannot be resolved', {
      cause: errorMessage(error),
    });
  }

  const state = createScanState(canonicalRoot, options.exclude ?? []);
  try {
    await enumerateDirectory(state, canonicalRoot, '', options);
  } catch (error) {
    return refusal('ROOT_UNREADABLE', 'Analyzer could not traverse the root directory', {
      cause: errorMessage(error),
    });
  }
  if (state.inventory.markdown_files === 0 && options.allowEmpty !== true) {
    return refusal('NO_MARKDOWN_FILES', 'Analyzer root contains no eligible Markdown files');
  }
  state.markdownPaths.sort((left, right) => compareExact(left.relativePath, right.relativePath));
  for (const markdownPath of state.markdownPaths) {
    await scanMarkdownFile(state, markdownPath);
  }
  return { ok: true, data: finishScan(state) };
}

function createScanState(canonicalRoot: string, exclusions: readonly string[]): ScanState {
  return {
    canonicalRoot,
    exclusions,
    files: [],
    markdownPaths: [],
    inventory: {
      total_files: 0,
      markdown_files: 0,
      non_markdown_by_extension: {},
      excluded_entries: { directories: 0, symlinks: 0 },
    },
    directMarkdownByFolder: new Map(),
    issues: new Map(),
    fingerprint: new FingerprintAccumulator(),
  };
}

function isExcluded(state: ScanState, relativePath: string): boolean {
  return isInExcludedDir(relativePath, state.exclusions, { pathStyle: 'posix' });
}

async function enumerateDirectory(
  state: ScanState,
  directory: string,
  relativeDirectory: string,
  hooks: ScanRootHooks,
): Promise<void> {
  const entries = await readContainedDirectory(state.canonicalRoot, directory, {
    afterPreflight: async () => {
      await hooks.afterDirectoryPreflight?.({
        absolutePath: directory,
        relativePath: relativeDirectory,
      });
    },
  });
  entries.sort((left, right) => compareExact(left.name, right.name));

  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      state.inventory.excluded_entries.symlinks++;
      continue;
    }
    if (entry.isDirectory()) {
      if (
        shouldIgnoreBuiltIn(relativePath, { allowNonMarkdown: true, pathStyle: 'posix' })
        || isExcluded(state, relativePath)
      ) {
        state.inventory.excluded_entries.directories++;
        continue;
      }
      await enumerateDirectory(state, join(directory, entry.name), relativePath, hooks);
      continue;
    }
    if (!entry.isFile()) continue;
    if (shouldIgnoreBuiltIn(relativePath, { allowNonMarkdown: true, pathStyle: 'posix' })) continue;
    if (isExcluded(state, relativePath)) continue;

    state.inventory.total_files++;
    if (!entry.name.toLowerCase().endsWith('.md')) {
      const extension = extname(entry.name) || '[none]';
      state.inventory.non_markdown_by_extension[extension]
        = (state.inventory.non_markdown_by_extension[extension] ?? 0) + 1;
      continue;
    }

    state.inventory.markdown_files++;
    if (relativeDirectory !== '') {
      state.directMarkdownByFolder.set(
        relativeDirectory,
        (state.directMarkdownByFolder.get(relativeDirectory) ?? 0) + 1,
      );
    }
    state.markdownPaths.push({
      absolutePath: join(directory, entry.name),
      relativePath,
      filename: entry.name,
    });
  }
}

export interface ReadContainedDirectoryHooks {
  /** @internal Deterministic seam for exercising path replacement races. */
  afterPreflight?: () => Promise<void>;
}

/**
 * Enumerate a directory only when its opened descriptor remains contained and
 * stable. Linux enumerates through procfs so the entries are bound to the
 * opened directory; other platforms use no-follow flags when available plus
 * post-enumeration identity checks, which are best-effort against adversarial
 * ancestor replacement.
 */
export async function readContainedDirectory(
  canonicalRoot: string,
  directory: string,
  hooks: ReadContainedDirectoryHooks = {},
): Promise<Dirent<string>[]> {
  const preflightPath = await realpath(directory);
  assertContained(canonicalRoot, preflightPath);
  const preflightStat = await lstat(directory, { bigint: true });
  if (!preflightStat.isDirectory() || preflightStat.isSymbolicLink()) {
    throw new Error('Analyzer source path is not a regular directory');
  }

  await hooks.afterPreflight?.();

  const directoryFlag = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
  const handle = await open(directory, constants.O_RDONLY | directoryFlag | noFollowFlag());
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isDirectory()) throw new Error('Analyzer source path is not a regular directory');
    if (before.dev !== preflightStat.dev || before.ino !== preflightStat.ino) {
      throw new Error('Analyzer source directory changed before it was opened');
    }
    await assertOpenedHandleContained(canonicalRoot, handle.fd);
    const entries = await readdir(
      process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : directory,
      { withFileTypes: true },
    );
    const after = await handle.stat({ bigint: true });
    const resolvedAfterRead = await realpath(directory);
    assertContained(canonicalRoot, resolvedAfterRead);
    const pathAfterRead = await lstat(directory, { bigint: true });

    if (
      !pathAfterRead.isDirectory()
      || pathAfterRead.isSymbolicLink()
      || preflightStat.size !== after.size
      || preflightStat.mtimeNs !== after.mtimeNs
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || pathAfterRead.dev !== after.dev
      || pathAfterRead.ino !== after.ino
    ) {
      throw new Error('Analyzer source directory changed while it was being enumerated');
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function scanMarkdownFile(
  state: ScanState,
  path: { absolutePath: string; relativePath: string; filename: string },
): Promise<void> {
  const { absolutePath, relativePath, filename } = path;
  let content: Buffer;
  try {
    content = await readContainedFile(state.canonicalRoot, absolutePath);
  } catch (error) {
    state.files.push({
      relativePath,
      title: filename.slice(0, -3),
      contentHash: UNREADABLE_CONTENT_HASH,
      frontmatter: null,
      unreadable: true,
      tags: [],
    });
    state.fingerprint.add({ relativePath, content: 'UNREADABLE' });
    addIssue(state, 'FILE_UNREADABLE', { path: relativePath, message: errorMessage(error) });
    return;
  }

  state.fingerprint.add({ relativePath, content });
  const mapping = parseFrontmatterMapping(content.toString('utf8'));
  const parseError = mapping.parseError ?? (
    isPlainAnalyzerMapping(mapping.data)
      ? null
      : 'Frontmatter is not a plain YAML mapping'
  );
  const frontmatter = {
    hasFrontmatter: mapping.hasFrontmatter,
    data: parseError === null ? sanitizeAnalyzerMapping(mapping.data) : {},
    parseError,
  };
  state.files.push({
    relativePath,
    title: filename.slice(0, -3),
    contentHash: createHash('sha256').update(content).digest('hex'),
    frontmatter,
    unreadable: false,
    tags: parseError === null ? noteTags(mapping.body, frontmatter.data) : [],
  });
  if (frontmatter.parseError !== null) {
    addIssue(state, 'FRONTMATTER_MALFORMED', {
      path: relativePath,
      message: frontmatter.parseError,
    });
  }
}

export interface ReadContainedFileHooks {
  /** @internal Deterministic seam for exercising path replacement races. */
  afterPreflight?: () => Promise<void>;
  /** @internal Runs only after handle-bound containment, immediately before reading bytes. */
  beforeRead?: () => Promise<void>;
}

/**
 * Read a regular file only when its path remains contained and stable. Linux
 * binds containment to the opened descriptor through procfs before reading;
 * other platforms use leaf no-follow when available plus post-read identity
 * checks, which are best-effort against adversarial ancestor replacement.
 */
export async function readContainedFile(
  canonicalRoot: string,
  absolutePath: string,
  hooks: ReadContainedFileHooks = {},
): Promise<Buffer> {
  const preflightPath = await realpath(absolutePath);
  assertContained(canonicalRoot, preflightPath);
  const preflightStat = await lstat(absolutePath);
  if (!preflightStat.isFile() || preflightStat.isSymbolicLink()) {
    throw new Error('Analyzer source path is not a regular file');
  }

  await hooks.afterPreflight?.();

  const handle = await open(absolutePath, constants.O_RDONLY | noFollowFlag());
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('Analyzer source path is not a regular file');
    await assertOpenedHandleContained(canonicalRoot, handle.fd);
    await hooks.beforeRead?.();
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const resolvedAfterRead = await realpath(absolutePath);
    assertContained(canonicalRoot, resolvedAfterRead);
    const pathAfterRead = await lstat(absolutePath, { bigint: true });

    if (
      !pathAfterRead.isFile()
      || pathAfterRead.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || pathAfterRead.dev !== after.dev
      || pathAfterRead.ino !== after.ino
    ) {
      throw new Error('Analyzer source path changed while it was being read');
    }
    return content;
  } finally {
    await handle.close();
  }
}

function noFollowFlag(): number {
  return process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number'
    ? 0
    : constants.O_NOFOLLOW;
}

async function assertOpenedHandleContained(canonicalRoot: string, descriptor: number): Promise<void> {
  // Node core does not expose portable descriptor-to-final-path APIs. Linux
  // procfs lets us validate the opened dentry itself before consuming bytes.
  if (process.platform !== 'linux') return;
  const openedPath = await readlink(`/proc/self/fd/${descriptor}`);
  if (!isAbsolute(openedPath) || openedPath.endsWith(' (deleted)')) {
    throw new Error('Analyzer could not verify the opened source path');
  }
  assertContained(canonicalRoot, openedPath);
}

function assertContained(canonicalRoot: string, candidate: string): void {
  const relativePath = relative(canonicalRoot, candidate);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Analyzer source path resolves outside the selected root');
  }
}

function addIssue(
  state: ScanState,
  code: AnalyzerIssueCode,
  example: AnalyzerIssue['examples'][number],
): void {
  const existing = state.issues.get(code);
  if (existing) {
    existing.count++;
    if (existing.examples.length < MAX_ISSUE_EXAMPLES) {
      existing.examples.push(example);
    } else {
      existing.truncated = true;
    }
    return;
  }
  state.issues.set(code, { code, count: 1, examples: [example], truncated: false });
}

function finishScan(state: ScanState): ScanSnapshot {
  const nonMarkdownByExtension = Object.fromEntries(
    Object.entries(state.inventory.non_markdown_by_extension)
      .sort(([left], [right]) => compareExact(left, right)),
  );
  const folders = buildFolders(state.directMarkdownByFolder);
  return {
    canonicalRoot: state.canonicalRoot,
    exclusions: [...state.exclusions],
    files: state.files,
    inventory: { ...state.inventory, non_markdown_by_extension: nonMarkdownByExtension },
    folders: folders.folders,
    foldersTruncated: folders.truncated,
    issues: [...state.issues.values()].sort((left, right) => compareExact(left.code, right.code)),
    sourceFingerprint: state.fingerprint.digest(),
  };
}

/**
 * Every non-root directory with Markdown in its subtree. When there are more than
 * MAX_FOLDERS, the shallowest are kept so top-level structure always survives.
 */
function buildFolders(directMarkdownByFolder: Map<string, number>): {
  folders: AnalyzerFolder[];
  truncated: boolean;
} {
  const subtreeCounts = new Map<string, number>();
  for (const [folder, count] of directMarkdownByFolder) {
    const segments = folder.split('/');
    for (let depth = 1; depth <= segments.length; depth++) {
      const ancestor = segments.slice(0, depth).join('/');
      subtreeCounts.set(ancestor, (subtreeCounts.get(ancestor) ?? 0) + count);
    }
  }
  const all = [...subtreeCounts.entries()].map(([path, subtree]) => ({
    path,
    markdown_files: directMarkdownByFolder.get(path) ?? 0,
    subtree_markdown_files: subtree,
  }));
  const kept = all.length <= MAX_FOLDERS
    ? all
    : all
      .sort((left, right) => depth(left.path) - depth(right.path) || compareExact(left.path, right.path))
      .slice(0, MAX_FOLDERS);
  return {
    folders: kept.sort((left, right) => compareExact(left.path, right.path)),
    truncated: all.length > MAX_FOLDERS,
  };
}

function depth(path: string): number {
  return path.split('/').length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
