import { createContext } from 'react';

import type { RunRecord } from '@multimodal-canvas/domain';

/**
 * 画布节点 → 最近一次运行记录。由 App 注入、画布统一提供，供节点“节点信息”
 * 展示运行诊断（归档阶段、尝试记录、最近错误、参考素材）等只读信息。
 */
export type NodeRunRecords = Readonly<Record<string, RunRecord>>;

/** 共享的空记录；保持引用稳定，未注入运行记录时不会触发额外渲染。 */
export const emptyNodeRunRecords: NodeRunRecords = Object.freeze({});

export const NodeRunContext = createContext<NodeRunRecords | null>(null);
