import { Modal, type App } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TopicWikiCreate } from '@vault/viz-ui';
import type { TopicWikiNote } from '@vault/query-core';
import { connectEngine } from '../engine/transport.js';
import { unwrapEnvelope } from '../engine/client.js';
import { makeWikiRebuildClient } from '../provenance/wiki-rebuild-client.js';

/** The note's Engine node from its path, with get-node on a short-lived Engine connection: the tool
 *  an AI caller uses to find a note's id. */
export function engineNoteByPath(engineUrl: string, token: string, connect = connectEngine): (path: string) => Promise<TopicWikiNote> {
  return async path => {
    const conn = await connect(engineUrl, token);
    try {
      const env = unwrapEnvelope<{ id?: unknown; title?: unknown }>(
        await conn.call({ name: 'get-node', arguments: { file_path: path, include_embeds: false } }));
      const id = env.ok ? env.data?.id : undefined;
      if (typeof id !== 'string' || !id) throw Error('Engine has no node for this note');
      const title = env.data?.title;
      return { id, title: typeof title === 'string' && title.trim() ? title : path.replace(/^.*\//, '').replace(/\.md$/i, '') };
    } finally { await conn.close().catch(() => {}); }
  };
}

export interface CreateTopicWikiModalInput {
  /** The note's file name, shown until Engine names it. */
  noteTitle: string;
  /** The note's path: Engine resolves it to the one note, never a namesake in another folder. */
  notePath: string;
  endpoint: string;
  token: string;
  /** Resolves the note's path to its Engine node. */
  note: (path: string) => Promise<TopicWikiNote>;
  /** Open a wiki's home page by the wiki's title. */
  onOpenWiki: (title: string) => void;
  connect?: Parameters<typeof makeWikiRebuildClient>[0]['connect'];
}

/** "Create topic wiki from this note" (#387): free checks, one paid suggestion, the person's accept or
 *  edit, then the wiki's build followed by status. Closing it closes its Curator connection but doesn't
 *  stop a build. */
export class CreateTopicWikiModal extends Modal {
  private root: Root | null = null;
  private client: ReturnType<typeof makeWikiRebuildClient> | null = null;

  constructor(app: App, private readonly input: CreateTopicWikiModalInput) {
    super(app);
  }

  onOpen(): void {
    const { endpoint, token, connect } = this.input;
    this.client = makeWikiRebuildClient({ endpoint, token, ...(connect ? { connect } : {}) });
    this.root = createRoot(this.contentEl);
    this.root.render(createElement(TopicWikiCreate, {
      api: { ...this.client.topic, note: this.input.note },
      noteTitle: this.input.noteTitle, noteRef: this.input.notePath,
      onClose: () => this.close(),
      onOpenWiki: title => { this.close(); this.input.onOpenWiki(title); },
    }));
  }

  onClose(): void {
    this.root?.unmount();
    this.root = null;
    void this.client?.close();
    this.client = null;
  }
}
