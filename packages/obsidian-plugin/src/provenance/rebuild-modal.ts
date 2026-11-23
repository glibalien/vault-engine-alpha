import { Modal, type App } from 'obsidian';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** The Obsidian modal the wiki panel's rebuild dialogs open in (#545). The panel's view owns each flow's
 *  state and guards; this only hosts what it renders. Closing it (Esc, ×, or clicking outside) tells the
 *  view through `onDismiss`, which treats it as the dialog's Close. */
export class RebuildModal extends Modal {
  private root: Root | null = null;
  private content: ReactNode = null;
  constructor(app: App, private readonly onDismiss: (modal: RebuildModal) => void) {
    super(app);
  }
  onOpen(): void {
    this.modalEl?.classList.add('vp-rebuild-modal');
    this.root = createRoot(this.contentEl);
    this.root.render(this.content);
  }
  render(content: ReactNode): void {
    this.content = content;
    this.root?.render(content);
  }
  onClose(): void {
    const root = this.root;
    this.root = null;
    // Unmount once the event that closed it has finished with the tree.
    queueMicrotask(() => root?.unmount());
    this.onDismiss(this);
  }
}
