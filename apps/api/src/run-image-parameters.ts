import {
  ImageOutputParameterError,
  resolveImageOutputParameters,
  type CanvasDocument,
} from '@multimodal-canvas/domain';
import { getRunSnapshotIncludedNodeIds, isRunAssetSource } from './runs';

/** 创建 Run 前发现的图片输出参数错误；只携带节点身份和脱敏字段诊断。 */
export class RunImageParameterError extends Error {
  /** 路由可用此稳定错误码返回 HTTP 400，不能将请求入队。 */
  readonly code = 'IMAGE_OUTPUT_PARAMETERS_INVALID';
  /** 发生格式或冲突错误的参数名，可能包含多个别名。 */
  readonly parameter: string;

  /**
   * @param nodeId 参数所属节点。
   * @param cause 共享解析器产生的脱敏错误。
   */
  constructor(
    readonly nodeId: string,
    cause: ImageOutputParameterError,
  ) {
    super(cause.message, { cause });
    this.name = 'RunImageParameterError';
    this.parameter = cause.parameter;
  }
}

/**
 * 在创建新 Run 前校验所有实际执行的图片节点，不改画布、参数或旧快照。
 * @param input 已完成连线结果投影的画布、目标 ID 和可选提交参数；提交值仅覆盖目标自身字段。
 * @returns 校验通过时无返回值；来源、手动上游输出、禁用及闭包外节点不参与。
 * @throws RunImageParameterError 任一执行图片节点含非法或冲突的输出参数时拒绝创建。
 */
export function validateRunImageParameters(input: {
  canvas: CanvasDocument;
  targetNodeId: string;
  parameters?: Readonly<Record<string, unknown>>;
  /** API 完成模型解析后的逐节点别名；缺省条目才回退到节点保存值。 */
  nodeModelAliases?: Readonly<Record<string, string>>;
}): void {
  const { canvas, targetNodeId } = input;
  const includedNodeIds = getRunSnapshotIncludedNodeIds(canvas, targetNodeId);
  for (const node of canvas.nodes) {
    if (
      !includedNodeIds.has(node.id) ||
      node.data.mediaType !== 'image' ||
      node.data.enabled === false ||
      isRunAssetSource(node, targetNodeId)
    ) {
      continue;
    }
    const parameters = {
      ...(node.data.parameters ?? {}),
      ...(node.id === targetNodeId ? input.parameters : {}),
    };
    try {
      resolveImageOutputParameters(
        parameters,
        input.nodeModelAliases?.[node.id] ?? node.data.modelAlias,
      );
    } catch (error) {
      if (!(error instanceof ImageOutputParameterError)) throw error;
      throw new RunImageParameterError(node.id, error);
    }
  }
}
