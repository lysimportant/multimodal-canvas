import { describe, expect, it } from 'vitest';

import type { Asset, NodeResourceRef } from '@multimodal-canvas/domain';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import {
  collectConnectedPromptAssets,
  createConnectedResourceReferenceId,
} from './connected-prompt-assets';

/** 构造同资产的来源回显；缺省版本表示生成结果版本未知。 */
function source(id: string, version?: number): AssetFlowNode {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      mediaType: 'image',
      mode: 'generate',
      resultAsset: { assetId: 'shared', version },
    },
  };
}

/** 构造冻结引用；ID 控制来源绑定和排序标记，名称不参与身份解析。 */
function reference(id: string, assetVersion?: number, name = id): NodeResourceRef {
  return { id, assetId: 'shared', mediaType: 'image', name, assetVersion };
}

/** 将冻结版本绑定到指定来源，版本不写进 ID。 */
function boundReference(sourceId: string, version?: number): NodeResourceRef {
  return reference(createConnectedResourceReferenceId(sourceId, 'shared'), version, sourceId);
}

/** 生成仅含参考图连线的内存图，不上传资源或调用 Provider。 */
function graph(sources: AssetFlowNode[], references: NodeResourceRef[]) {
  const target: AssetFlowNode = {
    id: 'target',
    type: 'video',
    position: { x: 200, y: 0 },
    data: {
      label: '目标',
      mediaType: 'video',
      mode: 'generate',
      videoMode: 'omni_reference',
      resourceRefs: references,
    },
  };
  const edges: FlowEdge[] = sources.map((node) => ({
    id: `edge:${node.id}`,
    source: node.id,
    target: target.id,
    sourceHandle: 'output:image',
    targetHandle: 'input:referenceImage',
  }));
  return { nodes: [...sources, target], edges };
}

/** 按传入连线顺序读取资源条；资源目录仅用于测试最新版本不能覆盖冻结身份。 */
function collect(sources: AssetFlowNode[], references: NodeResourceRef[], assets: Asset[] = []) {
  const { nodes, edges } = graph(sources, references);
  return collectConnectedPromptAssets('target', nodes, edges, assets);
}

describe('来源绑定 ID 契约', () => {
  it('分别编码来源和资产，避免冒号、斜杠及中文导致串绑', () => {
    expect(createConnectedResourceReferenceId('节点:a/b', 'asset:一')).toBe(
      'connected:source:%E8%8A%82%E7%82%B9%3Aa%2Fb:asset%3A%E4%B8%80',
    );
    expect(createConnectedResourceReferenceId('a:b', 'c')).not.toBe(
      createConnectedResourceReferenceId('a', 'b:c'),
    );
  });

  it('来源 ID 含分隔字符时可读排序后的绑定，别名变化不影响版本', () => {
    const ref = boundReference('节点:a/b', 1);
    ref.id = `ordered:ordered:${ref.id}`;
    ref.name = '新别名';
    expect(collect([source('节点:a/b', 3)], [ref])[0]).toMatchObject({
      sourceNodeId: '节点:a/b',
      referenceName: '新别名',
      assetVersion: 1,
    });
  });
});
describe('来源绑定的冻结版本', () => {
  it('同资产多版本排序后来源更新，仍保留各自冻结版本和别名', () => {
    const references = [boundReference('b', 2), boundReference('a', 1)].map((ref) => ({
      ...ref,
      id: `ordered:${ref.id}`,
    }));
    const result = collect([source('a', 3), source('b', 2)], references);
    expect(
      result.map((item) => [item.sourceNodeId, item.assetVersion, item.referenceName]),
    ).toEqual([
      ['a', 1, 'a'],
      ['b', 2, 'b'],
    ]);
    expect(result.map((item) => item.contentUrl)).toEqual([
      '/v1/assets/shared/versions/1/content',
      '/v1/assets/shared/versions/2/content',
    ]);
  });

  it('绑定优先于来源当前版本的精确匹配，不把两个冻结版本合并', () => {
    const result = collect(
      [source('a', 2), source('b', 2)],
      [boundReference('b', 2), boundReference('a', 1)],
    );
    expect(result.map((item) => item.assetVersion)).toEqual([1, 2]);
  });

  it('来源版本暂时未知时仍使用已绑定的冻结版本', () => {
    const result = collect([source('a')], [boundReference('a', 1)]);
    expect(result[0]).toMatchObject({ assetVersion: 1, referenceName: 'a' });
    expect(result[0].versionUnavailable).toBeUndefined();
  });

  it('不借用其他来源的绑定，即使它是同资产唯一引用', () => {
    const result = collect([source('a', 3)], [boundReference('b', 1)]);
    expect(result[0]).toMatchObject({ sourceNodeId: 'a', assetVersion: 3 });
    expect(result[0].referenceName).toBeUndefined();
  });

  it.each([[boundReference('a', 1), boundReference('a', 2)], [boundReference('a')]])(
    '同来源绑定缺版本或冲突时不回退最新版：%j',
    (...references) => {
      const result = collect([source('a', 9)], references);
      expect(result[0].versionUnavailable).toBe(true);
      expect(result[0].assetVersion).toBeUndefined();
      expect(result[0].contentUrl).toBeUndefined();
      expect(result[0].referenceNeedsSync).toBeUndefined();
    },
  );

  it('相同冻结身份的重复绑定仍可读取且不修改节点、边或引用', () => {
    const data = graph(
      [source('a', 3), source('b', 4)],
      [boundReference('a', 1), boundReference('b', 2), boundReference('a', 1)],
    );
    const before = JSON.stringify(data);
    expect(
      collectConnectedPromptAssets('target', data.nodes, data.edges).map(
        (item) => item.assetVersion,
      ),
    ).toEqual([1, 2]);
    expect(JSON.stringify(data)).toBe(before);
  });
});

describe('历史引用的版本兼容', () => {
  it.each([
    'connected:shared',
    'ordered:connected:shared',
    'imported-reference',
    'connected:shared:1',
  ])('单一历史冻结引用继续保留版本：%s', (id) => {
    const result = collect([source('a', 9)], [reference(id, 1, '原名称')]);
    expect(result[0]).toMatchObject({
      assetVersion: 1,
      referenceName: '原名称',
      contentUrl: '/v1/assets/shared/versions/1/content',
    });
  });

  it.each(['connected:shared', 'ordered:connected:shared'])(
    '来源无版本时，明确旧连线身份优先于同资产的其它历史版本：%s',
    (id) => {
      const uploaded = source('a');
      uploaded.data = { label: '上传', mediaType: 'image', mode: 'source', assetId: 'shared' };
      const references = [
        reference('imported-reference', 3, '导入别名'),
        reference(id, 7, '连线别名'),
      ];
      const before = JSON.stringify(references);
      const result = collect([uploaded], references);
      expect(result[0]).toMatchObject({
        sourceNodeId: 'a',
        assetVersion: 7,
        referenceName: '连线别名',
        contentUrl: '/v1/assets/shared/versions/7/content',
      });
      expect(result[0].versionUnavailable).toBeUndefined();
      expect(result[0].referenceNeedsSync).toBeUndefined();
      expect(JSON.stringify(references)).toBe(before);
    },
  );

  it.each(['connected:shared', 'ordered:connected:shared'])(
    '旧连线身份优先级不覆盖多来源的精确历史版本：%s',
    (id) => {
      const result = collect(
        [source('a', 3), source('b', 7)],
        [reference(id, 7, '连线别名'), reference('imported-reference', 3, '导入别名')],
      );
      expect(
        result.map((item) => [item.sourceNodeId, item.assetVersion, item.referenceName]),
      ).toEqual([
        ['a', 3, '导入别名'],
        ['b', 7, '连线别名'],
      ]);
    },
  );

  it('本来源绑定优先于明确旧连线身份和来源精确版本', () => {
    const result = collect(
      [source('a', 3)],
      [
        reference('ordered:connected:shared', 7, '连线别名'),
        reference('imported-reference', 3, '导入别名'),
        boundReference('a', 1),
      ],
    );
    expect(result[0]).toMatchObject({ assetVersion: 1, referenceName: 'a' });
    expect(result[0].versionUnavailable).toBeUndefined();
  });

  it.each([[boundReference('a')], [boundReference('a', 1), boundReference('a', 2)]])(
    '明确旧连线身份不能解除本来源绑定的缺版本或冲突：%j',
    (...references) => {
      const result = collect(
        [source('a', 7)],
        [...references, reference('ordered:connected:shared', 7, '旧连线别名')],
      );
      expect(result[0].versionUnavailable).toBe(true);
      expect(result[0].assetVersion).toBeUndefined();
      expect(result[0].contentUrl).toBeUndefined();
    },
  );

  it('旧连线身份自身版本冲突时仍明确不可用，不任取一个历史版本', () => {
    const result = collect(
      [source('a')],
      [reference('connected:shared', 7), reference('ordered:connected:shared', 3)],
    );
    expect(result[0].versionUnavailable).toBe(true);
    expect(result[0].assetVersion).toBeUndefined();
    expect(result[0].contentUrl).toBeUndefined();
  });

  it('历史多版本按来源精确匹配，反向引用排列不交换版本和别名', () => {
    const result = collect(
      [source('a', 1), source('b', 2)],
      [
        reference('ordered:reference:2', 2, '第二版'),
        reference('ordered:reference:1', 1, '第一版'),
      ],
    );
    expect(result.map((item) => [item.assetVersion, item.referenceName])).toEqual([
      [1, '第一版'],
      [2, '第二版'],
    ]);
  });

  it.each([3, undefined])('历史多版本无法绑定来源版本 %s 时明确不可用，不切到新版本', (version) => {
    const references = [reference('reference:2', 2), reference('reference:1', 1)];
    const result = collect([source('a', version), source('b', 2)], references);
    expect(result[0].versionUnavailable).toBe(true);
    expect(result[0].assetVersion).toBeUndefined();
    expect(result[0].contentUrl).toBeUndefined();
    expect(result[1].assetVersion).toBe(2);
    expect(references.map((ref) => ref.assetVersion)).toEqual([2, 1]);
  });

  it('相同精确版本仍优先旧 connected 别名，不被排序标记隐藏', () => {
    const result = collect(
      [source('a', 2)],
      [
        reference('imported-reference', 2, '导入名'),
        reference('ordered:connected:shared', 2, '连线名'),
      ],
    );
    expect(result[0].referenceName).toBe('连线名');
  });

  it('单个未冻结旧别名仍投影来源确定版本，并保留待同步标记', () => {
    const result = collect(
      [source('a', 2)],
      [reference('ordered:connected:shared', undefined, '旧别名')],
    );
    expect(result[0]).toMatchObject({
      assetVersion: 2,
      referenceName: '旧别名',
      referenceNeedsSync: true,
    });
  });

  it('来源目录最新版不能解除历史多版本绑定歧义', () => {
    const uploaded = source('a');
    uploaded.data = { label: '上传', mediaType: 'image', mode: 'source', assetId: 'shared' };
    const catalog = {
      id: 'shared',
      name: '目录',
      mediaType: 'image',
      mimeType: 'image/png',
      status: 'ready',
      sizeBytes: 1,
      tags: [],
      latestVersion: 9,
      contentUrl: '/v1/assets/shared/versions/9/content',
    } as Asset;
    const result = collect(
      [uploaded],
      [reference('reference:1', 1), reference('reference:2', 2)],
      [catalog],
    );
    expect(result[0].versionUnavailable).toBe(true);
    expect(result[0].contentUrl).toBeUndefined();
  });
});
