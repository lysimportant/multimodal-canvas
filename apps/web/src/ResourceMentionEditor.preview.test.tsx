import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@multimodal-canvas/domain';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as auth from './auth-client';
import { ResourceMentionEditor } from './ResourceMentionEditor';
import { clearImageThumbnailCache } from './workspace/image-thumbnail-cache';

/** 直接读取样式源文件，避免 Vitest 将 CSS 导入替换为空模块。 */
const hoverCss = readFileSync(resolve(process.cwd(), 'src/resource-mention-hover.css'), 'utf8');
const controlsCss = readFileSync(
  resolve(process.cwd(), 'src/resource-mention-controls.css'),
  'utf8',
);

/** 合成图片目录故意比正文冻结版本更新，避免预览误用最新版。 */
const imageAsset: Asset = {
  id: 'mention-preview-image',
  name: '参考图',
  mediaType: 'image',
  mimeType: 'image/png',
  sizeBytes: 1024,
  status: 'ready',
  contentUrl: '/v1/assets/mention-preview-image/content',
  latestVersion: 9,
  tags: [],
};
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
let previewStyles: HTMLStyleElement;

beforeEach(() => {
  clearImageThumbnailCache();
  auth.clearAuthSession();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:mention-preview-thumbnail'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(auth, 'apiFetch').mockImplementation(async (url) =>
    String(url).endsWith('/access-url')
      ? Response.json({
          url: '/v1/assets/mention-preview-image/versions/1/content?access_token=synthetic',
        })
      : new Response('synthetic thumbnail', { headers: { 'content-type': 'image/png' } }),
  );
  previewStyles = document.createElement('style');
  previewStyles.textContent = hoverCss + controlsCss;
  document.head.append(previewStyles);
});

afterEach(() => {
  cleanup();
  clearImageThumbnailCache();
  auth.clearAuthSession();
  previewStyles.remove();
  vi.restoreAllMocks();
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('资源引用的悬浮展示与版本缩略图', () => {
  it.each([
    { mediaType: 'image', mimeType: 'image/png', tag: 'img' },
    { mediaType: 'video', mimeType: 'video/mp4', tag: 'video' },
  ] as const)('$mediaType 悬浮媒体命中满框样式，行内引用仍保持小尺寸', async (media) => {
    render(
      <ResourceMentionEditor
        nodeId="hover-layout"
        assets={[{ ...imageAsset, ...media, contentUrl: 'https://media.example.test/reference' }]}
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'reference',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: media.mediaType,
              inline: true,
            },
          ],
        }}
      />,
    );
    const editor = screen.getByRole('textbox');
    const token = editor.querySelector('.resource-mention-token')!;
    const inline = token.closest('.resource-mention-inline')!;
    expect(controlsCss).toMatch(
      /\.resource-mention-inline\s*\{[\s\S]*?width:\s*34px;[\s\S]*?height:\s*30px;/,
    );
    expect(token.querySelector('.resource-mention-preview')).toBeInTheDocument();
    fireEvent.mouseMove(token);
    const hover = await screen.findByRole('region', { name: '预览 参考图' });
    const shell = hover.querySelector('.artifact-preview-media-shell')!;
    const element = hover.querySelector(media.tag)!;
    expect(shell).toHaveClass('resource-mention-hover-preview');
    expect(shell).not.toHaveClass('resource-mention-preview');
    expect(getComputedStyle(shell).width).toBe('100%');
    expect(getComputedStyle(shell).height).toBe('100%');
    expect(getComputedStyle(element).objectFit).toBe('contain');
    expect(getComputedStyle(element).width).toBe('100%');
    expect(getComputedStyle(element).height).toBe('100%');
    expect(editor.closest('.resource-mention-composer')).not.toContainElement(hover);
    expect(controlsCss).toMatch(
      /\.resource-mention-inline\s*\{[\s\S]*?width:\s*34px;[\s\S]*?height:\s*30px;/,
    );
  });

  it('正文、悬浮、资料条和节点选择器复用冻结版本缩略图，完整详情才申请原图', async () => {
    const user = userEvent.setup();
    auth.persistAuthSession({
      accessToken: 'synthetic-mention-preview',
      tokenType: 'Bearer',
      expiresIn: 3600,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      user: {
        id: 'mention-preview-user',
        email: 'mention-preview@example.test',
        role: 'user',
        createdAt: '2026-10-07',
      },
    });
    render(
      <ResourceMentionEditor
        nodeId="frozen-thumbnail"
        assets={[imageAsset]}
        promptDocument={{
          version: 1,
          blocks: [
            { type: 'text', text: '参考 ' },
            {
              type: 'mention',
              mentionId: 'frozen-reference',
              assetId: imageAsset.id,
              assetVersion: 1,
              label: imageAsset.name,
              mediaType: 'image',
              inline: true,
            },
          ],
        }}
      />,
    );
    const editor = screen.getByRole('textbox');
    await waitFor(() =>
      expect(editor.querySelector('img')).toHaveAttribute('src', 'blob:mention-preview-thumbnail'),
    );
    const card = screen.getByRole('article');
    expect(card.querySelector('img')).toHaveAttribute('src', 'blob:mention-preview-thumbnail');
    fireEvent.mouseMove(editor.querySelector('.resource-mention-token')!);
    const hover = await screen.findByRole('region', { name: '预览 参考图' });
    await waitFor(() =>
      expect(hover.querySelector('img')).toHaveAttribute('src', 'blob:mention-preview-thumbnail'),
    );
    await user.type(editor, ' @');
    const option = await screen.findByRole('option', { name: /参考图/ });
    await waitFor(() =>
      expect(option.querySelector('img')).toHaveAttribute('src', 'blob:mention-preview-thumbnail'),
    );
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    expect(auth.apiFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/assets/mention-preview-image/versions/1/derivatives/thumbnail',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '预览并命名 参考图' }));
    const dialog = await screen.findByRole('dialog', { name: '资源预览' });
    await waitFor(() =>
      expect(within(dialog).getByRole('img')).toHaveAttribute(
        'src',
        'http://localhost:3000/v1/assets/mention-preview-image/versions/1/content?access_token=synthetic',
      ),
    );
    expect(auth.apiFetch).toHaveBeenCalledTimes(2);
    expect(auth.apiFetch).toHaveBeenLastCalledWith(
      'http://localhost:3000/v1/assets/mention-preview-image/access-url',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ version: 1 }) }),
    );
  });

  it.each([
    {
      latestVersion: 7,
      metadata: { version: 3 },
      contentUrl: imageAsset.contentUrl,
      version: 7,
    },
    {
      latestVersion: undefined,
      metadata: { version: 3 },
      contentUrl: imageAsset.contentUrl,
      version: 3,
    },
    {
      latestVersion: 2,
      metadata: { version: 1 },
      contentUrl: '/v1/assets/mention-preview-image/versions/2/content',
      version: 2,
    },
  ])('项目选择器按索引版本 $version 读取缩略图，兼容旧 metadata.version', async (index) => {
    render(
      <ResourceMentionEditor nodeId="project-thumbnail" assets={[{ ...imageAsset, ...index }]} />,
    );
    await userEvent.type(screen.getByRole('textbox'), '@');
    const option = await screen.findByRole('option', { name: /参考图/ });
    await waitFor(() =>
      expect(option.querySelector('img')).toHaveAttribute('src', 'blob:mention-preview-thumbnail'),
    );
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    expect(auth.apiFetch).toHaveBeenCalledWith(
      `http://localhost:3000/v1/assets/mention-preview-image/versions/${index.version}/derivatives/thumbnail`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(imageAsset.contentUrl).toBe('/v1/assets/mention-preview-image/content');
  });

  it('项目选择器保留外部图片地址，不把目录版本拼接到第三方 URL', async () => {
    render(
      <ResourceMentionEditor
        nodeId="external-thumbnail"
        assets={[
          {
            ...imageAsset,
            contentUrl: 'https://assets.example.test/reference.png',
            latestVersion: 7,
          },
        ]}
      />,
    );
    await userEvent.type(screen.getByRole('textbox'), '@');
    const option = await screen.findByRole('option', { name: /参考图/ });
    expect(option.querySelector('img')).toHaveAttribute(
      'src',
      'https://assets.example.test/reference.png',
    );
    expect(auth.apiFetch).not.toHaveBeenCalled();
  });
});
