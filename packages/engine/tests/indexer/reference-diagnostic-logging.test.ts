import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { indexFile, fullIndex } from '../../src/indexer/indexer.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
let db: ReturnType<typeof createTestDb>;
let vault: ReturnType<typeof createTempVault>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  db = createTestDb(); vault = createTempVault(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('reference_resolution_policy_version','2')").run();
});
afterEach(() => { db.close(); vault.cleanup(); vi.restoreAllMocks(); });
const logged = () => JSON.parse(warn.mock.calls[0][1] as string);
function assertBounded(observed: number) {
  expect(warn).toHaveBeenCalledTimes(1);
  const warnings = logged();
  expect(warnings.length).toBeLessThanOrEqual(50);
  expect(warnings.at(-1)).toMatchObject({code:'RESULT_TRUNCATED',details:{observed_count:observed}});
  expect(warnings.reduce((n: number, warning: any) => n + Buffer.byteLength(JSON.stringify(warning.details)),0)).toBeLessThanOrEqual(32768);
  expect(warnings[0].details.candidates).toHaveLength(10);
  expect(warnings[0].details).toMatchObject({candidate_count:11,candidates_truncated:true});
}
describe('bounded ingestion diagnostics', () => {
  for (const watcher of [false,true]) it(`logs bounded diagnostics after ingestion and preserves raw source (watcher=${watcher})`, () => {
    const rawTarget = '🌟'.repeat(4000);
    for (let i=0;i<11;i++) db.prepare('INSERT INTO nodes(id,file_path,title) VALUES (?,?,?)').run(`W${i}`,`Wiki/${i}.md`,rawTarget);
    for (let i=0;i<51;i++) createGlobalField(db,{name:`project${i}`,field_type:'reference',reference_target:'Project'});
    const content = `---\n${Array.from({length:51},(_,i) => `project${i}: "[[${rawTarget}]]"`).join('\n')}\n---\n`;
    const path = join(vault.vaultPath,'Source.md'); writeFileSync(path,content);
    if (watcher) processFileChange(path,'Source.md',db,new WriteLockManager(),vault.vaultPath);
    else indexFile(path,vault.vaultPath,db);
    assertBounded(51);
    expect(logged()[0].details.raw_target_truncated).toBe(true);
    expect(readFileSync(path,'utf8')).toBe(content);
    expect(db.prepare("SELECT value_text FROM node_fields WHERE field_name='project0'").get()).toEqual({value_text:rawTarget});
  });
  it('aggregates full-index logging once across files, using the completed catalog', () => {
    createGlobalField(db,{name:'project',field_type:'reference',reference_target:'Project'});
    for(let i=0;i<11;i++) {
      const dir = join(vault.vaultPath,`Wiki${i}`); mkdirSync(dir);
      writeFileSync(join(dir,'Example.md'),'---\ntypes: [Wiki]\n---\n');
    }
    for(let i=0;i<51;i++) writeFileSync(join(vault.vaultPath,`Source${i}.md`),'---\nproject: "[[Example]]"\n---\n');
    const result = fullIndex(vault.vaultPath,db);
    expect(result.errors).toBe(0); assertBounded(51);
    expect(db.prepare("SELECT COUNT(*) AS n FROM node_fields WHERE field_name='project' AND value_text='Example'").get()).toEqual({n:51});
  });
  it('does not let a failed logging sink fail a committed ingestion', () => {
    createGlobalField(db,{name:'project',field_type:'reference',reference_target:'Project'});
    db.prepare("INSERT INTO nodes(id,file_path,title) VALUES ('W','Wiki.md','Example')").run();
    const path = join(vault.vaultPath,'Source.md');
    writeFileSync(path,'---\nproject: "[[Example]]"\n---\n');
    warn.mockImplementation(() => { throw new Error('sink unavailable'); });
    expect(() => indexFile(path,vault.vaultPath,db)).not.toThrow();
    expect(() => processFileChange(path,'Source.md',db,new WriteLockManager(),vault.vaultPath)).not.toThrow();
    expect(db.prepare("SELECT value_text FROM node_fields WHERE field_name='project'").get()).toEqual({value_text:'Example'});
  });

});
