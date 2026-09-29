/** 桌面连线回归只驱动隔离项目的真实 UI；不修改生产代码或调用真实生成接口。 */
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  promptDocumentSchema,
  renderPromptDocument,
  type CanvasDocument,
  type PromptDocument,
} from '@multimodal-canvas/domain';
import {
  connectedIds,
  connectedLabels,
  connectedPrompt,
  test,
  type ConnectedScenario,
} from './connected-node-regression.fixture';

/** PC 验收覆盖常见笔记本与全高清桌面，不扩展到移动布局。 */
const desktopViewports = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
/** 四侧连接点的屏幕位置保持不变；职责由视频模式决定。 */
const sideCenters = { top: [0.5, 0], right: [1, 0.5], bottom: [0.5, 1], left: [0, 0.5] } as const;

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 45_000, retries: 0 });

/** 从持久画布读取唯一目标；找不到时明确失败，不补造节点。 */
function targetData(canvas: CanvasDocument) {
  const target = canvas.nodes.find((node) => node.id === connectedIds.target);
  if (!target) throw new Error('合成视频目标节点丢失');
  return target.data;
}

/** 验证两次独立 mention 固定到历史 v2，而非目录 v9/v10，且普通正文不变。 */
function expectFrozenMentions(document: PromptDocument | undefined, prompt = connectedPrompt) {
  expect(document, '必须保存真实结构化文档，不能只给纯文本着色').toBeDefined();
  const parsed = promptDocumentSchema.parse(document);
  const mentions = parsed.blocks.filter((block) => block.type === 'mention');
  expect(mentions, '两处良都必须成为 mention').toHaveLength(2);
  for (const mention of mentions) {
    expect(mention).toMatchObject({
      type: 'mention',
      assetId: connectedIds.asset,
      assetVersion: 2,
      mediaType: 'image',
      entityName: '良',
      label: 'generated',
    });
    expect(mention.mentionId).not.toBe('');
  }
  expect(new Set(mentions.map((mention) => mention.mentionId)).size).toBe(2);
  expect(renderPromptDocument(parsed)).toBe(prompt);
  return parsed;
}

/** 同时检查资源卡别名与结构化正文的持久身份，不能只验证 UI 上出现“良”。 */
function expectFrozenTarget(canvas: CanvasDocument, prompt = connectedPrompt) {
  const data = targetData(canvas);
  const document = expectFrozenMentions(data.promptDocument, prompt);
  expect(data.prompt).toBe(prompt);
  expect(data.resourceRefs).toEqual([
    {
      id: `connected:${connectedIds.asset}`,
      assetId: connectedIds.asset,
      mediaType: 'image',
      name: '良',
      assetVersion: 2,
    },
  ]);
  expect(data.modelAlias).toBe('minimax-h3');
  expect(data.videoMode).toBe('omni_reference');
  return document;
}

/** 保存与交互不能重命名来源、写入临时回显，或悄悄改变节点/连线身份。 */
function expectSourcePreserved(scenario: ConnectedScenario) {
  const canvas = scenario.canvas();
  expect(canvas.nodes.map((node) => node.id)).toEqual(
    scenario.initial.nodes.map((node) => node.id),
  );
  expect(canvas.nodes.find((node) => node.id === connectedIds.source)).toEqual(
    scenario.initial.nodes[0],
  );
  expect(canvas.nodes[0]!.data).not.toHaveProperty('assetId');
  expect(canvas.nodes[0]!.data).not.toHaveProperty('contentUrl');
  expect(canvas.nodes[0]!.data).not.toHaveProperty('resultAsset');
  expect(canvas.edges).toEqual(scenario.initial.edges);
}

/** 截图在成功和失败时都留存于当前 testInfo 的独立目录。 */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

/** 等待真实历史恢复与图片解码，不向 React 状态或 DOM 注入结果。 */
async function waitForConnectedCanvas(page: Page, scenario: ConnectedScenario) {
  const source = page.locator(`.react-flow__node[data-id="${connectedIds.source}"]`);
  const target = page.locator(`.react-flow__node[data-id="${connectedIds.target}"]`);
  await expect(source).toBeVisible({ timeout: 30_000 });
  await expect(target).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect
    .poll(() =>
      scenario.requests.some(
        (request) =>
          request.method === 'GET' && request.path === `/v1/projects/${connectedIds.project}/runs`,
      ),
    )
    .toBe(true);
  const preview = source.locator('img').first();
  await expect(preview).toHaveAttribute(
    'src',
    new RegExp(`/v1/assets/${connectedIds.asset}/versions/2/content`),
  );
  await expect
    .poll(() =>
      preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page
        .locator('.react-flow__viewport')
        .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
    )
    .toBeCloseTo(1.1, 3);
  await expect(source).toBeInViewport();
  await expect(target).toBeInViewport();
  expectSourcePreserved(scenario);
  return { source, target };
}

/** 有效 Cookie auth/me Mock 在导航前安装；只打开本规格独占项目。 */
async function openProject(page: Page, scenario: ConnectedScenario) {
  await page.goto(`/projects/${connectedIds.project}`);
  return waitForConnectedCanvas(page, scenario);
}

/** 点击视频卡片打开实际快捷编辑器，不调用内部状态更新函数。 */
async function openTargetEditor(page: Page) {
  const editor = page.getByRole('region', {
    name: `${connectedLabels.target}生成设置`,
    exact: true,
  });
  if (!(await editor.isVisible()))
    await page
      .locator(`.react-flow__node[data-id="${connectedIds.target}"]`)
      .click({ position: { x: 140, y: 75 } });
  await expect(editor).toBeVisible();
  return editor;
}

/** 检查资源授权确实返回 v2 的本地图片 bytes，不以目录缩略图替代冻结预览。 */
async function expectPreviewVersion(page: Page) {
  const dialog = page.getByRole('dialog', { name: '资源预览', exact: true });
  await expect(dialog).toBeVisible();
  const image = dialog.locator('img').first();
  await expect(image).toHaveAttribute(
    'src',
    new RegExp(`/v1/assets/${connectedIds.asset}/versions/2/content`),
  );
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  return dialog;
}

/** 通过“预览并命名”保存别名；同名良也必须修复旧的纯文本引用。 */
async function nameConnectedResource(page: Page, editor: Locator, previousName: string) {
  await editor.getByRole('button', { name: `预览并命名 ${previousName}`, exact: true }).click();
  const dialog = await expectPreviewVersion(page);
  await dialog.getByRole('textbox', { name: '资源名称', exact: true }).fill('良');
  await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(editor.getByRole('button', { name: '预览并命名 良', exact: true })).toBeVisible();
  await expect(editor.locator('.resource-mention-token')).toHaveText(['良', '良']);
  await expect(editor.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue(
    connectedPrompt,
  );
}

/** 自动保存可能先于 Ctrl+S 完成；仍须有实际 PATCH、服务端确认和后续业务内容断言。 */
async function saveCanvas(page: Page, scenario: ConnectedScenario) {
  await page.keyboard.press('Control+s');
  await expect.poll(() => scenario.writes.length).toBeGreaterThan(0);
  await expect(page.getByRole('status', { name: '已保存到项目', exact: true })).toBeVisible();
  const saved = scenario.canvas();
  expect(saved.revision).toBeGreaterThan(scenario.initial.revision);
  expect(scenario.writes.at(-1)!.nodes).toEqual(saved.nodes);
  return saved;
}

/** 仅捕获一次合成目标提交；任何上游 POST、重复提交或未声明接口均被 fixture abort。 */
async function submitOnce(page: Page, scenario: ConnectedScenario) {
  const editor = await openTargetEditor(page);
  const button = editor.getByRole('button', { name: '生成', exact: true });
  await expect(button).toBeEnabled();
  scenario.armSubmission();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/v1/nodes/${connectedIds.target}/runs`,
  );
  await button.click();
  expect((await responsePromise).status()).toBe(202);
  await expect.poll(() => scenario.submissions.length).toBe(1);
  await expect(button).toBeEnabled();
  expect(
    scenario.requests.filter(
      (request) => request.method === 'POST' && request.path.endsWith('/runs'),
    ),
  ).toEqual([expect.objectContaining({ path: `/v1/nodes/${connectedIds.target}/runs` })]);
  return scenario.submissions[0]!;
}

/** 从网络再次读取保存结果；提高目录版本后，引用 ID、版本与 mentionId 仍不能漂移。 */
async function reloadFrozenTarget(
  page: Page,
  scenario: ConnectedScenario,
  document: PromptDocument,
  prompt = connectedPrompt,
) {
  scenario.advanceCatalog();
  const reads = scenario.canvasReads();
  await page.reload();
  await waitForConnectedCanvas(page, scenario);
  await expect.poll(scenario.canvasReads).toBeGreaterThan(reads);
  const editor = await openTargetEditor(page);
  await expect(editor.locator('.resource-mention-token')).toHaveText(['良', '良']);
  await expect(editor.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue(prompt);
  await editor.getByRole('button', { name: '预览并命名 良', exact: true }).click();
  await expectPreviewVersion(page);
  await page.keyboard.press('Escape');
  expect(expectFrozenTarget(scenario.canvas(), prompt)).toEqual(document);
  expectSourcePreserved(scenario);
}

/** 验证中心与边缘的真实命中，避免只检查 DOM 存在而漏掉遮挡或裁切。 */
async function expectUnobstructed(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return [
          [rect.left + rect.width / 2, rect.top + rect.height / 2],
          [rect.left + 3, rect.top + rect.height / 2],
          [rect.right - 3, rect.top + rect.height / 2],
        ].every(([x, y]) => {
          const hit = document.elementFromPoint(x!, y!);
          return Boolean(hit && element.contains(hit));
        });
      }),
    )
    .toBe(true);
}

/** 仅约束操作项，不禁止悬浮栏自身的外边框；hover 不得增加边框、阴影或零留白。 */
async function expectBorderlessPaddedHover(locator: Locator) {
  await locator.hover();
  await expect
    .poll(
      () =>
        locator.evaluate((element) => {
          const style = getComputedStyle(element);
          return [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ].map(Number.parseFloat);
        }),
      { message: '真实操作按钮 hover 的四边宽度必须为零' },
    )
    .toEqual([0, 0, 0, 0]);
  await expect(locator).toHaveCSS('box-shadow', 'none');
  const padding = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(
      Number.parseFloat,
    );
  });
  expect(
    padding.every((value) => value >= 4),
    '操作项四边都要有至少 4px 留白',
  ).toBe(true);
}

/** 菜单及 portal tooltip 都必须留在当前桌面视口内。 */
async function expectInsideViewport(page: Page, locator: Locator) {
  const viewport = page.viewportSize();
  const box = await locator.boundingBox();
  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

/** 按触发器的 aria-describedby 等待对应 tooltip，避免读到上一个按钮正在关闭的说明。 */
async function expectBriefTooltip(page: Page, trigger: Locator, text?: RegExp) {
  await expect(trigger).toHaveAttribute('aria-describedby', /\S/);
  const descriptionId = (await trigger.getAttribute('aria-describedby'))!.split(/\s+/)[0];
  const tooltip = page.locator(`[role="tooltip"][id="${descriptionId}"]`);
  await expect(tooltip).toBeVisible();
  const content = (await tooltip.innerText()).trim();
  expect(content.length).toBeGreaterThanOrEqual(4);
  expect(content.length).toBeLessThanOrEqual(100);
  if (text) expect(content).toMatch(text);
  await expectInsideViewport(page, tooltip);
}

/** 读取四个可见锚点的绝对位置；额外语义输入口不能被误计成第五个可见锚点。 */
async function handleGeometry(node: Locator) {
  return node.locator('.flow-asset-node').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const scaleX = rect.width / (element as HTMLElement).offsetWidth;
    const scaleY = rect.height / (element as HTMLElement).offsetHeight;
    const left = Number.parseFloat(style.borderLeftWidth) * scaleX;
    const right = Number.parseFloat(style.borderRightWidth) * scaleX;
    const top = Number.parseFloat(style.borderTopWidth) * scaleY;
    const bottom = Number.parseFloat(style.borderBottomWidth) * scaleY;
    return {
      x: rect.x + left,
      y: rect.y + top,
      width: rect.width - left - right,
      height: rect.height - top - bottom,
      handles: [
        ...element.querySelectorAll<HTMLElement>('.flow-node-handle[data-handle-side]'),
      ].map((handle) => {
        const bounds = handle.getBoundingClientRect();
        return {
          side: handle.dataset.handleSide!,
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
        };
      }),
    };
  });
}

/** 按绝对定位的 padding box 测量，每侧一个圆心且误差不超过 2px；选中态 3px 边框不算锚点偏移。 */
async function expectCenteredHandles(node: Locator) {
  const geometry = await handleGeometry(node);
  expect(geometry.handles.map((handle) => handle.side).sort()).toEqual(
    Object.keys(sideCenters).sort(),
  );
  for (const [side, [x, y]] of Object.entries(sideCenters)) {
    const handle = geometry.handles.find((item) => item.side === side)!;
    expect(
      Math.abs(handle.x - (geometry.x + geometry.width * x)),
      `${side} 横向偏移`,
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(handle.y - (geometry.y + geometry.height * y)),
      `${side} 纵向偏移`,
    ).toBeLessThanOrEqual(2);
  }
  return geometry;
}

/** 端口的连线 ID、职责说明和 aria-disabled 必须与当前视频模式一致。 */
async function expectVideoHandles(node: Locator, mode: 'omni_reference' | 'first_last_frame') {
  const roles =
    mode === 'first_last_frame'
      ? {
          top: ['input:prompt', /提示词输入/],
          right: ['output:video', /输出/],
          bottom: ['input:lastFrame', /尾帧输入/],
          left: ['input:firstFrame', /首帧输入/],
        }
      : {
          top: ['input:prompt', /提示词输入/],
          right: ['output:video', /输出/],
          bottom: ['visual:bottom', /未启用/],
          left: ['visual:left', /参考素材.*媒体/],
        };
  for (const [side, [id, title]] of Object.entries(roles)) {
    const handle = node.locator(`.flow-node-handle[data-handle-side="${side}"]`);
    await expect(handle).toHaveAttribute('data-handleid', id as string);
    await expect(handle).toHaveAttribute('title', title as RegExp);
    if (mode === 'omni_reference' && side === 'bottom')
      await expect(handle).toHaveAttribute('aria-disabled', 'true');
    else await expect(handle).not.toHaveAttribute('aria-disabled', 'true');
  }
  if (mode === 'omni_reference') {
    for (const [role, title] of [
      ['referenceImage', '参考图'],
      ['content', '参考视频'],
      ['audioTrack', '参考音频'],
    ]) {
      const handle = node.locator(`.flow-node-semantic-handle[data-handle-role="${role}"]`);
      await expect(handle).toHaveAttribute('data-handleid', `input:${role}`);
      await expect(handle).toHaveAttribute('title', title!);
    }
  }
}

for (const viewport of desktopViewports) {
  test.describe(`桌面 ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('成功 run 独立回显的 generated 改名良：两处 mention 保存刷新仍固定 v2，原节点不改名', async ({
      page,
      scenario,
    }, testInfo) => {
      await openProject(page, scenario);
      const editor = await openTargetEditor(page);
      await expect(editor.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue(
        connectedPrompt,
      );
      await expect(editor.locator('.resource-mention-token')).toHaveCount(0);
      await capture(page, testInfo, 'history-only-before-alias');
      await nameConnectedResource(page, editor, 'generated');
      await capture(page, testInfo, 'two-structured-liang-mentions');
      const saved = await saveCanvas(page, scenario);
      const document = expectFrozenTarget(saved);
      expectSourcePreserved(scenario);
      await reloadFrozenTarget(page, scenario, document);
      await capture(page, testInfo, 'reloaded-pinned-version');
      expect(scenario.submissions).toEqual([]);
    });

    test.describe('旧项目：已有良别名但无 assetVersion，正文仍为纯 text 块', () => {
      test.use({ legacyAlias: true });

      test('旧良只读恢复与直接提交不暗写画布，请求的两处 mention 固定历史 v2', async ({
        page,
        scenario,
      }, testInfo) => {
        expect(targetData(scenario.initial).resourceRefs![0]).not.toHaveProperty('assetVersion');
        expect(targetData(scenario.initial).promptDocument!.blocks).toEqual([
          { type: 'text', text: connectedPrompt },
        ]);
        await openProject(page, scenario);
        const editor = await openTargetEditor(page);
        await expect(
          editor.getByRole('button', { name: '预览并命名 良', exact: true }),
        ).toBeVisible();
        scenario.observations.loadedTokens = await editor
          .locator('.resource-mention-token')
          .allTextContents();
        await capture(page, testInfo, 'legacy-loaded-without-edit');
        await expect(editor.locator('.resource-mention-token')).toHaveText(['良', '良']);
        expect(scenario.writes, '只读加载不能触发迁移 PATCH').toEqual([]);
        expect(scenario.canvas()).toEqual(scenario.initial);
        const submission = await submitOnce(page, scenario);
        await capture(page, testInfo, 'legacy-direct-submission');
        expectFrozenMentions(submission.body.promptDocument);
        expect(submission.body.parameters?.prompt).toBe(connectedPrompt);
        expect(submission.canvas, '未经编辑的生成只规范化请求，不暗写旧画布').toEqual(
          scenario.initial,
        );
        scenario.advanceCatalog();
        const reads = scenario.canvasReads();
        await page.reload();
        await waitForConnectedCanvas(page, scenario);
        await expect.poll(scenario.canvasReads).toBeGreaterThan(reads);
        const restoredEditor = await openTargetEditor(page);
        await expect(restoredEditor.locator('.resource-mention-token')).toHaveText(['良', '良']);
        await expect(
          restoredEditor.getByRole('textbox', { name: '提示词', exact: true }),
        ).toHaveValue(connectedPrompt);
        await restoredEditor.getByRole('button', { name: '预览并命名 良', exact: true }).click();
        await expectPreviewVersion(page);
        await page.keyboard.press('Escape');
        expect(scenario.writes, '直接提交和刷新也不能偷偷改写缺版本的旧存储').toEqual([]);
        expect(scenario.canvas()).toEqual(scenario.initial);
        expectSourcePreserved(scenario);
        await capture(page, testInfo, 'legacy-reloaded-readonly');
      });

      test('再次保存同名良也会修复旧正文并补足历史版本', async ({ page, scenario }, testInfo) => {
        await openProject(page, scenario);
        const editor = await openTargetEditor(page);
        await nameConnectedResource(page, editor, '良');
        const document = expectFrozenTarget(await saveCanvas(page, scenario));
        await capture(page, testInfo, 'legacy-same-name-repaired');
        await reloadFrozenTarget(page, scenario, document);
        expect(scenario.submissions).toEqual([]);
      });

      test('仅编辑旧正文后保存并模拟提交：两处良绑定 v2且不丢其它文字', async ({
        page,
        scenario,
      }, testInfo) => {
        await openProject(page, scenario);
        const editor = await openTargetEditor(page);
        const prompt = editor.getByRole('textbox', { name: '提示词', exact: true });
        const expectedPrompt = `${connectedPrompt}镜头保持平稳。`;
        await prompt.click();
        await prompt.press('Control+End');
        await prompt.pressSequentially('镜头保持平稳。');
        await expect(prompt).toHaveValue(expectedPrompt);
        await expect(editor.locator('.resource-mention-token')).toHaveText(['良', '良']);
        const document = expectFrozenTarget(await saveCanvas(page, scenario), expectedPrompt);
        await capture(page, testInfo, 'legacy-edited-normalized');
        const submission = await submitOnce(page, scenario);
        expectFrozenMentions(submission.body.promptDocument, expectedPrompt);
        expectFrozenTarget(submission.canvas, expectedPrompt);
        expect(submission.body.parameters?.prompt).toBe(expectedPrompt);
        await reloadFrozenTarget(page, scenario, document, expectedPrompt);
      });
    });

    test('真实 AssetNode 悬浮操作按钮 hover 无边框有留白，tooltip 简述且可键盘打开信息', async ({
      page,
      scenario,
    }, testInfo) => {
      const { source } = await openProject(page, scenario);
      await source.hover({ position: { x: 130, y: 80 } });
      const toolbar = source.locator('.flow-node-floating-controls');
      await expect(toolbar).toBeVisible();
      await expect(toolbar).toHaveCSS('opacity', '1');
      const buttons = toolbar.locator('button.flow-node-action-button:not(:disabled)');
      expect(await buttons.count()).toBeGreaterThanOrEqual(4);
      for (const button of await buttons.all()) {
        await expectUnobstructed(button);
        await expect(button).toHaveAccessibleName(/\S/);
        await expectBorderlessPaddedHover(button);
        await expectBriefTooltip(page, button);
      }
      await capture(page, testInfo, 'asset-node-hover-toolbar');
      await page.mouse.move(viewport.width - 10, viewport.height - 10);
      await source.focus();
      const info = toolbar.getByRole('button', { name: '查看节点信息', exact: true });
      for (let index = 0; index < 16; index += 1) {
        await page.keyboard.press('Tab');
        if (await info.evaluate((element) => document.activeElement === element)) break;
      }
      await expect(info).toBeFocused();
      expect(await info.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
      await expectBriefTooltip(page, info, /节点.*类型|运行状态|资源信息/);
      await capture(page, testInfo, 'asset-node-keyboard-tooltip');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: '节点信息', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: '节点信息', exact: true })).toBeHidden();
      await expect(page.locator('.react-flow__node')).toHaveCount(2);
      expectSourcePreserved(scenario);
      expect(scenario.writes).toEqual([]);
      expect(scenario.submissions).toEqual([]);
    });

    test('右下角画布菜单和 tooltip 不裁切，hover 无逐项边框且键盘导航不创建节点', async ({
      page,
      scenario,
    }, testInfo) => {
      await openProject(page, scenario);
      const pane = page.locator('.react-flow__pane');
      const bounds = await pane.boundingBox();
      expect(bounds).not.toBeNull();
      await pane.click({
        button: 'right',
        position: { x: bounds!.width - 32, y: bounds!.height - 120 },
      });
      const menu = page.getByRole('menu', { name: '画布操作', exact: true });
      await expect(menu).toBeVisible();
      await expectInsideViewport(page, menu);
      const items = menu.getByRole('menuitem');
      expect(await items.count()).toBeGreaterThanOrEqual(6);
      for (const item of await items.all()) {
        await expectInsideViewport(page, item);
        if ((await item.getAttribute('aria-disabled')) !== 'true') await expectUnobstructed(item);
      }
      const fit = menu.getByRole('menuitem', { name: '自动适配缩放', exact: true });
      await expectBorderlessPaddedHover(fit);
      await expectBriefTooltip(page, fit, /视图|画布/);
      await capture(page, testInfo, 'context-menu-bottom-right');
      await page.mouse.move(viewport.width - 4, 4);
      await fit.focus();
      await page.keyboard.press('ArrowDown');
      const search = menu.getByRole('menuitem', { name: '搜索', exact: true });
      await expect(search).toBeFocused();
      await expectBriefTooltip(page, search, /查找.*节点/);
      await capture(page, testInfo, 'context-menu-keyboard-tooltip');
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(page.locator('.react-flow__node')).toHaveCount(2);
      expectSourcePreserved(scenario);
      expect(scenario.writes).toEqual([]);
      expect(scenario.submissions).toEqual([]);
    });

    test.describe('四侧连接点', () => {
      // 使用预置空边目标，只验证模式切换；不把不兼容边的删除混入本次端口验收。
      test.use({ connectedEdge: false });
      test('first_last_frame 与 omni_reference 来回切换时位置不漂移，职责与 tooltip 同步', async ({
        page,
        scenario,
      }, testInfo) => {
        const { source, target } = await openProject(page, scenario);
        const editor = await openTargetEditor(page);
        const initial = await expectCenteredHandles(target);
        await expectCenteredHandles(source);
        for (const mode of ['omni_reference', 'first_last_frame', 'omni_reference'] as const) {
          if (
            mode === 'first_last_frame' ||
            (
              await editor.getByRole('combobox', { name: /^生成模式：/ }).getAttribute('aria-label')
            )?.includes('首尾帧')
          ) {
            await editor.getByRole('combobox', { name: /^生成模式：/ }).click();
            const options = page.getByRole('listbox', { name: '生成模式选项', exact: true });
            await options
              .getByRole('option', { name: mode === 'first_last_frame' ? /^首尾帧/ : /^全能参考/ })
              .click();
          }
          await expectVideoHandles(target, mode);
          const geometry = await expectCenteredHandles(target);
          expect(Math.abs(geometry.width - initial.width)).toBeLessThanOrEqual(1);
          expect(Math.abs(geometry.height - initial.height)).toBeLessThanOrEqual(1);
          for (const handle of geometry.handles) {
            const before = initial.handles.find((item) => item.side === handle.side)!;
            expect(Math.abs(handle.x - before.x)).toBeLessThanOrEqual(2);
            expect(Math.abs(handle.y - before.y)).toBeLessThanOrEqual(2);
          }
          await capture(page, testInfo, `video-handles-${mode}`);
        }
        const saved = await saveCanvas(page, scenario);
        expect(targetData(saved).videoMode).toBe('omni_reference');
        expect(
          saved.nodes.map(({ id, position, width, height }) => ({ id, position, width, height })),
        ).toEqual(
          scenario.initial.nodes.map(({ id, position, width, height }) => ({
            id,
            position,
            width,
            height,
          })),
        );
        expectSourcePreserved(scenario);
        expect(scenario.submissions).toEqual([]);
      });
    });
  });
}
