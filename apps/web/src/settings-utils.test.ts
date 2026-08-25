import { describe, expect, it } from 'vitest';

import { validateAiSettingsForm } from './settings-utils';

describe('AI settings form validation', () => {
  it('accepts an HTTP(S) URL and a key when no credential is configured', () => {
    expect(
      validateAiSettingsForm({
        baseUrl: ' https://newapi.example.com/v1 ',
        apiKey: 'server-key',
        configured: false,
      }),
    ).toEqual({});
  });

  it('reports field-specific errors for an invalid URL and missing key', () => {
    expect(
      validateAiSettingsForm({
        baseUrl: 'ftp://newapi.example.com',
        apiKey: '  ',
        configured: false,
      }),
    ).toEqual({
      baseUrl: '请输入有效的 HTTP(S) Base URL',
      apiKey: '未配置凭据时请输入 API Key',
    });
  });

  it('allows an empty key when the server already has credentials', () => {
    expect(
      validateAiSettingsForm({
        baseUrl: 'http://localhost:3000/v1',
        apiKey: '',
        configured: true,
      }),
    ).toEqual({});
  });
});
