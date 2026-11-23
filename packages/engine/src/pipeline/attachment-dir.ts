// src/pipeline/attachment-dir.ts
//
// Resolve the vault's attachment folder to its ACTUAL on-disk casing, so the
// engine never creates a folder that differs only in case from an existing one
// (a case-insensitive Obsidian Sync client would merge the two and re-case the
// whole folder — the 2026-06-16 incident). `configured` (VAULT_ATTACHMENT_DIR)
// selects WHICH folder name; the on-disk casing of an existing case-variant
// wins. Never throws: a missing/unreadable vault root returns the configured
// name (created on first write).
import { readdirSync } from 'node:fs';

export function resolveAttachmentDir(vaultPath: string, configured?: string): string {
  const name = configured ?? 'attachments';

  let dirNames: string[];
  try {
    dirNames = readdirSync(vaultPath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[attachment-dir] could not read vault root ${vaultPath}: ${msg}; using "${name}"`);
    return name;
  }

  const matches = dirNames.filter((d) => d.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) return name; // none on disk -> create as configured

  if (matches.length > 1) {
    // Already diverged (pathological; only possible on a case-sensitive FS).
    // Prefer the exact configured casing (includes() is an exact string match);
    // else pick deterministically by codepoint order (uppercase before lowercase).
    const pick = matches.includes(name) ? name : [...matches].sort()[0];
    console.warn(
      `[attachment-dir] multiple case-variants of "${name}" exist in the vault: ${matches.join(', ')}; using "${pick}". Consolidate them to one folder.`,
    );
    return pick;
  }

  const onDisk = matches[0];
  if (onDisk === name) return name; // exact casing present
  console.warn(
    `[attachment-dir] configured "${name}" but vault has "${onDisk}"; using "${onDisk}" to avoid a case-divergent folder`,
  );
  return onDisk;
}
