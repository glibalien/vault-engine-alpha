import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

import { validateDependency } from '../node_modules/dependency-cruiser/src/validate/index.mjs';

const require = createRequire(import.meta.url);
const config = require('../.dependency-cruiser.cjs');
const ruleSet = { forbidden: config.forbidden };

function dependencyIsForbidden(from, to) {
  return !validateDependency(
    ruleSet,
    { source: from },
    {
      resolved: to,
      dependencyTypes: ['local'],
      couldNotResolve: false,
      circular: false,
      dynamic: false,
      exoticallyRequired: false,
    },
  ).valid;
}

const workspaceDirectories = readdirSync(new URL('../packages/', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

for (const leafDirectory of ['contract', 'pricing', 'settings-registry']) {
  for (const workspaceDirectory of workspaceDirectories) {
    if (workspaceDirectory === leafDirectory) continue;

    assert.equal(
      dependencyIsForbidden(
        `packages/${leafDirectory}/src/index.ts`,
        `packages/${workspaceDirectory}/src/index.ts`,
      ),
      true,
      `${leafDirectory} must not import workspace package ${workspaceDirectory}`,
    );
  }
}

const deployableSurfaces = ['engine', 'curator', 'obsidian-plugin'];

for (const sourceSurface of deployableSurfaces) {
  for (const targetSurface of deployableSurfaces) {
    if (sourceSurface === targetSurface) continue;

    assert.equal(
      dependencyIsForbidden(
        `packages/${sourceSurface}/src/example.ts`,
        `packages/${targetSurface}/src/index.ts`,
      ),
      true,
      `${sourceSurface} must not import deployable surface ${targetSurface}`,
    );
  }
}

assert.equal(
  dependencyIsForbidden(
    'packages/curator/src/example.ts',
    'packages/contract/src/index.ts',
  ),
  false,
  'Curator may import the shared Contract package',
);

assert.equal(
  dependencyIsForbidden(
    'packages/viz-ui/src/example.ts',
    'packages/query-core/src/index.ts',
  ),
  false,
  'Viz UI may import Query Core',
);

for (const workspaceDirectory of workspaceDirectories) {
  if (workspaceDirectory === 'installer') continue;
  const sharedContract = ['settings-registry', 'contract', 'pricing'].includes(workspaceDirectory);

  assert.equal(
    dependencyIsForbidden(
      'packages/installer/src/example.ts',
      `packages/${workspaceDirectory}/src/index.ts`,
    ),
    !sharedContract,
    sharedContract
      ? `Installer may import the shared ${workspaceDirectory} package`
      : `Installer must not import workspace package ${workspaceDirectory}`,
  );
  assert.equal(
    dependencyIsForbidden(
      `packages/${workspaceDirectory}/src/example.ts`,
      'packages/installer/src/index.ts',
    ),
    true,
    `${workspaceDirectory} must not import the installer`,
  );
}

console.log('Dependency boundary regression checks passed.');
