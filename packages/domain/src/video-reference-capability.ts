import { z } from 'zod';

/**
 * New API 视频参考素材能力契约。
 *
 * `tokenSyntax` 描述提示词内联引用与实际发送素材之间的编号约定；能力
 * 数值只表示本次模型目录声明允许的最大素材数量。
 */
export const videoReferenceCapabilitySchema = z
  .object({
    version: z.literal(1),
    adapter: z.literal('seedance-video'),
    maxImages: z.number().int().nonnegative().safe(),
    maxVideos: z.number().int().nonnegative().safe(),
    maxAudios: z.number().int().nonnegative().safe(),
    tokenSyntax: z.literal('numbered-media'),
  })
  .strict();

export type VideoReferenceCapability = z.infer<typeof videoReferenceCapabilitySchema>;

/** 解析模型目录中的能力声明；非法或未知结构均按未声明处理。 */
export function parseVideoReferenceCapability(
  value: unknown,
): VideoReferenceCapability | undefined {
  const parsed = videoReferenceCapabilitySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
