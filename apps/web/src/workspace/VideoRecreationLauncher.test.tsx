import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetFlowNode } from '../canvas-utils';
import { CanvasNodeToolbar } from './CanvasNodeToolbar';
import { VideoRecreationLauncher } from './VideoRecreationLauncher';

afterEach(cleanup);

/** 构造当前有视频回显的来源；覆盖字段用于验证候选边界，不访问资源接口。 */
function videoNode(id: string, data: Partial<AssetFlowNode['data']> = {}): AssetFlowNode {
  return {
    id,
    type: 'video',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      mediaType: 'video',
      mode: 'source',
      assetId: `asset-${id}`,
      contentUrl: `/v1/assets/asset-${id}/versions/2/content`,
      ...data,
    },
  };
}

/** 创建记录型回调，确保浏览和选择流程不会自行创建或上传。 */
function callbacks() {
  return { onCreate: vi.fn(), onClose: vi.fn(), onRequestUpload: vi.fn() };
}

describe('短视频复刻常驻入口', () => {
  it('显示纯图标且不改变四种媒体类型，点击不冒泡或创建普通节点', async () => {
    const onOpenVideoRecreation = vi.fn();
    const onAddGenerateNode = vi.fn();
    const parentClick = vi.fn();
    const parentPointerDown = vi.fn();
    render(
      <div onClick={parentClick} onPointerDown={parentPointerDown}>
        <CanvasNodeToolbar
          onOpenVideoRecreation={onOpenVideoRecreation}
          onAddGenerateNode={onAddGenerateNode}
        />
      </div>,
    );
    expect(
      within(screen.getByRole('group', { name: '创建节点' })).getAllByRole('button'),
    ).toHaveLength(4);
    const button = screen.getByRole('button', { name: '短视频复刻' });
    expect(button).toHaveTextContent(/^$/);
    expect(button).toHaveAccessibleName('短视频复刻');
    expect(button.querySelector('.lucide-clapperboard')).not.toBeNull();
    expect(onOpenVideoRecreation).not.toHaveBeenCalled();
    fireEvent.pointerDown(button);
    await userEvent.click(button);
    expect(onOpenVideoRecreation).toHaveBeenCalledOnce();
    expect(onAddGenerateNode).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
    expect(parentPointerDown).not.toHaveBeenCalled();
  });
});

describe('短视频复刻来源与流程', () => {
  it('打开即展示四步流程，只在明确点击后创建单个来源的草稿', async () => {
    const actions = callbacks();
    render(<VideoRecreationLauncher nodes={[videoNode('原视频')]} {...actions} />);
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: '短视频复刻 · 使用流程' })).toBeVisible(),
    );
    const guide = screen.getByRole('list', { name: '短视频复刻使用流程' });
    expect(within(guide).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByLabelText('参考视频节点')).toHaveValue('原视频');
    expect(actions.onCreate).not.toHaveBeenCalled();
    expect(actions.onRequestUpload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '创建复刻节点' }));
    expect(actions.onCreate).toHaveBeenCalledExactlyOnceWith('原视频');
    expect(actions.onClose).toHaveBeenCalledOnce();
  });

  it('多条视频未选中时要求用户选择，不默认复刻第一条', async () => {
    const actions = callbacks();
    render(<VideoRecreationLauncher nodes={[videoNode('A'), videoNode('B')]} {...actions} />);
    const create = screen.getByRole('button', { name: '创建复刻节点' });
    expect(create).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('参考视频节点'), 'B');
    expect(actions.onCreate).not.toHaveBeenCalled();
    await userEvent.click(create);
    expect(actions.onCreate).toHaveBeenCalledExactlyOnceWith('B');
  });

  it('优先选用当前已选中的可用视频', () => {
    render(
      <VideoRecreationLauncher
        nodes={[videoNode('A'), { ...videoNode('B'), selected: true }]}
        {...callbacks()}
      />,
    );
    expect(screen.getByLabelText('参考视频节点')).toHaveValue('B');
  });

  it('生成结果未暴露URL仍可使用真实结果身份，但不回退到被手动回显替换的旧结果', () => {
    render(
      <VideoRecreationLauncher
        nodes={[
          videoNode('生成结果', {
            mode: 'generate',
            assetId: undefined,
            contentUrl: undefined,
            resultAsset: { assetId: 'real-result', version: 3 },
          }),
          videoNode('无手动回显', {
            mode: 'generate',
            manualOutput: true,
            assetId: undefined,
            contentUrl: undefined,
            resultAsset: { assetId: 'old-result', version: 1 },
          }),
        ]}
        {...callbacks()}
      />,
    );
    expect(screen.getByLabelText('参考视频节点')).toHaveValue('生成结果');
    expect(screen.queryByRole('option', { name: '无手动回显' })).not.toBeInTheDocument();
  });

  it('排除其它媒体、无回显、运行中和本地忙碌来源，保留上传入口', async () => {
    const actions = callbacks();
    render(
      <VideoRecreationLauncher
        nodes={[
          videoNode('图片', { mediaType: 'image' }),
          videoNode('未生成', { contentUrl: undefined }),
          ...(['queued', 'preparing', 'running', 'processing', 'cancel_requested'] as const).map(
            (runStatus) => videoNode(runStatus, { runStatus }),
          ),
          videoNode('上传中'),
        ]}
        busyNodeIds={new Set(['上传中'])}
        {...actions}
      />,
    );
    expect(screen.getByLabelText('参考视频节点')).toBeDisabled();
    expect(screen.getByRole('button', { name: '创建复刻节点' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '上传原视频' }));
    expect(actions.onRequestUpload).toHaveBeenCalledOnce();
    expect(actions.onClose).toHaveBeenCalledOnce();
    expect(actions.onCreate).not.toHaveBeenCalled();
  });

  it.each(['删除', '本地忙碌', '运行中'])('选择后来源%s时禁用创建，不自动改为其它来源', (state) => {
    const actions = callbacks();
    const a = { ...videoNode('A'), selected: true };
    const b = videoNode('B');
    const view = render(<VideoRecreationLauncher nodes={[a, b]} {...actions} />);
    expect(screen.getByLabelText('参考视频节点')).toHaveValue('A');
    view.rerender(
      <VideoRecreationLauncher
        nodes={
          state === '删除'
            ? [b]
            : [state === '运行中' ? videoNode('A', { runStatus: 'running' }) : a, b]
        }
        busyNodeIds={state === '本地忙碌' ? new Set(['A']) : undefined}
        {...actions}
      />,
    );
    expect(screen.getByLabelText('参考视频节点')).toHaveValue('');
    expect(screen.getByRole('button', { name: '创建复刻节点' })).toBeDisabled();
    expect(actions.onCreate).not.toHaveBeenCalled();
  });

  it('关闭流程不创建节点或上传资源', async () => {
    const actions = callbacks();
    render(<VideoRecreationLauncher nodes={[]} {...actions} />);
    await userEvent.click(screen.getByRole('button', { name: '关闭短视频复刻流程' }));
    expect(actions.onClose).toHaveBeenCalledOnce();
    expect(actions.onCreate).not.toHaveBeenCalled();
    expect(actions.onRequestUpload).not.toHaveBeenCalled();
  });
});
