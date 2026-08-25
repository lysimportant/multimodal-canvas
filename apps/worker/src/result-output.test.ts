import { describe, expect, it } from 'vitest';

import {
  ProviderOutputError,
  normalizeProviderOutput,
  providerOutputToArchiveInput,
} from './result-output';

describe('provider output normalization', () => {
  it('normalizes OpenAI chat text and preserves content parts order', () => {
    const output = normalizeProviderOutput(
      {
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: '第一段' },
                { type: 'text', text: '第二段' },
              ],
            },
          },
        ],
      },
      'text',
    );

    expect(output).toEqual({
      mediaType: 'text',
      kind: 'text',
      text: '第一段第二段',
      mimeType: 'text/plain',
      format: 'txt',
    });
  });

  it('normalizes image URL and base64 response variants', () => {
    expect(
      normalizeProviderOutput({ data: [{ url: 'https://cdn.example/image.webp' }] }, 'image'),
    ).toMatchObject({
      mediaType: 'image',
      kind: 'url',
      url: 'https://cdn.example/image.webp',
      mimeType: 'image/png',
    });
    expect(normalizeProviderOutput({ data: [{ b64_json: 'aGVsbG8=' }] }, 'image')).toMatchObject({
      mediaType: 'image',
      kind: 'base64',
      base64: 'aGVsbG8=',
      mimeType: 'image/png',
    });
  });

  it('preserves top-level New API image format and MIME hints', () => {
    expect(
      normalizeProviderOutput(
        {
          output_format: 'webp',
          mime_type: 'image/webp',
          data: [{ b64_json: 'd2VicC1pbWFnZQ==' }],
        },
        'image',
      ),
    ).toMatchObject({
      mediaType: 'image',
      kind: 'base64',
      base64: 'd2VicC1pbWFnZQ==',
      mimeType: 'image/webp',
      format: 'webp',
    });

    expect(
      normalizeProviderOutput(
        {
          outputFormat: 'jpeg',
          data: [{ b64_json: 'anBlZy1pbWFnZQ==' }],
        },
        'image',
      ),
    ).toMatchObject({
      mediaType: 'image',
      kind: 'base64',
      mimeType: 'image/jpeg',
      format: 'jpeg',
    });
  });

  it('normalizes canonical provider output without leaking unknown fields', () => {
    const output = normalizeProviderOutput(
      {
        mediaType: 'audio',
        kind: 'base64',
        base64: 'aGVsbG8=',
        mimeType: 'audio/wav',
        format: 'wav',
        apiKey: 'must-not-cross-boundary',
      },
      'audio',
    );
    expect(output).toEqual({
      mediaType: 'audio',
      kind: 'base64',
      base64: 'aGVsbG8=',
      mimeType: 'audio/wav',
      format: 'wav',
    });
    expect(output).not.toHaveProperty('apiKey');
  });

  it('decodes text and inline binary output for the archiver', () => {
    const text = providerOutputToArchiveInput(
      { mediaType: 'text', kind: 'text', text: 'hello', mimeType: 'text/plain' },
      'text',
    );
    expect(text?.content?.toString('utf8')).toBe('hello');
    expect(text).toMatchObject({ mediaType: 'text', mimeType: 'text/plain' });

    const binary = providerOutputToArchiveInput(
      { mediaType: 'image', kind: 'base64', base64: 'aGVsbG8=', mimeType: 'image/png' },
      'image',
    );
    expect(binary?.content?.toString('utf8')).toBe('hello');
    expect(binary).toMatchObject({ mediaType: 'image', mimeType: 'image/png' });
  });

  it('passes remote URLs through as server-side fetch inputs', () => {
    expect(
      providerOutputToArchiveInput(
        {
          mediaType: 'audio',
          kind: 'url',
          url: 'https://cdn.example/audio.mp3',
          mimeType: 'audio/mpeg',
        },
        'audio',
      ),
    ).toEqual({
      mediaType: 'audio',
      mimeType: 'audio/mpeg',
      contentUrl: 'https://cdn.example/audio.mp3',
    });
  });

  it('rejects malformed, unsafe, or mismatched output', () => {
    expect(() =>
      normalizeProviderOutput(
        { mediaType: 'image', kind: 'url', url: 'javascript:alert(1)', mimeType: 'image/png' },
        'image',
      ),
    ).toThrow(ProviderOutputError);
    expect(() =>
      normalizeProviderOutput(
        { mediaType: 'image', kind: 'base64', base64: 'not base64!', mimeType: 'image/png' },
        'image',
      ),
    ).toThrow(ProviderOutputError);
    expect(() =>
      normalizeProviderOutput(
        {
          mediaType: 'image',
          kind: 'url',
          url: 'https://cdn.example/x.png',
          mimeType: 'image/png',
        },
        'audio',
      ),
    ).toThrow(/media type mismatch/);
  });

  it('accepts data URI base64 while retaining only the encoded payload', () => {
    const output = normalizeProviderOutput(
      {
        mediaType: 'image',
        kind: 'base64',
        base64: 'data:image/png;base64,aGVsbG8=',
        mimeType: 'image/png',
      },
      'image',
    );
    expect(output).toMatchObject({ kind: 'base64', base64: 'data:image/png;base64,aGVsbG8=' });
    expect(providerOutputToArchiveInput(output, 'image')?.content?.toString()).toBe('hello');
  });

  it('converts data URI URLs and raw binary responses safely', () => {
    expect(
      normalizeProviderOutput(
        {
          mediaType: 'image',
          kind: 'url',
          url: 'data:image/png;base64,aGVsbG8=',
          mimeType: 'image/png',
        },
        'image',
      ),
    ).toMatchObject({ mediaType: 'image', kind: 'base64', base64: 'aGVsbG8=' });
    expect(normalizeProviderOutput(new Uint8Array([104, 105]), 'audio')).toMatchObject({
      mediaType: 'audio',
      kind: 'base64',
      base64: 'aGk=',
    });
  });

  it('reads object-shaped text content from Responses API output', () => {
    expect(
      normalizeProviderOutput(
        { output: [{ content: [{ type: 'output_text', text: 'response text' }] }] },
        'text',
      ),
    ).toMatchObject({ mediaType: 'text', text: 'response text' });
  });
});
