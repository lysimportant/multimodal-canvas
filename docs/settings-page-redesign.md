# 设置页布局优化

任务级别 P1，改版模式为保留品牌的局部优化。面向 PC Web 的日常创作配置，使用现有 React、项目 UI 组件、Lucide 和主题 token；不引入新的设计系统。使用 design-taste-frontend 的审计、层级、对比度和交互原则，展示页的 Hero、图片及营销布局要求不适用于本表单。设计参数为 DESIGN_VARIANCE 3、MOTION_INTENSITY 2、VISUAL_DENSITY 6。

## 基线与范围

- 分支 `codex/generate-to-new-node`，起点 `ec68df5`；Node v24.12.0、pnpm 11.19.0，依赖已安装。
- 保留用户已有的 `docs/resource-input-compatibility.md` 改动。前次凭据修复已通过完整验证，本轮重新检查设置专项作为基线。
- 现有品牌使用系统无衬线字体、主题色、5-8px 表单圆角，支持护眼、浅色、深色及高对比主题。保留路由、主导航文案、表单名称与顺序、API 和凭据行为。
- 主要问题：非交互范围栏与分类导航重复占宽；页头留白过多；节点模型字段窄，重复来源说明造成长行；设置子组件存在固定浅色文字与边框。
- 本轮优化页头、范围展示、分类导航、表单宽度、主题一致性及说明提示。不修改服务端、凭据格式、Skill 功能或生产部署；复杂手机布局后置，保留基本窄屏降级。
- 子代理使用 `gpt-5.6-sol`、`max`，仅负责来源摘要辅助提示及专项测试。主代理负责页面布局、样式、集成验收和提交。

## 检查点

- [x] 阅读现有设置页、表单组件、主题 token、专项测试及上次修复记录。
- [x] 基线截图及设置专项测试，63 项通过。
- [x] 页面排版和辅助提示完成。
- [x] PC 多宽度、浅深主题、核心交互、错误与键盘检查，14 项浏览器测试通过。
- [x] lint、typecheck、test、build 完成；最终交付前核对差异与敏感信息。

交付使用任务级提交及中文 annotated Tag `v2026.09.18-settings-page-redesign`，推送到 `origin/codex/generate-to-new-node`，成功状态以最终远程引用核验为准。

## 结果与验收

页头合并设置范围，保留五类导航；扩大表单区域和模型输入框，URL 与 Key 并排排列，保存与取消操作留在底部。节点来源的解析说明由信息图标在 hover/focus 时展示，失效错误和地址摘要保持可见。分类支持方向键及 Home/End；提示可按 Escape 关闭，设置弹窗保留，再按一次才关闭弹窗。输入、按钮、错误提示与焦点轮廓跟随页面主题。

同一隔离预览、1440 × 1000 视口、节点默认分类的测量：

| 指标             | 改版前                  | 改版后                  |
| ---------------- | ----------------------- | ----------------------- |
| 表单内容区域宽度 | 700px                   | 1152px                  |
| 模型输入框宽度   | 129px                   | 459px                   |
| 四行默认配置高度 | 236 / 204 / 204 / 204px | 126 / 126 / 126 / 126px |
| 文档高度         | 1574px                  | 1021px                  |

截图和测量保存在本地 `test-results/settings-redesign-before/`、`test-results/settings-redesign-after/`；最终桌面截图在 `test-results/settings-redesign-browser-final/`。浅色、深色、护眼主题的五类设置均检查过；新增浏览器用例覆盖 1920、1440、1280px 及 390px 基本降级，没有横向溢出或浏览器控制台错误。

- 浏览器回归：`pnpm --filter @multimodal-canvas/web exec playwright test e2e/settings-page-layout.spec.ts e2e/independent-connection.spec.ts e2e/smoke.spec.ts --grep '设置页|首次无全局|已有全局|saves AI settings|设置删除当前 Key|settings are truly modal|设置保留四类|主菜单支持' --workers=1 --reporter=line`，14/14 通过。包含共享弹窗、Key 删除状态、独立连接保存和失败重试；接口使用合成夹具。
- 工程检查：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 均通过。Web 74 个文件、1073 项用例通过，API 报告 863 项通过和 67 项跳过，Worker 258 项通过和 3 项跳过，runtime 8 项通过；跳过的设施与集成检查不计作验收成功。最终日志为 `settings-redesign-final-lint.log`、`settings-redesign-final-typecheck.log`、`settings-redesign-verified-tests.log`、`settings-redesign-final-build.log`，均位于 `test-results/`。构建仍提示既有主 bundle 超过 500kB，代码拆分不在本轮范围。
- 本地 HTTP 验收：`node .data/independent-connection-live-smoke.mjs`，合成连接保存、刷新模型、选择后重载恢复、取消均成功，浏览器错误为空；结果保存在 `test-results/settings-redesign-live-smoke.log`。最终重新测量三种主题，表格指标一致。
- Lighthouse 12.8.2：独立 Chromium、合成账户、本地 Vite 预览，性能 93、可访问性 100、最佳实践 100，LCP 1.3s、TBT 0ms、CLS 0.023。报告为 `test-results/settings-redesign-lighthouse.json`；这是开发预览单次采样，不代表生产性能或完整人工无障碍验收。
- 审计发现并修正“获取模型”的可访问名称与可见文字不一致；共享顶栏品牌链接仍有一个不计分的名称一致性提示，属于既有全站组件，保留为后续项。
- 首次全量测试中，画布批量生成用例触发 5 秒超时，其后一项出现残留节点；单独重跑 `pnpm --filter @multimodal-canvas/web exec vitest run src/canvas-editor.test.tsx`，56/56 通过，最终全量复跑也通过。未修改画布逻辑或调大超时。子代理复核确认失败用例没有挂载设置组件；旧异步请求跨用例污染为可能原因，精确超时位置仍未取证，测试隔离加固留待后续。

## 环境与边界

本机预览 `http://127.0.0.1:5192/settings`，隔离 API 为 `http://127.0.0.1:19312`，合成上游为 `http://127.0.0.1:19313`。启动沿用 `.data/independent-connection-preview.mts` 和 `.data/independent-connection-web.mjs`；页面测量使用 `node .data/settings-layout-audit.mjs after`。这些本地脚本和结果不进入版本库，不使用真实 Key，不访问真实供应商。

没有 API、数据库、配置格式或依赖变更，无迁移要求；回滚可撤销本次提交。真实 PostgreSQL/Redis/S3 集成和生产部署不在本轮验收范围。共享导航名称提示以及复杂移动端设计保留后续处理。
