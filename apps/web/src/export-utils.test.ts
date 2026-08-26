import { describe, expect, it, vi } from 'vitest';

import {
  buildProjectExportUrl,
  downloadProjectExport,
  fetchProjectExport,
  filenameFromContentDisposition,
  sanitizeDownloadFilename,
  type DownloadDocument,
} from './export-utils';

describe('project export helpers', () => {
  it('builds an encoded project export URL', () => {
    expect(buildProjectExportUrl('http://localhost:3000/', 'project/a', 'workflow')).toBe(
      'http://localhost:3000/v1/projects/project%2Fa/export/workflow',
    );
  });

  it('sanitizes path separators and control characters', () => {
    expect(sanitizeDownloadFilename('../report:final?.json', 'fallback.json')).toBe(
      '.. report final .json',
    );
    expect(sanitizeDownloadFilename('...', 'fallback.json')).toBe('fallback.json');
  });

  it('prefers RFC 5987 filenames and safely falls back', () => {
    expect(
      filenameFromContentDisposition(
        "attachment; filename=workflow.json; filename*=UTF-8''%E5%B7%A5%E4%BD%9C%E6%B5%81%E7%A8%8B.json",
        'fallback.json',
      ),
    ).toBe('工作流程.json');
    expect(filenameFromContentDisposition('attachment; filename="results.zip"', 'x.zip')).toBe(
      'results.zip',
    );
    expect(filenameFromContentDisposition('attachment; filename="../../x.zip"', 'x.zip')).toBe(
      '.. .. x.zip',
    );
  });

  it('fetches the requested export as a blob and preserves its attachment name', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(new Blob(['{}'], { type: 'application/json' }), {
          status: 200,
          headers: {
            'content-disposition': "attachment; filename*=UTF-8''demo.workflow.json",
          },
        }),
    );

    const result = await fetchProjectExport(
      'http://localhost:3000/',
      'project-1',
      'workflow',
      fetcher,
    );

    expect(result.filename).toBe('demo.workflow.json');
    expect(result.blob.size).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledWith(
      'http://localhost:3000/v1/projects/project-1/export/workflow',
      { cache: 'no-store', headers: { accept: 'application/json' } },
    );
  });

  it('surfaces JSON and plain-text export errors', async () => {
    const jsonError = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: '结果资产不可用' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      fetchProjectExport('http://localhost:3000', 'project-1', 'results', jsonError),
    ).rejects.toThrow('结果资产不可用');

    const textError = vi.fn<typeof fetch>(
      async () => new Response('gateway unavailable', { status: 502 }),
    );
    await expect(
      fetchProjectExport('http://localhost:3000', 'project-1', 'results', textError),
    ).rejects.toThrow('gateway unavailable');
  });

  it('creates, clicks, and revokes a temporary browser download link', () => {
    const click = vi.fn();
    const remove = vi.fn();
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      click,
      remove,
    };
    const appendChild = vi.fn();
    const fakeDocument = {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
      documentElement: { appendChild },
    } as unknown as DownloadDocument;
    const createObjectURL = vi.fn(() => 'blob:export');
    const revokeObjectURL = vi.fn();

    downloadProjectExport(
      { blob: new Blob(['content']), filename: '../result.zip' },
      {
        documentRef: fakeDocument,
        urlApi: { createObjectURL, revokeObjectURL },
        schedule: (callback) => callback(),
      },
    );

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor).toMatchObject({ href: 'blob:export', download: '.. result.zip' });
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export');
  });
});
