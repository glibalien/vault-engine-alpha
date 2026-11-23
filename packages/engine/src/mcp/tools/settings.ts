import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DOMAINS, settingsNotesForKeys } from '@vault/settings-registry';
import type { SettingsDomain, SettingIssue } from '@vault/settings-registry';
import { ok, fail } from './errors.js';
import type { Issue } from './errors.js';
import type { SettingsService } from '../../settings/service.js';
import type { ModelCatalog } from '../../settings/models.js';
import { projectPendingSettingsNotes, writeSettingsNotes } from '../../settings/note.js';
import type { NoteWriterDeps } from '../../settings/note.js';
import { isDomainSeeded, markDomainSeeded } from '../../settings/store.js';
import { typeKey } from '../../parser/type-key.js';

/** Pseudo-domain name for the read-only, DB-assembled Settings/Models/ catalog. Not a SettingsDomain. */
const MODELS_PSEUDO_DOMAIN = 'models';

function toWarning(i: SettingIssue): Issue {
  return { code: i.code, message: i.message, severity: 'warning', field: i.key };
}

function domainPayload(service: SettingsService, domain: SettingsDomain) {
  return {
    effective: service.effectiveWithAliases(domain),
    stored: service.storedWithAliases(domain),
    version: service.version(domain),
    seeded: service.seeded(domain),
    issues: service.issues(domain),
  };
}

/**
 * The values set at install (VAULT_SETTINGS_DIR, VAULT_ATTACHMENT_DIR, VAULT_TYPE_KEY):
 * reported, not settings.
 */
function folders(service: SettingsService) {
  return { settingsDir: service.settingsDir, attachmentDir: service.attachmentDir, typeKey: typeKey() };
}

function modelsPayload(catalog: ModelCatalog) {
  return {
    catalog: catalog.entries(),
    providers: catalog.providerKeys(),
    version: catalog.version(),
    issues: catalog.issues(),
  };
}

export function registerGetSettings(server: McpServer, service: SettingsService, catalog: ModelCatalog): void {
  server.tool(
    'get-settings',
    'Return effective + stored settings, version, seeded flag, and current issues per domain, plus the read-only "models" pseudo-domain (the Settings/Models/ catalog). Omit domain for all domains + models. The "vault" domain is the vocabulary map (Settings/Vault.md): the kinds of notes (types), fields, status values and folders the suite reads in your notes; a kind or field that is null is none, and what depends on it is off. Its issues name designated types and fields no note has. wiki and curator still report their old names for vault keys (projectType, statusField, wikiDir, topicDir, activeStatuses, ...). settingsDir and attachmentDir are the folders set at install; typeKey is the frontmatter key that holds a note\'s types, also set at install.',
    { domain: z.string().optional() },
    async (params) => {
      const domain = params.domain as string | undefined;
      const knownDomains: readonly string[] = [...DOMAINS, MODELS_PSEUDO_DOMAIN];
      if (domain !== undefined && !knownDomains.includes(domain)) {
        return fail('INVALID_PARAMS', `Unknown settings domain: ${domain}. Known: ${knownDomains.join(', ')}`);
      }
      try {
        if (domain === MODELS_PSEUDO_DOMAIN) {
          return ok({ ...folders(service), domains: { [MODELS_PSEUDO_DOMAIN]: modelsPayload(catalog) } });
        }
        const list = domain ? [domain as SettingsDomain] : DOMAINS;
        const domains: Record<string, unknown> = Object.fromEntries(list.map(d => [d, domainPayload(service, d)]));
        if (domain === undefined) domains[MODELS_PSEUDO_DOMAIN] = modelsPayload(catalog);
        return ok({ ...folders(service), domains });
      } catch (err) {
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}

export function registerUpdateSettings(
  server: McpServer, service: SettingsService, noteDeps: NoteWriterDeps,
): void {
  server.tool(
    'update-settings',
    'Patch a settings domain. Omitted keys are unchanged; null resets a key to its default, except in the vault domain, where null sets a kind or field to none (turning off what depends on it); to restore a vault default, pass the default value. Rejected keys surface as warnings. Regenerates the settings notes that show the patched keys (every note for an empty patch). The wiki and curator domains still accept their old names for vault keys (null resets them) and write the vault key.',
    { domain: z.string(), patch: z.record(z.string(), z.unknown()) },
    async (params) => {
      const domain = params.domain as string;
      if (domain === MODELS_PSEUDO_DOMAIN) {
        return fail('INVALID_PARAMS', 'models is read-assembled from Settings/Models/ notes — edit the notes');
      }
      if (!(DOMAINS as readonly string[]).includes(domain)) {
        return fail('INVALID_PARAMS', `Unknown settings domain: ${domain}. Known: ${DOMAINS.join(', ')}`);
      }
      try {
        const d = domain as SettingsDomain;
        const result = service.applyPatch(
          d,
          params.patch as Record<string, unknown>,
          { journalProjection: true },
        );
        const warnings = result.issues.map(toWarning);
        // Service-side seeding contract (Phase 2): any successful programmatic
        // write means this domain is now canonically managed — env seeding for
        // it must never run afterwards (setWikiConfig precedent). Empty patches
        // count: a fresh install with no migrated env vars still seeds.
        if (!isDomainSeeded(noteDeps.db, d)) markDomainSeeded(noteDeps.db, d);
        // The patch already committed (the change is live). If regenerating the
        // note throws, do NOT fail the call — returning INTERNAL_ERROR would
        // report failure on a change that took effect, and the stale note would
        // silently revert it at the next ingest. Surface a warning instead; the
        // next successful write-back (or a re-save) reconciles the file.
        const noteWriteFailed = (noteErr: unknown): void => {
          warnings.push({
            code: 'SETTINGS_NOTE_WRITE_FAILED',
            message: noteErr instanceof Error ? noteErr.message : String(noteErr),
            severity: 'warning',
          });
        };
        // The notes that show the patch's keys (#746); every note for an empty patch.
        const written = settingsNotesForKeys(d, Object.keys(params.patch));
        try {
          writeSettingsNotes(noteDeps, d, { notes: written, touchedFields: result.applied });
        } catch (noteErr) {
          noteWriteFailed(noteErr);
        }
        // A vault key written by an old name journaled Vault.md: project it too, unless it
        // holds edits not yet read, which its own ingest then merges with the journaled keys.
        // The notes just written are skipped: a failed one keeps its journal for later.
        try {
          projectPendingSettingsNotes(noteDeps, written);
        } catch (noteErr) {
          noteWriteFailed(noteErr);
        }
        const payload = domainPayload(service, d);
        return ok(
          { domain: d, effective: payload.effective, stored: payload.stored, version: payload.version, applied: result.applied },
          warnings,
        );
      } catch (err) {
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
