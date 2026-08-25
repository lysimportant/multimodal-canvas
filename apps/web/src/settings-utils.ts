export type AiSettingsFormValues = {
  baseUrl: string;
  apiKey: string;
  configured: boolean;
};

export type AiSettingsFormErrors = Partial<Record<'baseUrl' | 'apiKey', string>>;

/** Validate the client-side fields without changing the settings API payload. */
export function validateAiSettingsForm(values: AiSettingsFormValues): AiSettingsFormErrors {
  const errors: AiSettingsFormErrors = {};
  let validBaseUrl = false;

  try {
    const parsed = new URL(values.baseUrl.trim());
    validBaseUrl =
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    validBaseUrl = false;
  }

  if (!validBaseUrl) errors.baseUrl = '请输入有效的 HTTP(S) Base URL';
  if (!values.configured && values.apiKey.trim().length === 0) {
    errors.apiKey = '未配置凭据时请输入 API Key';
  }

  return errors;
}
