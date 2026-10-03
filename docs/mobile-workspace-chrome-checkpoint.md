# 手机画布菜单与资源栏检查点

## 范围与验收

- P2：仅在宽度不超过 600px 时，把右上角原有操作全部收到“画布菜单”；增加独立“全部资源”按钮，资源栏初始完全隐藏。
- 菜单和资源面板均可关闭；原有命令、撤销/重做、整理、外观、设置、账户、导出和运行继续可用。桌面侧栏固定/收起偏好保持不变。
- 不修改节点、API、资源数据、依赖或其它移动端交互；不调用付费生成接口。
- 验收包括 320px、390px、桌面视口以及跨断点切换；资源搜索与添加、嵌套菜单、关闭/焦点返回，无横向溢出与控制台错误。

## 起点

- 分支 `codex/generate-to-new-node`，起点 `3d72fa2`，上游 `origin/codex/generate-to-new-node`。
- Node v24.12.0；pnpm 11.19.0；工作区依赖已安装，无需安装。
- 当前无根 README 或 AGENTS.md；遵循会话提供的全局规则，已读取 `TODO-CONSOLIDATED.md` 和资源栏检查点。
- 基线：`pnpm --filter @multimodal-canvas/web exec vitest run src/responsive-ux.test.ts --maxWorkers=1 --minWorkers=1`，16/16 通过。
- 用户预存改动涉及提示词 Skill、测试、全局 `index.css` 和文档删除；全部保留，不纳入本次提交。新增独立样式文件，避免改写用户 CSS。

## 当前状态

- 实现及全部针对性验收已完成。子代理负责独立 E2E，主代理复核并修复关闭焦点时序后重跑整套专项。
- 任务期间其它并行工作提交了 `666d939`；本次保留该提交及其余未提交变更，只提交本任务 6 个文件。

## 回退

- 仅 Web 展示变化，无迁移；回退本次任务提交即可恢复，不改变已保存的桌面侧栏偏好或资源。

## 实现与当前验证

- 已加入手机专用菜单/资源抽屉及响应式入口，600px 以上直接渲染原 DOM，保留桌面布局与持久化偏好。
- 菜单复用全部原有控件；资源面板预挂载保留上传引用，菜单关闭后卸载，避免嵌套浮层残留。关闭恢复各自入口焦点，转入命令/设置时不抢走新弹窗焦点。
- 已通过 App 67 项、ResourcePanel 37 项、响应式 16 项、新浮层 5 项，共 125 项针对性单测；类型检查通过。
- Web lint 通过。第一次生产构建遇到共享 Windows TEMP 中 esbuild 文件拒绝删除；仅为构建进程指定 `.local-tests/mobile-workspace-build-temp` 后成功，无环境或依赖修改。保留既有 chunk 大小警告。
- 已目视检查 320px/390px 初始画布、菜单和资源列表截图，未见越界或遮挡。18/18 项浏览器专项全部通过，覆盖 320×640、390×844、1440×900 和 600/601px 断点、资源搜索/添加、外观/导出嵌套菜单、命令/设置切换、Escape 关闭及焦点返回。所有请求使用 mock，无付费请求；API 隔离审计无错误。
- 额外发现既有资源“清除搜索”按钮存在输入草稿未清空的现象，涉及共享 IME 草稿同步，不属于本次手机入口任务；不改写该逻辑。本轮验证使用正常编辑搜索框清空，保留后续单独修复风险。
- 最后成功命令：下列 E2E 全套 18/18 通过；随后 Web lint、build（包含 tsc）及新组件 5/5 单测均通过。尚未部署生产环境；共享本地开发服务 5173 未改动。

## 复验与证据

```powershell
$env:WEB_BASE_URL = $null
$env:WEB_PORT = '5187'
$env:VITE_API_BASE_URL = 'http://127.0.0.1:5187'
pnpm --filter @multimodal-canvas/web exec playwright test -c playwright.config.ts mobile-workspace-chrome.spec.ts --workers=1 --reporter=line --trace=on --output=test-results/mobile-workspace-chrome-complete
```

- 专项截图和 trace：`apps/web/test-results/mobile-workspace-chrome-complete/`；独立测试服务由 Playwright 启停。
- 构建时仅在当前 PowerShell 进程设置 `TEMP` / `TMP` 为仓库 `.local-tests/mobile-workspace-build-temp`，再运行 `pnpm --filter @multimodal-canvas/web build`。
- 本次为局部低风险 P2 展示调整，无公共 API、数据格式、依赖或迁移变化；按小改动提交并推送当前已配置上游，不发布版本 Tag。
