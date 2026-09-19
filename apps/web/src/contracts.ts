import type { MediaType, ModelSelection } from '@multimodal-canvas/domain';

/** 平台凭据摘要；内部指纹用于匹配，安全尾号用于展示，不包含完整 Key。 */
export type AiCredentialSummary = {
  id: string;
  baseUrl: string;
  keyFingerprint: string;
  /** 服务端裁剪的安全尾号；旧响应或无法读取凭据时缺失。 */
  keySuffix?: string;
  updatedAt: string;
  active: boolean;
  /** 该凭据自身已保存的类型默认模型；从未配置过的凭据没有该字段。 */
  defaultModels?: Partial<Record<MediaType, string | ModelSelection>>;
};
