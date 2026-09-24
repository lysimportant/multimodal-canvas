# 刷新启动反馈

## 目标与基线

P1：刷新后从 HTML 到会话恢复均有可见状态，不改变认证、资源引用或画布数据契约。按跨入口与认证视图的大型变更验证交付。

- 起点：`codex/generate-to-new-node @ c113fd9`，上游 `origin/codex/generate-to-new-node`。Node `v24.12.0`、pnpm `11.19.0`；本地依赖齐全，无新增依赖。
- 原有 `docs/resource-input-compatibility.md` 改动保留，不纳入提交；blob `0f0688d28fd19f8f9cea3a79666c505e6a6e2e03`。
- 改前 `index.html` 的 root 为空；`AppContent` 在会话恢复结束前不渲染路由，180 秒会话预算期间无等待页。生产主样式还会阻塞首绘。
- 开发 5173 与生产 5188 分别冻结入口和会话响应，四种场景均复现 root 无子元素、无文本及 status；证据 `.data/startup-loading-baseline-20260924/`。
- 基线认证单测 16 项通过，日志 `.data/startup-auth-baseline.log`。本地 Web 5173、生产预览 5188 在线；API 3000 未监听。

## 实现与验收

- [x] HTML 内联启动状态、必要样式和五种既有主题；主脚本未返回时即可显示，不依赖组件库下载。
- [x] 入口 `startup/bootstrap.ts` 动态加载主模块及其样式，生产主 CSS 不再阻塞 HTML 启动提示首绘。
- [x] 下载满 15 秒解释较久等待；脚本或样式失败停止进度动画并提供“重新加载”。不自动重发请求、不显示虚假百分比。禁用 JavaScript 时给出明确说明。
- [x] React 提交时替换 HTML 占位，通过 MutationObserver 清除仅用于启动阶段的监听和计时器，挂载后不拦截业务错误。
- [x] 会话等待使用真实 Ant Design Spin，10 秒后补充等待服务器说明。保留 180 秒认证预算、Cookie、401 续期及已有会话保留行为，不提前开放私有路由。
- [x] 工作台和项目深链直达/reload、慢脚本/样式、失败重试、会话错误、五种主题、减少动画、无脚本场景完成浏览器回归及截图检查。
- [x] 单测、lint/typecheck/build、diff 与原有文件保护检查完成。

HTML 启动页的静态状态和重试按钮属于组件库尚未加载时的必要原生兜底；不是重新引入通用自定义控件。React 阶段继续使用现有 Ant Design。

## 验证命令与结果

- `pnpm --filter @multimodal-canvas/web test --maxWorkers=2 --reporter=json --outputFile=../../.data/startup-web-tests.json`：**1,090 项通过**，新增启动/会话单测 29 项。
- `pnpm --filter @multimodal-canvas/ui test`：16 项通过；`pnpm test:runtime`：8 项通过。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`：分别 9、15、9 个任务通过；新增 E2E 完成后再次执行 Web lint，通过。无依赖/锁文件变化。
- `WEB_BASE_URL=http://127.0.0.1:5188 pnpm --filter @multimodal-canvas/web exec playwright test e2e/startup-loading.spec.ts --project=chromium --workers=1`：**22 项通过**。
- 同一专项使用 5173：**20 项通过、2 项生产 CSS 专项跳过**；这两项已在 5188 执行通过。
- 生产预览旧登录 5 项、资源引用/组件库 10 项、真实应用主页 1 项通过。开发独立主页最终重跑 **8/8** 通过；不改变旧用例。
- 旧主页独立测试夹具依赖 Vite `/@react-refresh`，首次误在生产预览执行的 7 项失败不作为产品回归；改用 5173。并行运行时有 1 项鼠标交互时序失败，独立重跑及最终整套均通过，保留日志。既有整套 smoke 的其它 25 项基线失败未在本轮修复或重验。
- 浏览器全部 API 使用合成 mock，不访问真实授权或供应商。正常场景无新增 console.error/pageerror；故障注入仅允许对应资源失败和明确启动诊断。
- 冻结资源且尚未释放时已存在真实 FCP：5188 的 entry/main/CSS 样本分别 96/76/80 ms，5173 的 entry/main 为 64/64 ms。仅本机隔离样本，不是线上 SLA 或总启动性能改进承诺。

## 本地证据与交付

- 基线：`.data/startup-loading-baseline-20260924/baseline.json` 及四张白屏截图。
- 首绘：`.data/startup-loading-fcp-summary.json`；修复后截图：`.data/startup-loading-postfix-evidence/`。
- 新专项：`.data/startup-loading-postfix-5188-report.json`、`.data/startup-loading-postfix-5173-final-report.json`。
- 全量检查：`.data/startup-{web-tests,lint,typecheck,build,ui-tests,runtime-tests}*`；旧用例：`.data/startup-existing-browser.log`、`.data/startup-home-dev-final.log`。
- 最后成功阶段：代码实现、全部专项、Web 全量单测、根 lint/typecheck/build 与截图验收完成；交付目标为当前 origin 上游分支及附注 Tag `v2026.09.24-startup-loading`。

## 范围、剩余风险与回退

仅调整 Web 启动反馈，不改会话超时预算、API、数据结构或依赖。主业务包仍约 1,873 kB（gzip 579 kB），保留构建大 chunk 提示；路由全面拆包是独立后续性能任务。不能缩短服务器尚未返回 HTML 的时间，不能替代未启动的 API 或 New API 授权服务。

本轮未启动 API 3000、未测试真实授权/付费 Provider、未部署生产。后续现场验收需先恢复 API 及其依赖，再检查实际账号的刷新和授权往返；不要把前端隔离验收当作外部服务通过。回退此次提交即可恢复前端入口；无数据迁移或数据库写入，不改变用户作品。
