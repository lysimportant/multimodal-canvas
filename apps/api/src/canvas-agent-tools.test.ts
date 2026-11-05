import { describe, expect, it } from 'vitest';

import { canvasAgentTools } from './canvas-agent-tools';

describe('画布 MCP 工具契约', () => {
  it('编辑与运行工具的说明直接给出字段契约，避免 Agent 猜测', () => {
    const tools = canvasAgentTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.get('get_canvas')?.description).toContain('第一步必须调用');
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
    expect(byName.get('apply_canvas_operations')?.description).toContain('2.5D/3D 真实画质');
    expect(byName.get('apply_canvas_operations')?.description).toContain('禁止默认退回手绘平涂');
    expect(byName.get('apply_canvas_operations')?.description).toContain(
      '生成人物定妆图或人物参考图时',
    );
    expect(byName.get('apply_canvas_operations')?.description).toContain(
      '背景必须硬性统一为纯白纯色（#FFFFFF）',
    );
    expect(byName.get('run_node')?.description).toContain('禁止为验证');
    expect(byName.get('get_run')?.description).toContain('list_project_runs');
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
});
