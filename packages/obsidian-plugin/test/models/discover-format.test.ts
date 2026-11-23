import { describe, it, expect } from 'vitest';
import {
  remoteDetailLine,
  formatContextLength,
  catalogDetailLine,
  toggleArgs,
  type DiscoveredModelRow,
} from '../../src/models/discover-format.js';

const fullRow: DiscoveredModelRow = {
  provider: 'openrouter',
  model: 'anthropic/claude-3.5-sonnet',
  displayName: 'Claude 3.5 Sonnet',
  description: 'A capable model.',
  vision: true,
  tools: true,
  contextLength: 200000,
  pricing: { input: 3, output: 15 },
  serverless: true,
  deprecated: false,
  inCatalog: true,
};

const sparseRow: DiscoveredModelRow = {
  provider: 'fireworks',
  model: 'accounts/fireworks/models/x',
  displayName: 'X',
  description: '',
  vision: false,
  tools: false,
  contextLength: null,
  pricing: null,
  serverless: true,
  deprecated: false,
  inCatalog: false,
};

describe('remoteDetailLine', () => {
  it('renders every segment for a fully-populated row', () => {
    expect(remoteDetailLine(fullRow)).toBe(
      'anthropic/claude-3.5-sonnet · 👁 vision · 🔧 tools · 200k ctx · $3/$15 per Mtok · ✓ in catalog',
    );
  });

  it('renders the model id and flags a missing price for a sparse row (no caps/ctx/pricing/catalog)', () => {
    expect(remoteDetailLine(sparseRow)).toBe('accounts/fireworks/models/x · no list price');
  });

  it('formats sub-1000 context lengths without a k suffix', () => {
    expect(remoteDetailLine({ ...sparseRow, contextLength: 512 })).toBe('accounts/fireworks/models/x · 512 ctx · no list price');
  });

  it('includes only the capabilities that are present', () => {
    expect(remoteDetailLine({ ...sparseRow, vision: true })).toBe('accounts/fireworks/models/x · 👁 vision · no list price');
    expect(remoteDetailLine({ ...sparseRow, tools: true })).toBe('accounts/fireworks/models/x · 🔧 tools · no list price');
  });
});

describe('catalogDetailLine', () => {
  it('renders an enabled catalog entry', () => {
    expect(catalogDetailLine({ title: 'Claude 3.5 Sonnet', provider: 'openrouter', enabled: true })).toBe(
      'Claude 3.5 Sonnet — openrouter · enabled',
    );
  });

  it('renders a disabled catalog entry', () => {
    expect(catalogDetailLine({ title: 'X', provider: 'fireworks', enabled: false })).toBe('X — fireworks · disabled');
  });
});

describe('toggleArgs', () => {
  it('targets the Settings/Models note by path and flips enabled → disabled', () => {
    expect(toggleArgs('Claude 3.5 Sonnet', true)).toEqual({
      getNode: { file_path: 'Settings/Models/Claude 3.5 Sonnet.md' },
      setFields: { enabled: false },
    });
  });

  it('flips a disabled entry back on', () => {
    expect(toggleArgs('X', false)).toEqual({
      getNode: { file_path: 'Settings/Models/X.md' },
      setFields: { enabled: true },
    });
  });

  it('targets the model note in the settings folder Engine reports (#449)', () => {
    expect(toggleArgs('X', true, 'Config')).toEqual({
      getNode: { file_path: 'Config/Models/X.md' },
      setFields: { enabled: false },
    });
    expect(toggleArgs('X', true, 'Settings')).toEqual(toggleArgs('X', true));
  });
});

describe('formatContextLength — million-scale windows (§B)', () => {
  it('renders million-scale windows as M, not a four-digit k', () => {
    // 1M-context models are ordinary now; "1000k ctx" reads as a bug in the UI.
    expect(formatContextLength(1_000_000)).toBe('1M');
    expect(formatContextLength(2_000_000)).toBe('2M');
  });

  it('keeps one decimal where rounding to M would otherwise lie', () => {
    expect(formatContextLength(1_500_000)).toBe('1.5M');
  });

  it('leaves sub-million windows on the k scale', () => {
    expect(formatContextLength(200_000)).toBe('200k');
    expect(formatContextLength(999_000)).toBe('999k');
    expect(formatContextLength(512)).toBe('512');
  });
});
