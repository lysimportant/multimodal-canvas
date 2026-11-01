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
    expect(byName.get('apply_canvas_operations')?.description).toContain('update_node');
    expect(byName.get('run_node')?.description).toContain('idempotencyKey');
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
    ]);
  });
});
