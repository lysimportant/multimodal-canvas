# 节点批量生成与分组交互

## 范围与基线

- P1：继续任务 `01a0af67-c683-7d80-9b17-34435ed288ba` 的五项 PC Web 需求。
- 分支 `codex/generate-to-new-node`，起点 `e40c5ad`，上游 `origin/codex/generate-to-new-node`。
- Node v24.12.0、pnpm 11.19.0，使用仓库已有依赖；根目录无 README、AGENTS.md，采用会话规则。
- 接手时保留 25 个已修改文件和新增的 domain 数量测试；`docs/resource-input-compatibility.md` 是任务开始前的用户修改，不纳入提交。
- 恢复基线：画布组件 49 项中 47 项通过、2 项分组文字查询失败；分组组件 17 项通过。旧基线命令参数错误，不能作为测试通过证据。

## 验收与检查点

- [x] 分组空白区域可选中、拖动，悬浮卡片包含四种类型数量、拖动、重命名及解散操作。
- [x] 图片「修改图片」只创建带当前资源引用的草稿，用户点击生成才提交运行。
- [x] 悬浮栏显示「耗时」，统一按秒展示。
- [x] 视频预设 16 秒改为 15 秒，另有自定义正整数秒数输入框；保留模型明确声明的能力限制。
- [x] 每个节点支持 1 至 20 份生成数量，默认 1，设置页可修改新节点默认值。
- [x] 所有数量大于 1 的结果默认卡牌堆叠，右上角箭头展开/收起并有动画。
- [x] 分组在 25%、50%、100%、200% 缩放下保持可操作，节点和端口优先接收交互。
- [x] 1920 和 1366 桌面宽度下卡牌展开/收起、整叠拖动、保存刷新与悬浮栏边界通过浏览器验证。
- [x] 中途断网、撤销后续节点或删除批次首节点时停止剩余提交，已取得运行 ID 的任务继续跟踪。
- [x] 最终运行边界回归、lint、typecheck、build 与任务差异审查通过。

## 兼容与回滚

生成数量及卡牌归属是可选画布字段，历史节点缺省仍为 1。每份生成使用独立节点和既有运行接口，保留各自状态、结果、输入引用；数量不作为 Provider 参数传递。默认数量保存在当前浏览器，只影响新建节点。无数据库迁移或新依赖，不需要数据备份或迁移。回滚代码不会删除已有运行和资产，旧版可忽略新增展示字段。测试只用合成路由与本地 Mock，不发收费供应商请求；生产验收与手机适配不在本轮范围内。

## 恢复与阶段验证

- 批量运行已接通：复制参数及输入边，每份采用独立节点/运行 ID；中途提交失败停止剩余创建请求，跟踪已取得 ID 的任务，不自动重发。
- 再次批量生成保留旧成员及资产，解除旧卡牌归属；整批粘贴重建批次与节点身份，单独粘贴后方成员独立显示。
- `pnpm typecheck`、`pnpm build`、`WEB_PORT=5173 pnpm test` 第一轮通过。Web 920、API 753、Worker 251、Provider 344、Domain 90、UI 3、观测 21、凭据加密 7 项通过；API 59、Worker 3 项条件集成测试跳过，不计作验收通过。
- 73 项既有浏览器回归第一轮 66 项通过，7 项在修复 React Flow 根层叠并切换到专用服务后全部通过。根层叠、端口透明桥接命中及桌面边界悬浮栏继续以鼠标验证，不仅依赖组件测试。
- 中断后重新读取检查点，代码与日志均保留，原开发服务已停止；恢复 `WEB_PORT=5187`、`VITE_API_BASE_URL=http://localhost:3000` 的 Vite 供所有 Mock 验收复用。
- 用户再次明确移动端统一后置，本轮不新增移动端适配；既有手机相关代码保持原有行为。
- Web 全量回归 921 项通过，随后新增撤销批次的停止提交用例，主流程组件 52 项通过。日志分别为 `test-results/node-batch-final-web-test.log`、`test-results/node-batch-app-final.log`。
- 联合浏览器 32 项首轮 30 项通过、2 项失败；其中 25% 倍率标题覆盖节点是实际几何问题，已让标题随画布缩放。另一项通过组内空白区域验证选择互斥，避免被节点编辑器遮挡。修复后分组及缩放联合 10 项、分组组件 17 项全部通过，截图在 `test-results/group-browser-final/`。
- 新增生成浏览器 5 项通过，覆盖数量 1/2/3 的准确请求次数、独立结果和输入边、保存刷新、15 秒预设、17 秒自定义及设置默认数量；日志 `test-results/generation-browser-final.log`。
- 核心浏览器烟测 6 项通过，覆盖四类节点、图片修改草稿、上传和结果优先级、模型参数和 PC 视频参数；日志 `test-results/node-batch-core-smoke.log`。
- 最新 `pnpm lint`、`pnpm typecheck`、`pnpm build` 通过；构建保留已有大于 500 kB 的 chunk 提醒，拆包不在本轮范围内。
- 最终只读审查补出“首份请求等待期间删除首节点后继续提交”的问题，回归先复现失败，再修复为同时核验发起节点和当前目标。主流程完整 53 项通过（`test-results/generation-delete-regression.log`）；移除测试中不受支持的查询选项后，针对该用例再次通过（`test-results/node-batch-delete-final.log`），最终类型检查与构建通过。
- 最后生成浏览器复验 5 项全部通过（`test-results/node-batch-generation-recheck.log`），无页面异常或 console.error。未发现新增凭据或调试日志。

## 验证复现与交付

所有命令在仓库根目录执行。开发服务使用已有本地依赖：

```powershell
$env:VITE_API_BASE_URL='http://localhost:3000'
$env:WEB_PORT='5187'
pnpm --filter @multimodal-canvas/web dev --host 127.0.0.1 --port 5187 --strictPort
```

此服务用于 Mock 浏览器验收，不代表真实 API 或供应商栈已启动。端口占用时应保留原服务，显式指定其他端口并同步 `WEB_BASE_URL`。

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm --filter @multimodal-canvas/web exec vitest run src/canvas-editor.test.tsx src/workspace/CanvasGroupLayer.test.tsx
$env:WEB_BASE_URL='http://127.0.0.1:5187'
pnpm --filter @multimodal-canvas/web exec playwright test e2e/node-generation-batch.spec.ts e2e/node-batch.spec.ts --workers=1
pnpm --filter @multimodal-canvas/web exec playwright test e2e/canvas-group-menu.spec.ts e2e/next-acceptance.spec.ts -g '组名拖动|组内空白|竖向右键|分组缩放往返|分组：整组' --workers=1
```

本轮 PC 功能与验收完成。任务提交使用分支 `codex/generate-to-new-node` 及中文 annotated Tag `v2026.09.18-node-batch-interactions`，目标为 `origin` 的同名上游分支；实际提交与推送结果以 Git 核验及最终交付消息为准。任务开始前已有的 `docs/resource-input-compatibility.md` 修改保持未提交，测试日志和截图不纳入版本库。

后续范围：移动端统一适配、真实供应商与生产环境验收。条件集成测试的跳过与现有构建体积提醒均保留，不能将本轮 Mock 验证视为这些后续项已完成。
