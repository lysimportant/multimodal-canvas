import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptDocument } from '@multimodal-canvas/domain';
import { NodeQuickEditor, type NodeQuickEditorProps } from './NodeQuickEditor';
import type { VideoPromptReferenceContext } from './video-prompt-reference-labels';
import { readInlinePrompt, selectInlinePrompt } from '../InlinePromptInput';

function PreviewEditor({
  nodeId,
  value,
  promptDocument,
  videoReferenceContext,
  onDocumentChange,
  models = [],
  credentialId,
}: {
  nodeId: string;
  value: string;
  promptDocument?: PromptDocument;
  videoReferenceContext?: VideoPromptReferenceContext;
  onDocumentChange?: (document: PromptDocument) => void;
  ariaLabel?: string;
  models?: NodeQuickEditorProps['models'];
  credentialId?: string;
}) {
  return (
    <NodeQuickEditor
      node={{
        id: nodeId,
        type: videoReferenceContext ? 'video' : 'image',
        position: { x: 0, y: 0 },
        data: {
          label: '预览测试',
          mediaType: videoReferenceContext ? 'video' : 'image',
          mode: 'generate',
          prompt: value,
          promptDocument,
          modelAlias: videoReferenceContext?.modelAlias,
          videoMode: videoReferenceContext?.videoMode,
          credentialId,
        },
      }}
      models={models}
      busy={false}
      onPromptDocumentChange={onDocumentChange}
      onModelChange={vi.fn()}
      onInferenceStrengthChange={vi.fn()}
      onRun={vi.fn()}
    />
  );
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('禁止网络'))));
afterEach(() => {
  cleanup();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('视频真实提示词入口', () => {
  it.each([
    [
      'matched',
      'selected',
      {
        version: 1,
        adapter: 'seedance-video',
        tokenSyntax: 'numbered-media',
        maxImages: 30,
        maxVideos: 10,
        maxAudios: 10,
      },
      true,
    ],
    [
      'different credential',
      'other',
      {
        version: 1,
        adapter: 'seedance-video',
        tokenSyntax: 'numbered-media',
        maxImages: 30,
        maxVideos: 10,
        maxAudios: 10,
      },
      false,
    ],
    [
      'invalid contract',
      'selected',
      {
        version: 1,
        adapter: 'seedance-video',
        tokenSyntax: 'numbered-media',
        maxImages: 30,
        maxVideos: 10,
        maxAudios: 10,
        unrecognized: true,
      },
      false,
    ],
  ])('仅采用相同凭据的有效能力声明：%s', (_name, credentialId, videoReferences, accepted) => {
    render(
      <PreviewEditor
        nodeId="video"
        value=""
        credentialId="selected"
        videoReferenceContext={{
          modelAlias: 'arbitrary-channel-alias',
          videoMode: 'omni_reference',
        }}
        models={[
          {
            id: 'arbitrary-channel-alias',
            name: '渠道模型',
            mediaTypes: ['video'],
            credentialId,
            capabilities: { videoReferences },
          },
        ]}
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'hero',
              assetId: 'hero',
              assetVersion: 1,
              mediaType: 'image',
              label: 'hero',
              inline: true,
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '查看真实提示词' }));
    if (accepted) expect(screen.getByLabelText('真实提示词正文')).toHaveTextContent('Image 1');
    else {
      expect(screen.getByRole('alert')).toHaveTextContent('尚未确认素材编号映射');
      expect(screen.queryByLabelText('真实提示词正文')).not.toBeInTheDocument();
    }
  });

  it('读取未回写父层的最新输入，可通过键盘打开关闭且不提交', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <PreviewEditor
          nodeId="video"
          value=""
          ariaLabel="提示词"
          videoReferenceContext={{ modelAlias: 'wan3.0-video', videoMode: 'omni_reference' }}
          onDocumentChange={onDocumentChange}
          promptDocument={{
            version: 1,
            blocks: [
              {
                type: 'mention',
                mentionId: 'hero',
                assetId: 'hero',
                assetVersion: 1,
                mediaType: 'image',
                label: 'hero',
                inline: true,
              },
              { type: 'text', text: '走进房间' },
            ],
          }}
        />
      </ConfigProvider>,
    );
    const input = screen.getByRole('textbox', { name: '提示词' });
    input.focus();
    selectInlinePrompt(input, readInlinePrompt(input).length);
    await user.keyboard('。转身');
    const edits = onDocumentChange.mock.calls.length;
    const trigger = screen.getByRole('button', { name: '查看真实提示词' });
    expect(trigger.closest('.node-quick-editor-run-group')).not.toBeNull();
    trigger.focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: '真实提示词' });
    expect(within(dialog).getByLabelText('真实提示词正文')).toHaveTextContent('图1走进房间。转身');
    expect(onDocumentChange).toHaveBeenCalledTimes(edits);
    await user.click(within(dialog).getByRole('button', { name: '关闭真实提示词' }));
    expect(screen.queryByRole('dialog', { name: '真实提示词' })).not.toBeInTheDocument();
  });

  it('空输入显示空状态，其他类型的输入框不显示入口', () => {
    const { rerender } = render(
      <PreviewEditor nodeId="video" value="" videoReferenceContext={{}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '查看真实提示词' }));
    expect(screen.getByRole('status')).toHaveTextContent('输入框中暂无提示词');
    rerender(<PreviewEditor nodeId="image" value="图片提示词" />);
    expect(screen.queryByRole('button', { name: '查看真实提示词' })).not.toBeInTheDocument();
  });

  it('版本缺失时展示错误且不显示猜测的正文', () => {
    render(
      <PreviewEditor
        nodeId="video"
        value=""
        videoReferenceContext={{ modelAlias: 'wan3.0-video' }}
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'missing',
              assetId: 'missing',
              label: 'missing',
              mediaType: 'image',
              inline: true,
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '查看真实提示词' }));
    expect(screen.getByRole('alert')).toHaveTextContent('版本尚未确定');
    expect(screen.queryByLabelText('真实提示词正文')).not.toBeInTheDocument();
  });
});
