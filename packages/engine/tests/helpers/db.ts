import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import {
  addUndoTables,
  ensureMetaTable,
  addNodeTypesSortOrder,
  addSchemaUndoSnapshots,
  addGlobalFieldUndoSnapshots,
  addUndoLinkBindings,
  addUndoMemorySubjects,
  addUiHints,
  upgradeToMemories,
  upgradeToMemoriesV2,
  upgradeToMemoriesV3,
  upgradeToMemoryNoteReceipts,
  upgradeToMemoryHistory,
  upgradeToMemoryConsolidationPending,
  upgradeToMemoryChangedBy,
  upgradeToMemorySubjects,
  upgradeToProvenance,
  upgradeToWikiStatusVersions,
} from '../../src/db/migrate.js';

export function createTestDb(options: { verbose?: (message?: unknown) => void } = {}): Database.Database {
  const db = new Database(':memory:', options);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  addUndoTables(db);
  addNodeTypesSortOrder(db);
  addSchemaUndoSnapshots(db);
  addGlobalFieldUndoSnapshots(db);
  addUndoLinkBindings(db);
  addUndoMemorySubjects(db);
  addUiHints(db);
  // registerAllTools always registers the memories tools (per the durable-memories
  // design, they run even without an embedder), so every test DB needs these
  // tables to exist by the time registration happens — mirrors src/index.ts's
  // production startup chain, which runs this migration unconditionally too.
  upgradeToMemories(db);
  upgradeToMemoriesV2(db);
  upgradeToMemoriesV3(db);
  upgradeToMemoryNoteReceipts(db);
  upgradeToMemoryHistory(db);
  upgradeToMemoryConsolidationPending(db);
  upgradeToMemoryChangedBy(db);
  upgradeToMemorySubjects(db);
  ensureMetaTable(db);
  upgradeToProvenance(db);
  upgradeToWikiStatusVersions(db);
  return db;
}
