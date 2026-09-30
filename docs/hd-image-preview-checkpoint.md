# 原图预览修复检查点

日期：2026-10-01（Asia/Shanghai）。P1，PC Web 图片查看器单一目标；不修改生成请求、原文件、数据库、节点外框或用户现有改动。

## 基线

- 分支 `codex/generate-to-new-node`，HEAD `ce73d6dfd2a31b370d5b9fcd950ee8776b4d9be8`，上游 `origin/codex/generate-to-new-node`。
- Node v24.12.0、pnpm 11.19.0，node_modules 与 pnpm 锁文件已存在。根 README.md 不存在；已检查 TODO-CONSOLIDATED.md 与前轮检查点。
- 用户未提交变更：index.css、CanvasNodeToolbar.test.tsx；删除 docs/resource-input-compatibility.md。保留，不纳入提交。
- 现场只读复现：节点16解码3840×2160，Dialog在473×672窗口绘制415×233，工具栏却显示100%；原始大小按钮仅返回适配尺寸。

## 验收

- 适应窗口显示真实原图比例；1:1 时实际 img 绘制宽高乘 devicePixelRatio 等于自然宽高（屏幕像素1:1），不放大缩小后的图层，不改变src。
- 轮滚锚定、拖动、旋转90°、水平翻转、重置、铺满窗口与键盘操作可用；失败重试、资源切换、关闭恢复正确。
- 原文件下载字节保持不变，节点外框不被预览内容撑大；视频/音频旧功能不变。
- 单测、桌面浏览器回归、lint/typecheck/build；现有8080项目部署及烟测。先保留Web回滚镜像，只重建Web，不碰数据服务。

## 当前状态

- 已完成原图查看器、测试、样式与本地8080部署；单测与浏览器回归代理已完成并退出。
- 不新增第三方依赖，不调用付费生成API，不修改项目节点、原文件、生成记录或数据格式。
- 后续如需裁剪、调色、AI超分或改写图片，应单独确认资源版本与保存规则；本次仅查看，不实现这些有副作用的编辑功能。

## 实现阶段检查点

- 已接入专用 ImagePreviewStage：直接绘制原图目标宽高，缩放百分比相对原图；新增适应、1:1、旋转、翻转、重置、铺满窗口和键盘/拖动。
- 根据现场 DPR=1.5，100% 改为屏幕物理像素1:1：CSS宽高=原图宽高/devicePixelRatio，平移在100%时对齐屏幕像素边界；监听屏幕密度变化，不重新取图。
- 修复初次测量受 Modal 入场动画影响：采用 clientWidth/clientHeight 而不是已被外层 transform 缩放的 getBoundingClientRect。单测与浏览器回归覆盖中。
- 首轮root lint 9/9、typecheck 15/15通过；build读到仍在编写中的测试类型错误，待单测代理完成后统一重跑，未记为构建通过。
- Web已保存回滚快照 `multimodal-canvas-web:before-hd-image-preview-20261001`，ID `sha256:e5457a3f4fcb1d8499b3c9d5ca4dc757ef7cc7416ff8cad3ee06f16fe086e0b8`；尚未部署。

## 最终验证与部署

- 基线 AssetPreview 单测42/42；最终图片查看与下载相关单测76/76，包含32项新查看器用例。
- 全量 Web 单测 `pnpm --filter @multimodal-canvas/web exec vitest run --maxWorkers=2`：1539/1540通过；唯一失败是既有WorkflowCanvas菜单用例在并行构建期间超过5秒。结束构建后整个WorkflowCanvas文件单独复跑47/47通过，用例耗时3.83秒。所有1540项均有通过记录，不宣称一次无失败的全量执行；日志web-unit-all.log和workflow-recheck.log。
- 浏览器最终 `node-hover-preview.spec.ts --workers=1`：17/17通过；既有悬浮用例另连续3次通过。覆盖1920×1080、1366×768、窄窗口390×844，以及DPR 1/1.5/2。原文件下载逐字节相同；节点与画布外框不变。旧测试对有限Modal动画增加稳定等待，不取消原断言；无限光标动画不计入等待。
- 根目录 `pnpm lint`、`pnpm typecheck`、`pnpm build` 通过；无新增依赖，保留既有Vite大包提示。最终差异通过格式和git diff检查，无真实密钥写入。
- 本地现场节点16原图仍3840×2160，DPR=1.5，点击1:1后实际CSS尺寸2560×1440，乘DPR正好3840×2160；百分比100%，图片与祖先没有适配图层scale放大，资源路径不变。旋转、翻转、重置、铺满及Esc退出逐项烟测通过，页面错误日志为空。
- 仅 `docker compose build web` / `docker compose up -d --no-deps web`，项目页面HTTP200，六服务healthy；API、Worker、Postgres、Redis、MinIO容器ID均与基线相同。原有用户改动未回滚也不纳入本次提交。
- 临时5189测试服务已关闭。日志、桌面与高分屏截图、现场尺寸JSON位于 `.local-tests/hd-preview-20261001/`，截图live-fit.jpg、live-native.jpg、live-expanded.jpg；未把图片或带签名URL写入Git。

## 交付与回滚

交付分支 `origin/codex/generate-to-new-node`，annotated Tag `v2026.10.01-hd-original-preview`。实际提交ID与远端验证见交付回复及Git日志。

回滚时将 `multimodal-canvas-web:before-hd-image-preview-20261001` 标记为 `multimodal-canvas-web:local`，再仅重建Web；没有数据库迁移、数据回写或生成重试。不得重建/清理数据卷。

原图1:1指一原图像素对应一屏幕物理像素；浏览器/系统缩放变化时跟随devicePixelRatio重算。超过100%只放大显示，不创造新细节；上游若返回低像素文件，本功能不会伪造为4K。
