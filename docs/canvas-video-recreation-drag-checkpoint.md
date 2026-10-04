# 短视频复刻回调与节点拖动回归

## 范围与基线

2026-10-04，P1。用户要求解决节点拖动卡顿；起点为 `codex/generate-to-new-node @ dc19669`，使用 Node v24.12.0、pnpm 11.19.0 和现有依赖。只修复复刻入口回调身份引起的渲染广播，不重构画布、不改模型调用、节点尺寸或持久化格式。

原有 `apps/web/src/index.css`、`apps/web/src/workspace/CanvasNodeToolbar.test.tsx` 修改及 `docs/resource-input-compatibility.md` 删除不属于本轮，保持并排除提交。开发与固定构建均包含这些既有工作区内容，前后比较不混用不同 CSS。

## 原因与最小修复

`App.tsx` 用内联包装函数传递 `onRecreateVideo`，每次坐标帧都产生新引用。`WorkflowCanvas` 把它放进 `NodeVideoRecreationContext`，全部 `AssetNode` 订阅此 Context，因此拖一个普通文字节点也会让其余节点渲染；`React.memo` 不能挡住 Context 更新。

现在直接传递已有的 `handleCreateVideoRecreationNode`，不加新的缓存层，也不删除其真实业务依赖。该 `useCallback` 仍从 ref 获取最新节点，在资产、项目等业务依赖变化时更新，并保留原有异步错误处理、版本冻结和创建行为。

## 回归证据

- 修改前 App/WorkflowCanvas 两文件基线 146/146 通过，说明旧测试漏掉了新增 Context。
- `App.test.tsx` 把 `onRecreateVideo` 纳入回调稳定性清单。旧实现连续 20 帧更换引用 20 次，新增断言预期 0，确认红灯；修复后专项转绿。
- `WorkflowCanvas.test.tsx` 的节点探针实际订阅 `NodeVideoRecreationContext`，传入非空稳定 spy；48 个节点连续 12 次坐标变化，只有移动节点渲染。未移动节点仍可调用复刻入口，收到正确节点 ID。
- 专项命令：`pnpm --filter @multimodal-canvas/web exec vitest run src/App.test.tsx src/workspace/WorkflowCanvas.test.tsx -t '50 个资源与已选节点连续 20 次位置更新|48 节点连续 12 次位置更新'`。旧实现 1 失败/1 通过，修复后 2 通过；144 项关键词筛选跳过不计入通过数量。

## 实际构建前后对比

修复前后分别由相同 Vite 配置构建，使用独立静态预览，不替换浏览器收到的 App 代码。固定负载为 48 个普通文字节点、47 条连线、1440×1000，选中同一节点、打开参数编辑器，以真实 React Flow 监听器处理 60 次逐 rAF 合成鼠标移动。顺序为前/后/后/前/前/后；计时不与测试、类型检查或构建并行。

全部业务请求在内存 Mock，外网被拒绝，没有移动或保存用户项目，也没有发送分析/生成请求。所有样本的节点 transform 实际变化，节点/边数量不变、节点尺寸维持 220×170，页面与控制台错误为零。

| 指标                | 修复前 1 / 2 / 3           | 修复后 1 / 2 / 3         |
| ------------------- | -------------------------- | ------------------------ |
| 平均 rAF 间隔（ms） | 123.725 / 88.697 / 114.685 | 16.668 / 16.668 / 16.666 |
| P95 间隔（ms）      | 200.0 / 133.4 / 183.4      | 16.7 / 16.7 / 16.8       |
| 长任务次数          | 60 / 60 / 60               | 0 / 0 / 0                |

三组平均从 109.036ms 降至 16.667ms，约减少 84.7%。这是本机 Chromium headless 合成负载的帧调度结果，不是显示器实际 FPS，也不保证千节点或持续媒体播放达到相同数值。

单独的开发模式插桩只计节点/编辑器 render，没有替换 App 回调：未移动节点额外渲染两次均由 5546 降至 0，编辑器额外渲染始终为 0。StrictMode 和插桩会影响绝对计数，因此不将开发模式帧耗时混入上表。

- 前构建入口：`main-fgaJikQE.js`；后构建入口：`main-DL4ttPCI.js`，CSS 均为 `main-D8Ncgra5.css`。
- 脱敏本地证据位于 Git 忽略的 `.local-tests/drag-fix-20261004/`：`measure-builds.cjs`、`comparison/comparison.json`、`renders-before/comparison.json`、`renders-after/comparison.json`、`summary.json` 及截图。
- 第一次前构建因系统 TEMP 中 esbuild 临时文件删除被拒绝而失败；将 TEMP/TMP 限定到本任务目录后重跑通过，未修改系统配置或依赖。

## 验收与交付检查点

### 工程检查

- `pnpm lint --force`：9/9 任务通过，无缓存。
- `pnpm typecheck --force`：15/15 任务通过，无缓存。
- `pnpm build --env-mode=loose`：9/9 任务通过；仍有既有 Vite 大分块警告。完整构建与已部署的固定构建入口、CSS 和主包字节一致。
- `pnpm test:runtime`：8/8 通过。完整测试以 `VITE_API_BASE_URL=http://localhost:3000`、`WEB_PORT=5173`、`WORKER_PROVIDER=mock`、`RUN_SERVICE=memory` 和任务私有 TEMP/TMP 执行。最终根命令为 `pnpm test --force --env-mode=loose --concurrency=2 -- --maxWorkers=4 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000`；PowerShell 用参数数组保留独立的 `--`。
- 上述完整运行中，Domain 336、Providers 768、Execution 43、Credential Crypto 7、Observability 21、UI 16、Worker 784、API 1171 项通过；日志汇总另列 Worker 28/API 92 项跳过，不计集成通过；未从总数差额推断额外用例状态。
- Web 完整运行 2224 通过、1 失败；唯一失败是 `canvas-editor.test.tsx` 中“三份生成并保存卡牌归属”超过该 describe 自带的 15 秒期限。随后使用 `pnpm --filter @multimodal-canvas/web exec vitest run src/canvas-editor.test.tsx --maxWorkers=1 --minWorkers=1`，保持原断言及原期限，全部 70/70 通过。Web 2225 项在完整运行加该文件独立复核中均取得通过证据，**不代表根命令一次全绿**。
- 更早的验证误把正式构建的同源空值带入 Web 单测，产生 62 项地址断言失败；已纠正验证环境，未为适应错误环境修改业务代码。Windows PowerShell 给 .NET 字符串参数传 `$null` 会在本机留下空值而非删除，最终显式固定开发 origin。四 worker 初跑的 Skill 工作台超时，独立原期限复核 27/27 通过；最终 20 秒 CLI 期限只用于并发验收，不改仓库配置。

### 浏览器与本地运行

- 固定预览的短视频复刻流程 7/7 通过；本机更新后的 `8080` 独立重跑同样 7/7 通过，覆盖 1440×1000、1366×768、人物/商品替换、版本冻结、保存恢复及显式分析/生成。
- 显式设置 `PERFORMANCE_LABEL=drag-fix-20261004` 后，`e2e/next-performance.spec.ts` 在 `8080` 的 100 节点、99 连线、100 成员组完整流程 1/1 通过。未设置标签时的一次跳过不计验收。所有业务请求都使用 Mock，页面/控制台错误断言为零；截图已检查。
- 部署后首轮浏览器测试为 6/7，1440 完整编辑器滚动说明后标题离开视口。保留原截图与 trace；在不并行运行全量测试时，旧构建同场景重复 3/3 通过，新构建完整 7/7 通过。没有放松断言或顺手改 CSS，该偶发现象未据此宣称已修复。
- 仅更新本机回环 `127.0.0.1:8080` 的 `multimodal-canvas-app-web-1`：沿用原 Web 镜像的 Caddy/健康配置，仅覆盖已验收静态包，再 `docker compose up --detach --no-deps --no-build --wait web`。未改共享/远程生产，也未执行迁移。API、Worker、PostgreSQL、Redis、MinIO 的容器 ID 均未变化且 healthy。
- `/health`、首页返回 200；首页加载 `index-CDS3Dy-6.js`，再加载 `main-DL4ttPCI.js`。服务实际返回的主包 SHA256 为 `BA603A9FDCFD59EBE511CBFC5632065E9DE2AF1B609A7B5D0DBF2BF8C8B7A6E1`，与固定构建一致。
- 保留本地回滚镜像 `multimodal-canvas-web:drag-before-20261004-5cf47b855844`。需要回滚时将其重新标为 `multimodal-canvas-web:local`，按同一项目仅重建 Web 容器；不清数据卷或回退数据库。
- 本任务独立预览 5192/5193 已停止，用户既有 5190/5191 保留；5191 是旧冻结预览，不代表本次更新。验收与体验以已更新的 8080 为准。

### 交付与后置观察

本轮是低风险局部修复：生产实现只改一处回调绑定，附两份回归测试及项目说明，不涉及公开 API、依赖、迁移或数据格式。按当前上游提交并推送，不新增 Tag；提交号和远程引用以最终 Git 核验为准。原有三项用户变化不提交。未进行真实 Provider 效果验收。

- [ ] 后置观察：完整编辑器展开流程后的自动滚动在重负载下曾使标题不在视口；需稳定复现后另行区分测试滚动时机与交互缺陷，不扩大本次卡顿修复。
- [ ] 后置观察：重型 jsdom 画布/Skill 交互在多 worker 下接近既有期限，后续可独立设计测试分片和资源隔离，不用增加本轮业务代码掩盖超时。
