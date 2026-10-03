import {
  buildVideoRecreationPrompt,
  getVideoRecreationIssue,
  renderPromptDocument,
  videoRecreationConfigSchema,
  type VideoRecreationConfig,
} from '@multimodal-canvas/domain';
import type { FlowNodeData } from '../canvas-utils';

/** 原子保存复刻配置、固定资源和提示词；未完成时清空旧提示词防止错用人物。 */
export function applyVideoRecreationConfig(
  data: FlowNodeData,
  input: VideoRecreationConfig,
): FlowNodeData {
  const config = videoRecreationConfigSchema.parse(input);
  const issue = getVideoRecreationIssue(config);
  const promptDocument = issue
    ? { version: 1 as const, blocks: [{ type: 'text' as const, text: '' }] }
    : buildVideoRecreationPrompt(config);
  const { duration: _duration, ...parameters } = data.parameters ?? {};
  return {
    ...data,
    videoRecreation: config,
    videoMode: 'omni_reference',
    promptDocument,
    prompt: renderPromptDocument(promptDocument),
    parameters: {
      ...parameters,
      ...(config.analysis ? { duration: config.analysis.template.durationSeconds } : {}),
    },
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

/** 所有生成入口共用的复刻预检；专属节点不能切换模式或静默更改全片时长。 */
export function recreationGenerationIssue(data: FlowNodeData): string | undefined {
  if (!data.videoRecreation) return undefined;
  return (
    getVideoRecreationIssue(data.videoRecreation) ??
    (!Number.isSafeInteger(data.videoRecreation.analysis?.template.durationSeconds)
      ? '当前视频接口仅支持整秒时长，不能取整、裁剪或省略整片分析时长'
      : undefined) ??
    (data.videoMode !== 'omni_reference'
      ? '复刻节点需要支持参考视频与人物图片的全能参考模式'
      : undefined) ??
    (data.parameters?.duration !== data.videoRecreation.analysis?.template.durationSeconds
      ? '复刻时长必须与整条参考视频一致，不能静默裁剪或延长'
      : undefined)
  );
}
