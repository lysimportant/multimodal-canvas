import {
  getExecutionPromptDocument,
  renderPromptDocument,
  renderVideoPromptReferenceDocument,
  type NodeResourceRef,
  type PromptDocument,
} from '@multimodal-canvas/domain';
import type { ConnectedPromptAsset } from './connected-prompt-assets';
import {
  collectVideoPromptReferences,
  type VideoPromptReferenceContext,
} from './video-prompt-reference-labels';

/** 仅转换当前输入正文；共用提交转换器，不读取资源内容或发起生成。 */
export function previewVideoPrompt(
  document: PromptDocument,
  context: VideoPromptReferenceContext,
  connectedAssets: readonly ConnectedPromptAsset[] = [],
  resourceRefs: readonly NodeResourceRef[] = [],
): string {
  const executionDocument = getExecutionPromptDocument({ promptDocument: document, resourceRefs })!;
  const mentions = executionDocument.blocks.filter((block) => block.type === 'mention');
  if (mentions.some((mention) => mention.placeholder || mention.placeholderReason))
    throw new Error('有引用资源尚未绑定，请先选择实际资源。');
  if (
    mentions.some((mention) => mention.assetVersion === undefined) ||
    connectedAssets.some(
      (asset) =>
        asset.versionUnavailable ||
        (asset.videoInputBindings?.length && asset.assetVersion === undefined),
    )
  )
    throw new Error('有引用资源的版本尚未确定，请重新选择资源后查看真实提示词。');
  if (mentions.some((mention) => mention.mediaType === 'text'))
    throw new Error('当前提示词包含文字资源，需解析资源正文后才能确定完整提交内容。');
  const hasInlineReferences = mentions.some((mention) => mention.inline && !mention.executionOnly);
  if (hasInlineReferences || context.videoReferences) {
    const parameters = context.parameters ?? {};
    const metadata =
      parameters.metadata && typeof parameters.metadata === 'object'
        ? (parameters.metadata as Record<string, unknown>)
        : {};
    if (
      [
        'images',
        'image',
        'input_reference',
        'first_frame',
        'last_frame',
        'start_frame',
        'end_frame',
        'reference_images',
        'videos',
        'audios',
        'reference_videos',
        'reference_audios',
        'content',
        'input',
      ].some((key) => parameters[key] !== undefined || metadata[key] !== undefined)
    )
      throw new Error('媒体参数与引用资源混用，无法确定素材编号，请通过资源条或连线提供素材。');
  }
  // 画布不替上游判断模型能力：视频参考素材一律按实际发送顺序编号，预览与提交保持一致。
  const references = collectVideoPromptReferences(
    context,
    executionDocument,
    connectedAssets,
    resourceRefs,
  );
  return renderPromptDocument(
    renderVideoPromptReferenceDocument(executionDocument, references, context),
  );
}
