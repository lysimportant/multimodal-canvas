/** 按账户、媒体类型和操作类型保存本机最近手动选择的模型，不存储密钥或节点内容。 */
import type { MediaType, NodeMode } from '@multimodal-canvas/domain';
import type { ModelEntry, ModelSelection } from '../workspace/contracts';

/** 可记忆模型的节点操作类型；来源节点不调用模型。 */
export type OperationNodeMode = Exclude<NodeMode, 'source'>;

/** 构造版本化偏好键；账号间不共享模型或来源标识。 */
function preferenceKey(ownerId: string, mediaType: MediaType, mode: OperationNodeMode): string {
  return `multimodal-canvas:node-model:v1:${encodeURIComponent(ownerId)}:${mediaType}:${mode}`;
}

/**
 * 读取最近模型，只返回当前目录仍支持该媒体类型的精确模型与来源组合。
 * @returns 未保存、数据格式失效或目录已移除时返回 undefined。
 * @throws 本机存储不可访问时抛出原始异常，由界面提示持久化故障。
 */
export function readNodeModelPreference(
  ownerId: string,
  mediaType: MediaType,
  mode: OperationNodeMode,
  models: readonly ModelEntry[],
): ModelSelection | undefined {
  const raw = window.localStorage.getItem(preferenceKey(ownerId, mediaType, mode));
  if (!raw) return undefined;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    throw new Error('本机模型偏好格式损坏，请重新选择模型');
  }
  if (!stored || typeof stored !== 'object') return undefined;
  const { modelAlias, credentialId, platformModelId } = stored as Partial<ModelSelection>;
  if (
    typeof modelAlias !== 'string' ||
    (credentialId !== undefined && typeof credentialId !== 'string') ||
    (platformModelId !== undefined && (typeof platformModelId !== 'string' || !platformModelId))
  )
    return undefined;
  const current = models.find(
    (model) =>
      (platformModelId
        ? model.platformModelId === platformModelId
        : !model.platformModelId &&
          model.id === modelAlias &&
          model.credentialId === credentialId) && model.mediaTypes.includes(mediaType),
  );
  return current
    ? {
        modelAlias: current.id,
        ...(current.platformModelId ? { platformModelId: current.platformModelId } : {}),
        ...(current.credentialId ? { credentialId: current.credentialId } : {}),
      }
    : undefined;
}

/**
 * 用户明确选择时保存模型，清空选择时移除当前类型的偏好。
 * @throws 浏览器禁用存储或配额不足时抛出异常；节点编辑本身不依赖写入成功。
 */
export function writeNodeModelPreference(
  ownerId: string,
  mediaType: MediaType,
  mode: OperationNodeMode,
  selection: ModelSelection,
): void {
  const key = preferenceKey(ownerId, mediaType, mode);
  const modelAlias = selection.modelAlias.trim();
  if (!modelAlias) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(
    key,
    JSON.stringify({
      modelAlias,
      ...(selection.platformModelId ? { platformModelId: selection.platformModelId } : {}),
      ...(selection.credentialId ? { credentialId: selection.credentialId } : {}),
    }),
  );
}
