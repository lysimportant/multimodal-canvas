import type { MediaType } from '@multimodal-canvas/domain';
import type { ResolvedMention } from '@multimodal-canvas/providers';

import type { AssetScope, AssetStore } from './assets';
import type { ProjectStore } from './projects';
import type { RunExecutor, RunExecutorRequest } from './runs';

/** 本地图片编辑可读取的输入角色，与图片 Provider 映射保持一致。 */
const imageSourceRoles = new Set(['imageEdit', 'content', 'referenceImage']);

/**
 * 为 API 内存运行读取文字多模态输入和图片编辑原图的冻结内容。
 * @param executor 已配置的真实 Provider 执行器，不在此重试或下载外部 URL。
 * @param assetStore 已套用项目归属策略的资产存储。
 * @param projectStore 项目存储，执行前重新确认项目未归档且用户仍有访问权。
 * @param maxBytes 单项资源允许读取的字节上限，使用 API 资源提及限制。
 * @returns 仅将临时 data URL 和已解析提及交给 Provider 的执行器，不改写持久快照。
 * @throws 项目/资产不可访问、归档、版本不可用、格式或大小非法、运行已取消时停止请求。
 */
export function withLocalResourceReferences(
  executor: RunExecutor,
  assetStore: AssetStore,
  projectStore: ProjectStore,
  maxBytes: number,
): RunExecutor {
  return async (request: RunExecutorRequest) => {
    const target = request.snapshot.nodes.find((node) => node.id === request.snapshot.targetNodeId);
    if (
      !target ||
      !['text', 'image'].includes(target.data.mediaType) ||
      target.data.mode !== 'generate'
    ) {
      return typeof executor === 'function' ? executor(request) : executor.execute(request);
    }
    const resourceInputs = request.snapshot.inputs.filter((input) =>
      target.data.mediaType === 'text'
        ? (input.snapshot.data.mediaType === 'text' &&
            ['prompt', 'content', 'transcript'].includes(input.role)) ||
          (input.snapshot.data.mediaType === 'image' && input.role === 'content')
        : imageSourceRoles.has(input.role) && input.snapshot.data.mediaType === 'image',
    );
    const frozenMentions = (request.snapshot.promptMentions ?? []).filter(
      (mention) =>
        (mention.nodeId ?? request.snapshot.targetNodeId) === target.id &&
        (target.data.mediaType === 'text' || mention.mediaType === 'image'),
    );
    if (resourceInputs.length === 0 && frozenMentions.length === 0) {
      return typeof executor === 'function' ? executor(request) : executor.execute(request);
    }

    /** 水合前后与发送前检查取消，避免读取期间取消后仍发送收费请求。 */
    const assertActive = () => {
      if (request.isCancelled?.()) throw new Error('资源运行已取消，未发送 Provider 请求');
    };
    assertActive();
    /** 读取前后重新核验项目，防止排队或读取期间撤销归属后继续发送。 */
    const assertProjectAccessible = async () => {
      const project = await projectStore.get(
        request.snapshot.projectId,
        request.userId ? { ownerId: request.userId } : undefined,
      );
      if (!project || project.archivedAt) throw new Error('资源运行的项目已不可访问或已归档');
    };
    await assertProjectAccessible();

    const readAssets: Array<{ assetId: string; scope: AssetScope }> = [];
    /** 后续资源读取或请求说明落库期间，先前已读资源也可能被撤销。只复查元数据。 */
    const assertReadAssetsAccessible = async () => {
      for (const { assetId, scope } of readAssets) {
        const asset = await assetStore.get(assetId, scope);
        if (!asset || asset.status === 'archived') {
          throw new Error(`资源 ${assetId} 已不可访问或已归档`);
        }
      }
    };

    /** 按冻结版本读取资源；媒体、MIME、权限与实际字节必须与该输入一致。 */
    const loadResource = async (
      assetId: string,
      version: number,
      mediaType: MediaType,
      declaredMimeType?: string,
    ): Promise<ResolvedMention['source']> => {
      const projectScope: AssetScope = {
        projectId: request.snapshot.projectId,
        ...(request.userId ? { ownerId: request.userId } : {}),
      };
      const globalScope: AssetScope = {
        projectId: null,
        ...(request.userId ? { ownerId: request.userId } : {}),
      };
      const projectAsset = await assetStore.get(assetId, projectScope);
      const scope = projectAsset ? projectScope : globalScope;
      const asset = projectAsset ?? (await assetStore.get(assetId, globalScope));
      if (!asset || asset.status === 'archived')
        throw new Error(`资源 ${assetId} 已不可访问或已归档`);
      const mimeType = resourceMimeType(asset.mimeType, mediaType, assetId);
      if (
        asset.mediaType !== mediaType ||
        (declaredMimeType && resourceMimeType(declaredMimeType, mediaType, assetId) !== mimeType)
      ) {
        throw new Error(`资源 ${assetId} 的媒体类型或格式与冻结输入不一致`);
      }
      if (target.data.mediaType === 'image' && !/^image\/(?:png|jpeg|webp)$/.test(mimeType)) {
        throw new Error(`图片资产 ${assetId} 的格式不支持编辑`);
      }
      const selected = (await assetStore.listVersions(assetId, scope)).find(
        (candidate) => candidate.version === version,
      );
      if (!selected) throw new Error(`资源 ${assetId} 的冻结版本 ${version} 已不可用`);
      if (selected.sizeBytes <= 0 || selected.sizeBytes > maxBytes)
        throw new Error(`资源 ${assetId} 的冻结版本超出大小限制`);
      const content = await assetStore.getVersionContent(assetId, version, scope);
      if (!content) throw new Error(`资源 ${assetId} 的冻结版本 ${version} 内容不可用`);
      if (
        content.byteLength === 0 ||
        content.byteLength > maxBytes ||
        content.byteLength !== selected.sizeBytes
      ) {
        throw new Error(`资源 ${assetId} 的冻结版本内容大小不符合记录`);
      }
      if (mediaType === 'text') {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(content);
        } catch {
          throw new Error(`资源 ${assetId} 的内容不是有效 UTF-8 文本`);
        }
      }
      const current = await assetStore.get(assetId, scope);
      if (!current || current.status === 'archived')
        throw new Error(`资源 ${assetId} 已不可访问或已归档`);
      readAssets.push({ assetId, scope });
      assertActive();
      return {
        kind: 'data-url',
        mimeType,
        dataUrl: `data:${mediaType === 'text' ? 'text/plain' : mimeType};base64,${content.toString('base64')}`,
      };
    };

    const hydratedNodes = new Map<string, RunExecutorRequest['snapshot']['nodes'][number]>();
    const inputs = [...request.snapshot.inputs];
    for (const input of resourceInputs) {
      const assetId = input.sourceAssetId ?? input.snapshot.data.assetId;
      if (!assetId) continue;
      const matched = /^\/v1\/assets\/([^/]+)\/versions\/([1-9]\d*)\/content$/.exec(
        input.snapshot.data.contentUrl ?? '',
      );
      if (
        !matched ||
        decodeURIComponent(matched[1]!) !== assetId ||
        !Number.isSafeInteger(Number(matched[2]))
      ) {
        throw new Error(`资源输入 ${input.nodeId} 缺少有效冻结版本，不能使用当前版本或外部地址`);
      }
      if (input.snapshot.data.assetId && input.snapshot.data.assetId !== assetId) {
        throw new Error(`资源输入 ${input.nodeId} 的资产身份与冻结输入不一致`);
      }
      if (
        input.sourceAssetVersion !== undefined &&
        input.sourceAssetVersion !== Number(matched[2])
      ) {
        throw new Error(`资源输入 ${input.nodeId} 的资产版本与冻结地址不一致`);
      }
      const source = await loadResource(
        assetId,
        Number(matched[2]),
        input.snapshot.data.mediaType,
        input.snapshot.data.mimeType,
      );
      const node = {
        ...input.snapshot,
        data: {
          ...input.snapshot.data,
          contentUrl: source.dataUrl,
          mimeType: source.mimeType,
          ...(input.snapshot.data.mediaType === 'text' ? { prompt: undefined } : {}),
        },
      };
      hydratedNodes.set(input.nodeId, node);
      inputs[inputs.indexOf(input)] = {
        ...input,
        sourceAssetId: assetId,
        sourceAssetVersion: Number(matched[2]),
        snapshot: node,
      };
    }
    const resolvedMentions: ResolvedMention[] = [];
    for (const mention of frozenMentions) {
      resolvedMentions.push({
        ...mention,
        nodeId: target.id,
        source: await loadResource(mention.assetId, mention.assetVersion, mention.mediaType),
      });
    }
    await assertProjectAccessible();
    await assertReadAssetsAccessible();
    assertActive();
    const prepared: RunExecutorRequest = {
      ...request,
      snapshot: {
        ...request.snapshot,
        inputs,
        nodes: request.snapshot.nodes.map((node) => hydratedNodes.get(node.id) ?? node),
      },
      ...(resolvedMentions.length ? { resolvedMentions } : {}),
      onRequestPrompt: async (record) => {
        assertActive();
        await request.onRequestPrompt?.(record);
        await assertProjectAccessible();
        await assertReadAssetsAccessible();
        assertActive();
      },
    };
    return typeof executor === 'function' ? executor(prepared) : executor.execute(prepared);
  };
}

/** 规范化并核验资源 MIME，文本只接受已有聊天映射可解码的 UTF-8 文档类型。 */
function resourceMimeType(value: string, mediaType: MediaType, assetId: string): string {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase();
  if (!normalized || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) {
    throw new Error(`资源 ${assetId} 的 MIME 类型无效`);
  }
  const compatible =
    mediaType === 'text'
      ? normalized.startsWith('text/') ||
        normalized === 'application/json' ||
        normalized === 'application/xml'
      : normalized.startsWith(`${mediaType}/`);
  if (!compatible) throw new Error(`资源 ${assetId} 的 MIME 类型与媒体类型不一致`);
  return normalized;
}
