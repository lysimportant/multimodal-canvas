import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderPromptDocument,
  type Asset,
  type CanvasDocument,
  type PromptDocument,
  type PromptMention,
  type RunRecord,
} from '@multimodal-canvas/domain';

import type { WorkflowCanvasProps } from './workspace/WorkflowCanvas';
import { collectConnectedPromptAssets } from './workspace/connected-prompt-assets';
import { TextPromptEditor } from './TextPromptEditor';

/** 只替换画布布局，保留 App 状态、连线回调和真实提示词编辑器。 */
const view = vi.hoisted(() => ({ canvas: null as WorkflowCanvasProps | null }));
vi.mock('./workspace/WorkflowCanvas', () => ({
  WorkflowCanvas: (props: WorkflowCanvasProps) => {
    view.canvas = props;
    const target = props.nodes.find((node) => node.id === 'video-target');
    return target ? (
      <TextPromptEditor
        nodeId={target.id}
        value={target.data.prompt ?? ''}
        promptDocument={target.data.promptDocument}
        assets={props.assets}
        connectedAssets={collectConnectedPromptAssets(
          target.id,
          props.nodes,
          props.edges,
          props.assets,
        )}
        onConnectedResourceRename={(assetId, name) =>
          props.onConnectedResourceRename?.(assetId, name, target.id)
        }
        onDocumentChange={(document) => props.onPromptDocumentChange?.(document, target.id)}
        ariaLabel="提示词"
      />
    ) : null;
  },
}));
vi.mock('./workspace/ResourcePanel', () => ({ ResourcePanel: () => null }));

import { App } from './App';
import * as auth from './auth-client';
import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from './state/workspace-preferences';

/** 合成资源目录的最新版本故意高于节点回显，防止别名同步改用最新内容。 */
const image: Asset = {
  id: 'image-six',
  name: '图片生成节点 6',
  mediaType: 'image',
  mimeType: 'image/png',
  sizeBytes: 10,
  status: 'ready',
  tags: [],
  latestVersion: 9,
  contentUrl: '/v1/assets/image-six/versions/9/content',
};
/** 现有引用携带自定义绑定，用于验证改名不会重建其他提及。 */
const mansui: PromptMention = {
  type: 'mention',
  mentionId: 'mention-mansui',
  assetId: 'image-mansui',
  label: '角色图',
  entityName: '满穗',
  mediaType: 'image',
  assetVersion: 4,
  binding: { entityName: '满穗', scope: 'scene', note: '保留用户设定' },
};
/** 未连线的已有引用也必须原样保留。 */
const jar: PromptMention = {
  type: 'mention',
  mentionId: 'mention-jar',
  assetId: 'image-jar',
  label: '道具图',
  entityName: '陶缸',
  mediaType: 'image',
  assetVersion: 1,
};
/** 测试项目只存在于内存中。 */
const project = {
  id: 'mention-sync-project',
  name: '引用测试',
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
};
/** 不含凭据的合成会话。 */
const session: auth.StoredAuthSession = {
  user: { id: 'mention-sync-user', role: 'admin', createdAt: project.createdAt },
  expiresAt: '2099-01-01T00:00:00.000Z',
};
/** 每项测试独立维护的模拟画布及请求记录。 */
let canvas: CanvasDocument;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
/** 未声明请求必须导致测试失败，即使界面捕获了请求异常。 */
let unexpectedRequests: string[];
/** 来源运行只从合成只读快照恢复，不通过节点编辑注入，便于检查打开时零保存。 */
let archivedRuns: RunRecord[];
/** 仅提交投影用例允许一次合成 400，不创建运行或访问真实 Provider。 */
let allowRejectedSubmission: boolean;

/** 构造两张上游图片；节点 6 的标题始终不改名。 */
function initialCanvas(): CanvasDocument {
  return {
    revision: 1,
    nodes: [
      {
        id: 'image-node-six',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          label: image.name,
          mediaType: 'image',
          mode: 'generate',
        },
      },
      {
        id: 'image-node-mansui',
        type: 'image',
        position: { x: 0, y: 200 },
        data: {
          label: '满穗图片',
          mediaType: 'image',
          mode: 'generate',
        },
      },
      {
        id: 'video-target',
        type: 'video',
        position: { x: 400, y: 0 },
        data: {
          label: '视频生成节点',
          mediaType: 'video',
          mode: 'generate',
          videoMode: 'omni_reference',
          promptDocument: {
            version: 1,
            blocks: [
              { type: 'text', text: '良看向' },
              mansui,
              { type: 'text', text: '，把' },
              jar,
              { type: 'text', text: '递给良。备注：图片生成节点 6。' },
            ],
          },
          resourceRefs: [
            {
              id: 'retained-ref',
              assetId: jar.assetId,
              mediaType: 'image',
              name: '陶缸',
              assetVersion: 1,
            },
          ],
        },
      },
    ],
    edges: [
      {
        id: 'mansui-input',
        sourceNodeId: 'image-node-mansui',
        targetNodeId: 'video-target',
        sourceHandle: 'output:image',
        targetHandle: 'input:referenceImage',
        order: 0,
      },
    ],
  };
}

/** 复现旧别名无版本、正文全是 text 的保存状态；两张图片来源都由成功运行恢复。 */
function restoreLegacyCanvas(): void {
  const target = canvas.nodes[2];
  target.data.videoMode = 'first_last_frame';
  target.data.promptDocument = {
    version: 1,
    blocks: [{ type: 'text', text: '良站在窗前，良转身' }],
  };
  target.data.resourceRefs!.push({
    id: `connected:${image.id}`,
    assetId: image.id,
    mediaType: 'image',
    name: '良',
  });
  canvas.edges = canvas.nodes.slice(0, 2).map((node, index) => ({
    id: `input-${node.id}`,
    sourceNodeId: node.id,
    targetNodeId: target.id,
    sourceHandle: 'output:image',
    targetHandle: index === 0 ? 'input:firstFrame' : 'input:lastFrame',
    order: 0,
  }));
  archivedRuns = canvas.nodes.slice(0, 2).map((node, index) => ({
    id: `restored-${node.id}`,
    projectId: project.id,
    targetNodeId: node.id,
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    provider: 'mock',
    modelAlias: 'synthetic-image',
    snapshot: {
      projectId: project.id,
      canvasRevision: canvas.revision,
      targetNodeId: node.id,
      modelAlias: 'synthetic-image',
      parameters: {},
      submittedAt: project.createdAt,
      nodes: [node],
      edges: [],
      inputs: [],
    },
    result: {
      provider: 'mock',
      summary: '合成成功结果',
      targetNodeId: node.id,
      mediaType: 'image',
      inputCount: 0,
      simulated: true,
      asset: { assetId: index === 0 ? image.id : mansui.assetId, version: index === 0 ? 1 : 4 },
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }));
}

/** 等待来源回显及投影完成，不触发画布编辑或显式保存。 */
async function openLegacyEditor() {
  const app = render(<App />);
  await screen.findByRole('textbox', { name: '提示词' });
  await waitFor(() => {
    expect(view.canvas?.nodes[0].data.resultAsset?.version).toBe(1);
    expect(document.querySelectorAll('.resource-mention-token')).toHaveLength(2);
  });
  return app;
}

/** 只允许内存查询、预览授权和模拟画布保存；生成、资产写入及未声明请求全部拒绝。 */
function installApi() {
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    ).pathname;
    const method = init?.method ?? 'GET';
    if (path === '/v1/auth/me' && method === 'GET') return Response.json(session);
    if (path === '/v1/models') return Response.json({ models: [] });
    if (path === '/v1/settings/ai') return Response.json({ settings: { defaultModels: {} } });
    if (path.endsWith('/models/defaults')) return Response.json({ defaults: {} });
    if (path === '/v1/prompt-skills') return Response.json({ skills: [] });
    if (path === '/v1/assets' && method === 'GET') return Response.json({ assets: [image] });
    if (
      [image.id, mansui.assetId].some((id) => path === '/v1/assets/' + id + '/access-url') &&
      method === 'POST'
    ) {
      const { version } = JSON.parse(String(init?.body));
      return Response.json({
        url: `${path.slice(0, -'/access-url'.length)}/versions/${version}/content`,
      });
    }
    if (path === '/v1/projects' && method === 'GET') return Response.json({ projects: [project] });
    if (path === '/v1/projects/' + project.id) return Response.json({ project });
    if (path.endsWith('/canvas') && method === 'GET') return Response.json({ canvas });
    if (path.endsWith('/canvas') && method === 'PATCH') {
      canvas = { ...JSON.parse(String(init?.body)), revision: canvas.revision + 1 };
      return Response.json({ canvas });
    }
    if (path.endsWith('/runs') && method === 'GET') return Response.json({ runs: archivedRuns });
    if (path === '/v1/nodes/video-target/runs' && method === 'POST' && allowRejectedSubmission) {
      return Response.json({ error: '合成拒绝，不创建任务' }, { status: 400 });
    }
    unexpectedRequests.push(method + ' ' + path);
    throw new Error('禁止测试请求：' + method + ' ' + path);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/projects/' + project.id);
  window.localStorage.clear();
  auth.clearAuthSession();
  auth.persistAuthSession(session);
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
  vi.spyOn(auth, 'fetchCurrentSession').mockResolvedValue(session);
  vi.spyOn(auth, 'openAuthEventStream').mockResolvedValue(undefined);
  canvas = initialCanvas();
  unexpectedRequests = [];
  archivedRuns = [];
  allowRejectedSubmission = false;
  view.canvas = null;
  installApi();
});
afterEach(() => {
  cleanup();
  auth.clearAuthSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
  expect(unexpectedRequests).toEqual([]);
});

describe('连线资源别名同步到提示词', () => {
  it('打开旧别名仅投影不保存，直接编辑即保存固定 v1，保留首尾帧模式和两条连线', async () => {
    restoreLegacyCanvas();
    const before = structuredClone(canvas);
    await openLegacyEditor();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(canvas).toEqual(before);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toEqual([]);
    const persisted = view.canvas!.nodes.find((node) => node.id === 'video-target')!;
    expect(persisted.data.promptDocument).toEqual(before.nodes[2].data.promptDocument);
    expect(persisted.data.resourceRefs).toEqual(before.nodes[2].data.resourceRefs);
    const edges = structuredClone(view.canvas!.edges);
    fireEvent.change(screen.getByRole('textbox', { name: '提示词' }), {
      target: { value: '良站在窗前，良转身。' },
    });
    const edited = view.canvas!.nodes.find((node) => node.id === 'video-target')!;
    expect(edited.data.videoMode).toBe('first_last_frame');
    expect(view.canvas!.edges).toEqual(edges);
    expect(edited.data.promptDocument!.blocks.filter((block) => block.type === 'mention')).toEqual([
      expect.objectContaining({ entityName: '良', assetId: image.id, assetVersion: 1 }),
      expect.objectContaining({ entityName: '良', assetId: image.id, assetVersion: 1 }),
    ]);
    expect(edited.data.resourceRefs).toEqual([
      before.nodes[2].data.resourceRefs![0],
      { ...before.nodes[2].data.resourceRefs![1], assetVersion: 1 },
    ]);
    await waitFor(() =>
      expect(canvas.nodes[2].data.promptDocument).toEqual(edited.data.promptDocument),
    );
    expect(canvas.nodes[2].data.resourceRefs).toEqual(edited.data.resourceRefs);
  });

  it.each(['unlink', 'plain'] as const)(
    '明确%s后保存冻结引用，刷新不复活旧别名',
    async (action) => {
      restoreLegacyCanvas();
      const app = await openLegacyEditor();
      const text = '良站在窗前，良转身';
      const edges = structuredClone(view.canvas!.edges);
      if (action === 'unlink') fireEvent.click(screen.getByRole('button', { name: '删除 良' }));
      else
        act(() =>
          view.canvas!.onPromptDocumentChange!(
            { version: 1, blocks: [{ type: 'text', text }] },
            'video-target',
          ),
        );
      expect(document.querySelectorAll('.resource-mention-token')).toHaveLength(0);
      await waitFor(() =>
        expect(canvas.nodes[2].data.resourceRefs).toContainEqual({
          id: `connected:${image.id}`,
          assetId: image.id,
          mediaType: 'image',
          name: '良',
          assetVersion: 1,
        }),
      );
      expect(canvas.nodes[2].data.promptDocument!.blocks).toEqual([{ type: 'text', text }]);
      expect(view.canvas!.edges).toEqual(edges);
      app.unmount();
      view.canvas = null;
      render(<App />);
      await screen.findByRole('textbox', { name: '提示词' });
      await waitFor(() => expect(view.canvas?.nodes[0].data.resultAsset?.version).toBe(1));
      expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue(text);
      expect(document.querySelectorAll('.resource-mention-token')).toHaveLength(0);
      expect(view.canvas!.edges).toEqual(edges);
    },
  );

  it('不编辑不改名直接提交采用投影 v1，合成 400 不保存项目或重发', async () => {
    restoreLegacyCanvas();
    const before = structuredClone(canvas);
    allowRejectedSubmission = true;
    await openLegacyEditor();
    act(() =>
      view.canvas!.onRunNode(
        view.canvas!.nodes.find((node) => node.id === 'video-target')!,
        'sameNode',
      ),
    );
    await screen.findByText('合成拒绝，不创建任务');
    const posts = fetchMock.mock.calls.filter(
      ([input, init]) => String(input).endsWith('/video-target/runs') && init?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0][1]?.body)) as { promptDocument: PromptDocument };
    expect(renderPromptDocument(body.promptDocument)).toBe('良站在窗前，良转身');
    expect(body.promptDocument.blocks.filter((block) => block.type === 'mention')).toEqual([
      expect.objectContaining({ entityName: '良', assetId: image.id, assetVersion: 1 }),
      expect.objectContaining({ entityName: '良', assetId: image.id, assetVersion: 1 }),
    ]);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toEqual([]);
    expect(canvas).toEqual(before);
    expect(view.canvas!.nodes[2].data.promptDocument).toEqual(before.nodes[2].data.promptDocument);
  });

  it.each([false, true])(
    '保存良立即绑定既有正文并保留其它引用、冻结版本和两条连线（已保存别名：%s）',
    async (alreadyNamed) => {
      const target = canvas.nodes[2];
      if (alreadyNamed)
        target.data.resourceRefs!.push({
          id: 'connected:' + image.id,
          assetId: image.id,
          mediaType: 'image',
          name: '良',
          assetVersion: 2,
        });
      const originalDocument = structuredClone(target.data.promptDocument!);
      const originalRefs = structuredClone(target.data.resourceRefs);
      const originalText = renderPromptDocument(originalDocument);
      const app = render(<App />);
      await screen.findByRole('textbox', { name: '提示词' });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '打开项目集合' })).toBeEnabled(),
      );
      act(() =>
        view.canvas!.onNodesChange(
          view
            .canvas!.nodes.filter((node) => node.type === 'image')
            .map((node) => ({
              type: 'replace' as const,
              id: node.id,
              item: {
                ...node,
                data: {
                  ...node.data,
                  resultAsset:
                    node.id === 'image-node-six'
                      ? {
                          assetId: image.id,
                          version: 2,
                          contentUrl: '/v1/assets/image-six/versions/2/content',
                          mimeType: 'image/png',
                        }
                      : { assetId: mansui.assetId, version: 4 },
                },
              },
            })),
        ),
      );
      const originalSource = structuredClone(view.canvas!.nodes[0].data);
      act(() =>
        view.canvas!.onConnect({
          source: 'image-node-six',
          target: target.id,
          sourceHandle: 'output:image',
          targetHandle: 'input:referenceImage',
        }),
      );
      expect(view.canvas!.edges).toHaveLength(2);
      const edges = structuredClone(view.canvas!.edges);
      fireEvent.click(
        screen.getByRole('button', { name: '预览并命名 ' + (alreadyNamed ? '良' : image.name) }),
      );
      const dialog = screen.getByRole('dialog', { name: '资源预览' });
      fireEvent.change(within(dialog).getByRole('textbox', { name: '资源名称' }), {
        target: { value: '良' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: '保存名称' }));

      const renamed = view.canvas!.nodes.find((node) => node.id === target.id)!;
      const document = renamed.data.promptDocument!;
      const mentions = document.blocks.filter(
        (block): block is PromptMention => block.type === 'mention' && block.assetId === image.id,
      );
      expect(mentions).toHaveLength(2);
      expect(mentions).toEqual([
        expect.objectContaining({ entityName: '良', assetVersion: 2 }),
        expect.objectContaining({ entityName: '良', assetVersion: 2 }),
      ]);
      expect(new Set(mentions.map((mention) => mention.mentionId)).size).toBe(2);
      expect(document.blocks).toContainEqual(mansui);
      expect(document.blocks).toContainEqual(jar);
      expect(renderPromptDocument(document)).toBe(originalText);
      expect(renamed.data.prompt).toBe(originalText);
      expect(renamed.data.videoMode).toBe('omni_reference');
      expect(renamed.data.resourceRefs).toContainEqual({
        id: 'connected:' + image.id,
        assetId: image.id,
        mediaType: 'image',
        name: '良',
        assetVersion: 2,
      });
      expect(view.canvas!.nodes[0].data).toEqual(originalSource);
      expect(view.canvas!.edges).toEqual(edges);
      expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue(originalText);
      expect(
        [...globalThis.document.querySelectorAll('.resource-mention-token')].map(
          (token) => token.textContent,
        ),
      ).toEqual(['良', '满穗', '陶缸', '良']);
      await waitFor(() =>
        expect(canvas.nodes.find((node) => node.id === target.id)?.data.promptDocument).toEqual(
          document,
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: '预览并命名 良' }));
      const previews = fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith('/' + image.id + '/access-url'),
      );
      expect(previews.length).toBeGreaterThan(0);
      expect(previews.map(([, init]) => JSON.parse(String(init?.body)))).toEqual(
        previews.map(() => ({ version: 2 })),
      );
      fireEvent.click(
        within(screen.getByRole('dialog', { name: '资源预览' })).getByRole('button', {
          name: '关闭',
        }),
      );
      expect(
        fetchMock.mock.calls.filter(
          ([input, init]) => init?.method === 'POST' && !String(input).endsWith('/access-url'),
        ),
      ).toEqual([]);
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => String(input).includes('/v1/assets/') && init?.method === 'PATCH',
        ),
      ).toBe(false);

      act(() => view.canvas!.onUndoCanvas?.());
      const undone = view.canvas!.nodes.find((node) => node.id === target.id)!;
      expect(undone.data.promptDocument).toEqual(originalDocument);
      expect(undone.data.resourceRefs).toEqual(originalRefs);
      expect(view.canvas!.edges).toEqual(edges);
      act(() => view.canvas!.onRedoCanvas?.());
      expect(view.canvas!.nodes.find((node) => node.id === target.id)?.data.promptDocument).toEqual(
        document,
      );
      await waitFor(() =>
        expect(canvas.nodes.find((node) => node.id === target.id)?.data.promptDocument).toEqual(
          document,
        ),
      );
      app.unmount();
      view.canvas = null;
      render(<App />);
      await screen.findByRole('textbox', { name: '提示词' });
      expect(view.canvas!.nodes.find((node) => node.id === target.id)?.data.promptDocument).toEqual(
        document,
      );
      expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue(originalText);
      expect(
        [...globalThis.document.querySelectorAll('.resource-mention-token')].map(
          (token) => token.textContent,
        ),
      ).toEqual(['良', '满穗', '陶缸', '良']);
    },
  );
});
