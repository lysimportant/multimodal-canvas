import { z } from 'zod';

import type { FlowNodeData } from '../canvas-utils';

/** 节点信息读取的最小数据范围；执行时间必须属于当前展示的结果版本。 */
type NodeInfoSource = Pick<
  FlowNodeData,
  'createdAt' | 'assetId' | 'contentUrl' | 'manualOutput' | 'resultAsset' | 'resultTiming'
>;

/** 已验证的时间及其本地化展示文本，不包含推断或补写的历史时间。 */
export type NodeInfoTime = {
  /** 标准 UTC ISO 8601 时间，供 HTML time 元素使用。 */
  dateTime: string;
  /** 浏览器本地时区的中文日期与时间，精确到秒。 */
  label: string;
};

/**
 * 读取节点创建时间与当前结果的服务端完成时间，不修改节点或订阅时钟。
 * @param nodeId 当前节点标识，用于排除其他节点的执行时间。
 * @param data 当前展示版本的数据；手动替换、无结果或非成功终态不能借用执行时间。
 * @returns 两个可选时间；缺失或无效值为 undefined，由信息面板显示“未记录”。
 * 结果时间只采用 resultTiming.finishedAt，不采用供应商响应、当前执行或浏览器加载时间。
 */
export function getNodeInfoTimes(nodeId: string, data: NodeInfoSource) {
  const hasResult = Boolean(data.resultAsset || (data.assetId && data.contentUrl));
  const timing = data.resultTiming;
  return {
    createdAt: recordedTime(data.createdAt),
    resultAt:
      hasResult && !data.manualOutput && timing?.nodeId === nodeId && timing.outcome === 'succeeded'
        ? recordedTime(timing.finishedAt)
        : undefined,
  };
}

/** 校验完整日历日期与时区，避免无效日期被 Date 自动顺延。 */
const recordedTimeSchema = z.string().datetime({ offset: true });

/**
 * 将包含时区的 ISO 8601 时间转为本地显示，拒绝缺失、日期片段和无效时间。
 * @param value 原始记录时间，必须包含完整日期、时分秒及 Z 或时区偏移。
 * @returns 可展示的时间；无有效记录时返回 undefined，不回填当前时间。
 */
function recordedTime(value?: string): NodeInfoTime | undefined {
  const parsed = recordedTimeSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const date = new Date(parsed.data);
  if (!Number.isFinite(date.getTime())) return undefined;
  return { dateTime: date.toISOString(), label: date.toLocaleString('zh-CN', { hour12: false }) };
}
