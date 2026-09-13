# 节点悬浮操作与媒体预览检查点

更新时间：2026-09-13。

## 基线与本轮范围

- 起点 `main @ fed53b6`，跟踪文件无未提交修改；保留已有三个 `.codex-patch*.py`、`compose-config.yaml` 和 `compose.yaml.full` 未跟踪文件。
- Node `v24.12.0`、pnpm `11.19.0`，复用锁文件和本地依赖。
- 基线：`pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/AssetNode.test.tsx src/workspace/AssetPreview.test.tsx src/workspace/asset-node.css.test.ts --reporter=dot`，29 项通过。
- P1 主目标：节点悬浮卡片在画布缩小后仍至少显示 250px，允许超出节点；图片首击选择并打开输入框、后续点击预览；预览按原媒体尺寸等比适配视口；图片/视频节点增加当前内容下载。
- 验收不改变节点持久化尺寸、生成合同或数据库，不调用收费 Provider。下载复用既有读取权限和当前资产版本。

## 阶段与恢复

- [x] 阅读仓库检查点、相关模块与现有测试，确认旧卡片跟随画布缩放、图片首击打开 Dialog、预览舞台固定尺寸的原因。
- [x] 实现悬浮栏尺寸补偿和下载，补齐错误反馈。
- [x] 实现图片两次点击和媒体原始比例适配；图片 source 节点也先进入输入编辑，使用实际快速编辑器 ID，Ctrl+A 全选不能绕过首击输入。
- [x] 完成本次 Web 回归、lint、typecheck、build、真实浏览器冒烟及截图检查；全仓库已有失败另列如下。
- [x] 审查差异和 Git 状态；本次交付仅包含 Web 相关实现、测试和本检查点。

## 验证结果

- `pnpm --filter @multimodal-canvas/web test`：50 个文件、590 项通过，日志 `.data/node-preview-web-test-final.log`。
- `pnpm --filter @multimodal-canvas/web lint`、`pnpm typecheck`、`pnpm build` 通过。最终构建包含最后的编辑器 Context 修复；构建仍提示已有主包大于 500 kB。
- `WEB_PORT=5196 pnpm --filter @multimodal-canvas/web exec playwright test -c playwright.config.ts e2e/smoke.spec.ts --grep '节点操作改进|编辑器参数浮层和放大对话框 390' --reporter=line`：9 项通过，包括 8 项本轮专项及窄屏编辑器复验。
- 专项覆盖屏幕至少 250px、悬浮卡片超出节点、缩小后拖动、首击输入和再次预览、Ctrl+A、多种媒体比例、窗口调整、节点外框尺寸保持、图片/视频下载字节一致、视频播放和浏览器错误检查。
- 已检查 1440×900、1024×640、390×844 截图；横图、竖图、方图、小图及视频没有固定预览舞台造成的多余边框。截图及日志见 `.data/node-preview-browser-verified/` 和同名 `.log`。

## 已有检查限制与后续事项

- 全仓库 `pnpm lint` 仍因未修改的 `packages/providers/src/index.test.ts` 格式失败，日志 `.data/node-preview-lint.log`。
- 全仓库 `WEB_PORT=5173 pnpm test` 在未修改的 Worker 取消视频轮询测试失败：Mock 只匹配旧 `/video/generations`，当前 Provider 请求 `/v1/videos`。Worker 191 项通过、1 项失败；不把本次结果标为全仓库测试通过。日志 `.data/node-preview-test.log`。
- 全量浏览器首次运行 60 项通过、4 项失败；其中窄屏编辑器单独复验已通过。另 3 项旧连线测试仍靠拖资源到画布准备来源节点，但基线 `App.tsx` 已明确改为使用资源卡片添加按钮。后续应更新这些测试夹具，不改变已确认的资源拖拽交互。日志 `.data/node-preview-e2e.log`。

## 兼容性与交付

不修改数据库、持久化节点尺寸或公开 API。图片节点先进入编辑，再允许点击图片预览；展开按钮仍可直接预览。视频 source 节点仍保持直接预览。预览小媒体保持原尺寸，大媒体按视口等比缩小；标题与控件保留必要空间。

下载取当前回显资产或结果版本，复用现有认证和 Blob 保存。请求失败有提示，切换产物或卸载会取消旧下载；外部资源需要其服务器允许浏览器跨域读取。

本机验收服务为 `http://127.0.0.1:5196/`，通过未跟踪的 `.data/node-preview-dev.mjs` 启动（`node .data/node-preview-dev.mjs`），复用现有 `127.0.0.1:8080` Docker API，并代理 `/v1` 和 `/health`。已确认首页及健康检查返回 200，匿名账户接口返回正常的 401 JSON。前端服务保持运行，未重新部署 Docker。

交付目标为当前上游 `origin/main`（GitHub），按共享预览行为变更创建中文 annotated Tag `v0.15.9`；实际提交 ID 与远程引用核验见最终交接。保留全部 5 个已有未跟踪文件，不提交本地测试日志。回滚可撤销本次提交，无需数据迁移。
