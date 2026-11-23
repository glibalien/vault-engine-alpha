import { MarkdownView, TFile, type App, type WorkspaceLeaf } from 'obsidian';
import type { Client } from '@vault/query-core';

/** Remembers only a Markdown leaf; sidebar focus never becomes the document target. */
export class LastMarkdownTarget {
  private leaf: WorkspaceLeaf | null = null;
  record(leaf: WorkspaceLeaf | null): void {
    if (leaf?.view instanceof MarkdownView) this.leaf = leaf;
  }
  currentPath(): string | null {
    const view = this.leaf?.view;
    return view instanceof MarkdownView &&
      view.file?.extension.toLowerCase() === 'md'
      ? view.file.path
      : null;
  }
  clear(): void {
    this.leaf = null;
  }
}
export async function openExistingNode(
  app: App,
  client: Client,
  nodeId: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const env = await client.getNode({ node_id: nodeId, include_embeds: false });
  if (!isCurrent()) throw Error('Inspection context changed');
  if (!env.ok) throw Error('Current source could not be resolved');
  const path = env.data.file_path;
  const file = path ? app.vault.getAbstractFileByPath(path) : null;
  if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md')
    throw Error('This note is not available locally');
  // openFile never invokes the unresolved-link creation path.
  if (!isCurrent()) throw Error('Inspection context changed');
  await app.workspace.getLeaf(false).openFile(file);
}
