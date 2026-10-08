import {
  image2proVideoContractForModel,
  isRetiredImage2proVideoModel,
  retiredImage2proVideoModelReason,
  portRoleSchema,
  precheckVideoGenerationInputs,
  renderPromptDocument,
  videoInputRoleForPromptMention,
  videoModeForPromptMentions,
  type RunInputSnapshot,
  type RunSnapshot,
  type VideoGenerationIssue,
} from '@multimodal-canvas/domain';

/** Image2Pro 提交前的节点诊断，不保存 Run 或发送 Provider 请求。 */
export class RunImage2proVideoError extends Error {
  /** 第一个共享合同错误码，与 Provider 的拒绝原因一致。 */
  readonly code: VideoGenerationIssue['code'];

  /** @param nodeId 非法输入所属执行节点。 @param issues 共享预检返回的脱敏问题。 */
  constructor(
    readonly nodeId: string,
    readonly issues: readonly VideoGenerationIssue[],
  ) {
    super(issues[0]?.message ?? 'Image2Pro 视频输入不符合合同');
    this.name = 'RunImage2proVideoError';
    this.code = issues[0]?.code ?? 'UNSUPPORTED_INPUT_COMBINATION';
  }
}

/**
 * 按已冻结版本预检实际执行的 Image2Pro 节点；退役 Flash 拒绝新运行，其他模型沿用既有校验。
 * @param snapshot 已完成资产归属、版本、模型和凭据冻结的快照；不修改其内容。
 * @returns 合同通过时无返回值；不读取素材字节，不创建或恢复任务。
 * @throws RunImage2proVideoError 参数、模式、媒体类型或参考数量不符合已确认合同。
 */
export function validateRunImage2proVideo(snapshot: RunSnapshot): void {
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  for (const node of snapshot.nodes) {
    const modelAlias =
      node.id === snapshot.targetNodeId ? snapshot.modelAlias : node.data.modelAlias;
    if (
      node.data.mode !== 'generate' ||
      node.data.enabled === false ||
      node.data.mediaType !== 'video'
    ) {
      continue;
    }
    if (isRetiredImage2proVideoModel(modelAlias)) {
      throw new RunImage2proVideoError(node.id, [
        { code: 'UNSUPPORTED_INPUT_COMBINATION', message: retiredImage2proVideoModelReason },
      ]);
    }
    if (!image2proVideoContractForModel(modelAlias)) continue;
    const inputs: RunInputSnapshot[] =
      node.id === snapshot.targetNodeId
        ? [...snapshot.inputs]
        : snapshot.edges.flatMap((edge) => {
            if (edge.targetNodeId !== node.id) return [];
            const source = nodesById.get(edge.sourceNodeId);
            if (!source || source.data.enabled === false) return [];
            const version = /\/versions\/([1-9]\d*)\/content$/.exec(source.data.contentUrl ?? '');
            return [
              {
                nodeId: source.id,
                role: portRoleSchema.parse(edge.targetHandle.slice('input:'.length)),
                sortOrder: edge.order,
                sourceAssetId: source.data.assetId,
                ...(version ? { sourceAssetVersion: Number(version[1]) } : {}),
                snapshot: source,
              },
            ];
          });
    const seenReferences = new Set(
      inputs
        .filter((input) => input.sourceAssetId)
        .map((input) => `${input.sourceAssetId}:${input.sourceAssetVersion ?? ''}:${input.role}`),
    );
    const mentionInputs: RunInputSnapshot[] = [];
    for (const mention of snapshot.promptMentions ?? []) {
      if ((mention.nodeId ?? snapshot.targetNodeId) !== node.id) continue;
      const role = videoInputRoleForPromptMention(
        mention.mediaType,
        node.data.videoMode,
        modelAlias,
      );
      if (!role) {
        throw new RunImage2proVideoError(node.id, [
          {
            code: 'UNSUPPORTED_INPUT_COMBINATION',
            message: 'Image2Pro 当前模式不支持此资源提及，请使用全能参考模式或明确连接首尾帧',
          },
        ]);
      }
      // 与 Provider 按资产版本和角色去重的规则一致，重复提及不会虚增图片数量。
      const referenceKey = `${mention.assetId}:${mention.assetVersion}:${role}`;
      if (seenReferences.has(referenceKey)) continue;
      seenReferences.add(referenceKey);
      mentionInputs.push({
        nodeId: `mention:${mention.mentionId}`,
        role,
        sortOrder: 10_000 + mention.blockOrder,
        sourceAssetId: mention.assetId,
        sourceAssetVersion: mention.assetVersion,
        ...(mention.durationSeconds !== undefined
          ? { sourceDurationSeconds: mention.durationSeconds }
          : {}),
        snapshot: {
          id: `mention:${mention.mentionId}`,
          type: mention.mediaType,
          position: { x: 0, y: 0 },
          data: {
            label: mention.label,
            mediaType: mention.mediaType,
            mode: 'source',
          },
        },
      });
    }
    const parameters =
      node.id === snapshot.targetNodeId
        ? snapshot.parameters
        : {
            ...(node.data.parameters ?? {}),
            ...(node.data.inferenceStrength
              ? { inferenceStrength: node.data.inferenceStrength }
              : {}),
          };
    const textInput = inputs.find(
      (input) =>
        input.snapshot.data.mediaType === 'text' &&
        (input.role === 'prompt' || input.role === 'content'),
    );
    const nodePrompt =
      parameters.prompt ??
      (node.data.promptDocument
        ? renderPromptDocument(node.data.promptDocument)
        : node.data.prompt);
    const prompt =
      textInput?.role === 'content'
        ? textInput.snapshot.data.prompt
        : (nodePrompt ?? textInput?.snapshot.data.prompt);
    const result = precheckVideoGenerationInputs([...inputs, ...mentionInputs], {
      modelAlias,
      parameters: { ...parameters, ...(prompt !== undefined ? { prompt } : {}) },
      videoMode: videoModeForPromptMentions(node.data.videoMode, mentionInputs.length > 0),
    });
    if (result.issues.length) throw new RunImage2proVideoError(node.id, result.issues);
  }
}
