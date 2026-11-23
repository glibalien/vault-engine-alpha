import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DOMAINS, settingsNotesForKeys } from '@vault/settings-registry';
import type { SettingsDomain, SettingIssue } from '@vault/settings-registry';
import { ok, fail } from './errors.js';
import type { Issue } from './errors.js';
import type { SettingsService } from '../../settings/service.js';
import { writeSettingsNotes } from '../../settings/note.js';
import type { NoteWriterDeps } from '../../settings/note.js';

function toWarning(i: SettingIssue): Issue {
  return { code: i.code, message: i.message, severity: 'warning', field: i.key };
}

export function registerPromptDefaults(
  server: McpServer, service: SettingsService, noteDeps: NoteWriterDeps,
): void {
  server.tool(
    'register-prompt-defaults',
    'Register built-in prompt defaults for text settings in a domain. Clients call this so Settings notes can document overrides and stale prompt versions.',
    { domain: z.string(), defaults: z.record(z.string(), z.unknown()) },
    async (params) => {
      const domain = params.domain as string;
      if (!(DOMAINS as readonly string[]).includes(domain)) {
        return fail('INVALID_PARAMS', `Unknown settings domain: ${domain}. Known: ${DOMAINS.join(', ')}`);
      }
      try {
        const d = domain as SettingsDomain;
        const result = service.registerPromptDefaults(d, params.defaults as Record<string, string>);
        const warnings = result.issues.map(toWarning);
        if (result.changed) {
          try {
            // Prompt defaults change only the engine-owned documentation body;
            // they do not own any frontmatter setting or explicit-null marker.
            writeSettingsNotes(noteDeps, d, { notes: settingsNotesForKeys(d, result.applied), touchedFields: [] });
          } catch (noteErr) {
            warnings.push({
              code: 'SETTINGS_NOTE_WRITE_FAILED',
              message: noteErr instanceof Error ? noteErr.message : String(noteErr),
              severity: 'warning',
            });
          }
        }
        return ok({ domain: d, applied: result.applied, changed: result.changed }, warnings);
      } catch (err) {
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
