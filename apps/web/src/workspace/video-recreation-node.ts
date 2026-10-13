import {
  buildVideoRecreationDraftPrompt,
  buildVideoRecreationPrompt,
  getVideoRecreationIssue,
  renderPromptDocument,
  videoRecreationConfigSchema,
  type VideoRecreationConfig,
} from '@multimodal-canvas/domain';
import type { FlowNodeData } from '../canvas-utils';

/**
 * 原子保存复刻配置、固定资源和提示词；未完成时展示分析草稿占位，生成入口仍由预检阻止。
 * 首次分析或更换来源时补上缺省秒数，保留用户已填写的参数与后续显式清空。
 */
export function applyVideoRecreationConfig(
  data: FlowNodeData,
  input: VideoRecreationConfig,
): FlowNodeData {
  const config = videoRecreationConfigSchema.parse(input);
  const issue = getVideoRecreationIssue(config);
  const promptDocument = issue
    ? config.analysis
      ? buildVideoRecreationDraftPrompt(config)
      : { version: 1 as const, blocks: [{ type: 'text' as const, text: '' }] }
    : buildVideoRecreationPrompt(config);
  const parameters = { ...data.parameters };
  const previous = data.videoRecreation;
  const sameSource =
    previous?.source.assetId === config.source.assetId &&
    previous.source.assetVersion === config.source.assetVersion;
  if (
    config.analysis &&
    (!sameSource || !previous?.analysis) &&
    parameters.duration === undefined &&
    parameters.seconds === undefined &&
    parameters.durationSeconds === undefined
  ) {
    parameters.duration = config.analysis.template.durationSeconds;
  }
  return {
    ...data,
    videoRecreation: config,
    videoMode: 'omni_reference',
    promptDocument,
    prompt: renderPromptDocument(promptDocument),
    parameters,
    resourceRefs: promptDocument.blocks.flatMap((block) =>
      block.type === 'mention'
        ? [
            {
              id: block.mentionId,
              assetId: block.assetId,
              assetVersion: block.assetVersion,
              mediaType: block.mediaType,
              name: block.label,
            },
          ]
        : [],
    ),
  };
}

/** 所有生成入口共用的复刻预检；核对冻结来源和绑定，不按分析时长限制用户参数。 */
export function recreationGenerationIssue(data: FlowNodeData): string | undefined {
  if (data.videoRecreationDraft) return '请先选择参考视频并完成分析';
  if (!data.videoRecreation) return undefined;
  return (
    getVideoRecreationIssue(data.videoRecreation) ??
    (data.videoMode !== 'omni_reference'
      ? '复刻节点需要支持参考视频与人物图片的全能参考模式'
      : undefined)
  );
}
