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

export type ModelDefaults = Partial<Record<MediaType, string>>;

export type AiSettings = {
  baseUrl: string;
  configured: boolean;
  keyFingerprint?: string;
  defaultModels: ModelDefaults;
};

export type ModelEntry = { id: string; name: string; mediaTypes: MediaType[] };

export type CanvasBackground = 'dots' | 'lines' | 'cross' | 'blank';

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
