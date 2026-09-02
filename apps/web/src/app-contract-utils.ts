import type { Asset, MediaType } from '@multimodal-canvas/domain';

import type { AssetFlowNode } from './canvas-utils';

export const DEFAULT_PROJECT_NAME = '未命名项目';
export const SUCCESS_NOTICE_DISMISS_MS = 3200;

export const canvasBackgroundValues = ['dots', 'lines', 'cross', 'blank'] as const;
export type CanvasBackground = (typeof canvasBackgroundValues)[number];

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type Notice = { kind: 'error' | 'success'; message: string };

const mediaLabels: Record<MediaType, string> = {
  text: '文字',
  image: '图片',
  audio: '音频',
  video: '视频',
};

/** Keep project creation and the project switcher consistent about blank names. */
export function normalizeProjectName(value: string, fallback = DEFAULT_PROJECT_NAME): string {
  return value.trim() || fallback;
}

/**
 * 为新建节点生成在当前画布中唯一且可读的默认名称。
 * @param baseLabel 节点类型的基础名称。
 * @param existingLabels 当前画布已有节点名称。
 * @returns 未占用的节点名称。
 */
export function createUniqueNodeLabel(
  baseLabel: string,
  existingLabels: readonly string[],
): string {
  const occupied = new Set(existingLabels);
  if (!occupied.has(baseLabel)) return baseLabel;
  let suffix = 2;
  while (occupied.has(`${baseLabel} ${suffix}`)) suffix += 1;
  return `${baseLabel} ${suffix}`;
}

/** Parse persisted UI state without allowing an unknown value into React Flow. */
export function parseCanvasBackground(value: string | null | undefined): CanvasBackground {
  return canvasBackgroundValues.includes(value as CanvasBackground)
    ? (value as CanvasBackground)
    : 'dots';
}

export function findProject(
  projects: readonly ProjectSummary[],
  projectId: string | null | undefined,
): ProjectSummary | undefined {
  return projectId ? projects.find((project) => project.id === projectId) : undefined;
}

/** A switch is a no-op while loading or when the requested project is already active. */
export function canSwitchProject(
  currentProjectId: string | null,
  requestedProjectId: string,
  isLoading: boolean,
): boolean {
  return !isLoading && currentProjectId !== requestedProjectId;
}

export function getNoticeAutoDismissMs(notice: Notice | null): number | null {
  return notice?.kind === 'success' ? SUCCESS_NOTICE_DISMISS_MS : null;
}

export function createSourceFlowNode(
  asset: Pick<Asset, 'id' | 'name' | 'mediaType' | 'contentUrl' | 'mimeType'>,
  position: { x: number; y: number },
  createId: () => string = () => crypto.randomUUID(),
): AssetFlowNode {
  return {
    id: `node_${asset.id}_${createId()}`,
    type: asset.mediaType,
    position,
    data: {
      label: asset.name,
      mediaType: asset.mediaType,
      mode: 'source',
      assetId: asset.id,
      contentUrl: asset.contentUrl,
      mimeType: asset.mimeType,
    },
  } as AssetFlowNode;
}

export function createGenerateFlowNode(
  mediaType: MediaType,
  position: { x: number; y: number },
  createId: () => string = () => crypto.randomUUID(),
): AssetFlowNode {
  return {
    id: `node_${mediaType}_${createId()}`,
    type: mediaType,
    position,
    data: {
      label: `${mediaLabels[mediaType]}生成节点`,
      mediaType,
      mode: 'generate',
    },
  } as AssetFlowNode;
}
