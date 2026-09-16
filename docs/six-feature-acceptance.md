# 六项需求验收记录

更新时间：2026-09-16。
基线：`codex/generate-to-new-node @ dd0c28c`（`docs: 制定节点与画布六项增强计划`）。
验收对象：[next.md](next.md) 第 3～8 节的六项功能与第 9 节 A～G 阶段。

本文件只记录**实际执行过的命令与真实结果**。未执行、被跳过或未取得证据的项目显式标注，
不用口头状态代替代码与测试。所有 Mock 结果都不代表供应商真实验收。

## 1. 环境与基线

| 项目     | 值                                                                         |
| -------- | -------------------------------------------------------------------------- |
| 工作目录 | `G:\multimodal-canvas`                                                     |
| 运行时   | Node v24.12.0，pnpm 11.19.0，Windows PowerShell 7                          |
| 分支上游 | `codex/generate-to-new-node` → `origin/codex/generate-to-new-node`         |
| 起始状态 | 干净工作区，`dd0c28c`                                                      |
| 数据库   | 本机无 `DATABASE_URL`；迁移与 Prisma 集成测试使用一次性 PostgreSQL 16 容器 |

实施前基线（本轮实测，非历史记录）：

```powershell
pnpm typecheck   # 13 tasks successful，exit 0
$env:WEB_PORT='5173'; pnpm test   # 13 tasks successful，exit 0
```

## 2. 阶段 A：冻结合同与迁移

| 项目         | 证据                                                                                 |
| ------------ | ------------------------------------------------------------------------------------ |
| 领域合同     | `packages/domain/src/index.ts` 新增请求提示词记录、节点计时、分组与空节点相关 schema |
| 合同单测     | `packages/domain/src/request-prompt.test.ts`，16 项通过                              |
| 迁移         | `prisma/migrations/20260916120000_canvas_groups_run_node_timings`                    |
| 迁移隔离验证 | 一次性 PostgreSQL 16 容器从零应用 17 个迁移，`prisma migrate diff` 报空迁移          |

隔离库命令与结果：

```powershell
docker run -d --name mc-migrate-scratch -e POSTGRES_PASSWORD=scratch -e POSTGRES_USER=scratch -e POSTGRES_DB=scratch -p 55432:5432 postgres:16-alpine
$env:DATABASE_URL='postgresql://scratch:scratch@127.0.0.1:55432/scratch?schema=public'
pnpm exec prisma migrate deploy   # 17 migrations applied，exit 0
pnpm exec prisma migrate diff --from-url $env:DATABASE_URL --to-schema-datamodel prisma/schema.prisma --script
# → "-- This is an empty migration."（无残留漂移）
```

真实数据库集成测试（同一隔离容器）：

```powershell
$env:TEST_DATABASE_URL='postgresql://scratch:scratch@127.0.0.1:55432/scratch?schema=public'
$env:TEST_DATABASE_CONFIRMED_ISOLATED='true'; $env:WORKER_PROVIDER='mock'; $env:DATABASE_URL=''
pnpm --filter @multimodal-canvas/api exec vitest run src/prisma.integration.test.ts --reporter=verbose
# → Test Files 1 passed；Tests 20 passed | 5 skipped（Redis/MinIO/队列用例按配置跳过）
```

其中与本次直接相关的用例已实际执行通过：`新增独立凭据持久化为非活动行，重启实例后仍按 ID 可解析`、
`applies 0001-0007 …` 与 `applies 0009 …` 两个迁移兼容性用例（整库结构比对已把新迁移纳入链路）。

## 3. 阶段 D：连线路径与特效（需求四）

实现：`apps/web/src/workspace/canvas-edge-appearance.tsx` 提供独立的 `edgePathStyle` 与 `edgeEffect`
两个偏好；`FlowingCanvasEdge` 使用 React Flow 自身的 `getBezierPath` / `getSmoothStepPath` /
`getStraightPath`；外观面板分「路径样式」「动态特效」两组。

```powershell
pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/FlowingCanvasEdge.test.tsx src/state/workspace-preferences.test.ts src/workspace/workspace-modules.test.tsx src/workspace/WorkflowCanvas.test.tsx --reporter=dot
# → Test Files 4 passed；Tests 91 passed（含 5 × 6 = 30 组合独立性、旧偏好迁移、端点圆心内收）
```

旧偏好迁移：`flow` → 标准曲线 + 流光，`pulse` → 标准曲线 + 呼吸脉冲，`minimal` → 标准曲线 + 无特效。

## 4. 阶段 B：请求提示词与节点耗时（需求一、二）

Provider 层（`packages/providers`）：在真正发送请求前把最终请求文本交给 `onRequestPrompt` 钩子；
钩子抛错时不发送请求。

```powershell
pnpm --filter @multimodal-canvas/providers exec vitest run --reporter=dot
# → Test Files 6 passed；Tests 310 passed
pnpm --filter @multimodal-canvas/providers run typecheck   # exit 0
```

Worker 与持久化层：发送前留存、按节点计时（服务端 UTC、单调合并）、结果身份绑定。

```powershell
$env:DATABASE_URL='postgresql://scratch:scratch@127.0.0.1:55432/scratch?schema=public'
pnpm --filter @multimodal-canvas/worker exec vitest run --reporter=dot
# → Test Files 14 passed；Tests 227 passed（含 3 个真实 PostgreSQL 集成用例，实际运行）
pnpm --filter @multimodal-canvas/api exec vitest run src/run-persistence.test.ts src/runs.test.ts src/runs-bullmq.test.ts --reporter=dot
# → Test Files 3 passed；Tests 48 passed
```

Web 展示层接入：`RequestPromptDialog.tsx`（短标题、摘要块、完整提示词块、双复制、键盘与焦点圈定）
由节点悬浮栏的「提示词」动作打开，只读取该节点本次执行真正发送的请求记录；
`NodeDurationBadge.tsx` 显示在节点信息面板的「耗时」行，运行中由**整页唯一的共享时钟**递增。
两者都有应用级用例，覆盖记录存在与缺失两条路径。

```powershell
pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/RequestPromptDialog.test.tsx --reporter=dot
# → Test Files 1 passed；Tests 15 passed
pnpm --filter @multimodal-canvas/web exec vitest run src/canvas-editor.test.tsx --reporter=dot
# → Test Files 1 passed；Tests 40 passed（含提示词入口读取真实记录、无记录时明确说明）
```

## 5. 阶段 E、F：分组与清空（需求五、六）

几何与归属规则：`apps/web/src/canvas-utils.ts` 新增包围盒、成组、落点判定、归属迁移、
组成员同步、整组平移、外框缩放等纯函数。

```powershell
pnpm --filter @multimodal-canvas/web exec vitest run src/canvas-utils.test.ts src/canvas-group-utils.test.ts src/workspace/CanvasGroupLayer.test.tsx --reporter=dot
# → 通过：21 + 20 + 10 项
```

空节点判定：`apps/web/src/workspace/empty-node-rules.ts` 覆盖 next.md 第 8.2 节表格的全部情况；
应用层通过 `buildEmptyNodeRuntimeState` 提供有效上游输入与“运行记录待查询”两个外部条件，
候选数量预览与真正执行共用同一份状态构造，二者结果一致。

```powershell
pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/empty-node-rules.test.ts src/workspace/ClearCanvasMenu.test.tsx --reporter=dot
# → 通过：14 + 9 项
```

应用级端到端（真实 `App` + 画布交互，Mock API）：

```powershell
pnpm --filter @multimodal-canvas/web exec vitest run src/canvas-editor.test.tsx --reporter=dot
# → Test Files 1 passed；Tests 40 passed
# 新增：胶囊工具栏创建空组与选区成组、解散保留成员、清空菜单 hover/取消、
#       清空空节点保留有内容提示词、保留有有效上游输入的空节点并一次撤销
```

分组导入导出往返（API 层）：

```powershell
pnpm --filter @multimodal-canvas/api exec vitest run src/canvas-group-import.test.ts --reporter=dot
# → Test Files 1 passed；Tests 5 passed
```

## 6. 阶段 C：设置（需求三）

后端与查询层：独立凭据创建不激活全局连接（内存/文件/Prisma 三种存储）、按凭据的类型默认模型。

```powershell
pnpm --filter @multimodal-canvas/api exec vitest run src/settings.test.ts src/app.test.ts src/file-ai-settings.test.ts src/project-model-defaults.test.ts src/settings-sync.test.ts --reporter=dot
# → Test Files 5 passed；Tests 139 passed
pnpm --filter @multimodal-canvas/web exec vitest run src/query --reporter=dot
# → Test Files 2 passed；Tests 11 passed
```

宽版设置界面（分类导航、节点默认四行、独立连接入口）：见第 7 节最终验证。

```powershell
pnpm --filter @multimodal-canvas/web exec vitest run src/settings-panel.test.tsx src/settings-utils.test.ts --reporter=dot
# → Test Files 2 passed；Tests 60 passed（含全局范围写独立连接、独立 Key 不改动活动连接）
```

## 7. 全仓库检查

```powershell
pnpm typecheck   # Tasks: 13 successful, 13 total，exit 0
$env:WEB_PORT='5173'; pnpm test   # Tasks: 13 successful, 13 total，exit 0
pnpm build       # Tasks: 8 successful, 8 total，exit 0
pnpm lint        # Tasks: 8 successful, 8 total，exit 0
```

单测合计（turbo 13 个任务全部通过）：

| 包                                      | 结果                                    |
| --------------------------------------- | --------------------------------------- |
| domain                                  | 2 文件 / 65 项                          |
| providers                               | 6 文件 / 310 项                         |
| worker                                  | 14 文件 / 233 通过、3 跳过              |
| api                                     | 52 通过 / 3 跳过文件；660 通过、57 跳过 |
| web                                     | 60 文件 / 825 项                        |
| ui / observability / credential-crypto  | 3 + 21 + 7 项                           |

相比本轮开始前的基线（同一条 `pnpm test`，13 任务通过），新增约 330 项测试。

浏览器端到端：

```powershell
$env:WEB_PORT='5173'; pnpm --filter @multimodal-canvas/web test:e2e
# 本轮改动后：46 passed / 22 failed / 2 skipped
# 同一命令在起始提交 dd0c28c 上：46 passed / 22 failed / 2 skipped
```

失败集合与改动前**完全一致**：本轮没有引入也没有修复既有 E2E 失败。逐项对比后发现的唯一
新增失败（`saves AI settings and tests the mocked connection`，原因是设置面板分类化后连接
表单需要先切到「连接与 Key」）已在 `e2e/smoke.spec.ts` 同步修正。

`pnpm lint` 在起始提交上本来就失败：工作区因 `core.autocrlf=true` 为 CRLF，而 Prettier 默认
只接受 LF。本轮在 `.prettierrc.json` 增加 `"endOfLine": "auto"`，让格式检查同时接受两种行尾，
`pnpm lint` 现在才能真正作为门禁使用（既有文件不再需要为行尾而改动）。

## 8. 已知缺口与未验证项

诚实记录，不计入已完成：

| 项目                                 | 状态                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 真实供应商请求                       | 未执行。本轮全部为 Mock 与合同单测，不代表供应商能力验收                                       |
| `negativeText` 正向用例              | 无现网视频合同会写入负向字段，只验证了「未发送时不记录」的方向                                 |
| 参考资源 `assetVersion`              | 仅在冻结快照携带时记录（`imageEditSource.version` 或匹配的 `resourceRefs[].assetVersion`）     |
| 内存运行模式（`RUN_SERVICE=memory`） | 没有请求记录存储，列表返回空、单条读取 404；该模式下没有写入方，未实现内存记录存储             |
| 结果绑定补写                         | strict 绑定写入失败后，重试会复用已归档结果而不再调用 Provider，因此不会补绑定（重试是新 run） |
| 数据库集成中的 Redis/MinIO           | 未配置相应服务，相关用例跳过                                                                   |
| 浏览器端到端既有失败                 | 22 项在起始提交上即失败，本轮未修复，也未新增失败                                               |
| 视觉截图检查                         | Playwright 只做断言，未逐项人工核对截图                                                        |
| 服务器时间偏移                       | 运行中已用时间使用浏览器时钟，未接入服务端时间偏移；最终值以服务端落库时间为准                 |
