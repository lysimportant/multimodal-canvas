import { z } from 'zod';

const trimmedString = z.string().transform((value) => value.trim());

export const aiSettingsFormSchema = z
  .object({
    baseUrl: trimmedString,
    apiKey: trimmedString,
    configured: z.boolean(),
  })
  .superRefine((values, context) => {
    let validBaseUrl = false;
    try {
      const parsed = new URL(values.baseUrl);
      validBaseUrl =
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
    } catch {
      validBaseUrl = false;
    }
    if (!validBaseUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: '请输入有效的 HTTP(S) Base URL',
      });
    }
    if (!values.configured && values.apiKey.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: '未配置凭据时请输入 API Key',
      });
    }
  });

export type AiSettingsFormValues = z.infer<typeof aiSettingsFormSchema>;
