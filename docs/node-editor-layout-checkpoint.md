# 节点上传资料与输入面板检查点

2026-10-08，P1。起点 `main @ 1f8e490`，上游 `origin/main`。Node `24.12.0`、pnpm `11.19.0`，沿用本地依赖。

## 范围与基线

- 上传引用资源只追加参考资料，不自动插入正文；保留手动 `@` 选择、资料命名、版本冻结与保存。
- PC 快捷输入固定高度从 300px 改为 250px；整个浮动面板不滚动，空间不足时在画布边界吸附。
- 完整编辑 Dialog 保留底部 Skill 配置、选择、优化和撤销，生成仍需显式操作。
- 不修改节点外框、供应商合同、数据库、依赖或移动端布局，不调用真实 Provider。

开始时存在 `NodeQuickEditor.tsx`、Domain 和 Providers 的 Image2Pro 未提交改动；本轮期间该并行任务继续修改相关代码及测试。全部保留，提交时逐块区分，不能纳入本任务提交。

定位证据：上传路径调用 `selectMention` 插入正文；Dialog 的底部控件通过 `!expandedEditorOpen` 排除了 Skill；浮层按节点外侧空隙设置高度并允许整个面板滚动，上下无空隙时直接隐藏。

## 恢复位置

- 布局和真实画布订阅基线：3 文件 140/140 通过。
- 两个新几何用例及新 CSS 边界断言在旧实现下失败：4 failed / 21 passed。
- 已修改完整尺寸与贴边计算；超过画布高度时限制面板显示倍率，不缩减逻辑输入高度，不向节点尺寸回写。逻辑宽度固定由画布几何决定，避免限高倍率与工具栏换行互相驱动；正常倍率仍按节点两倍宽显示，限高时整体缩小。
- 上传按既有 `attached` 资料格式保存；受控编辑器以父层资料为准，同正文的撤销也移除卡片。批次逐项读取实时节点，不覆盖前项；未知版本、超量及首尾帧模式冲突明确拒绝。离开编辑会话后迟到上传仅保留已归档项目素材，不附到其它节点。
- Dialog 使用同一个 Skill 配置入口，移除额外内联会话；待处理任务切换后仅查询原任务，不创建重复优化。复刻节点继续使用专属工作流。
- 上传编辑器最终 84/84；App 81、App 引用 23、资料动作 53、相机 7、Skill 工作台 28、引用同步 8 通过。Skill 配置及优化专项 8/8，pending 切换 1/1。
- 最新布局核心 38/38 通过，包括固定高度、全部边界、换向滞后、观察器不重建、换行宽度稳定及资源栏避让；另 107 项因专项筛选未执行，不算全量通过。浮层避开可见资源栏，资源栏显隐后重新计算边界，模型栏左端及中心已验证真实点击命中。
- 首次并行组件长跑出现默认 5 秒超时；最终全量将减少并行并使用命令行测试时限，不修改项目测试配置。首次全仓 typecheck 发现两处新夹具缺少必填 `contentUrl`，补齐后 Web typecheck/lint 已通过。
- 较早全仓 lint 为 8/9 包成功，唯一失败为并行用户任务的 `packages/domain/src/image2pro-video-contract.test.ts` 格式问题；本任务未修改该文件。并行任务后续更新后，收尾全仓 lint 9/9 成功（3 项缓存），本任务 Web lint 单独复跑也通过。

## 收尾验证

- PC 浏览器最终 6/6 通过：1440×900、1366×768；上传仅保存资料、显式 `@` 后插入正文；1/1.5/2 倍上下边界；250px 正文单独滚动而整卡不滚动；节点外框不变；Dialog Skill 悬浮、选择、点击重开与逐层 Escape。没有控制台错误、未声明请求或媒体生成请求。
- 最新 18 张截图位于 `apps/web/test-results/node-editor-layout-*`，已实际复查资源栏避让、两倍贴边面板及 Dialog Skill。
- 最后资源栏避让补丁后，`pnpm --filter @multimodal-canvas/web typecheck`、Web lint 和 Web build 均通过；全仓 `pnpm typecheck` 为 15/15 成功（7 项缓存）。常规全仓 build 已为 9/9 成功（6 项缓存），补丁后另做 Web 构建，3724 模块、21.12 秒通过；仍有既有的大于 500kB chunk 提示。
- 最后 Web 构建首次遇到系统 Temp 中 esbuild 临时文件删除权限失败，改用仓库内 TEMP/TMP 后重跑成功，没有修改系统配置或依赖。
- `pnpm test:runtime` 8/8。全仓测试限制为 Turbo 单任务、Vitest 两个 Worker、15 秒单测试时限：Domain 446、凭据 13、观测 21、UI 16、Providers 815、Execution 56 通过；Web 为 135 文件/2561 项通过、1 文件/1 项失败，12 分 37 秒退出 1。此前并行默认 5 秒超时不算通过证据。
- 唯一 Web 失败是 Image2Pro `duration: 0` 的生成禁用断言；该参数校验属于并行任务，未纳入本次暂存差异。并行任务在全量期间继续更新源码和测试，随后对当前工作区的 Image2Pro 非法参数组专项复测 5/5 通过（242 项按筛选跳过）。未在这些并行更新后重跑全部 136 个 Web 测试文件，不能把首次全量退出 1 改写成全仓测试绿灯。
- 首次全仓失败中断了 API/Worker 的实际执行，单独补跑为 7/7 Turbo 任务成功（2 项缓存）：API 71 文件/1259 项通过、8 文件/108 项跳过；Worker 23 文件/862 项通过、6 文件/28 项跳过。需要设施的跳过项保持未验收，不用 Mock 替代生产验收。
- 暂存差异和 `git diff --check` 已核对；常见密钥模式未命中。本任务与共享文件的 Image2Pro 差异已逐块分开，未暂存该并行任务。

无数据库、依赖或持久化格式升级。需要回滚时恢复本任务前应用代码即可；已上传的项目素材仍保留，不执行清理或覆盖用户数据。

日志保存在忽略目录 `.local-tests/node-editor-layout/`。布局专项命令：

```powershell
$env:TEMP = Join-Path (Get-Location) '.local-tests/node-editor-layout/temp'
$env:TMP = $env:TEMP
$env:VITE_API_BASE_URL = 'http://localhost:3000'
$env:WEB_PORT = '5173'
pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/quick-editor-layout.test.ts src/workspace/node-input-height-layout.test.ts src/workspace/WorkflowCanvas.test.tsx --maxWorkers=2
```

全仓与服务补跑使用下列本地 Turbo 入口；直接执行入口以保留 Vitest 参数分隔符：

```powershell
.\node_modules\.bin\turbo.cmd run test --concurrency=1 -- --maxWorkers=2 --testTimeout=15000 --reporter=dot
.\node_modules\.bin\turbo.cmd run test --filter=@multimodal-canvas/api --filter=@multimodal-canvas/worker --concurrency=1 -- --maxWorkers=2 --testTimeout=15000 --reporter=dot
```

本任务代码与 PC 验收已完成，未部署 Docker、运行迁移或调用真实 Provider。交付分支为 GitHub `origin/main`，交付附注 Tag 为 `v2026.10.08-node-editor-layout`；恢复时以 Git 远程引用核对交付结果。并行 Image2Pro 工作区改动及其后续全量验收不属于本次提交，全部保留。
