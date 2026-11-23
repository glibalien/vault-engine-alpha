import { Modal, type App } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DossierBuild, type NoteKind } from '@vault/viz-ui';
import { entityKinds, type VaultSettings } from '@vault/settings-registry';
import { makeWikiRebuildClient } from '../provenance/wiki-rebuild-client.js';
import { hasType } from './project-wikis.js';

/** The notes build-dossier takes, by the same rule (Curator `resolveDossierSubject`): one of the vault map's
 *  entity kinds but its project kind, and never a wiki page or a project (a project's dossier is its
 *  project wiki). Its dry run still decides, and words a refusal (the owner's own note, say). */
export function offersDossier(types: unknown, vault: VaultSettings): boolean {
  if (vault.wikiType !== null && hasType(types, vault.wikiType)) return false;
  if (vault.projectType !== null && hasType(types, vault.projectType)) return false;
  return entityKinds(vault).filter(kind => kind !== vault.projectType).some(kind => hasType(types, kind));
}

/** The note's kind for the wiki panel (#554), when it can have a dossier: a person, a company, or another
 *  of the vault map's entity kinds, named by its type ("Vendor"). Null for a note that can't have one. */
export function dossierKindOf(types: unknown, vault: VaultSettings): NoteKind | null {
  if (!offersDossier(types, vault)) return null;
  if (vault.personType !== null && hasType(types, vault.personType)) return { kind: 'person', label: 'Person' };
  if (vault.companyType !== null && hasType(types, vault.companyType)) return { kind: 'company', label: 'Company' };
  const kind = entityKinds(vault).find(k => k !== vault.projectType && hasType(types, k)) ?? 'note';
  const words = kind.replace(/[-_]+/g, ' ').trim();
  return { kind: 'other', label: words.charAt(0).toUpperCase() + words.slice(1) };
}

export interface DossierModalInput {
  /** The note's file name, shown until Engine names it. */
  noteTitle: string;
  /** The note's path: Engine resolves it to the one note, never a namesake in another folder. */
  notePath: string;
  endpoint: string;
  token: string;
  /** Resolves the note's path to its Engine node. */
  note: (path: string) => Promise<{ id: string; title: string }>;
  /** Open the dossier's page by its title. */
  onOpenPage: (title: string) => void;
  /** The dialog closed: a build may be running now, which an open wiki panel should show. */
  onClosed?: () => void;
  connect?: Parameters<typeof makeWikiRebuildClient>[0]['connect'];
}

/** "Build dossier" (#715): build-dossier's free dry run, the paid build on confirm, its status, and
 *  the page to open. Closing it closes its Curator connection but doesn't stop a build. */
export class DossierModal extends Modal {
  private root: Root | null = null;
  private client: ReturnType<typeof makeWikiRebuildClient> | null = null;

  constructor(app: App, private readonly input: DossierModalInput) {
    super(app);
  }

  onOpen(): void {
    const { endpoint, token, connect } = this.input;
    this.client = makeWikiRebuildClient({ endpoint, token, ...(connect ? { connect } : {}) });
    // The same dialog as the wiki panel's, which opens this flow too (#554).
    this.modalEl?.classList.add('vp-rebuild-modal');
    this.root = createRoot(this.contentEl);
    this.root.render(createElement(DossierBuild, {
      api: this.client.dossier, note: this.input.note, noteTitle: this.input.noteTitle, noteRef: this.input.notePath,
      onClose: () => this.close(),
      onOpenPage: title => { this.close(); this.input.onOpenPage(title); },
    }));
  }

  onClose(): void {
    this.root?.unmount();
    this.root = null;
    void this.client?.close();
    this.client = null;
    this.input.onClosed?.();
  }
}
