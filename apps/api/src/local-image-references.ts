import type { ResolvedMention } from '@multimodal-canvas/providers';

import type { AssetScope, AssetStore } from './assets';
import type { ProjectStore } from './projects';
import type { RunExecutor, RunExecutorRequest } from './runs';

/** 本地图片编辑可读取的输入角色，与图片 Provider 映射保持一致。 */
const imageSourceRoles = new Set(['imageEdit', 'content', 'referenceImage']);

/**
 * 为 API 内存运行的图片编辑读取冻结原图；其他媒体请求原样交给执行器。
 * @param executor 已配置的真实 Provider 执行器，不在此重试或下载外部 URL。
 * @param assetStore 已套用项目归属策略的资产存储。
 * @param projectStore 项目存储，执行前重新确认项目未归档且用户仍有访问权。
 * @param maxBytes 单张图片允许读取的字节上限，使用 API 资源提及限制。
 * @returns 仅将临时 data URL 和已解析提及交给 Provider 的执行器，不改写持久快照。
 * @throws 项目/资产不可访问、归档、版本不可用、格式或大小非法、运行已取消时停止请求。
 */
export function withLocalImageReferences(
  executor: RunExecutor,
  assetStore: AssetStore,
  projectStore: ProjectStore,
  maxBytes: number,
): RunExecutor {
  return async (request: RunExecutorRequest) => {
    const target = request.snapshot.nodes.find((node) => node.id === request.snapshot.targetNodeId);
    if (target?.data.mediaType !== 'image' || target.data.mode !== 'generate') {
      return typeof executor === 'function' ? executor(request) : executor.execute(request);
    }
    const imageInputs = request.snapshot.inputs.filter(
      (input) => imageSourceRoles.has(input.role) && input.snapshot.data.mediaType === 'image',
    );
    const frozenMentions = (request.snapshot.promptMentions ?? []).filter(
      (mention) =>
        (mention.nodeId ?? request.snapshot.targetNodeId) === target.id &&
        mention.mediaType === 'image',
    );
    if (imageInputs.length === 0 && frozenMentions.length === 0) {
      return typeof executor === 'function' ? executor(request) : executor.execute(request);
    }

    /** 水合前后与发送前检查取消，避免读取期间取消后仍发送收费请求。 */
    const assertActive = () => {
      if (request.isCancelled?.()) throw new Error('图片运行已取消，未发送 Provider 请求');
    };
    assertActive();
    /** 原图读取前后重新核验项目，防止排队或读取期间撤销归属后继续发送。 */
    const assertProjectAccessible = async () => {
      const project = await projectStore.get(
        request.snapshot.projectId,
        request.userId ? { ownerId: request.userId } : undefined,
      );
      if (!project || project.archivedAt) throw new Error('图片运行的项目已不可访问或已归档');
    };
    await assertProjectAccessible();

    /** 按已冻结版本读取并校验图片，不使用资产的当前版本内容。 */
    const loadImage = async (
      assetId: string,
      version: number,
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
        throw new Error(`图片资产 ${assetId} 已不可访问或已归档`);
      if (asset.mediaType !== 'image' || !/^image\/(?:png|jpeg|webp)$/i.test(asset.mimeType)) {
        throw new Error(`图片资产 ${assetId} 的格式不支持编辑`);
      }
      const selected = (await assetStore.listVersions(assetId, scope)).find(
        (candidate) => candidate.version === version,
      );
      if (!selected) throw new Error(`图片资产 ${assetId} 的冻结版本 ${version} 已不可用`);
      if (selected.sizeBytes <= 0 || selected.sizeBytes > maxBytes)
        throw new Error(`图片资产 ${assetId} 的冻结版本超出大小限制`);
      const content = await assetStore.getVersionContent(assetId, version, scope);
      if (!content) throw new Error(`图片资产 ${assetId} 的冻结版本 ${version} 内容不可用`);
      if (
        content.byteLength === 0 ||
        content.byteLength > maxBytes ||
        content.byteLength !== selected.sizeBytes
      ) {
        throw new Error(`图片资产 ${assetId} 的冻结版本内容大小不符合记录`);
      }
      const current = await assetStore.get(assetId, scope);
      if (!current || current.status === 'archived')
        throw new Error(`图片资产 ${assetId} 已不可访问或已归档`);
      assertActive();
      return {
        kind: 'data-url',
        mimeType: asset.mimeType,
        dataUrl: `data:${asset.mimeType};base64,${content.toString('base64')}`,
      };
    };

    const hydratedNodes = new Map<string, RunExecutorRequest['snapshot']['nodes'][number]>();
    const inputs = [...request.snapshot.inputs];
    for (const input of imageInputs) {
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
        throw new Error(`图片输入 ${input.nodeId} 缺少有效冻结版本，不能使用当前版本或外部地址`);
      }
      const source = await loadImage(assetId, Number(matched[2]));
      const node = {
        ...input.snapshot,
        data: { ...input.snapshot.data, contentUrl: source.dataUrl, mimeType: source.mimeType },
      };
      hydratedNodes.set(input.nodeId, node);
      inputs[inputs.indexOf(input)] = { ...input, snapshot: node };
    }
    const resolvedMentions: ResolvedMention[] = [];
    for (const mention of frozenMentions) {
      resolvedMentions.push({
        ...mention,
        nodeId: target.id,
        source: await loadImage(mention.assetId, mention.assetVersion),
      });
    }
    await assertProjectAccessible();
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
        assertActive();
      },
    };
    return typeof executor === 'function' ? executor(prepared) : executor.execute(prepared);
  };
}
