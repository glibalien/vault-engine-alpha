// src/renderer/types.ts

export interface RenderInput {
  types: string[];
  fields: Record<string, unknown>;        // field values from DB (reconstructed)
  body: string;
  fieldOrdering: FieldOrderEntry[];        // resolved ordering from merge algorithm
  referenceFields: Set<string>;            // fields whose values need [[wiki-link]] wrapping
  listReferenceFields: Set<string>;        // list fields whose elements need [[wiki-link]] wrapping
  orphanRawValues: Record<string, string>; // field → value_raw_text for orphans with wiki-links
  explicitNullFields: ReadonlySet<string>; // YAML keys explicitly present with a null value
  /** Fields written back as they are in the note's file (#501): their own lines when they
   * have them, else their value as YAML read it. Place them in `fieldOrdering`. */
  keptFields?: ReadonlyMap<string, KeptFieldText>;
}

export interface KeptFieldText {
  /** The field's lines in the file, key included; null when only the value is known. */
  text: string | null;
  /** The value as YAML read it. */
  raw: unknown;
}

export interface FieldOrderEntry {
  field: string;
  category: 'claimed' | 'orphan';
}
