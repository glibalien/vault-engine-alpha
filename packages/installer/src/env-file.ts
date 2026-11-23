import type { Secret } from './secret.js';

/** A variable for an env file; secrets stay wrapped until the file is rendered. */
export type EnvValue = string | Secret;

export interface EnvEntry {
  name: string;
  value: EnvValue;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BARE = /^[A-Za-z0-9_@%+=:,./-]*$/;

export class EnvFileError extends Error {
  override readonly name = 'EnvFileError';
}

/**
 * Who reads the file: systemd's `EnvironmentFile` (Linux), or Node's `--env-file` (the
 * launchd agents on macOS, since launchd reads no env file). They quote differently.
 */
export type EnvDialect = 'systemd' | 'node';

/**
 * Render an env file for `dialect` (systemd's unless given). Plain values are written
 * bare, anything else is quoted so its reader reads it back verbatim (systemd.exec,
 * EnvironmentFile=; Node's dotenv parser). The message for a value the file cannot hold
 * names the variable, never its value.
 */
export function renderEnvFile(comments: readonly string[], entries: readonly EnvEntry[], dialect: EnvDialect = 'systemd'): string {
  const lines = comments.map(comment => `# ${comment}`);
  if (lines.length > 0) lines.push('');
  const seen = new Set<string>();
  for (const { name, value } of entries) {
    if (!NAME.test(name)) throw new EnvFileError(`invalid variable name: ${name}`);
    if (seen.has(name)) throw new EnvFileError(`variable set twice: ${name}`);
    seen.add(name);
    const text = typeof value === 'string' ? value : value.reveal();
    lines.push(`${name}=${dialect === 'node' ? quoteForNode(name, text) : quote(name, text)}`);
  }
  return `${lines.join('\n')}\n`;
}

function quote(name: string, value: string): string {
  if (/[\n\r\0]/.test(value)) throw new EnvFileError(`${name} contains a line break, which an env file cannot hold`);
  if (BARE.test(value)) return value;
  // Single quotes keep every character verbatim; double quotes only when the value has one.
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/[\\"`$]/g, character => `\\${character}`)}"`;
}

/**
 * Node's parser has no escapes: a quoted value runs to the next quote of the same kind,
 * and in double quotes `\n` becomes a line break. So each value takes a quote it does not
 * contain, and double quotes only without a backslash.
 */
function quoteForNode(name: string, value: string): string {
  if (/[\n\r\0]/.test(value)) throw new EnvFileError(`${name} contains a line break, which an env file cannot hold`);
  if (BARE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  throw new EnvFileError(`${name} holds ', \` and " or \\ together, which Node's env file cannot hold`);
}

/**
 * Read back a file this module rendered, in either dialect: comments, blank lines, and
 * `NAME=value` with a bare, single-quoted, backtick-quoted (Node's), or double-quoted
 * value on one line. A Node-dialect double-quoted value never holds a backslash, so the
 * systemd escapes read it the same.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const equals = line.indexOf('=');
    const name = equals > 0 ? line.slice(0, equals).trim() : '';
    if (!NAME.test(name)) throw new EnvFileError(`line ${index + 1} is not NAME=value`);
    values.set(name, unquote(line.slice(equals + 1).trim(), index + 1));
  }
  return values;
}

function unquote(value: string, line: number): string {
  for (const [quote, kind] of [["'", 'single'], ['`', 'backtick']] as const) {
    if (!value.startsWith(quote)) continue;
    if (value.length < 2 || !value.endsWith(quote) || value.slice(1, -1).includes(quote)) {
      throw new EnvFileError(`line ${line} has an unterminated ${kind}-quoted value`);
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    let result = '';
    for (let index = 1; index < value.length; index++) {
      const character = value[index] as string;
      if (character === '\\' && index + 1 < value.length) {
        const next = value[index + 1] as string;
        result += '\\"`$'.includes(next) ? next : `\\${next}`;
        index++;
      } else if (character === '"') {
        if (index !== value.length - 1) throw new EnvFileError(`line ${line} has text after a quoted value`);
        return result;
      } else {
        result += character;
      }
    }
    throw new EnvFileError(`line ${line} has an unterminated double-quoted value`);
  }
  return value;
}
