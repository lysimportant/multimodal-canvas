import { z } from 'zod';

/** Image2Pro 图片任务 API 的冻结执行合同；旧运行继续使用原有 OpenAI Images 合同。 */
export const IMAGE2PRO_IMAGE_TASK_CONTRACT = 'image2pro-image-task-v1' as const;

/** New API 请求关联 ID 限 ASCII 64 字符，拒绝会被 URL 归一化的独立点路径。 */
export const newApiRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/)
  .refine((value) => value !== '.' && value !== '..');
