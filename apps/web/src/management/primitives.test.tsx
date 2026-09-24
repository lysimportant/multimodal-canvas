/** 管理薄适配使用真实 Ant Design，保留状态、焦点和分页契约。 */
import '@testing-library/jest-dom/vitest';
import { Button } from '@multimodal-canvas/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal, Notice, Pagination, QueryState } from './primitives';

afterEach(cleanup);

describe('管理业务薄适配', () => {
  it('加载、请求失败、空数据和已加载内容仍然互斥，并使用库组件', async () => {
    const retry = vi.fn();
    const view = render(
      <QueryState loading error={new Error('读取失败')} empty="暂无数据" onRetry={retry}>
        已加载内容
      </QueryState>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('正在加载');
    expect(view.container.querySelector('.ant-spin')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    view.rerender(
      <QueryState error={new Error('权限不足')} empty="暂无数据" onRetry={retry}>
        已加载内容
      </QueryState>,
    );
    expect(screen.getByRole('alert')).toHaveClass('ant-alert');
    expect(screen.getByRole('alert')).toHaveTextContent('权限不足');
    expect(screen.queryByText('暂无数据')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(retry).toHaveBeenCalledOnce();
    view.rerender(<QueryState empty="暂无数据">已加载内容</QueryState>);
    expect(view.container.querySelector('.ant-empty')).toHaveTextContent('暂无数据');
    expect(screen.queryByText('已加载内容')).toBeNull();
    view.rerender(<QueryState>已加载内容</QueryState>);
    expect(screen.getByText('已加载内容')).toBeVisible();
  });

  it('成功反馈用 status，错误反馈用 alert，未知错误正文不丢失', () => {
    const view = render(<Notice value={{ kind: 'success', text: '已保存' }} />);
    expect(screen.getByRole('status')).toHaveClass('ant-alert');
    expect(screen.queryByRole('alert')).toBeNull();
    view.rerender(<Notice value={{ kind: 'error', text: '写入权限已收回' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('写入权限已收回');
    view.rerender(<Notice value={null} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it('库分页仍按固定页大小翻页，边界与请求期间不能继续翻页', () => {
    const change = vi.fn();
    const view = render(<Pagination page={1} pageSize={20} total={45} onChange={change} />);
    const navigation = screen.getByRole('navigation', { name: '结果分页' });
    expect(view.container.querySelector('.ant-pagination')).not.toBeNull();
    expect(within(navigation).getByText('共 45 项')).toBeVisible();
    expect(within(navigation).queryByRole('combobox')).toBeNull();
    fireEvent.click(within(navigation).getByTitle('上一页'));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(within(navigation).getByTitle('下一页'));
    expect(change).toHaveBeenCalledWith(2, 20);
    change.mockClear();
    view.rerender(<Pagination page={3} pageSize={20} total={45} onChange={change} />);
    fireEvent.click(within(navigation).getByTitle('下一页'));
    expect(change).not.toHaveBeenCalled();
    view.rerender(<Pagination page={2} pageSize={20} total={45} onChange={change} busy />);
    fireEvent.click(within(navigation).getByTitle('上一页'));
    fireEvent.click(within(navigation).getByTitle('下一页'));
    expect(change).not.toHaveBeenCalled();
  });

  it('真实 Modal 关闭后释放弹层并将焦点还给触发按钮', async () => {
    /** 保持生产中的条件挂载方式，关闭动画结束后卸载。 */
    function DialogExample() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button type="button" onClick={() => setOpen(true)}>
            打开测试详情
          </Button>
          {open && (
            <Modal title="测试详情" onClose={() => setOpen(false)}>
              业务内容
            </Modal>
          )}
        </>
      );
    }
    render(<DialogExample />);
    const trigger = screen.getByRole('button', { name: '打开测试详情' });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '测试详情' });
    expect(dialog.tagName).not.toBe('DIALOG');
    expect(dialog).toHaveClass('ant-modal');
    await waitFor(() => expect(within(dialog).getByText('业务内容')).toBeVisible());
    await userEvent.click(within(dialog).getByRole('button', { name: '关闭弹窗' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
