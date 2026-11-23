import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { createProviderClients } from '@vault/llm';
import {
  CLAUDE_VISION_MODEL,
  ModelVisionImageExtractor,
  ModelVisionPdfExtractor,
  visionExtractorId,
  visionImageExtensions,
} from '../../src/extraction/extractors/model-vision.js';
import type { UsageRecorder } from '../../src/usage/recorder.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PDF = Buffer.from('%PDF-1.4 test');

function fakeClients() {
  const openAiCreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'extracted' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } },
  });
  const anthropicCreate = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'page one' }],
    usage: { input_tokens: 500, output_tokens: 100 },
    stop_reason: 'end_turn',
  });
  const openAiOptions: Array<{ apiKey: string; baseURL: string }> = [];
  const clients = createProviderClients({ fireworks: 'fw', openrouter: 'or', anthropic: 'ak', openai: 'oa' }, {
    createOpenAi: options => {
      openAiOptions.push(options);
      return { chat: { completions: { create: openAiCreate } } } as unknown as OpenAI;
    },
    createAnthropic: () => ({ messages: { create: anthropicCreate } }) as unknown as Anthropic,
  });
  return { clients, openAiCreate, anthropicCreate, openAiOptions };
}

function withFile<T>(name: string, bytes: Buffer, run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'model-vision-'));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('vision extractor identity', () => {
  it('keeps the existing ids, keyed by wire API', () => {
    expect(visionExtractorId('fireworks', 'image')).toBe('openai-compat-vision-image');
    expect(visionExtractorId('openrouter', 'image')).toBe('openai-compat-vision-image');
    expect(visionExtractorId('openai', 'pdf')).toBe('openai-compat-vision-pdf');
    expect(visionExtractorId('anthropic', 'image')).toBe('claude-vision-image');
    expect(visionExtractorId('anthropic', 'pdf')).toBe('claude-vision-pdf');
  });

  it('accepts tiff and bmp only where the provider takes them', () => {
    expect(visionImageExtensions('fireworks')).toEqual(expect.arrayContaining(['.tiff', '.bmp']));
    expect(visionImageExtensions('openrouter')).toEqual(expect.arrayContaining(['.tiff', '.bmp']));
    expect(visionImageExtensions('anthropic')).toEqual(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
    expect(visionImageExtensions('openai')).toEqual(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  });

  it('refuses a PDF extractor for a provider without PDF input', () => {
    expect(() => new ModelVisionPdfExtractor(fakeClients().clients, { provider: 'fireworks', model: 'm' }))
      .toThrow('Fireworks takes no PDF input');
  });
});

describe('ModelVisionImageExtractor', () => {
  it('sends the image then the prompt to an OpenAI-compatible provider and records usage there', async () => {
    const { clients, openAiCreate, openAiOptions } = fakeClients();
    const record = vi.fn();
    const img = new ModelVisionImageExtractor(clients, { provider: 'openrouter', model: 'z-ai/glm-vision' }, { record } as unknown as UsageRecorder);
    expect([img.id, img.mediaType, img.provider, img.model]).toEqual(['openai-compat-vision-image', 'image', 'openrouter', 'z-ai/glm-vision']);

    await withFile('scan.png', PNG, async file => {
      await expect(img.extract(file)).resolves.toEqual({ text: 'extracted' });
      expect(openAiOptions).toEqual([{ apiKey: 'or', baseURL: 'https://openrouter.ai/api/v1' }]);
      expect(openAiCreate).toHaveBeenCalledWith({
        model: 'z-ai/glm-vision',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
          { type: 'text', text: expect.stringContaining('Extract all text from this image') },
        ] }],
      });
      expect(record).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'openrouter', model: 'z-ai/glm-vision', purpose: 'vision-extraction',
        inputTokens: 600, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 0, sourceRef: file,
      }));
    });
  });

  it("records OpenRouter's reported charge and response id with the tokens (#320)", async () => {
    const { clients, openAiCreate } = fakeClients();
    openAiCreate.mockResolvedValueOnce({
      id: 'gen-v1', choices: [{ message: { content: 'extracted' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 50, cost: 0.0019 },
    });
    const record = vi.fn();
    const img = new ModelVisionImageExtractor(clients, { provider: 'openrouter', model: 'z-ai/glm-vision' }, { record } as unknown as UsageRecorder);
    await withFile('scan.png', PNG, file => img.extract(file));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openrouter', purpose: 'vision-extraction', inputTokens: 1000, providerCostUsd: 0.0019, requestId: 'gen-v1',
    }));
  });

  it('uses max_completion_tokens at OpenAI', async () => {
    const { clients, openAiCreate, openAiOptions } = fakeClients();
    await withFile('scan.png', PNG, file => new ModelVisionImageExtractor(clients, { provider: 'openai', model: 'gpt-test' }).extract(file));
    expect(openAiOptions).toEqual([{ apiKey: 'oa', baseURL: 'https://api.openai.com/v1' }]);
    expect(openAiCreate.mock.calls[0]![0]).toMatchObject({ model: 'gpt-test', max_completion_tokens: 4096 });
  });

  it('sends Anthropic an image block with the sniffed type, not the extension', async () => {
    const { clients, anthropicCreate } = fakeClients();
    const img = new ModelVisionImageExtractor(clients, { provider: 'anthropic', model: CLAUDE_VISION_MODEL });
    expect(img.id).toBe('claude-vision-image');
    await withFile('really-a-jpeg.png', JPEG, async file => {
      await expect(img.extract(file)).resolves.toEqual({ text: 'page one' });
    });
    expect(anthropicCreate).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG.toString('base64') } },
        { type: 'text', text: expect.stringContaining('Extract all text from this image') },
      ] }],
    });
  });

  it('refuses an image type the provider does not take', async () => {
    const { clients, anthropicCreate } = fakeClients();
    const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
    await withFile('scan.tiff', tiff, async file => {
      await expect(new ModelVisionImageExtractor(clients, { provider: 'anthropic', model: CLAUDE_VISION_MODEL }).extract(file))
        .rejects.toThrow(/Unsupported image format/);
    });
    expect(anthropicCreate).not.toHaveBeenCalled();
  });
});

describe('ModelVisionPdfExtractor', () => {
  it('sends Anthropic a document block and records Anthropic usage', async () => {
    const { clients, anthropicCreate } = fakeClients();
    const record = vi.fn();
    const pdf = new ModelVisionPdfExtractor(clients, { provider: 'anthropic', model: CLAUDE_VISION_MODEL }, { record } as unknown as UsageRecorder);
    expect(pdf.id).toBe('claude-vision-pdf');
    await withFile('scan.pdf', PDF, async file => {
      await expect(pdf.extract(file)).resolves.toEqual({ text: 'page one' });
    });
    expect(anthropicCreate).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') } },
        { type: 'text', text: expect.stringContaining('scanned PDF') },
      ] }],
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic', inputTokens: 500, outputTokens: 100 }));
  });

  it('sends OpenAI the PDF as a file part', async () => {
    const { clients, openAiCreate } = fakeClients();
    const pdf = new ModelVisionPdfExtractor(clients, { provider: 'openai', model: 'gpt-test' });
    expect(pdf.id).toBe('openai-compat-vision-pdf');
    await withFile('scan.pdf', PDF, file => pdf.extract(file));
    expect(openAiCreate.mock.calls[0]![0]).toMatchObject({
      model: 'gpt-test',
      max_completion_tokens: 8192,
      messages: [{ role: 'user', content: [
        { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${PDF.toString('base64')}` } },
        { type: 'text', text: expect.stringContaining('scanned PDF') },
      ] }],
    });
  });
});
