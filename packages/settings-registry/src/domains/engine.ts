import type { SettingDescriptor } from '../types.js';

export interface EngineSettings {
  provenanceRequestBytes: number;
  provenanceComponentBytes: number;
  provenanceItemCount: number;
  provenanceOutputBytes: number;
  provenanceTotalBytes: number;
  provenanceCapacityBytes: number;
  provenanceLeaseHours: number;
  provenanceFailedRetentionDays: number;

  excludeDirs: string[];
  backupsEnabled: boolean;
  backupIntervalHours: number;
  backupKeep: number;
  editsLogRetentionDays: number;
  extractionCacheRetentionDays: number;
  syncLogRetentionHours: number;
  undoRetentionHours: number;
  normalizeCron: string;
  normalizeQuiescenceMinutes: number;
  linkRepair: 'on' | 'report' | 'off';
  extractionEnabled: boolean;
  visionProvider: 'gemini' | 'claude' | 'model';
  visionModel: string;
  memoryConsolidationModel: string;
}

const csv = (raw: string): string[] => raw.split(',').map(s => s.trim()).filter(Boolean);
const int = (raw: string): unknown => { const n = parseInt(raw, 10); return Number.isFinite(n) ? n : raw; };

export const ENGINE_DESCRIPTORS: SettingDescriptor[] = [
  { key: 'provenanceRequestBytes', domain: 'engine', type: { kind: 'int', min: 1, max: 1048576 }, default: 1048576, reload: 'next-use',
    description: 'Maximum effective provider request bytes.' },
  { key: 'provenanceComponentBytes', domain: 'engine', type: { kind: 'int', min: 1, max: 262144 }, default: 262144, reload: 'next-use',
    description: 'Maximum selected input component bytes.' },
  { key: 'provenanceItemCount', domain: 'engine', type: { kind: 'int', min: 1, max: 512 }, default: 512, reload: 'next-use',
    description: 'Maximum captured input items.' },
  { key: 'provenanceOutputBytes', domain: 'engine', type: { kind: 'int', min: 1, max: 262144 }, default: 262144, reload: 'next-use',
    description: 'Maximum generated home contribution bytes.' },
  { key: 'provenanceTotalBytes', domain: 'engine', type: { kind: 'int', min: 1, max: 2097152 }, default: 2097152, reload: 'next-use',
    description: 'Maximum retained bytes reserved per derivation.' },
  { key: 'provenanceCapacityBytes', domain: 'engine', type: { kind: 'int', min: 1, max: 1099511627776 }, default: 1073741824, reload: 'next-use',
    description: 'Logical provenance capacity including active reservations; excludes indexes and backups.' },
  { key: 'provenanceLeaseHours', domain: 'engine', type: { kind: 'int', min: 1, max: 168 }, default: 24, reload: 'next-use',
    description: 'Hours before an uncommitted capture is abandoned.' },
  { key: 'provenanceFailedRetentionDays', domain: 'engine', type: { kind: 'int', min: 1, max: 365 }, default: 7, reload: 'next-use',
    description: 'Days to retain failed or abandoned payloads. Committed captures never expire automatically.' },

  { key: 'excludeDirs', domain: 'engine', type: { kind: 'string-list' }, default: [], reload: 're-arm',
    envSeed: { var: 'VAULT_EXCLUDE_DIRS', parse: csv },
    description: 'Folder prefixes excluded from indexing, watching, reconciling, and normalizing. Segment-based: "Notes" does not match "TaskNotes". May never cover the settings folder itself.' },
  { key: 'backupsEnabled', domain: 'engine', type: { kind: 'bool' }, default: true, reload: 're-arm',
    envSeed: { var: 'VAULT_BACKUP_DISABLED', parse: raw => raw !== '1' },
    description: 'Daily VACUUM INTO database backups. Disabling skips backups; optimize and retention sweeps still run.' },
  { key: 'backupIntervalHours', domain: 'engine', type: { kind: 'int', min: 1 }, default: 24, reload: 're-arm',
    envSeed: { var: 'VAULT_BACKUP_INTERVAL_HOURS', parse: int },
    description: 'Hours between database backup runs.' },
  { key: 'backupKeep', domain: 'engine', type: { kind: 'int', min: 1 }, default: 7, reload: 're-arm',
    envSeed: { var: 'VAULT_BACKUP_KEEP', parse: int },
    description: 'Number of daily backup snapshots retained (rotation by filename).' },
  { key: 'editsLogRetentionDays', domain: 'engine', type: { kind: 'int', min: 1 }, default: 90, reload: 're-arm',
    envSeed: { var: 'EDITS_LOG_RETENTION_DAYS', parse: int },
    description: 'Days of edits_log history kept (value-removed discard records are exempt forever).' },
  { key: 'extractionCacheRetentionDays', domain: 'engine', type: { kind: 'int', min: 1 }, default: 30, reload: 're-arm',
    envSeed: { var: 'EXTRACTION_CACHE_RETENTION_DAYS', parse: int },
    description: 'LRU retention window for cached attachment extractions.' },
  { key: 'syncLogRetentionHours', domain: 'engine', type: { kind: 'int', min: 1 }, default: 24, reload: 're-arm',
    envSeed: { var: 'SYNC_LOG_RETENTION_HOURS', parse: int },
    description: 'Hours of sync_log file-event history kept.' },
  { key: 'undoRetentionHours', domain: 'engine', type: { kind: 'int', min: 1 }, default: 24, reload: 're-arm',
    envSeed: { var: 'UNDO_RETENTION_HOURS', parse: int },
    description: 'Hours undo snapshots are kept before the hourly cleanup sweep removes them.' },
  { key: 'normalizeCron', domain: 'engine', type: { kind: 'cron-or-empty' }, default: '', reload: 're-arm',
    envSeed: { var: 'NORMALIZE_CRON' },
    description: 'Cron expression for the periodic normalizer sweep. Empty disables it.' },
  { key: 'normalizeQuiescenceMinutes', domain: 'engine', type: { kind: 'int', min: 0 }, default: 60, reload: 're-arm',
    envSeed: { var: 'NORMALIZE_QUIESCENCE_MINUTES', parse: int },
    description: 'Normalizer skips files modified within this many minutes.' },
  { key: 'linkRepair', domain: 'engine', type: { kind: 'enum', values: ['on', 'report', 'off'] }, default: 'on', reload: 'restart',
    description: 'Startup link repair. on: at each Engine start, notes holding links that resolve only inside Engine, or that miss a note by filename sanitization, are re-saved with each such link naming its file, and stored titles that drifted from their filenames are reset. A re-saved note is rendered in full, so it also gets the type key and Engine\'s field order. report: log the notes a repair would re-save, writing nothing. off: skip it; vault-doctor still reports these links. Applied at the next Engine restart.' },
  { key: 'extractionEnabled', domain: 'engine', type: { kind: 'bool' }, default: true, reload: 'restart',
    envSeed: { var: 'EXTRACTION_ENABLED', parse: raw => raw.trim().toLowerCase() !== 'false' },
    description: 'Paid attachment extraction: Deepgram audio, and vision for images and scanned PDFs. Off keeps their API keys for other features; attachments are then read only by the free local extractors (Markdown, Office, text PDFs, SVG). Applied after an engine restart, which queues every attachment again.' },
  { key: 'visionProvider', domain: 'engine', type: { kind: 'enum', values: ['gemini', 'claude', 'model'] }, default: 'gemini', reload: 're-arm',
    envSeed: { var: 'VISION_PROVIDER', parse: (raw: string) => raw.trim().toLowerCase() === 'qwen' ? 'model' : raw.trim() },
    description: 'Vision model provider for image extraction and scanned-PDF fallback: gemini, claude, or model (any vision-capable Settings/Models catalog entry named by visionModel). Requires the matching API key in env. Applied live — the extractor set re-arms.' },
  { key: 'visionModel', domain: 'engine', type: { kind: 'model-ref' }, default: '[[Qwen 3.7 Plus]]', reload: 're-arm',
    envSeed: { var: 'QWEN_VISION_MODEL' },
    description: 'Catalog reference ([[Model Note Title]]) for the vision model used when visionProvider is "model" — any vision-capable catalog entry on any provider. It reads images; when its provider takes PDF input (Anthropic, OpenAI) it also reads scanned PDFs, otherwise those go to Gemini. Applied live — the extractor set re-arms.' },
  { key: 'memoryConsolidationModel', domain: 'engine', type: { kind: 'model-ref' }, default: '[[Qwen 3.7 Plus]]', reload: 'next-use',
    envSeed: { var: 'MEMORY_CONSOLIDATION_MODEL' },
    description: 'Catalog reference for the memory-consolidation classifier, on any provider. Consolidation runs when any provider key is set; without one, new memories are stored without consolidation, and a missing key for the chosen model stores that memory unconsolidated. Read per call.' },
];
