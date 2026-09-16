import type { MediaType, ModelSelection } from '@multimodal-canvas/domain';

/** 平台凭据摘要；只包含可公开的地址、指纹和类型默认模型，不包含 Key。 */
export type AiCredentialSummary = {
  id: string;
  baseUrl: string;
  keyFingerprint: string;
  updatedAt: string;
  active: boolean;
  /** 该凭据自身已保存的类型默认模型；从未配置过的凭据没有该字段。 */
  defaultModels?: Partial<Record<MediaType, string | ModelSelection>>;
};
