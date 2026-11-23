import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';

export async function makeScanTree(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vault-analyzer-'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

export async function snapshotTree(root: string): Promise<{
  paths: string[];
  entries: Array<{ path: string; kind: 'directory' | 'file' | 'symlink'; sha256?: string }>;
}> {
  const entries: Array<{ path: string; kind: 'directory' | 'file' | 'symlink'; sha256?: string }> = [];

  async function walk(directory: string): Promise<void> {
    const children = await readdir(directory);
    for (const name of children.sort(compareExact)) {
      const path = join(directory, name);
      const stats = await lstat(path);
      const relativePath = relative(root, path).replaceAll('\\', '/');
      if (stats.isSymbolicLink()) {
        entries.push({ path: relativePath, kind: 'symlink' });
      } else if (stats.isDirectory()) {
        entries.push({ path: relativePath, kind: 'directory' });
        await walk(path);
      } else if (stats.isFile()) {
        entries.push({
          path: relativePath,
          kind: 'file',
          sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
        });
      }
    }
  }

  await walk(root);
  entries.sort((left, right) => compareExact(left.path, right.path));
  return { paths: entries.map(entry => entry.path), entries };
}

export function fm(data: Record<string, unknown>): string {
  return `---\n${stringify(data)}---\n`;
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
