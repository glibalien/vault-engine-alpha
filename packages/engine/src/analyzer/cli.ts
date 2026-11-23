#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { analyze, discoverTypeFields } from './index.js';
import { invalidArguments, type AnalyzerResult, type FieldTypeChoice } from './report.js';
import type { AnalyzeInput, FolderTypeRule, TagTypeRule } from './type-assignment.js';

export interface AnalyzerCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

type AnalyzerCliArguments =
  | { operation: 'discover'; root: string; exclude: string[] }
  | { operation: 'analyze'; root: string; typeField: string; typeKey?: string; exclude: string[] }
  | { operation: 'analyze'; root: string; specPath: string };

type AnalyzeSpec = Omit<AnalyzeInput, 'root'>;

const SPEC_KEYS = new Set(['type_field', 'type_key', 'folder_rules', 'tag_rules', 'type_renames', 'exclude', 'field_types']);
const FOLDER_RULE_KEYS = new Set(['directory', 'type']);
const TAG_RULE_KEYS = new Set(['tag', 'type']);

export async function runAnalyzerCli(argv: string[], io: AnalyzerCliIo): Promise<number> {
  const parsed = parseAnalyzerArgs(argv);
  if (!parsed.ok) {
    io.stdout(`${JSON.stringify(parsed)}\n`);
    return 2;
  }

  const result = await runOperation(parsed.data);
  io.stdout(`${JSON.stringify(result)}\n`);
  if (result.ok) return 0;
  return result.error.code === 'INVALID_ARGUMENTS' ? 2 : 1;
}

async function runOperation(args: AnalyzerCliArguments): Promise<AnalyzerResult<unknown>> {
  if (args.operation === 'discover') {
    return discoverTypeFields({ root: args.root, exclude: args.exclude });
  }
  if ('typeField' in args) {
    return analyze({
      root: args.root,
      typeField: args.typeField,
      ...(args.typeKey !== undefined ? { typeKey: args.typeKey } : {}),
      exclude: args.exclude,
    });
  }
  const spec = await readAnalyzeSpec(args.specPath);
  if (!spec.ok) return spec;
  return analyze({ root: args.root, ...spec.data });
}

function parseAnalyzerArgs(argv: string[]): AnalyzerResult<AnalyzerCliArguments> {
  const [operation, ...tokens] = argv;
  if (operation !== 'discover' && operation !== 'analyze') {
    return invalidArguments('operation must be discover or analyze');
  }

  const flags = new Map<string, string>();
  const exclude: string[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (flag !== '--root' && flag !== '--type-field' && flag !== '--type-key' && flag !== '--spec' && flag !== '--exclude') {
      return invalidArguments(`unknown argument: ${flag ?? ''}`.trim());
    }
    if (value === undefined || value === '' || value.startsWith('--')) {
      return invalidArguments(`missing value for ${flag}`);
    }
    if (flag === '--exclude') {
      exclude.push(value);
      continue;
    }
    if (flags.has(flag)) {
      return invalidArguments(`duplicate argument: ${flag}`);
    }
    flags.set(flag, value);
  }

  const root = flags.get('--root');
  if (!root) return invalidArguments('missing required argument: --root');

  if (operation === 'discover') {
    for (const flag of ['--type-field', '--type-key', '--spec']) {
      if (flags.has(flag)) return invalidArguments(`unknown argument for discover: ${flag}`);
    }
    return { ok: true, data: { operation, root, exclude } };
  }

  const typeField = flags.get('--type-field');
  const typeKey = flags.get('--type-key');
  const specPath = flags.get('--spec');
  if (typeField && specPath) {
    return invalidArguments('use either --type-field or --spec, not both');
  }
  if (specPath) {
    if (exclude.length > 0) return invalidArguments('put exclusions in the --spec file');
    if (typeKey !== undefined) return invalidArguments('put the type key in the --spec file');
    return { ok: true, data: { operation, root, specPath } };
  }
  if (!typeField) return invalidArguments('missing required argument: --type-field or --spec');
  return { ok: true, data: { operation, root, typeField, ...(typeKey !== undefined ? { typeKey } : {}), exclude } };
}

/**
 * Read an analysis spec: a JSON object with optional `type_field`, `type_key`, `folder_rules`
 * (`[{ directory, type }]`), `tag_rules` (`[{ tag, type }]`, #650), `type_renames` (`{ from: to | null }`), `exclude`, and
 * `field_types` (`{ field: { field_type, list_item_type? } }`).
 * Value validation is shared with the library through `analyze`.
 */
async function readAnalyzeSpec(path: string): Promise<AnalyzerResult<AnalyzeSpec>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return invalidArguments(`could not read spec file: ${error instanceof Error ? error.message : String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidArguments('spec file is not valid JSON');
  }
  if (!isJsonObject(value)) return invalidArguments('spec must be a JSON object');
  for (const key of Object.keys(value)) {
    if (!SPEC_KEYS.has(key)) return invalidArguments(`unknown spec key: ${key}`);
  }

  let folderRules: FolderTypeRule[] | undefined;
  if (value.folder_rules !== undefined) {
    if (!Array.isArray(value.folder_rules)) return invalidArguments('folder_rules must be an array');
    folderRules = [];
    for (const rule of value.folder_rules) {
      if (
        !isJsonObject(rule)
        || Object.keys(rule).some(key => !FOLDER_RULE_KEYS.has(key))
        || !('directory' in rule)
        || !('type' in rule)
      ) {
        return invalidArguments('each folder rule must be an object with exactly directory and type');
      }
      folderRules.push(rule as unknown as FolderTypeRule);
    }
  }

  let tagRules: TagTypeRule[] | undefined;
  if (value.tag_rules !== undefined) {
    if (!Array.isArray(value.tag_rules)) return invalidArguments('tag_rules must be an array');
    tagRules = [];
    for (const rule of value.tag_rules) {
      if (
        !isJsonObject(rule)
        || Object.keys(rule).some(key => !TAG_RULE_KEYS.has(key))
        || !('tag' in rule)
        || !('type' in rule)
      ) {
        return invalidArguments('each tag rule must be an object with exactly tag and type');
      }
      tagRules.push(rule as unknown as TagTypeRule);
    }
  }

  return {
    ok: true,
    data: {
      ...(tagRules ? { tagRules } : {}),
      ...(value.type_field !== undefined && value.type_field !== null
        ? { typeField: value.type_field as string }
        : {}),
      ...(value.type_key !== undefined && value.type_key !== null
        ? { typeKey: value.type_key as string }
        : {}),
      ...(folderRules ? { folderRules } : {}),
      ...(value.type_renames !== undefined
        ? { typeRenames: value.type_renames as Record<string, string | null> }
        : {}),
      ...(value.exclude !== undefined ? { exclude: value.exclude as string[] } : {}),
      ...(value.field_types !== undefined
        ? { fieldTypes: value.field_types as Record<string, FieldTypeChoice> }
        : {}),
    },
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAnalyzerCliEntrypoint(moduleUrl: string, entrypoint: string | undefined): boolean {
  if (!entrypoint) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return moduleUrl === pathToFileURL(entrypoint).href;
  }
}

if (isAnalyzerCliEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runAnalyzerCli(process.argv.slice(2), {
    stdout: value => process.stdout.write(value),
    stderr: value => process.stderr.write(value),
  });
}
