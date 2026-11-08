import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { CanvasDocument } from '@multimodal-canvas/domain';

import { canvasAgentTools, executeCanvasTool } from './canvas-agent-tools';
import { registerCanvasMcp } from './canvas-mcp';

describe('画布 MCP 工具契约', () => {
  it('编辑与运行工具的说明直接给出字段契约，避免 Agent 猜测', () => {
    const tools = canvasAgentTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.get('get_canvas')?.description).toContain('第一步必须调用');
    expect(byName.get('get_canvas')?.description).toContain('生成新参考图片前');
    expect(byName.get('get_canvas')?.description).toContain('节点已删除不能说明项目资产不存在');
    const assets = byName.get('list_assets')!.description;
    expect(assets).toContain('遍历全部分页，直到 hasMore 为 false');
    expect(assets).toContain('按名称、资产台账身份/变体和用途筛选候选');
    expect(assets).toContain('不能因画布节点不存在就断定项目素材不存在');
    expect(assets).toContain('node.data.assetId 填候选素材 ID');
    expect(assets).toContain('create_node 操作顶层 assetVersion 填所选版本');
    expect(assets).toContain('服务端生成对应固定版本 contentUrl');
    const imageReader = byName.get('get_image')!.description;
    expect(imageReader).toContain('查看指定版本，核对图片用途');
    expect(imageReader).toContain('不能自动语义匹配');
    expect(byName.get('apply_canvas_operations')?.description).toContain('"type":"create_node"');
    expect(byName.get('apply_canvas_operations')?.description).toContain(
      'width、height 等显示尺寸写在 node 顶层',
    );
    expect(byName.get('apply_canvas_operations')?.description).toContain(
      '按 data.parameters.aspectRatio 推导长方形卡片',
    );
    expect(byName.get('apply_canvas_operations')?.description).toContain('素材引用与连线必须双写');
    expect(byName.get('apply_canvas_operations')?.description).toContain('update_node');
    expect(byName.get('run_node')?.description).toContain('idempotencyKey');
    expect(byName.get('apply_canvas_operations')?.description).toContain('不是验证或测试环境');
    expect(byName.get('apply_canvas_operations')?.description).toContain('3D CG / 2.5D CG');
    expect(byName.get('apply_canvas_operations')?.description).toContain('禁止默认退回手绘平涂');
    expect(byName.get('apply_canvas_operations')?.description).toContain(
      '生成人物定妆图或人物参考图时',
    );
    expect(byName.get('apply_canvas_operations')?.description).toContain('左侧 40% 放唯一大正脸');
    expect(byName.get('apply_canvas_operations')?.description).toContain('右侧 60% 全高均分');
    expect(byName.get('apply_canvas_operations')?.description).toContain(
      '更换角色或服装时，只替换身份/面部锚点',
    );
    expect(byName.get('apply_canvas_operations')?.description).toContain('纵向铺满全高');
    expect(byName.get('apply_canvas_operations')?.description).toContain('每栏上边界水平落在肩线/衣料肩线');
    expect(byName.get('apply_canvas_operations')?.description).toContain('头脸、颈部、发际线与发型均位于画框之外');
    expect(byName.get('apply_canvas_operations')?.description).toContain('人体采用自然成人比例');
    expect(byName.get('apply_canvas_operations')?.description).toContain('不另设材质球或服饰样本区');
    expect(byName.get('apply_canvas_operations')?.description).toContain('颜色保持清晰、有层次');
    expect(byName.get('apply_canvas_operations')?.description).toContain(
      '背景为纯白纯色（#FFFFFF）',
    );
    const edit = byName.get('apply_canvas_operations')!.description;
    expect(edit).toContain('图片 mention＋一个空格＋姓名');
    expect(edit).toContain('先放 promptDocument 图片 mention 块');
    expect(edit).toContain('图片 mention 必须 inline:true');
    expect(edit).toContain('不设 executionOnly');
    expect(edit).toContain('兼容既有“姓名＋一个空格＋图片 mention”的相邻结构');
    expect(edit).toContain('不为调换顺序重复插入姓名');
    expect(edit).toContain('姓名已由相邻 text 块写出时不设置 entityName');
    expect(edit).toContain('镜头正文里人物、场景首次出现处');
    expect(edit).toContain('同一镜内同一素材只挂一次、跨镜可各自再挂');
    expect(edit).toContain('台词行、声音：<…>、环境：…');
    expect(edit).toContain('禁止多指与手指粘连');
    expect(edit).toContain('禁止画面崩坏与镜头漂移');
    expect(edit).toContain('minimax-h3-1 使用通用 Image N');
    expect(edit).toContain('属于预览、提交或外部裸文本的输出语法');
    expect(edit).toContain('画布编辑态不手写');
    expect(edit).toContain('通用、Seedance、Wan3、H3 的默认画布稿与普通文本稿统一按三段式');
    expect(edit).toContain('【固定资产】→【视频生成风格类型】→【分镜】');
    expect(edit).toContain('仅当用户明确要求 H3 原生协议导出时');
    expect(edit).toContain('当前画布不会自动把图片或人物外观转换成 <Subject N> 定义');
    expect(edit).toContain('批量写入后必须逐节点打开“查看真实提示词”');
    expect(edit).not.toContain('H3 把角色外观写进');
    expect(edit).not.toContain('只适用于不经过 promptDocument 的手写文本');
    expect(byName.get('run_node')?.description).toContain('禁止为验证');
    expect(byName.get('get_run')?.description).toContain('list_project_runs');
    expect(edit).toContain('跨 EP 复用已有参考图');
    expect(edit).toContain('从本段分镜列出每位出场角色、每个场景及关键道具');
    expect(edit).toContain('实际画布 assetId@assetVersion');
    expect(edit).toContain('只有一张无关图片或只在文字中提到素材不算覆盖');
    expect(byName.get('run_node')?.description).toContain('禁止纯文字视频生成');
    expect(byName.get('run_node')?.description).toContain('当前运行时只检查是否至少存在图片引用');
    expect(byName.get('run_node')?.description).toContain('逐项判定对应关系');
    expect(edit).toContain('node.data.assetId 填候选素材 ID');
    expect(edit).toContain('create_node 操作顶层 assetVersion 填 get_image 已核实的版本');
    expect(edit).toContain('服务端据此生成固定版本 contentUrl');
    expect(edit).toContain('只有确认全部项目资产分页中没有适用候选后才生成新参考图片');
    expect(edit).toContain('候选身份、用途或版本不明确时暂停并报告');
    expect(edit).toContain('MCP 不执行自动图像语义匹配');
    expect(byName.get('run_node')?.description).toContain('生成任何新参考图片前');
    expect(byName.get('run_node')?.description).toContain('直到 hasMore 为 false');
    expect(byName.get('run_node')?.description).toContain('复用完全相同的 assetId@assetVersion');
    expect(byName.get('run_node')?.description).toContain('MCP 不执行自动图像语义匹配');
    expect(edit).toContain('没有来源节点时创建 source 节点：node.data.assetId 填候选素材 ID');
  });

  it('工具清单与执行入口共用同一份 schema', () => {
    expect(canvasAgentTools().map((tool) => tool.name)).toEqual([
      'get_canvas',
      'list_assets',
      'list_models',
      'get_image',
      'apply_canvas_operations',
      'run_node',
      'get_run',
      'cancel_run',
      'list_project_runs',
      'list_prompt_skills',
      'get_prompt_skill',
    ]);
  });

  it('模型、编辑和生成工具把数量接受权交给上游，禁止 Agent 为凑上限删引用', () => {
    const byName = new Map(canvasAgentTools().map((tool) => [tool.name, tool]));
    for (const name of ['list_models', 'apply_canvas_operations', 'run_node']) {
      expect(byName.get(name)?.description).toContain('参考素材数量及是否接受由上游决定');
      expect(byName.get(name)?.description).toContain('画布不按模型目录中的数量上限拦截');
      expect(byName.get(name)?.description).toContain('擅自删减引用');
    }
    const edit = byName.get('apply_canvas_operations')!.description;
    expect(edit).toContain('不把无关备用节点一起接入');
    expect(edit).toContain('没有提示词不等于无用');
    expect(edit).toContain('mention/resourceRefs 的固定版本和用途');
    expect(edit).toContain('重复连接幂等、固定版本及用途去重、文件可读性校验和实际发送素材清单');
  });

  it('MCP 初始化直接传达同一数量政策，读取说明不调用生成执行器', async () => {
    const app = Fastify({ logger: false });
    const execute = vi.fn(async () => ({}));
    registerCanvasMcp(app, { tools: canvasAgentTools(), execute });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/projects/synthetic-policy/mcp',
        headers: { accept: 'application/json, text/event-stream' },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'reference-policy-test', version: '1.0.0' },
          },
        },
      });
      expect(response.statusCode).toBe(200);
      const instructions = response.json().result.instructions as string;
      expect(instructions).toContain('参考素材数量及是否接受由上游决定');
      expect(instructions).toContain('画布不按模型目录中的数量上限拦截');
      expect(instructions).toContain('Agent 不得为了凑上限擅自删减引用');
      expect(instructions).toContain('不把无关备用节点一起接入');
      expect(instructions).toContain('没有提示词不等于无用');
      expect(instructions).toContain('并同步核对 mention/resourceRefs 的固定版本和用途');
      expect(instructions).toContain('参考图已承载脸型、发型、服饰等静态外观');
      expect(instructions).toContain('镜头正文仍须保留本镜的动作、可见表情、持物、起始状态和末态');
      expect(instructions).toContain('禁止椅子与地砖接触关系错误与人物漂浮');
      expect(instructions).toContain('按实际渠道冻结契约和真实发送顺序渲染编号');
      expect(instructions).toContain('历史写法或缺失素材逐项单列');
      expect(instructions).toContain('所有视频引擎共用人物风格与参考图规则');
      expect(instructions).toContain('缺图时先用图片节点制作人物、场景参考图');
      expect(instructions).toContain(
        '通用、Seedance、Wan3、H3 的默认画布稿与普通文本稿统一按三段式',
      );
      expect(instructions).toContain('【固定资产】→【视频生成风格类型】→【分镜】');
      expect(instructions).toContain('仅当用户明确要求 H3 原生协议导出时');
      expect(instructions).not.toContain('H3 把角色外观写进');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('运行查询把筛选和游标交给授权项目路由，并保留分页信息', async () => {
    const page = { runs: [{ id: 'newest-run' }], hasMore: true, nextCursor: 'next-page' };
    const invoke = vi.fn(async () => page);
    const context = { projectId: 'project/one', invoke };
    expect(await executeCanvasTool('list_project_runs', {}, context)).toEqual({
      ...page,
      projectId: 'project/one',
    });
    expect(invoke).toHaveBeenLastCalledWith('GET', '/v1/projects/project%2Fone/runs?limit=20');
    await executeCanvasTool(
      'list_project_runs',
      { limit: 50, nodeId: 'node & one', cursor: 'opaque_cursor' },
      context,
    );
    expect(invoke).toHaveBeenLastCalledWith(
      'GET',
      '/v1/projects/project%2Fone/runs?limit=50&nodeId=node+%26+one&cursor=opaque_cursor',
    );
    const description = canvasAgentTools().find(
      (tool) => tool.name === 'list_project_runs',
    )!.description;
    expect(description).toContain('最新优先');
    expect(description).toContain('nextCursor');
  });

  it.each([{ limit: 51 }, { nodeId: '' }, { cursor: '' }, { projectId: 'foreign' }])(
    '运行列表拒绝无效参数或扩大项目范围 %j',
    async (args) => {
      const invoke = vi.fn(async () => ({ runs: [] }));
      await expect(
        executeCanvasTool('list_project_runs', args, { projectId: 'project', invoke }),
      ).rejects.toMatchObject({ code: 'invalid_arguments' });
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});

describe('画布 MCP 视频参考与人物风格边界', () => {
  const video: CanvasDocument['nodes'][number] = {
    id: 'video',
    type: 'video',
    position: { x: 0, y: 0 },
    data: {
      label: '合成视频',
      mediaType: 'video',
      mode: 'generate',
      prompt: '3D CG 角色在门口转身，动作连续',
      parameters: { duration: 30, resolution: '768p' },
    },
  };
  const image: CanvasDocument['nodes'][number] = {
    id: 'image',
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      label: '合成角色参考',
      mediaType: 'image',
      mode: 'generate',
      prompt: '适度风格化的 3D CG 角色定妆图，纯白背景',
    },
  };
  const canvas = (
    nodes: CanvasDocument['nodes'],
    edges: CanvasDocument['edges'] = [],
  ): CanvasDocument => ({ revision: 1, nodes, edges });
  const contextFor = (document: CanvasDocument) => {
    const invoke = vi.fn(async (method: string) =>
      method === 'GET' ? { canvas: document } : { run: { id: 'synthetic-run' } },
    );
    return { projectId: 'synthetic-project', invoke };
  };
  const run = { nodeId: 'video', revision: 1, idempotencyKey: 'synthetic-key' };

  it.each(['真实人体比例', '非真人实拍', 'photoreal human skin', 'not live-action realism'])(
    '图片和视频提示词写入拒绝受限人物表述：%s',
    async (phrase) => {
      for (const mediaType of ['image', 'video'] as const) {
        const context = contextFor(canvas([]));
        await expect(
          executeCanvasTool(
            'apply_canvas_operations',
            {
              revision: 0,
              operations: [
                {
                  type: 'create_node',
                  node: {
                    id: 'new',
                    type: mediaType,
                    position: { x: 0, y: 0 },
                    data: { label: '合成', mediaType, mode: 'generate', prompt: phrase },
                  },
                },
              ],
            },
            context,
          ),
        ).rejects.toMatchObject({
          code: 'restricted_person_style',
          message: expect.not.stringContaining(phrase),
        });
        expect(context.invoke).not.toHaveBeenCalled();
      }
    },
  );

  it('正向 CG 图片与视频草稿可保存，模型参数不成为额外写入门槛', async () => {
    const context = contextFor(canvas([]));
    await executeCanvasTool(
      'apply_canvas_operations',
      {
        revision: 0,
        operations: [
          { type: 'create_node', node: image },
          { type: 'create_node', node: video },
        ],
      },
      context,
    );
    expect(context.invoke).toHaveBeenCalledTimes(1);
    expect(context.invoke).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/canvas/operations'),
      expect.any(Object),
    );
  });

  it('更新视频的结构化或参数提示词也拒绝受限表述，旧节点读取仍可用', async () => {
    const context = contextFor(canvas([video]));
    await expect(
      executeCanvasTool(
        'apply_canvas_operations',
        {
          revision: 1,
          operations: [
            {
              type: 'update_node',
              nodeId: 'video',
              data: {
                promptDocument: { version: 1, blocks: [{ type: 'text', text: '仿真人角色' }] },
              },
            },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'restricted_person_style' });
    expect(context.invoke).toHaveBeenCalledTimes(1);
    expect(context.invoke).toHaveBeenCalledWith('GET', expect.stringContaining('/canvas'));

    await expect(
      executeCanvasTool(
        'apply_canvas_operations',
        {
          revision: 1,
          operations: [
            {
              type: 'update_node',
              nodeId: 'video',
              data: { parameters: { negativePrompt: '真人脸模' } },
            },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'restricted_person_style' });
    expect(
      ((await executeCanvasTool('get_canvas', {}, context)) as { canvas: CanvasDocument }).canvas,
    ).toEqual(canvas([video]));
  });

  it('图片没有显式提示词时，更新后成为回退提示词的标题也受拦截', async () => {
    const bareImage: CanvasDocument['nodes'][number] = {
      ...image,
      data: { label: '合成图片', mediaType: 'image', mode: 'generate' },
    };
    const context = contextFor(canvas([bareImage]));
    await expect(
      executeCanvasTool(
        'apply_canvas_operations',
        {
          revision: 1,
          operations: [{ type: 'update_node', nodeId: 'image', data: { label: '真人角色图' } }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'restricted_person_style' });
    expect(context.invoke).toHaveBeenCalledTimes(1);
  });

  it('纯文字视频运行拒绝，且不提交生成', async () => {
    const context = contextFor(canvas([video]));
    await expect(executeCanvasTool('run_node', run, context)).rejects.toMatchObject({
      code: 'image_reference_required',
    });
    expect(context.invoke).toHaveBeenCalledTimes(1);
  });

  it('固定版本图像引用和启用的上游图片节点均允许视频运行', async () => {
    const mentioned = {
      ...video,
      data: {
        ...video.data,
        promptDocument: {
          version: 1 as const,
          blocks: [
            { type: 'text' as const, text: '角色 ' },
            {
              type: 'mention' as const,
              mentionId: 'face',
              assetId: 'synthetic-image',
              assetVersion: 1,
              mediaType: 'image' as const,
              label: '角色图',
              inline: true as const,
            },
          ],
        },
      },
    };
    const edge = {
      id: 'image-to-video',
      sourceNodeId: 'image',
      targetNodeId: 'video',
      sourceHandle: 'output:image',
      targetHandle: 'input:referenceImage',
      order: 0,
    };
    const attached: CanvasDocument['nodes'][number] = {
      ...video,
      data: {
        ...video.data,
        resourceRefs: [
          {
            id: 'face',
            assetId: 'synthetic-image',
            assetVersion: 1,
            mediaType: 'image',
            name: '角色图',
            attached: true,
          },
        ],
      },
    };
    const fixedSource: CanvasDocument['nodes'][number] = {
      ...image,
      data: {
        label: '合成固定图片',
        mediaType: 'image',
        mode: 'source',
        assetId: 'synthetic-image',
        contentUrl: '/v1/assets/synthetic-image/versions/1/content',
      },
    };
    for (const document of [
      canvas([mentioned]),
      canvas([attached]),
      canvas([image, video], [edge]),
      canvas([fixedSource, video], [edge]),
    ]) {
      const context = contextFor(document);
      await executeCanvasTool('run_node', run, context);
      expect(context.invoke).toHaveBeenLastCalledWith(
        'POST',
        '/v1/nodes/video/runs',
        expect.any(Object),
      );
    }
    const disabled = contextFor(
      canvas([{ ...image, data: { ...image.data, enabled: false } }, video], [edge]),
    );
    await expect(executeCanvasTool('run_node', run, disabled)).rejects.toMatchObject({
      code: 'image_reference_required',
    });
  });

  it('生成图片参考本身可以运行，受限旧提示词则在运行时拦截', async () => {
    const context = contextFor(canvas([image]));
    await executeCanvasTool('run_node', { ...run, nodeId: 'image' }, context);
    expect(context.invoke).toHaveBeenLastCalledWith(
      'POST',
      '/v1/nodes/image/runs',
      expect.any(Object),
    );

    const restricted = contextFor(
      canvas(
        [{ ...video, data: { ...video.data, prompt: '真实人体' } }, image],
        [
          {
            id: 'image-to-video',
            sourceNodeId: 'image',
            targetNodeId: 'video',
            sourceHandle: 'output:image',
            targetHandle: 'input:referenceImage',
            order: 0,
          },
        ],
      ),
    );
    await expect(executeCanvasTool('run_node', run, restricted)).rejects.toMatchObject({
      code: 'restricted_person_style',
    });
    expect(restricted.invoke).toHaveBeenCalledTimes(1);

    const fallbackTitle = contextFor(
      canvas([
        {
          ...image,
          data: { label: '真人角色图', mediaType: 'image', mode: 'generate' },
        },
      ]),
    );
    await expect(
      executeCanvasTool('run_node', { ...run, nodeId: 'image' }, fallbackTitle),
    ).rejects.toMatchObject({ code: 'restricted_person_style' });
  });
});
