# 分享页与媒体预览补齐检查点

更新时间：2026-10-06。任务级别 P1。

## 范围与基线

- 起点：`main @ 064d35f`，上游 `origin/main`；Node `24.12.0`、pnpm `11.19.0`，现有依赖可用。
- 分享页缺少大肥鱼品牌图与图片缩放工具；Dialog 已有完整图片查看器，音视频提供原生播放控件。
- 目标：分享页展示彩色大肥鱼；复用图片查看器的缩放、拖动、原图、旋转、翻转与铺满；Dialog 和分享页补充明确的播放操作、倍速及循环，保留原生进度、音量和视频全屏。
- 验收：匿名分享仅访问公开接口，不自动播放；原有令牌、到期与版本冻结合同不变；切换或关闭停止媒体；PC 和低高度窗口控件可见，不改变节点外框。
- 不涉及数据库、Provider、付费生成和生产部署，无需迁移；可撤销本轮前端提交回滚。
- 起点已有 SEO 修改：`apps/web/index.html`、`apps/web/public/site.webmanifest`、`apps/web/seo-build.ts`、`apps/web/src/pages/ContactPage.tsx`、`apps/web/src/seo/SiteMetadata.tsx`、`apps/web/src/seo/site-content.ts`、`docs/mascot-seo-checkpoint.md`，不纳入本轮提交。
- 实现期间这些 SEO 修改由其他任务单独提交为 `2fe50b9`；本轮接续该提交，不重写其文件或历史。

## 进度与验证

- [x] 核对 AGENTS、分享合同、图片查看器和当前工作区。
- [x] 基线：`PublicAssetSharePage`、`ImagePreviewStage`、`AssetPreview` 单测 3 文件 91 条通过。
- [x] 实现与针对性回归：4 个受影响测试文件合计 100 条通过；其中新播放器 5 条、分享页 16 条、原图查看器 32 条、既有预览 47 条。
- [x] 浏览器实际媒体操作、匿名边界及 PC 截图检查：分享创建/复制/匿名图片 1 条，视频 Dialog 1 条，公开视频/音频/文字/失效页 1 条通过。
- [x] 格式、类型、构建与最终差异检查。
- [ ] 提交并核验远程引用：目标 `origin/main`，附注 Tag `v2026.10.06-share-preview`；GitHub TLS 连接当前失败，恢复后再核验推送。

## 当前实现

- 分享页头部复用 `/brand/lovetv-mascot.webp`，包含大肥鱼可访问名称。
- 图片与 Dialog 共用 `ImagePreviewStage`，保留跨域匿名属性和无 Referrer 策略；铺满只改变页面布局，Esc 可从工具栏退出。加载失败和链接到期均移除媒体并恢复错误页面。
- `MediaPreviewPlayer` 提供播放/暂停/重播、0.25–2 倍速、循环、缓冲提示与失败重试。浏览器原生控件继续提供进度拖动、音量和视频全屏，公开页不自动播放。
- Dialog 的播放工具栏置于缩放舞台外；视频适配为工具栏预留高度。切源、重试、关闭和分享过期停止旧媒体，迟到的播放拒绝不覆盖新资源。
- 文字仍按纯文本展示，原文件链接与 Dialog 下载/分享入口保留，不添加公开目录或编辑功能。

## 验证证据与边界

- 专项：`VITE_API_BASE_URL=http://localhost:3000` 下运行 `PublicAssetSharePage.test.tsx`、`ImagePreviewStage.test.tsx`、`MediaPreviewPlayer.test.tsx`、`AssetPreview.test.tsx`。初轮发现新测试复用已消费的 Response，改为每次生成新 Response；类型检查修正测试库不支持的 `exact` 参数，产品代码无绕过。
- 浏览器：`WEB_PORT=5186 pnpm --filter @multimodal-canvas/web exec playwright test e2e/asset-share.spec.ts --workers=1`。初轮图片用例停在 Vite 冷启动加载页面；该用例定向重跑通过，其余两条首轮通过。所有 API 由合成夹具拦截，无真实用户数据和供应商调用。
- 已检查 1440×900 图片分享、1366×768 音视频分享、1280×480 视频 Dialog/分享、图片铺满截图。大肥鱼正确解码，控件可达；播放后时间推进，暂停/倍速/循环真实生效，关闭 Dialog 停止媒体且节点尺寸不变。仅失效夹具产生预期 410，其余场景无控制台或运行时错误。
- 日志和截图在忽略目录 `.local-tests/share-preview-20261006/`；原生进度、音量、全屏依赖浏览器媒体能力，未对每种浏览器逐项验收。本轮不部署正式站点，不运行数据库迁移或真实付费请求。
- 完整 Web 回归本轮执行 131 文件、2407 条：2406 条通过，`SkillWorkbench` 一条触及 5 秒时限；随后不改代码、不放宽时限，单独重跑该文件 27 条全部通过（42.64 秒）。不能将首次全量结果描述为零失败。
- `pnpm lint`、`pnpm typecheck`、`pnpm exec turbo run build --env-mode=loose` 均通过；构建时 `VITE_API_BASE_URL=''`。本轮 Web 检查和构建实际执行，未变更共享包的 Turbo 项命中缓存；Vite 原有超过 500 kB 的 chunk 提示仍存在。
- Git 远程读取尝试：现有代理的 Schannel 握手失败；临时 OpenSSL 后端与 HTTP/1.1 同样失败，直接连接 GitHub 443 超时。未修改 Git 全局代理、未关闭 TLS 校验、未强推。
