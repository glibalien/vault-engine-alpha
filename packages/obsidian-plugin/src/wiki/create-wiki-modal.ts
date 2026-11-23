import { Modal, type App } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WikiCreate } from '@vault/viz-ui';
import { makeWikiRebuildClient } from '../provenance/wiki-rebuild-client.js';

export interface CreateWikiModalInput {
  /** The project note's title. */
  project: string;
  /** The project note's path, which create-project-wiki resolves without mistaking a namesake for it. */
  projectRef: string;
  endpoint: string;
  token: string;
  onRegistered: () => void;
  onOpenWiki: () => void;
  connect?: Parameters<typeof makeWikiRebuildClient>[0]['connect'];
}

/** "Create project wiki" (#384): a free check, a paid start on confirm, then the first build
 *  followed by status. A first build that an earlier pause stopped is offered as Build it now, the
 *  whole-wiki rebuild on the same connection (#544). Closing it closes its Curator connection but
 *  doesn't stop the build. */
export class CreateWikiModal extends Modal {
  private root: Root | null = null;
  private client: ReturnType<typeof makeWikiRebuildClient> | null = null;

  constructor(app: App, private readonly input: CreateWikiModalInput) {
    super(app);
  }

  onOpen(): void {
    const { project, endpoint, token, connect } = this.input;
    this.client = makeWikiRebuildClient({ endpoint, token, ...(connect ? { connect } : {}) });
    this.root = createRoot(this.contentEl);
    this.root.render(createElement(WikiCreate, {
      api: this.client.create, rebuild: this.client.api, project, projectRef: this.input.projectRef,
      onClose: () => this.close(),
      onRegistered: this.input.onRegistered,
      onOpenWiki: () => { this.close(); this.input.onOpenWiki(); },
    }));
  }

  onClose(): void {
    this.root?.unmount();
    this.root = null;
    void this.client?.close();
    this.client = null;
  }
}
