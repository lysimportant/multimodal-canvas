# 资源栏文字移除检查点

## 当前范围与基线

- 任务级别：P2。按用户圈出的左侧资源卡片区域，移除整块可见文字（名称、类型、文件大小）及其 DOM 占位，只保留缩略图和操作按钮。
- 上轮只移除了名称行，遗留“图片 · 9.6 MB”等元信息。本轮已在 1440×1000 桌面布局复现：248px 侧栏内文字仅分到 15px 宽，76px 高的竖排文字超出 58px 高的卡片。
- 保留悬停名称、无障碍名称、按名称搜索、预览、拖拽及按钮操作；普通与已归档资源行为一致。不修改资源数据、画布标签、Dialog 标题、原图预览/下载或缩略图缓存。
- 起点：`codex/generate-to-new-node @ 0238ab98aaf7fa010e77b81ff4b950393af2aa10`，上游 `origin/codex/generate-to-new-node`；Node v24.12.0、pnpm 11.19.0，本地依赖已安装。
- 基线：`pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/ResourcePanel.test.tsx --maxWorkers=1 --no-cache`，22/22 通过；本地 Compose 六个服务 healthy。
- 预存用户变更：`apps/web/src/index.css`、`apps/web/src/workspace/CanvasNodeToolbar.test.tsx`，以及删除的 `docs/resource-input-compatibility.md`。保留且不纳入本次提交。

## 实施与验证

- 已直接删除卡片内 `.asset-card-copy` 文字区域，并移除本组件不再使用的 `formatBytes` 导入；不依赖 CSS 隐藏，无需覆盖用户的全局 CSS。
- 更新普通/归档资源回归：卡片不含文字区域或可见文本，仍有缩略图、悬停名称和操作入口。
- 验证：`pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/ResourcePanel.test.tsx src/workspace/AssetPreview.test.tsx --maxWorkers=1 --no-cache`，22+44 项全部通过。新断言在模拟图片 load 后检查无文字，不影响既有加载/错误提示。
- Web `lint`、`typecheck`、`build` 通过；本地构建临时目录仅按进程隔离，未更改用户环境配置。仍有既有大 chunk 提示。未执行整套 E2E 或真实付费生成验收。
- 部署：`docker compose build web` 成功（镜像构建内 9/9 包通过）；`docker compose up -d --no-deps --no-build web` 只更新 Web，`/health` 返回 200，未重启 API/Worker/数据服务。
- 实测 1440×1000 桌面：248px 侧栏中 50 张卡片的文字区域数量为 0、含可见文字的卡片数量为 0；58px 高的卡片只显示缩略图和按钮，抽查按钮均在卡片边界内。对照图见 `before-desktop.jpg` / `after-desktop.jpg`，尺寸记录见 `after-desktop.json`。
- 搜索 `38.png` 仅保留一张卡片；预览 Dialog 仍显示资源名并读取 3840×2160 原图，保留原文件下载入口。控制台无错误。烟测后已关闭预览、清空搜索，并恢复浏览器默认尺寸。

## 兼容与回退

- 无 API、依赖、数据库或数据格式变化，不删除/重命名任何资源，不调用付费生成服务。回退只需恢复组件文字区域后重建 Web，不需要数据迁移。
- 本轮证据目录：`.local-tests/resource-sidebar-text-20261002/`；上轮名称行移除证据仍保留在 `.local-tests/resource-sidebar-names-20261002/`，不作为本轮圈定区域修复通过的证据。
