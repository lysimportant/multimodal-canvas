# 画布一键整理

## 范围与基线

- 2026-10-02，P1；分支 `codex/generate-to-new-node`，起点 `fbfa569`，Node v24.12.0、pnpm 11.19.0，依赖已存在。
- 顶部工具栏及底部胶囊节点组新增“整理”按钮，共用同一操作；全画布按现有节点顺序从左到右、从上到下排列，每行最多 30 个节点。
- 只改节点位置；保留节点尺寸、内容、状态、连线和分组归属。组分别整理，组框跟随成员调整。
- 一次整理对应一次历史记录；保持自动保存、刷新恢复和撤销/重做。空画布或单节点禁用。
- 不改生成流程、Provider、原图/缩略图、数据库、依赖或文档格式；不在真实项目中自动整理。
- 用户原有 index.css、CanvasNodeToolbar.test.tsx 修改和 resource-input-compatibility.md 删除保持原状，不纳入提交。

## 验收与恢复

- 纯函数测试覆盖 0/1/30/31/61 节点、不同尺寸、幂等和分组；App 与隔离浏览器覆盖按钮、保存、撤销、重做和刷新。
- 布局函数、顶部与胶囊入口完成。初轮夹具问题已修正：补齐既有 MIME 默认值，生成请求断言使用 POST 计数而非项目运行列表 GET；RTL 查询不使用 Playwright 专有 exact 参数。
- 回退使用本轮任务提交的逆向提交并重建 web，不覆盖用户改动或项目数据。

## 验证结果

- `pnpm --filter @multimodal-canvas/web exec vitest run src/canvas-auto-arrange.test.ts src/canvas-editor.test.tsx src/canvas-history.test.ts src/canvas-persistence.test.ts src/canvas-group-utils.test.ts src/canvas-utils.test.ts src/workspace/CanvasNodeToolbar.test.tsx src/workspace/CanvasNodeToolbar.arrange.test.tsx src/workspace/WorkflowCanvas.test.tsx src/App.test.tsx --maxWorkers=2 --testTimeout=60000`：10 文件、272/272 通过，无跳过。
- `pnpm typecheck`：15 tasks 通过；`pnpm lint`、`pnpm build`：分别 9 tasks 通过。保留既有大 chunk 构建警告。
- Playwright 用隔离同源 Vite：PowerShell 先设置 `$env:WEB_PORT='5187'` 和 `$env:VITE_API_BASE_URL='http://127.0.0.1:5187'`，再执行 `pnpm --filter @multimodal-canvas/web exec playwright test -c playwright.config.ts e2e/canvas-auto-arrange.spec.ts --workers=1`，1/1 通过，无跳过。
- 浏览器验证 61 个节点排成 30/30/1、54 条边不变、220×160 节点不变、顶部/胶囊入口、重复整理不多占历史、一次撤销/重做、保存及刷新。页面/控制台错误、未知接口及禁止请求均为 0；没有真实 Provider 或用户项目写入。
- 原夹具依赖同源会话；默认 127.0.0.1 页面搭配 localhost API 会阻止跨站 Lax Cookie，本轮复现明确使用同源，不放宽认证或外部请求隔离。
- 已检查桌面 1600×900 截图。每行 30 个节点可能宽于当前视野；不强制改变用户缩放，可使用现有适配缩放或平移。

## 布局边界

- 原节点数组顺序决定排列顺序，不按名称重排或改变拓扑。水平净间距 60、行/区块净间距 80，单位为画布像素；列宽取本列最大值，行高取本行最大值。
- 分组继续受既有 10,000 像素边长合同约束，必要时减少列数而非放大上限；所有列数都无法容纳时显示错误，保留整个原布局，不写部分结果或历史。
- 不自动展开批次卡牌，不改变节点内容、结果或参数；只处理当前已加载画布。
- 证据与日志位于 `.local-tests/canvas-arrange-20261002/`。本地发布只替换 web；旧运行网页镜像另行保存，不重启 API/Worker，不改数据卷。

## 本地交付

- 已执行 `docker compose -f compose.yaml build web` 和 `docker compose -f compose.yaml up -d --no-deps web`；六服务 healthy，API、Worker、PostgreSQL、Redis、MinIO 容器 ID 在本次发布前后均未改变。
- 8080 项目地址 HTTP 200；已从实际发布的 JS 确认顶部及胶囊整理入口，不点击真实项目整理、不刷新用户正在编辑的标签页。用户刷新页面后可见。
- 原运行镜像的 config digest 无法直接打标签，已用 `docker commit --pause=false` 保存运行中的纯网页服务为 `multimodal-canvas-web:before-arrange-20261002`。需要回退时先将该标签重新标记为 `multimodal-canvas-web:local`，再仅重建 web 容器，不改数据卷。
- 原有两项用户文件修改的 SHA-256 与起点一致，原文档删除仍保留；这三项不纳入本轮提交。提交及 Tag 以 Git 记录为准。
