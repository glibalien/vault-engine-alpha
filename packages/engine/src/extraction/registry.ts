import type { Extractor } from './types.js';

interface UnavailableEntry {
  id: string;
  mediaType: string;
  extensions: string[];
  missingKey: string;
}

interface ExtractorStatusEntry {
  id: string;
  mediaType: string;
  extensions: string[];
}

interface UnavailableStatusEntry extends ExtractorStatusEntry {
  missingKey: string;
}

export interface ExtractorStatus {
  active: ExtractorStatusEntry[];
  unavailable: UnavailableStatusEntry[];
  /** Paid extractors turned off by the engine setting extractionEnabled, whatever their keys. */
  disabled: ExtractorStatusEntry[];
}

export class ExtractorRegistry {
  private readonly byExtension = new Map<string, Extractor>();
  private readonly unavailableByExtension = new Map<string, UnavailableEntry>();
  private readonly unavailableEntries: UnavailableEntry[] = [];
  private readonly disabledByExtension = new Map<string, ExtractorStatusEntry>();
  private readonly disabledEntries: ExtractorStatusEntry[] = [];

  register(extractor: Extractor): void {
    for (const ext of extractor.supportedExtensions) {
      this.byExtension.set(ext, extractor);
    }
  }

  /** Empties all registered + unavailable state so the instance can be re-populated in place
   *  (re-arm: callers holding this registry by reference see the rebuild without a swap). */
  clear(): void {
    this.byExtension.clear();
    this.unavailableByExtension.clear();
    this.unavailableEntries.length = 0;
    this.disabledByExtension.clear();
    this.disabledEntries.length = 0;
  }

  registerUnavailable(
    id: string,
    mediaType: string,
    extensions: string[],
    missingKey: string,
  ): void {
    const entry: UnavailableEntry = { id, mediaType, extensions, missingKey };
    // Always track in the status list so callers can see all API-gated extractors
    this.unavailableEntries.push(entry);
    // Only map extensions not already covered by an active extractor (for getUnavailableReason)
    for (const ext of extensions) {
      if (!this.byExtension.has(ext)) {
        this.unavailableByExtension.set(ext, entry);
      }
    }
  }

  /** A paid extractor turned off by setting: its extensions extract only through an active extractor. */
  registerDisabled(id: string, mediaType: string, extensions: string[]): void {
    const entry: ExtractorStatusEntry = { id, mediaType, extensions };
    this.disabledEntries.push(entry);
    for (const ext of extensions) {
      if (!this.byExtension.has(ext)) this.disabledByExtension.set(ext, entry);
    }
  }

  /** Why an extension cannot extract because extraction is off, or null. */
  getDisabledReason(ext: string): string | null {
    if (this.byExtension.has(ext)) return null;
    const entry = this.disabledByExtension.get(ext);
    return entry ? `Extractor '${entry.id}' is off (engine setting extractionEnabled is false)` : null;
  }

  getForExtension(ext: string): Extractor | null {
    return this.byExtension.get(ext) ?? null;
  }

  getUnavailableReason(ext: string): string | null {
    // If an active extractor covers this extension, never report unavailable
    if (this.byExtension.has(ext)) return null;
    const entry = this.unavailableByExtension.get(ext);
    if (!entry) return null;
    return `Extractor '${entry.id}' requires API key: ${entry.missingKey}`;
  }

  listAll(): Extractor[] {
    // Deduplicate — same extractor may be registered for multiple extensions
    const seen = new Set<Extractor>();
    for (const extractor of this.byExtension.values()) {
      seen.add(extractor);
    }
    return [...seen];
  }

  getStatus(): ExtractorStatus {
    const active: ExtractorStatusEntry[] = this.listAll().map(e => ({
      id: e.id,
      mediaType: e.mediaType,
      extensions: e.supportedExtensions,
    }));

    const unavailable: UnavailableStatusEntry[] = this.unavailableEntries.map(e => ({
      id: e.id,
      mediaType: e.mediaType,
      extensions: e.extensions,
      missingKey: e.missingKey,
    }));

    const disabled = this.disabledEntries.map(e => ({ id: e.id, mediaType: e.mediaType, extensions: e.extensions }));

    return { active, unavailable, disabled };
  }
}
