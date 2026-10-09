import { z } from 'zod';

/** New API 请求关联 ID 限 ASCII 64 字符，拒绝会被 URL 归一化的独立点路径。 */
export const newApiRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/)
  .refine((value) => value !== '.' && value !== '..');
