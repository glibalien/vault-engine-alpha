import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { parseArgs } from './transport/args.js';

// Administrative commands must dispatch before loading ordinary bootstrap seams.
loadDotenv({ path: resolve(import.meta.dirname ?? '.', '..', '.env'), quiet: true });
const args = parseArgs(process.argv.slice(2));
if (args.referenceResolution) {
  const { runReferenceAdministration } = await import('./resolver/admin.js');
  try {
    console.log(JSON.stringify(runReferenceAdministration(args, process.env)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  await import('./server-startup.js');
}
