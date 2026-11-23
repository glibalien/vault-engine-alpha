const INVALID_FILENAME_CHARACTER_RE = /[\u0000-\u001f<>:"/\\|?*]/;
const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const WIKI_LINK_WRAPPER_RE = /^\[\[(.+)\]\]$/;

/**
 * Whether `name` can be a final schema name. Mirrors Vault Analyzer's rules, which the
 * Analyzer enforces again: trimmed, safe as a portable `.schemas/<name>.yaml`, not in
 * Engine's reserved `_` namespace, and not a wiki-link that Engine's parser would unwrap.
 */
export function isTypeName(name: string): boolean {
  return name.length > 0
    && name === name.trim()
    && name !== '.'
    && name !== '..'
    && !name.startsWith('_')
    && !INVALID_FILENAME_CHARACTER_RE.test(name)
    && !WINDOWS_DEVICE_NAME_RE.test(name)
    && !WIKI_LINK_WRAPPER_RE.test(name)
    && Buffer.byteLength(`${name}.yaml`, 'utf8') <= 255;
}

/**
 * Names that share this key share one schema filename on case-insensitive filesystems.
 * Mirrors Vault Analyzer's `portableSchemaNameKey`.
 */
export function portableTypeKey(name: string): string {
  return name.normalize('NFC').toUpperCase().normalize('NFC');
}

/** A singular, lower-case type name suggested for a folder: `Meetings` -> `meeting`. */
export function suggestTypeName(folder: string): string {
  const name = folder.trim().toLowerCase();
  if (name === 'people') return 'person';
  if (/[^aeiou]ies$/.test(name)) return `${name.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(name)) return name;
  if (/(ches|shes|xes)$/.test(name)) return name.slice(0, -2);
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}
