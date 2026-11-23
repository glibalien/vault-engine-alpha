import { describe, expect, it } from 'vitest';
import { APICallError } from 'ai';
import { chatErrorText } from '../src/errors.js';

describe('chatErrorText', () => {
  it('keeps name and message for thrown errors', () => {
    const err = new APICallError({ message: '[Alibaba] The content field is a required field.', url: 'u', requestBodyValues: {}, statusCode: 400 });
    expect(chatErrorText(err)).toBe('AI_APICallError: [Alibaba] The content field is a required field.');
    expect(chatErrorText(new TypeError('boom'))).toBe('TypeError: boom');
  });

  it('reads the upstream reason from an in-stream provider error', () => {
    expect(chatErrorText({ message: 'Provider returned error', code: 400,
      metadata: { provider_name: 'Alibaba', raw: '{"error":{"message":"The content field is a required field.","code":"invalid_parameter_error"}}' } }))
      .toBe('Provider error 400: [Alibaba] The content field is a required field.');
  });

  it('accepts raw as plain text or an already-parsed object', () => {
    expect(chatErrorText({ message: 'Provider returned error', metadata: { raw: 'upstream said no' } }))
      .toBe('Provider error: upstream said no');
    expect(chatErrorText({ message: 'Provider returned error', metadata: { raw: { detail: 'quota exceeded' } } }))
      .toBe('Provider error: quota exceeded');
  });

  it('falls back to the wrapper message when there is no usable raw reason', () => {
    expect(chatErrorText({ message: 'Rate limited', code: 'rate_limit' })).toBe('Provider error rate_limit: Rate limited');
    expect(chatErrorText({ message: 'Provider returned error', metadata: { raw: '{}' } }))
      .toBe('Provider error: {}');
    expect(chatErrorText({ message: 'Provider returned error', metadata: null })).toBe('Provider error: Provider returned error');
  });

  it('caps a long reason and flattens whitespace', () => {
    const text = chatErrorText({ message: 'x', metadata: { raw: `line one\n\n${'a'.repeat(600)}` } });
    expect(text.startsWith('Provider error: line one aaa')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(530);
  });

  it('stringifies anything else', () => {
    expect(chatErrorText('plain')).toBe('plain');
    expect(chatErrorText(42)).toBe('42');
    expect(chatErrorText({ status: 500 })).toBe('[object Object]');
  });
});
