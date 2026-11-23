import { isSchemaName } from '../schema/name.js';

const INVALID_FILENAME_CHARACTER_RE = /[\u0000-\u001f<>:"/\\|?*]/;
const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const MAX_FILENAME_BYTES = 255;

/**
 * Return whether a normalized type value can be rendered as one portable
 * `.schemas/<name>.yaml` filename without escaping or colliding with Engine's
 * reserved schema namespace: Engine's own schema-name rule, plus what other
 * filesystems refuse.
 */
export function isApplySafeSchemaName(name: string): boolean {
  if (!isSchemaName(name)) return false;
  if (INVALID_FILENAME_CHARACTER_RE.test(name)) return false;
  if (WINDOWS_DEVICE_NAME_RE.test(name)) return false;
  return Buffer.byteLength(`${name}.yaml`, 'utf8') <= MAX_FILENAME_BYTES;
}

/** Approximate the filename equivalence used by portable case-insensitive filesystems. */
export function portableSchemaNameKey(name: string): string {
  return name.normalize('NFC').toUpperCase().normalize('NFC');
}
