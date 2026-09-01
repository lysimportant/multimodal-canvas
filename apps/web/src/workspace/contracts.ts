import { AudioLines, FileText, Image as ImageIcon, Video } from 'lucide-react';

import type { MediaType, NodeMode } from '@multimodal-canvas/domain';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
export const ASSET_DRAG_TYPE = 'application/x-multimodal-asset';

export const mediaLabels: Record<MediaType, string> = {
  text: '文字',
  image: '图片',
  audio: '音频',
  video: '视频',
};

export const modeLabels: Record<NodeMode, string> = {
  source: '来源',
  generate: '生成',
  transform: '转换',
};

export const mediaIcons: Record<MediaType, typeof FileText> = {
  text: FileText,
  image: ImageIcon,
  audio: AudioLines,
  video: Video,
};

export type AssetFilter = 'all' | MediaType;

export type ModelDefaults = Partial<Record<MediaType, string | ModelSelection>>;

export type AiSettings = {
  baseUrl: string;
  configured: boolean;
  keyFingerprint?: string;
  defaultModels: ModelDefaults;
};

export type ModelEntry = {
  id: string;
  name: string;
  mediaTypes: MediaType[];
  credentialId?: string;
  credentialLabel?: string;
  /** 模型目录返回的能力描述，前端按媒体类型解析可用参数。 */
  capabilities?: Record<string, unknown>;
  /** 模型目录返回的限制描述，作为能力字段缺失时的兼容来源。 */
  limitations?: Record<string, unknown>;
  /** 模型价格信息，仅随目录透传，不参与节点参数选择。 */
  price?: Record<string, unknown>;
};

export type ModelSelection = {
  modelAlias: string;
  credentialId?: string;
};

export type CanvasBackground = 'dots' | 'lines' | 'cross' | 'blank';

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
