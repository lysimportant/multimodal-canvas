import { describe, expect, it } from 'vitest';
import {
  canvasDocumentSchema,
  confirmedVideoInputRolesForModel,
  isUnadaptedYuanliuVideoModel,
  precheckVideoGenerationInputs,
  resolveYuanliuVideoParameters,
  videoFamilyForModel,
  videoInputRoleForPromptMention,
  videoModeCapability,
  yuanliuVideoContractForModel,
  yuanliuVideoModelAliases,
  YuanliuVideoParameterError,
  type MediaType,
  type PortRole,
  type RunInputSnapshot,
} from './index.js';

/** 精确别名与上游 ID 的已确认差异；不以相似模型名共享能力。 */
const models = [
  ['Yuan-Seedance-2.5-Official', 'seedance-2.5-guanfang-anmiao', 4, 30, 30, 0, 10, 40],
  ['Yuan-Seedance-2.0-LJ', 'yl_g7zy_seedance_v2_0_std', 4, 15, 9, 0, 0, 9],
  ['Yuan-Seedance-2.0-LJ-Full', 'yl_g7zy_seedance_v2_0_std_full', 5, 15, 9, 3, 3, 15],
  ['Yuan-Seedance-2.5-LJ', 'yl_g7zy_seedance_v2_5', 4, 30, 30, 0, 0, 30],
  ['Yuan-Seedance-2.5-LJ-Full', 'yl_g7zy_seedance_v2_5_full', 5, 30, 30, 10, 10, 40],
  ['Yuan-Seedance-2.0-HD', 'yl_seedance-2-0_ba0687ff09f2', 5, 15, 9, 0, 0, 9],
  ['Yuan-Seedance-2.5-HD', 'yl_seedance-2-5_6caffaca7390', 4, 30, 30, 0, 0, 30],
  ['Yuan-Seedance-2.5-HD-Full', 'yl_seedance-2-5_0fab2f1b1f10', 10, 30, 30, 10, 10, 40],
  ['Yuan-Seedance-2.5-HD-PerSecond', 'yl_seedance-2-5_750271498003', 10, 30, 30, 10, 10, 40],
  [
    'Yuan-Seedance-2.5-YS-Full',
    'yl_api_hmstudio_seedance_v2_5_101010_7d58bbb217e6',
    4,
    30,
    10,
    10,
    10,
    30,
  ],
  ['Yuan-Seedance-2.5-YS', 'yl_api_hmstudio_seedance_v2_5_dc729300ff39', 4, 30, 10, 0, 0, 10],
  ['Yuan-Seedance-2.5-YL1', 'yl_video-30_76dbb7993f8e', 30, 30, 9, 0, 0, 9],
  ['Yuan-Seedance-2.0-YS', 'yl_api_hmstudio_seedance_v2_0_514a65db713b', 4, 15, 9, 0, 0, 9],
] as const;

/** 构造有序普通参考或冻结文字，不读取用户素材和外部地址。 */
function reference(
  id: string,
  role: PortRole = 'referenceImage',
  mediaType: MediaType = 'image',
  sortOrder = 0,
): RunInputSnapshot {
  return {
    nodeId: id,
    role,
    sortOrder,
    snapshot: {
      id,
      type: mediaType,
      position: { x: 0, y: 0 },
      data: {
        label: id,
        mediaType,
        mode: 'source',
        contentUrl: `https://assets.invalid/${id}`,
      },
    },
  };
}

describe('源流精确视频合同', () => {
  it('持久化保留精确型号、显式参数、重复参考与 40 项边界，不修正非法旧参数', () => {
    const parameters = { duration: 30, quality: 'high', ratio: '9:16' };
    const node = {
      id: 'video',
      type: 'video',
      position: { x: 0, y: 0 },
      data: {
        label: 'video',
        mediaType: 'video',
        mode: 'generate',
        modelAlias: 'Yuan-Seedance-2.5-LJ-Full',
        parameters,
        resourceRefs: Array.from({ length: 40 }, (_, n) => ({
          id: `ref-${n}`,
          assetId: 'same',
          assetVersion: 2,
          mediaType: 'image',
          name: `reference-${n}`,
        })),
      },
    };
    const document = canvasDocumentSchema.parse({ revision: 1, nodes: [node], edges: [] });
    expect(document.nodes[0]!.data).toMatchObject({
      modelAlias: 'Yuan-Seedance-2.5-LJ-Full',
      parameters,
      resourceRefs: node.data.resourceRefs,
    });
    expect(
      canvasDocumentSchema.safeParse({
        revision: 1,
        nodes: [
          {
            ...node,
            data: {
              ...node.data,
              resourceRefs: [
                ...node.data.resourceRefs,
                { ...node.data.resourceRefs[0], id: 'ref-40' },
              ],
            },
          },
        ],
        edges: [],
      }).success,
    ).toBe(true);
  });
});
