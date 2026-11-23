import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OfficeExtractor } from '../../../src/extraction/extractors/office.js';

describe('OfficeExtractor', () => {
  const extractor = new OfficeExtractor();

  it('has correct id', () => {
    expect(extractor.id).toBe('office-doc');
  });

  it('has correct mediaType', () => {
    expect(extractor.mediaType).toBe('office');
  });

  it('has correct supportedExtensions', () => {
    expect(extractor.supportedExtensions).toEqual(['.docx', '.pptx', '.xlsx', '.csv']);
  });

  it('extracts CSV content', async () => {
    const dir = join(tmpdir(), 'office-extractor-test-' + Date.now());
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'data.csv');
    const content = 'name,age,city\nAlice,30,Seattle\nBob,25,Portland\n';
    await writeFile(filePath, content, 'utf-8');

    try {
      const result = await extractor.extract(filePath);
      expect(result.text).toBe(content);
      expect(result.metadata).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('ignores phantom XLSX range columns without cell values', async () => {
    const XLSX = await import('xlsx');
    const dir = join(tmpdir(), 'office-extractor-xlsx-test-' + Date.now());
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'sparse.xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([
      ['name', 'score'],
      ['Alice', 10],
    ]);
    sheet['!ref'] = 'A1:XFB77';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Scores');
    // Written through a buffer: the ESM build's writeFile needs set_fs() first.
    await writeFile(filePath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));

    try {
      const result = await extractor.extract(filePath);
      expect(result.text).toBe('name,score\nAlice,10');
      expect(result.text.length).toBeLessThan(100);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('throws on unsupported extension', async () => {
    await expect(
      extractor.extract('/some/file.rtf')
    ).rejects.toThrow('Unsupported office format: .rtf');
  });
});
