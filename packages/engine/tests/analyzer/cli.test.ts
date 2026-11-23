import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isAnalyzerCliEntrypoint, runAnalyzerCli } from '../../src/analyzer/cli.js';
import { fm, makeScanTree } from './helpers.js';

const roots: string[] = [];

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await makeScanTree(files);
  roots.push(root);
  return root;
}

function memoryIo(): {
  stdout: string;
  stderr: string;
  io: { stdout(value: string): void; stderr(value: string): void };
} {
  let stdout = '';
  let stderr = '';
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    io: {
      stdout(value) { stdout += value; },
      stderr(value) { stderr += value; },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('runAnalyzerCli', () => {
  it('recognizes an npm-style symlink as the CLI entrypoint', async () => {
    const root = await makeTree({ placeholder: '' });
    const cliPath = fileURLToPath(new URL('../../src/analyzer/cli.ts', import.meta.url));
    const linkedPath = join(root, 'vault-analyzer');
    await symlink(cliPath, linkedPath);

    expect(isAnalyzerCliEntrypoint(pathToFileURL(cliPath).href, linkedPath)).toBe(true);
  });

  it('serializes one discovery result to stdout and leaves stderr empty', async () => {
    const root = await makeTree({ 'Note.md': fm({ kind: 'note' }) });
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(['discover', '--root', root], output.io);

    expect(exitCode).toBe(0);
    expect(output.stderr).toBe('');
    expect(output.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, data: { format_version: 2 } });
  });

  it('returns exit 2 and INVALID_ARGUMENTS for a missing type field', async () => {
    const root = await makeTree({ 'Note.md': fm({ kind: 'note' }) });
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(['analyze', '--root', root], output.io);

    expect(exitCode).toBe(2);
    expect(output.stderr).toBe('');
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENTS' },
    });
  });

  it.each([
    ['an unsupported operation', ['inspect', '--root', '/tmp/vault']],
    ['an unknown flag', ['discover', '--root', '/tmp/vault', '--verbose']],
    ['a missing root', ['discover']],
    ['a duplicate root flag', ['discover', '--root', '/tmp/one', '--root', '/tmp/two']],
  ])('returns exit 2 and one JSON error for %s', async (_label, argv) => {
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(argv, output.io);

    expect(exitCode).toBe(2);
    expect(output.stderr).toBe('');
    expect(output.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENTS' },
    });
  });

  it.each([
    [
      'a duplicate --type-field',
      ['analyze', '--root', '/tmp/vault', '--type-field', 'kind', '--type-field', 'types'],
    ],
    [
      '--type-field on discover',
      ['discover', '--root', '/tmp/vault', '--type-field', 'kind'],
    ],
  ])('returns exit 2, one JSON envelope, and clean stderr for %s', async (_label, argv) => {
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(argv, output.io);

    expect(exitCode).toBe(2);
    expect(output.stderr).toBe('');
    expect(output.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENTS' },
    });
  });

  it('returns exit 0 when analysis reports non-fatal issues', async () => {
    const root = await makeTree({
      'Typed.md': fm({ kind: 'note' }),
      'Untyped.md': fm({ title: 'No type' }),
    });
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(
      ['analyze', '--root', root, '--type-field', 'kind'],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(output.stderr).toBe('');
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: true,
      data: { issues: [{ code: 'TYPE_KEY_INCOMPLETE_COVERAGE' }] },
    });
  });

  it('returns exit 1 for an Analyzer refusal', async () => {
    const root = await makeTree({ 'Note.md': fm({ kind: 'note' }) });
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(
      ['analyze', '--root', root, '--type-field', 'type'],
      output.io,
    );

    expect(exitCode).toBe(1);
    expect(output.stderr).toBe('');
    expect(output.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      error: { code: 'TYPE_FIELD_NOT_FOUND' },
    });
  });

  it('emits one valid JSON envelope for recursive aliases, NaN, and infinities', async () => {
    const root = await makeTree({
      'Unsafe.md': [
        '---',
        'kind: note',
        'recursive: &loop [*loop]',
        'nan: .nan',
        'positive: .inf',
        'negative: -.inf',
        '---',
        '',
      ].join('\n'),
    });
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(
      ['analyze', '--root', root, '--type-field', 'kind'],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(output.stderr).toBe('');
    expect(output.stdout.trim().split('\n')).toHaveLength(1);
    const envelope = JSON.parse(output.stdout);
    expect(envelope).toMatchObject({ ok: true, data: { format_version: 2 } });
    expect(envelope.data.needs_review.ambiguous_fields.map((field: { name: string }) => field.name))
      .toEqual(['nan', 'negative', 'positive', 'recursive']);
  });

  it('emits one refusal envelope without fabricated fields for a non-plain YAML root', async () => {
    const root = await makeTree({
      'Set.md': '---\n!!set\nkind:\n---\n',
    });
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(
      ['analyze', '--root', root, '--type-field', 'analyzer_value'],
      output.io,
    );

    expect(exitCode).toBe(1);
    expect(output.stderr).toBe('');
    expect(output.stdout.trim().split('\n')).toHaveLength(1);
    const envelope = JSON.parse(output.stdout);
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'TYPE_FIELD_NOT_FOUND' },
    });
    expect(envelope).not.toHaveProperty('data');
  });

  it('analyzes from a JSON spec with folder rules, renames, and exclusions', async () => {
    const root = await makeTree({
      'Meetings/A.md': fm({ kind: 'Meeting' }),
      'Meetings/B.md': '# Plain\n',
      'Templates/T.md': fm({ kind: 'template' }),
    });
    const specPath = await writeSpec({
      type_field: 'kind',
      folder_rules: [{ directory: 'Meetings', type: 'meeting' }],
      type_renames: { Meeting: 'meeting' },
      exclude: ['Templates'],
    });
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(['analyze', '--root', root, '--spec', specPath], output.io);

    expect(exitCode).toBe(0);
    expect(output.stderr).toBe('');
    const envelope = JSON.parse(output.stdout);
    expect(envelope.data.source).toMatchObject({ confirmed_type_field: 'kind', exclusions: ['Templates'] });
    expect(envelope.data.proposal.schemas.map((schema: { name: string }) => schema.name)).toEqual(['meeting']);
    expect(envelope.data.coverage).toMatchObject({ typed_by_type_field: 1, typed_by_folder_rule: 1 });
  });

  it('applies field_types from a JSON spec', async () => {
    const root = await makeTree({
      'A.md': fm({ kind: 'note', rating: 'high' }),
      'B.md': fm({ kind: 'note', rating: 4 }),
    });
    const specPath = await writeSpec({ type_field: 'kind', field_types: { rating: { field_type: 'string' } } });
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(['analyze', '--root', root, '--spec', specPath], output.io);

    expect(exitCode).toBe(0);
    const envelope = JSON.parse(output.stdout);
    expect(envelope.data.proposal.global_fields).toEqual([expect.objectContaining({ name: 'rating', field_type: 'string' })]);
    expect(envelope.data.needs_review.ambiguous_fields).toEqual([]);
  });

  it('takes the type key from --type-key or the spec\'s type_key (#445)', async () => {
    const root = await makeTree({ 'A.md': fm({ kind: 'note' }) });
    const flagged = memoryIo();
    const specced = memoryIo();
    const specPath = await writeSpec({ type_field: 'kind', type_key: 'kind' });

    const flagExit = await runAnalyzerCli(['analyze', '--root', root, '--type-field', 'kind', '--type-key', 'kind'], flagged.io);
    const specExit = await runAnalyzerCli(['analyze', '--root', root, '--spec', specPath], specced.io);

    expect([flagExit, specExit]).toEqual([0, 0]);
    expect(JSON.parse(flagged.stdout).data.proposal.type_field_mapping).toEqual({ source: 'kind', target: 'kind' });
    expect(JSON.parse(specced.stdout).data.proposal.type_field_mapping).toEqual({ source: 'kind', target: 'kind' });
  });

  it('accepts a null type_field for folder-only specs', async () => {
    const root = await makeTree({ 'People/Alice.md': '# Alice\n' });
    const specPath = await writeSpec({
      type_field: null,
      folder_rules: [{ directory: 'People', type: 'person' }],
    });
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(['analyze', '--root', root, '--spec', specPath], output.io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout).data.proposal.type_field_mapping).toBeNull();
  });

  it('accepts repeated --exclude flags on discover and analyze', async () => {
    const root = await makeTree({
      'Notes/A.md': fm({ kind: 'note' }),
      'Templates/T.md': fm({ kind: 'template' }),
      'Archive/X.md': fm({ kind: 'note' }),
    });
    const discover = memoryIo();
    const analyzeOutput = memoryIo();

    const discoverExit = await runAnalyzerCli(
      ['discover', '--root', root, '--exclude', 'Templates', '--exclude', 'Archive'],
      discover.io,
    );
    const analyzeExit = await runAnalyzerCli(
      ['analyze', '--root', root, '--type-field', 'kind', '--exclude', 'Templates', '--exclude', 'Archive'],
      analyzeOutput.io,
    );

    expect(discoverExit).toBe(0);
    expect(JSON.parse(discover.stdout).data.source.exclusions).toEqual(['Archive', 'Templates']);
    expect(analyzeExit).toBe(0);
    expect(JSON.parse(analyzeOutput.stdout).data.inventory.markdown_files).toBe(1);
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a non-object spec', '[]'],
    ['an unknown spec key', JSON.stringify({ type_field: 'kind', folder_rule: [] })],
    ['a folder rule without a type', JSON.stringify({ folder_rules: [{ directory: 'A' }] })],
    ['a folder rule with an extra key', JSON.stringify({ folder_rules: [{ directory: 'A', type: 'a', depth: 1 }] })],
    ['an invalid rule directory', JSON.stringify({ folder_rules: [{ directory: '../A', type: 'a' }] })],
    ['a spec with nothing to assign', JSON.stringify({ exclude: ['Templates'] })],
    ['an invalid field type', JSON.stringify({ type_field: 'kind', field_types: { rating: { field_type: 'enum' } } })],
  ])('returns exit 2 and INVALID_ARGUMENTS for %s', async (_label, contents) => {
    const root = await makeTree({ 'Note.md': fm({ kind: 'note' }) });
    const specPath = await writeSpecText(contents);
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(['analyze', '--root', root, '--spec', specPath], output.io);

    expect(exitCode).toBe(2);
    expect(output.stderr).toBe('');
    expect(output.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  });

  it.each([
    ['--type-field with --spec', ['analyze', '--root', '/tmp/vault', '--type-field', 'kind', '--spec', '/tmp/s.json']],
    ['--exclude with --spec', ['analyze', '--root', '/tmp/vault', '--spec', '/tmp/s.json', '--exclude', 'A']],
    ['--spec on discover', ['discover', '--root', '/tmp/vault', '--spec', '/tmp/s.json']],
    ['a missing spec file', ['analyze', '--root', '/tmp/vault', '--spec', '/definitely/missing/spec.json']],
  ])('returns exit 2 for %s', async (_label, argv) => {
    const output = memoryIo();

    const exitCode = await runAnalyzerCli(argv, output.io);

    expect(exitCode).toBe(2);
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  });
});

async function writeSpec(spec: unknown): Promise<string> {
  return writeSpecText(JSON.stringify(spec));
}

async function writeSpecText(contents: string): Promise<string> {
  const directory = await makeScanTree({ 'spec.json': contents });
  roots.push(directory);
  return join(directory, 'spec.json');
}
