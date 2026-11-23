import { expect, it } from 'vitest';
import { vaultSettingsFrom } from '@vault/settings-registry';
import { dossierKindOf, offersDossier } from '../../src/wiki/dossier-modal.js';

const vault = vaultSettingsFrom(undefined);

it('offers a dossier on a person or company note, never a project, a wiki page or another kind (#715)', () => {
  expect(vault.personType).toBe('person');
  expect(offersDossier(['person'], vault)).toBe(true);
  expect(offersDossier('[[company]]', vault)).toBe(true);
  expect(offersDossier(['project'], vault)).toBe(false);
  expect(offersDossier(['person', 'project'], vault)).toBe(false);
  expect(offersDossier(['company', vault.wikiType ?? 'wiki'], vault)).toBe(false);
  expect(offersDossier(['meeting'], vault)).toBe(false);
  expect(offersDossier(undefined, vault)).toBe(false);
});

it('follows the vault map\'s entity kinds when it names them (#715)', () => {
  const named = { ...vault, entityTypes: ['client', 'vendor', 'project'] };
  expect(offersDossier(['vendor'], named)).toBe(true);
  expect(offersDossier(['person'], named)).toBe(false);
  expect(offersDossier(['project'], named)).toBe(false);
});

it('names a note\'s kind for the wiki panel\'s dossier, by the vault map (#554)', () => {
  expect(dossierKindOf(['person'], vault)).toEqual({ kind: 'person', label: 'Person' });
  expect(dossierKindOf('[[company]]', vault)).toEqual({ kind: 'company', label: 'Company' });
  expect(dossierKindOf(['project'], vault)).toBeNull();
  expect(dossierKindOf(['meeting'], vault)).toBeNull();
  const named = { ...vault, entityTypes: ['client', 'print-vendor', 'project'] };
  expect(dossierKindOf(['print-vendor'], named)).toEqual({ kind: 'other', label: 'Print vendor' });
  expect(dossierKindOf(['person'], named)).toBeNull();
});
