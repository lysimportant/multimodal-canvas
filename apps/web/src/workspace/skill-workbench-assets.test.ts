import '@testing-library/jest-dom/vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadSkillWorkbenchAsset } from './skill-workbench-assets';

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];
  status = 204;
  withCredentials = false;
  body: ArrayBuffer | undefined;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  open = vi.fn();
  setRequestHeader = vi.fn();

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }

  send(body: ArrayBuffer) {
    this.body = body;
    this.onload?.();
  }
}

describe('Skill 工作台资源上传', () => {
  afterEach(() => {
    FakeXMLHttpRequest.instances = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('按初始化、对象传输、完成确认顺序上传文件并返回资源摘要', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          uploadId: 'upload-skill-context',
          uploadUrl: '/v1/assets/uploads/upload-skill-context',
          completeUrl: '/v1/assets/uploads/complete',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          asset: {
            id: 'asset-skill-context',
            name: '人物设定.md',
            mediaType: 'text',
            mimeType: 'text/markdown',
            sizeBytes: 6,
            latestVersion: 1,
            status: 'ready',
            contentUrl: '/v1/assets/asset-skill-context/content',
            tags: [],
          },
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);

    const file = new File(['设定'], '人物设定.md', { type: 'text/markdown' });
    const asset = await uploadSkillWorkbenchAsset(file);

    expect(asset).toMatchObject({ id: 'asset-skill-context', mediaType: 'text' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      name: '人物设定.md',
      mimeType: 'text/markdown',
      sizeBytes: 6,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(FakeXMLHttpRequest.instances[0]?.open).toHaveBeenCalledWith(
      'PUT',
      'http://localhost:3000/v1/assets/uploads/upload-skill-context',
    );
    expect(FakeXMLHttpRequest.instances[0]?.body?.byteLength).toBe(6);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      uploadId: 'upload-skill-context',
      name: '人物设定.md',
      sizeBytes: 6,
    });
  });

  it('空文件在初始化前拒绝，不发送任何写请求', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await expect(
      uploadSkillWorkbenchAsset(new File([], 'empty.txt', { type: 'text/plain' })),
    ).rejects.toThrow('不能为空');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
