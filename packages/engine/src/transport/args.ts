export interface ParsedArgs {
  dbPath: string | undefined;
  vaultPath: string | undefined;
  transport: 'stdio' | 'http' | 'both';
  port: number;
  reindexSearch: boolean;
  normalize: boolean;
  dryRun: boolean;
  referenceResolution?: 'preview' | 'apply';
  previewFingerprint?: string;
  offline?: boolean;
}

const VALID_TRANSPORTS = new Set(['stdio', 'http', 'both']);

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    dbPath: undefined,
    vaultPath: undefined,
    transport: 'stdio',
    port: 3333,
    reindexSearch: false,
    normalize: false,
    dryRun: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reference-resolution') {
      if (result.referenceResolution) throw new Error('Duplicate --reference-resolution');
      const value = argv[++i];
      if (value !== 'preview' && value !== 'apply') throw new Error('--reference-resolution requires preview or apply');
      result.referenceResolution = value;
    } else if (arg === '--preview-fingerprint') {
      const value = argv[++i];
      if (result.previewFingerprint || !value || !/^[a-f0-9]{64}$/.test(value)) throw new Error('--preview-fingerprint requires 64 lowercase hexadecimal characters');
      result.previewFingerprint = value;
    } else if (arg === '--offline') {
      result.offline = true;
    } else if (arg === '--transport') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --transport. Must be stdio, http, or both.');
      }
      const value = argv[++i];
      if (!VALID_TRANSPORTS.has(value)) {
        throw new Error(`Invalid --transport value: "${value}". Must be stdio, http, or both.`);
      }
      result.transport = value as ParsedArgs['transport'];
    } else if (arg === '--port') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --port. Must be an integer between 1 and 65535.');
      }
      const value = argv[++i];
      const num = Number(value);
      if (!Number.isInteger(num) || num < 1 || num > 65535) {
        throw new Error(`Invalid --port value: "${value}". Must be an integer between 1 and 65535.`);
      }
      result.port = num;
    } else if (arg === '--reindex-search') {
      result.reindexSearch = true;
    } else if (arg === '--normalize') {
      result.normalize = true;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (positional.length >= 1) result.dbPath = positional[0];
  if (positional.length >= 2) result.vaultPath = positional[1];

  if (result.referenceResolution) {
    if (argv.some(arg => ['--normalize', '--reindex-search', '--transport', '--port', '--dry-run'].includes(arg))) {
      throw new Error('Reference administration conflicts with normalize, reindex and transport options');
    }
    if (result.referenceResolution === 'apply' && (!result.offline || !result.previewFingerprint)) {
      throw new Error('Reference activation requires --offline and --preview-fingerprint');
    }
    if (result.referenceResolution === 'preview' && (result.offline || result.previewFingerprint)) {
      throw new Error('Preview does not accept apply guards');
    }
  } else if (result.offline || result.previewFingerprint) {
    throw new Error('Reference activation guards require --reference-resolution apply');
  }
  return result;
}
