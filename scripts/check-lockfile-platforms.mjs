#!/usr/bin/env node
// Guard against a platform-incomplete package-lock.json.
//
// esbuild ships its native binary as per-platform optional dependencies
// (@esbuild/<os>-<cpu>). npm records optional deps for ALL os/cpu targets in the
// lockfile ONLY on a clean resolve; an incremental `npm install` reconciled against
// an existing single-platform node_modules preserves just the host's binary. A
// linux-only lockfile then breaks `npm install` on macOS/Windows: the correct
// @esbuild/<platform> isn't in the lockfile, so esbuild's postinstall falls back to
// a fragile self-download that can grab a stale version → "Expected X but got Y"
// abort → node_modules/.bin left unpopulated → every build fails with
// `sh: tsc: command not found`. (See the 2026-06-27 cross-platform lockfile fix.)
//
// This check runs in CI (it only reads JSON, so it needs no install) and fails the
// build if the committed lockfile is missing any required platform.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

// Platforms a contributor (or CI) might plausibly install on. The lockfile must
// carry an @esbuild/<platform> entry for each, or installs there are broken.
const REQUIRED = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];

const present = new Set(
  Object.keys(lock.packages ?? {})
    .map((k) => k.match(/@esbuild\/([^/]+)$/)?.[1])
    .filter(Boolean),
);

const missing = REQUIRED.filter((p) => !present.has(p));

if (missing.length > 0) {
  console.error(
    `\n✗ package-lock.json is platform-incomplete: missing @esbuild/{${missing.join(', ')}}.` +
      `\n  esbuild platforms present: ${[...present].sort().join(', ') || '(none)'}` +
      `\n\n  This silently breaks \`npm install\` on the missing platforms.` +
      `\n  Regenerate a COMPLETE, cross-platform lockfile with a clean resolve` +
      `\n  (no platform-omitting config), then commit it:` +
      `\n\n    rm -rf node_modules package-lock.json && npm install` +
      `\n\n  A clean resolve records optional binaries for every os/cpu target` +
      `\n  regardless of the host; an incremental install against an existing` +
      `\n  single-platform node_modules does not.\n`,
  );
  process.exit(1);
}

console.log(
  `✓ package-lock.json records esbuild binaries for all required platforms: ${REQUIRED.join(', ')}.`,
);
