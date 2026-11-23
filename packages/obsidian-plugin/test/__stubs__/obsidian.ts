// Minimal stub of the runtime-only `obsidian` module so vitest can resolve
// imports of it. Code under test injects its own dependencies (e.g. transport's
// `post`, the modal's `searcher`), so these stubs are never meaningfully invoked.
// esbuild externalizes the real `obsidian` for the plugin build — this alias is
// vitest-only.

export const requestUrl = async (): Promise<{ status: number; headers: Record<string, string>; text: string }> => {
  throw new Error('obsidian.requestUrl stub called — inject a `post` in tests');
};

export const setIcon = (_el: HTMLElement, _icon: string): void => {};

export class SuggestModal<T> {
  emptyStateText = '';
  // Real Obsidian gives every SuggestModal a search <input>; tests that drive
  // selectSuggestion (which clears/re-triggers it) need a real element here.
  inputEl: HTMLInputElement = document.createElement('input');
  constructor(_app: unknown) {}
  setPlaceholder(_text: string): void {}
  open(): void {}
  // Real Obsidian's Modal.close() invokes onClose(); mirror that so tests can
  // observe teardown side effects (e.g. a modal closing its engine connection).
  close(): void { this.onClose(); }
  onClose(): void {}
  getSuggestions(_query: string): T[] { return []; }
  renderSuggestion(_item: T, _el: HTMLElement): void {}
  onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
  selectSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseSuggestion(item, evt);
    this.close();
  }
}

export class Modal {
  contentEl: HTMLElement = document.createElement('div');
  constructor(public app: unknown) {}
  open(): void { this.onOpen(); }
  close(): void { this.onClose(); }
  onOpen(): void {}
  onClose(): void {}
}

export class Notice {
  /** Every message shown, for tests that check what the user is told. */
  static readonly messages: string[] = [];
  constructor(message: string, _duration?: number) { Notice.messages.push(message); }
}

export class DropdownComponent {
  constructor(_containerEl: HTMLElement) {}
  addOption(_value: string, _display: string): this { return this; }
  onChange(_cb: (value: string) => void): this { return this; }
  setValue(_value: string): this { return this; }
}

export class TFile { path=''; extension='md'; }
export class MarkdownView { file:TFile|null=null; }
export class ItemView {
 contentEl=document.createElement('div');
 app: unknown;
 constructor(public leaf: {app?:unknown}) {this.app=leaf.app;}
 getState():Record<string,unknown>{return {};}
 async setState(_state:unknown,_result:unknown):Promise<void>{}
}
