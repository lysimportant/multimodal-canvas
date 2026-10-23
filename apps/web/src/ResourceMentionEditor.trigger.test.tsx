import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, PromptDocument } from '@multimodal-canvas/domain';
import { ResourceMentionEditor } from './ResourceMentionEditor';
import { readInlinePrompt, selectInlinePrompt } from './InlinePromptInput';

const asset: Asset = {
  id: 'reference-image',
  name: '产品图',
  mediaType: 'image',
  mimeType: 'image/png',
  sizeBytes: 10,
  status: 'ready',
  tags: [],
  latestVersion: 2,
  contentUrl: '/v1/assets/reference-image/content',
};
afterEach(cleanup);

describe('手动 @ 查询会话与引用编号', () => {
  it.each([' ', '\n', '，', '。', '.', '！'])(
    '手动输入名称继续搜索，分隔符 %j 结束且继续文字不回弹',
    async (separator) => {
      const user = userEvent.setup();
      render(<ResourceMentionEditor nodeId="query" assets={[asset]} ariaLabel="提示词" />);
      const input = screen.getByRole('textbox', { name: '提示词' });
      await user.type(input, '@产品');
      expect(screen.getByRole('searchbox')).toHaveValue('产品');
      await user.keyboard(separator === '\n' ? '{Shift>}{Enter}{/Shift}' : separator);
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      await user.keyboard('继续正文');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    },
  );

  it('旧 @ 长中文、点击、光标移动和粘贴均不开启查询', async () => {
    const user = userEvent.setup();
    const value = '@' + '旧中文正文'.repeat(35);
    render(
      <ResourceMentionEditor nodeId="old" value={value} assets={[asset]} ariaLabel="提示词" />,
    );
    const input = screen.getByRole('textbox', { name: '提示词' });
    await user.click(input);
    await user.keyboard('{End}继续{ArrowLeft}{ArrowRight}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.paste('@产品');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.keyboard('图');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('移动或 Escape 终止会话，撤销重做不复活旧 @，重新手动输入才打开', async () => {
    const user = userEvent.setup();
    render(<ResourceMentionEditor nodeId="movement" assets={[asset]} ariaLabel="提示词" />);
    const input = screen.getByRole('textbox', { name: '提示词' });
    await user.type(input, '@产');
    await user.keyboard('{ArrowLeft}{ArrowRight}品');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.keyboard('@');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}品{Control>}z{/Control}{Control>}y{/Control}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.keyboard('@');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    selectInlinePrompt(input, 0);
    fireEvent.select(input);
    fireEvent.mouseUp(input);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('IME 查询提交前保留会话，确认后按中文搜索，切换节点不扫描旧文本', async () => {
    const user = userEvent.setup();
    const view = render(<ResourceMentionEditor nodeId="ime" assets={[asset]} ariaLabel="提示词" />);
    const input = screen.getByRole('textbox', { name: '提示词' });
    await user.type(input, '@');
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '@chan', selectionStart: 5, selectionEnd: 5 } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.compositionEnd(input, {
      data: '产品',
      target: { value: '@产品', selectionStart: 3, selectionEnd: 3 },
    });
    expect(screen.getByRole('searchbox')).toHaveValue('产品');
    view.rerender(
      <ResourceMentionEditor nodeId="other" value="@旧正文" assets={[asset]} ariaLabel="提示词" />,
    );
    await user.click(screen.getByRole('textbox', { name: '提示词' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('移动端原生输入 @ 无需 keydown，粘贴同字符仍不开启', () => {
    render(<ResourceMentionEditor nodeId="mobile-input" assets={[asset]} ariaLabel="提示词" />);
    const input = screen.getByRole('textbox', { name: '提示词' });
    fireEvent.input(input, {
      inputType: 'insertText',
      data: '@',
      target: { value: '@', selectionStart: 1, selectionEnd: 1 },
    });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.paste(input, { clipboardData: { getData: () => '@' } });
    fireEvent.input(input, {
      inputType: 'insertFromPaste',
      data: '@',
      target: { value: '@@', selectionStart: 2, selectionEnd: 2 },
    });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('重复引用编号仅作无障碍描述，资料条保留顺序且正文无可见编号', () => {
    const onDocumentChange = vi.fn();
    const promptDocument: PromptDocument = {
      version: 1,
      blocks: [1, 1, 2].map((version, i) => ({
        type: 'mention',
        inline: true,
        mentionId: `mention-${i}`,
        assetId: asset.id,
        assetVersion: version,
        mediaType: 'image',
        label: asset.name,
      })),
    };
    const referenceLabels = new Map([
      [JSON.stringify([asset.id, 1]), ['Image2', 'Image4']],
      [JSON.stringify([asset.id, 2]), ['Image1']],
    ]);
    render(
      <ResourceMentionEditor
        nodeId="labels"
        promptDocument={promptDocument}
        assets={[asset]}
        referenceLabels={referenceLabels}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const input = screen.getByRole('textbox', { name: '提示词' });
    expect(input.querySelectorAll('[aria-description="Image2 / Image4"]')).toHaveLength(2);
    expect(input.querySelector('[aria-description="Image1"]')).toBeInTheDocument();
    expect(input).not.toHaveTextContent(asset.name);
    expect(input.querySelector('.resource-mention-reference-label')).not.toBeInTheDocument();
    expect(screen.queryByText(/Image[124]/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getAllByRole('article')[0]).toHaveAccessibleDescription('Image2 / Image4');
    expect(
      within(screen.getAllByRole('article')[0]).getByLabelText('引用顺序 1'),
    ).toHaveTextContent('1');
    expect(
      within(screen.getAllByRole('article')[1]).getByLabelText('引用顺序 2'),
    ).toHaveTextContent('2');
    expect(readInlinePrompt(input)).toBe('\uFFFC\uFFFC\uFFFC');
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it('确认引用升级富文本后不回弹，富文本粘贴 @ 不搜索，新的手动输入仍可搜索', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="rich-query"
        assets={[asset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    await user.type(screen.getByRole('textbox', { name: '提示词' }), '@产品');
    await user.keyboard('{Enter}');
    const input = screen.getByRole('textbox', { name: '提示词' });
    expect(input).toHaveAttribute('contenteditable', 'true');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      expect.objectContaining({
        type: 'mention',
        assetId: asset.id,
        assetVersion: 2,
        inline: true,
      }),
    ]);
    selectInlinePrompt(input, 1);
    fireEvent.select(input);
    await user.paste('@产品');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.keyboard('图@');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
