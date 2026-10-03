import { describe, expect, it } from 'vitest';
import { renderPromptDocument, type Asset, type PromptDocument } from '@multimodal-canvas/domain';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import { addNodeResourceReference, reorderNodeResources } from './node-resource-actions';
import {
  collectConnectedPromptAssets,
  createConnectedResourceReferenceId,
} from './connected-prompt-assets';

/** 已生成且可冻结版本的画布来源；测试不访问任何资源接口。 */
function source(id: string, assetId = id, version = 1): AssetFlowNode {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      label: '参考图',
      mediaType: 'image',
      mode: 'generate',
      resultAsset: { assetId, version },
    },
  };
}

/** 含原始正文的待生成视频节点。 */
function target(): AssetFlowNode {
  return {
    id: 'video',
    type: 'video',
    position: { x: 200, y: 0 },
    selected: true,
    data: {
      label: '视频',
      mediaType: 'video',
      mode: 'generate',
      videoMode: 'omni_reference',
      prompt: '保留原有正文。',
    },
  };
}

/** 只有旧纯文本别名的连线图，引用尚未冻结版本。 */
function legacyAliasGraph(): { nodes: AssetFlowNode[]; edges: FlowEdge[] } {
  const video = target();
  video.data.prompt = '将角色甲放在角色乙旁边。';
  video.data.resourceRefs = [
    { id: 'connected:a', assetId: 'a', mediaType: 'image', name: '角色甲' },
    { id: 'connected:b', assetId: 'b', mediaType: 'image', name: '角色乙' },
  ];
  return {
    nodes: [source('a'), source('b'), video],
    edges: ['a', 'b'].map((id) => ({
      id: 'edge-' + id,
      source: id,
      target: 'video',
      sourceHandle: 'output:image',
      targetHandle: 'input:referenceImage',
    })),
  };
}

/** 空目录只允许引用来源节点明确提供的版本，不读取真实资产。 */
const assets: Asset[] = [];

describe('addNodeResourceReference', () => {
  it('连续点击原子添加引用和边，保留目标选择、原文和源节点', () => {
    const original = [source('a'), source('b'), target()];
    const first = addNodeResourceReference(original, [], assets, 'video', 'a');
    const second = addNodeResourceReference(first.nodes, first.edges, assets, 'video', 'b');
    expect(original[2].data.promptDocument).toBeUndefined();
    expect(second.nodes[0]).toBe(original[0]);
    expect(second.nodes[2].selected).toBe(true);
    expect(second.nodes[2].data.prompt).toBe('保留原有正文。\n参考图\n参考图2');
    expect(
      second.nodes[2].data.resourceRefs?.map((ref) => [ref.assetId, ref.assetVersion]),
    ).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
    expect(second.edges.map((edge) => [edge.source, edge.target, edge.targetHandle])).toEqual([
      ['a', 'video', 'input:referenceImage'],
      ['b', 'video', 'input:referenceImage'],
    ]);
    expect(second.nodes[2].data.stale).toBe(true);
  });

  it('重复点击同一来源不重复追加正文、引用或边', () => {
    const first = addNodeResourceReference([source('a'), target()], [], assets, 'video', 'a');
    const second = addNodeResourceReference(first.nodes, first.edges, assets, 'video', 'a');
    expect(second.changed).toBe(false);
    expect(second.edges).toEqual(first.edges);
    expect(second.nodes).toEqual(first.nodes);
  });

  it('已有连线但尚无正文提及时只补引用，不重复连线', () => {
    const edge: FlowEdge = {
      id: 'existing',
      source: 'a',
      target: 'video',
      targetHandle: 'input:referenceImage',
    };
    const next = addNodeResourceReference([source('a'), target()], [edge], assets, 'video', 'a');
    expect(next.edges).toEqual([edge]);
    expect(
      next.nodes[1].data.promptDocument?.blocks.filter((block) => block.type === 'mention'),
    ).toHaveLength(1);
  });

  it('已有正文提及时只补来源边，不交换或复制正文', () => {
    const document: PromptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '看这里：' },
        {
          type: 'mention',
          mentionId: 'm',
          assetId: 'a',
          assetVersion: 1,
          mediaType: 'image',
          label: '角色甲',
        },
        { type: 'text', text: '。' },
      ],
    };
    const video = target();
    video.data.promptDocument = document;
    const next = addNodeResourceReference([source('a'), video], [], assets, 'video', 'a');
    expect(next.nodes[1].data.promptDocument).toEqual(document);
    expect(next.edges).toHaveLength(1);
  });

  it('自引用、无结果、未知生成版本和循环都整次拒绝', () => {
    const video = target();
    expect(() => addNodeResourceReference([video], [], assets, 'video', 'video')).toThrow('自身');
    const missing = source('a');
    delete missing.data.resultAsset;
    expect(() => addNodeResourceReference([missing, video], [], assets, 'video', 'a')).toThrow(
      '尚无资源',
    );
    const unknown = source('a');
    delete unknown.data.resultAsset!.version;
    expect(() => addNodeResourceReference([unknown, video], [], assets, 'video', 'a')).toThrow(
      '版本未知',
    );
    expect(() =>
      addNodeResourceReference(
        [source('a'), video],
        [{ id: 'back', source: 'video', target: 'a' }],
        assets,
        'video',
        'a',
      ),
    ).toThrow('循环');
    expect(video.data.promptDocument).toBeUndefined();
  });

  it('无媒体输入的文生视频可切换全能参考，不删除原有连线', () => {
    const video = target();
    video.data.videoMode = 'text_to_video';
    const next = addNodeResourceReference([source('a'), video], [], assets, 'video', 'a');
    expect(next.nodes[1].data.videoMode).toBe('omni_reference');
    expect(next.edges).toHaveLength(1);
  });

  it('不为新参考资源静默删除或改变已有首尾帧角色', () => {
    const video = target();
    video.data.videoMode = 'first_last_frame';
    const edge: FlowEdge = {
      id: 'first',
      source: 'a',
      target: 'video',
      sourceHandle: 'output:image',
      targetHandle: 'input:firstFrame',
    };
    expect(() =>
      addNodeResourceReference([source('a'), source('b'), video], [edge], assets, 'video', 'b'),
    ).toThrow('首尾帧');
    expect(edge.targetHandle).toBe('input:firstFrame');
    expect(video.data.videoMode).toBe('first_last_frame');
  });
});

describe('旧引用与视频模式边界', () => {
  it('连续添加不把历史别名当排序；未列连线保留原顺序', () => {
    const video = target();
    video.data.resourceRefs = [
      { id: 'connected:b', assetId: 'b', assetVersion: 1, mediaType: 'image', name: '旧别名' },
    ];
    const edges: FlowEdge[] = ['a', 'b'].map((id) => ({
      id,
      source: id,
      target: 'video',
      sourceHandle: 'output:image',
      targetHandle: 'input:referenceImage',
    }));
    const next = addNodeResourceReference(
      [source('a'), source('b'), source('c'), video],
      edges,
      assets,
      'video',
      'c',
    );
    const refs = next.nodes[3].data.resourceRefs!;
    expect(refs.map((ref) => ref.assetId)).toEqual(['a', 'b', 'c']);
    expect(refs.some((ref) => ref.id.startsWith('ordered:'))).toBe(false);
    expect(refs.find((ref) => ref.assetId === 'b')?.name).toBe('旧别名');
  });

  it('添加新来源前保存编辑器可见的旧投影，不丢失原正文提及', () => {
    const graph = legacyAliasGraph();
    const original = structuredClone(graph);
    const next = addNodeResourceReference(
      [...graph.nodes, source('c')],
      graph.edges,
      assets,
      'video',
      'c',
    );
    const video = next.nodes[2];
    expect(video.data.prompt).toBe('将角色甲放在角色乙旁边。\n参考图');
    expect(renderPromptDocument(video.data.promptDocument!)).toBe(video.data.prompt);
    expect(
      video.data.promptDocument?.blocks
        .filter((block) => block.type === 'mention')
        .map((block) => [block.assetId, block.assetVersion, block.entityName]),
    ).toEqual([
      ['a', 1, '角色甲'],
      ['b', 1, '角色乙'],
      ['c', 1, '参考图'],
    ]);
    expect(graph).toEqual(original);
  });

  it('点击已连线的旧投影资源只写回结构化引用，不重复正文或错误地返回无变化', () => {
    const graph = legacyAliasGraph();
    const next = addNodeResourceReference(graph.nodes, graph.edges, assets, 'video', 'a');
    expect(next.changed).toBe(true);
    expect(next.nodes[2].data.prompt).toBe(graph.nodes[2].data.prompt);
    expect(
      next.nodes[2].data.promptDocument?.blocks.filter((block) => block.type === 'mention'),
    ).toHaveLength(2);
    expect(next.edges).toEqual(graph.edges);
    const repeated = addNodeResourceReference(next.nodes, next.edges, assets, 'video', 'a');
    expect(repeated.changed).toBe(false);
    expect(repeated.nodes).toEqual(next.nodes);
  });

  it.each(['firstFrame', 'lastFrame'] as const)(
    '拒绝把合法首尾帧的已连接 %s 再添加为 mention',
    (role) => {
      const video = target();
      video.data.videoMode = 'first_last_frame';
      const nodes = [source('a'), source('b'), video];
      const edges: FlowEdge[] = [
        {
          id: 'first',
          source: 'a',
          target: 'video',
          sourceHandle: 'output:image',
          targetHandle: 'input:firstFrame',
        },
        {
          id: 'last',
          source: 'b',
          target: 'video',
          sourceHandle: 'output:image',
          targetHandle: 'input:lastFrame',
        },
      ];
      const before = structuredClone({ nodes, edges });
      expect(() =>
        addNodeResourceReference(nodes, edges, assets, 'video', role === 'firstFrame' ? 'a' : 'b'),
      ).toThrow('原帧连线和生成模式未改变');
      expect({ nodes, edges }).toEqual(before);
    },
  );

  it.each(['text_to_video', 'first_last_frame', 'omni_reference'] as const)(
    '%s 点选文字来源明确拒绝不支持的 mention，不更改模式或原有连线',
    (videoMode) => {
      const video = target();
      video.data.videoMode = videoMode;
      const text = source('text');
      text.type = 'text';
      text.data.mediaType = 'text';
      const nodes = [source('a'), source('b'), text, video];
      const edges: FlowEdge[] =
        videoMode === 'first_last_frame'
          ? [
              {
                id: 'first',
                source: 'a',
                target: 'video',
                sourceHandle: 'output:image',
                targetHandle: 'input:firstFrame',
              },
              {
                id: 'last',
                source: 'b',
                target: 'video',
                sourceHandle: 'output:image',
                targetHandle: 'input:lastFrame',
              },
            ]
          : [];
      const before = structuredClone({ nodes, edges });
      expect(() => addNodeResourceReference(nodes, edges, assets, 'video', 'text')).toThrow(
        '文字资源提及',
      );
      expect({ nodes, edges }).toEqual(before);
    },
  );
});

describe('reorderNodeResources', () => {
  it('交换编号只保存引用数组，正文及连线保持不变，重载仍有排序信息', () => {
    let graph = addNodeResourceReference(
      [source('a'), source('b'), target()],
      [],
      assets,
      'video',
      'a',
    );
    graph = addNodeResourceReference(graph.nodes, graph.edges, assets, 'video', 'b');
    const video = graph.nodes[2];
    const data = reorderNodeResources(video, graph.nodes, graph.edges, assets, [
      { assetId: 'b', assetVersion: 1 },
      { assetId: 'a', assetVersion: 1 },
    ]);
    expect(data.promptDocument).toEqual(video.data.promptDocument);
    expect(data.prompt).toBe(video.data.prompt);
    expect(
      JSON.parse(JSON.stringify(data)).resourceRefs.map((ref: { assetId: string }) => ref.assetId),
    ).toEqual(['b', 'a']);
    expect(graph.edges.map((edge) => edge.source)).toEqual(['a', 'b']);
  });

  it('显式排序标记全部引用，连续添加保留已排序项并将新项追加', () => {
    let graph = addNodeResourceReference(
      [source('a'), source('b'), source('c'), target()],
      [],
      assets,
      'video',
      'a',
    );
    graph = addNodeResourceReference(graph.nodes, graph.edges, assets, 'video', 'b');
    const order = [
      { assetId: 'b', assetVersion: 1 },
      { assetId: 'a', assetVersion: 1 },
    ];
    const data = reorderNodeResources(graph.nodes[3], graph.nodes, graph.edges, assets, order);
    expect(data.resourceRefs?.every((ref) => ref.id.startsWith('ordered:'))).toBe(true);
    graph.nodes = graph.nodes.map((node) => (node.id === 'video' ? { ...node, data } : node));
    const repeated = reorderNodeResources(graph.nodes[3], graph.nodes, graph.edges, assets, order);
    expect(repeated.resourceRefs).toEqual(data.resourceRefs);
    graph = addNodeResourceReference(graph.nodes, graph.edges, assets, 'video', 'c');
    const refs = graph.nodes[3].data.resourceRefs!;
    expect(refs.map((ref) => ref.assetId)).toEqual(['b', 'a', 'c']);
    expect(refs.slice(0, 2)).toEqual(data.resourceRefs);
    expect(refs[2].id.startsWith('ordered:')).toBe(false);
  });

  it('排序前恢复旧纯文本别名投影并冻结引用，正文及连线不变', () => {
    const graph = legacyAliasGraph();
    const before = structuredClone(graph);
    const video = graph.nodes[2];
    const data = reorderNodeResources(video, graph.nodes, graph.edges, assets, [
      { assetId: 'b', assetVersion: 1 },
      { assetId: 'a', assetVersion: 1 },
    ]);
    expect(data.prompt).toBe(video.data.prompt);
    expect(renderPromptDocument(data.promptDocument!)).toBe(video.data.prompt);
    expect(
      data.promptDocument?.blocks
        .filter((block) => block.type === 'mention')
        .map((block) => [block.assetId, block.assetVersion, block.entityName]),
    ).toEqual([
      ['a', 1, '角色甲'],
      ['b', 1, '角色乙'],
    ]);
    expect(data.resourceRefs?.map((ref) => [ref.assetId, ref.assetVersion])).toEqual([
      ['b', 1],
      ['a', 1],
    ]);
    expect(data.resourceRefs?.every((ref) => ref.id.startsWith('ordered:'))).toBe(true);
    expect(graph).toEqual(before);
  });

  it('已冻结别名不复活用户解绑后的普通文字', () => {
    const graph = legacyAliasGraph();
    const video = graph.nodes[2];
    video.data.resourceRefs = video.data.resourceRefs?.map((ref) => ({ ...ref, assetVersion: 1 }));
    const data = reorderNodeResources(video, graph.nodes, graph.edges, assets, [
      { assetId: 'b', assetVersion: 1 },
      { assetId: 'a', assetVersion: 1 },
    ]);
    expect(data.prompt).toBe(video.data.prompt);
    expect(data.promptDocument?.blocks.some((block) => block.type === 'mention')).not.toBe(true);
  });

  it.each(['add', 'reorder'] as const)('旧投影有同名歧义时 %s 原子拒绝', (operation) => {
    const graph = legacyAliasGraph();
    graph.nodes[2].data.resourceRefs![1].name = '角色甲';
    const before = structuredClone(graph);
    expect(() =>
      operation === 'add'
        ? addNodeResourceReference([...graph.nodes, source('c')], graph.edges, assets, 'video', 'c')
        : reorderNodeResources(graph.nodes[2], graph.nodes, graph.edges, assets, [
            { assetId: 'b', assetVersion: 1 },
            { assetId: 'a', assetVersion: 1 },
          ]),
    ).toThrow('多个资源或版本');
    expect(graph).toEqual(before);
  });

  it('同资产不同版本排序后，连线预览与引用别名仍匹配各自版本', () => {
    let graph = addNodeResourceReference(
      [source('a', 'shared', 1), source('b', 'shared', 2), target()],
      [],
      assets,
      'video',
      'a',
    );
    graph = addNodeResourceReference(graph.nodes, graph.edges, assets, 'video', 'b');
    const video = graph.nodes[2];
    const data = reorderNodeResources(video, graph.nodes, graph.edges, assets, [
      { assetId: 'shared', assetVersion: 2 },
      { assetId: 'shared', assetVersion: 1 },
    ]);
    const connected = collectConnectedPromptAssets(
      'video',
      graph.nodes.map((node) => (node.id === 'video' ? { ...node, data } : node)),
      graph.edges,
      assets,
    );
    expect(connected.map((asset) => asset.assetVersion)).toEqual([1, 2]);
    expect(data.resourceRefs?.map((ref) => ref.assetVersion)).toEqual([2, 1]);
  });

  it('缺项、重复和旧身份的排序回调被拒绝，不丢失引用', () => {
    const graph = addNodeResourceReference([source('a'), target()], [], assets, 'video', 'a');
    for (const order of [
      [],
      [{ assetId: 'a', assetVersion: 9 }],
      [
        { assetId: 'a', assetVersion: 1 },
        { assetId: 'a', assetVersion: 1 },
      ],
    ]) {
      expect(() =>
        reorderNodeResources(graph.nodes[1], graph.nodes, graph.edges, assets, order),
      ).toThrow('已变化');
    }
  });
});

describe('来源绑定与显式排序共存', () => {
  it('来源更新 v3 后排序保留 v1，再点选不得写入同来源的冲突绑定', () => {
    const graph = addNodeResourceReference([source('a'), target()], [], assets, 'video', 'a');
    graph.nodes[0] = source('a', 'a', 3);
    const before = structuredClone(graph);
    const data = reorderNodeResources(graph.nodes[1], graph.nodes, graph.edges, assets, [
      { assetId: 'a', assetVersion: 1 },
    ]);
    expect(data.resourceRefs).toEqual([
      {
        id: 'ordered:' + createConnectedResourceReferenceId('a', 'a'),
        assetId: 'a',
        assetVersion: 1,
        mediaType: 'image',
        name: '参考图',
      },
    ]);
    expect(data.promptDocument).toEqual(graph.nodes[1].data.promptDocument);
    expect(() => addNodeResourceReference(graph.nodes, graph.edges, assets, 'video', 'a')).toThrow(
      '已绑定其他冻结版本',
    );
    expect(graph).toEqual(before);
  });

  it('首次点选即绑定来源，含分隔字符的 ID 使用统一编码', () => {
    const graph = addNodeResourceReference(
      [source('节点:a/b', 'asset:一', 2), target()],
      [],
      assets,
      'video',
      '节点:a/b',
    );
    expect(graph.nodes[1].data.resourceRefs).toEqual([
      {
        id: createConnectedResourceReferenceId('节点:a/b', 'asset:一'),
        assetId: 'asset:一',
        assetVersion: 2,
        mediaType: 'image',
        name: '参考图',
      },
    ]);
  });

  it.each([false, true])(
    '旧引用迁移保留 ordered: 与冻结版本，正文是否已有 mention：%s',
    (hasMentions) => {
      const video = target();
      video.data.resourceRefs = [
        {
          id: 'ordered:reference:old-b',
          assetId: 'shared',
          assetVersion: 2,
          mediaType: 'image',
          name: '角色乙',
        },
        {
          id: 'ordered:connected:shared:1',
          assetId: 'shared',
          assetVersion: 1,
          mediaType: 'image',
          name: '角色甲',
        },
      ];
      if (hasMentions) {
        video.data.promptDocument = {
          version: 1,
          blocks: [
            { type: 'text', text: '将' },
            {
              type: 'mention',
              mentionId: 'old-a',
              assetId: 'shared',
              assetVersion: 1,
              mediaType: 'image',
              label: '甲',
              entityName: '角色甲',
            },
            { type: 'text', text: '放在' },
            {
              type: 'mention',
              mentionId: 'old-b',
              assetId: 'shared',
              assetVersion: 2,
              mediaType: 'image',
              label: '乙',
              entityName: '角色乙',
            },
            { type: 'text', text: '旁边。' },
          ],
        };
        video.data.prompt = renderPromptDocument(video.data.promptDocument);
      }
      const nodes = [source('a', 'shared', 1), source('b', 'shared', 2), video, source('c')];
      const edges: FlowEdge[] = ['a', 'b'].map((id) => ({
        id,
        source: id,
        target: 'video',
        sourceHandle: 'output:image',
        targetHandle: 'input:referenceImage',
      }));
      const graph = addNodeResourceReference(nodes, edges, assets, 'video', 'c');
      expect(graph.nodes[2].data.resourceRefs?.map((ref) => ref.id)).toEqual([
        'ordered:' + createConnectedResourceReferenceId('b', 'shared'),
        'ordered:' + createConnectedResourceReferenceId('a', 'shared'),
        createConnectedResourceReferenceId('c', 'c'),
      ]);
      const updatedNodes = graph.nodes.map((node) =>
        node.id === 'a' || node.id === 'b'
          ? {
              ...node,
              data: {
                ...node.data,
                resultAsset: { assetId: 'shared', version: node.id === 'a' ? 2 : undefined },
              },
            }
          : node,
      );
      expect(
        collectConnectedPromptAssets('video', updatedNodes, graph.edges, assets).map((item) => [
          item.sourceNodeId,
          item.assetVersion,
          item.referenceName,
        ]),
      ).toEqual([
        ['a', 1, '角色甲'],
        ['b', 2, '角色乙'],
        ['c', 1, '参考图'],
      ]);
      const reordered = reorderNodeResources(updatedNodes[2], updatedNodes, graph.edges, assets, [
        { assetId: 'c', assetVersion: 1 },
        { assetId: 'shared', assetVersion: 1 },
        { assetId: 'shared', assetVersion: 2 },
      ]);
      expect(reordered.resourceRefs?.map((ref) => [ref.id, ref.assetVersion])).toEqual([
        ['ordered:' + createConnectedResourceReferenceId('c', 'c'), 1],
        ['ordered:' + createConnectedResourceReferenceId('a', 'shared'), 1],
        ['ordered:' + createConnectedResourceReferenceId('b', 'shared'), 2],
      ]);
      expect(reordered.promptDocument).toEqual(graph.nodes[2].data.promptDocument);
      expect(reordered.prompt).toBe(graph.nodes[2].data.prompt);
    },
  );

  it('旧纯文本投影冻结时保留排序标记，不依赖旧引用未冻结的版本身份', () => {
    const graph = legacyAliasGraph();
    graph.nodes[2].data.resourceRefs = graph.nodes[2].data.resourceRefs!.reverse().map((ref) => ({
      ...ref,
      id: 'ordered:' + ref.id,
    }));
    const next = addNodeResourceReference(
      [...graph.nodes, source('c')],
      graph.edges,
      assets,
      'video',
      'c',
    );
    expect(next.nodes[2].data.resourceRefs?.map((ref) => [ref.id, ref.assetVersion])).toEqual([
      ['ordered:' + createConnectedResourceReferenceId('b', 'b'), 1],
      ['ordered:' + createConnectedResourceReferenceId('a', 'a'), 1],
      [createConnectedResourceReferenceId('c', 'c'), 1],
    ]);
  });

  it('已有独立 mention 新接来源连线时迁移 ID，但不追加正文或丢排序标记', () => {
    const video = target();
    video.data.promptDocument = {
      version: 1,
      blocks: [
        {
          type: 'mention',
          mentionId: 'existing',
          assetId: 'a',
          assetVersion: 1,
          mediaType: 'image',
          label: '角色甲',
        },
      ],
    };
    video.data.resourceRefs = [
      {
        id: 'ordered:reference:existing',
        assetId: 'a',
        assetVersion: 1,
        mediaType: 'image',
        name: '角色甲',
      },
    ];
    const next = addNodeResourceReference([source('a'), video], [], assets, 'video', 'a');
    expect(next.nodes[1].data.resourceRefs?.[0].id).toBe(
      'ordered:' + createConnectedResourceReferenceId('a', 'a'),
    );
    expect(next.nodes[1].data.promptDocument).toEqual(video.data.promptDocument);
    expect(next.edges).toHaveLength(1);
  });

  it('点击已有 mention 与连线的旧 ID 时保存来源迁移，再次点击不重复写入', () => {
    const first = addNodeResourceReference([source('a'), target()], [], assets, 'video', 'a');
    first.nodes[1].data.resourceRefs![0].id = 'ordered:reference:legacy';
    const next = addNodeResourceReference(first.nodes, first.edges, assets, 'video', 'a');
    expect(next.changed).toBe(true);
    expect(next.nodes[1].data.resourceRefs?.[0].id).toBe(
      'ordered:' + createConnectedResourceReferenceId('a', 'a'),
    );
    expect(next.nodes[1].data.promptDocument).toEqual(first.nodes[1].data.promptDocument);
    expect(next.edges).toEqual(first.edges);
    expect(addNodeResourceReference(next.nodes, next.edges, assets, 'video', 'a').changed).toBe(
      false,
    );
  });
});

describe('参考操作不覆盖节点回显', () => {
  it('添加和排序保留目标节点的运行结果与耗时展示字段', () => {
    const video = target();
    video.data.resultAsset = { assetId: 'old-video', version: 3 };
    video.data.runStatus = 'succeeded';
    video.data.runProgress = 100;
    const graph = addNodeResourceReference([source('a'), video], [], assets, 'video', 'a');
    expect(graph.nodes[1].data.resultAsset).toEqual(video.data.resultAsset);
    expect(graph.nodes[1].data.runStatus).toBe('succeeded');
    const data = reorderNodeResources(graph.nodes[1], graph.nodes, graph.edges, assets, [
      { assetId: 'a', assetVersion: 1 },
    ]);
    expect(data.resultAsset).toEqual(video.data.resultAsset);
    expect(data.runProgress).toBe(100);
  });

  it('手动替换的素材优先于旧生成结果，后续排序仍使用手动版本', () => {
    const image = source('a', 'old-image', 2);
    image.data.manualOutput = true;
    image.data.assetId = 'manual-image';
    image.data.contentUrl = '/v1/assets/manual-image/versions/3/content';
    const graph = addNodeResourceReference([image, target()], [], assets, 'video', 'a');
    expect(graph.nodes[1].data.resourceRefs?.map((ref) => [ref.assetId, ref.assetVersion])).toEqual(
      [['manual-image', 3]],
    );
    const data = reorderNodeResources(graph.nodes[1], graph.nodes, graph.edges, assets, [
      { assetId: 'manual-image', assetVersion: 3 },
    ]);
    expect(data.resourceRefs).toHaveLength(1);
  });
});
