# 资源栏名称隐藏检查点

## 范围与基线

- 任务级别：P2，仅隐藏左侧资源卡片的可见名称行，不删除或重命名资源。
- 验收：普通与已归档资源均不显示名称行；悬停提示、无障碍名称、按名称搜索、预览、拖拽及操作按钮保持可用；类型和文件大小仍显示。
- 不涉及画布节点、Dialog 标题、原文件下载、缩略图缓存、API、数据库或依赖变更。不修改全局 CSS。
- 起点：分支 `codex/generate-to-new-node`，提交 `6ac8e44acc801193467089c9348ab4d6db62391a`，上游 `origin/codex/generate-to-new-node`。
- 环境：Node v24.12.0、pnpm 11.19.0，已安装本地依赖；本地 Compose 六个服务均 healthy。
- 预存用户变更：`apps/web/src/index.css`、`apps/web/src/workspace/CanvasNodeToolbar.test.tsx`，以及删除的 `docs/resource-input-compatibility.md`。保留且不纳入本次提交。
- 修改前验证：`pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/ResourcePanel.test.tsx --maxWorkers=1 --no-cache`，20/20 通过。

## 进度

- 已移除卡片内名称 `strong` 元素，将其 `title` 转移到卡片预览入口；原有 `aria-label`、资源对象及交互回调不变。
- 已补充普通/归档资源无名称行的断言，并将名称搜索与筛选测试改为检查资源预览入口是否存在。
- 另外同步 3 个既有浏览器测试文件中的 7 处名称文本定位，改用预览按钮的无障碍名称，避免隐藏名称后误判上传失败。
- 回归：`ResourcePanel.test.tsx` 22/22、`AssetPreview.test.tsx` 44/44 通过；新断言的类型文案已校正为既有的“文字”。
- Web lint、typecheck 通过；首次 build 遇到 Windows 全局临时目录文件锁，改用本任务 `.local-tests/resource-sidebar-names-20261002/tmp` 作为进程级 TEMP/TMP 后 build 通过，未改用户环境配置。构建保留既有大 chunk 提示。
- 本地部署：`docker compose build web` 成功，镜像构建内 9/9 包构建通过；`docker compose up -d --no-deps --no-build web` 仅更新 Web，`/health` 返回 200，API/Worker/数据服务未重启。
- 真实页面烟测：资源栏 50 张卡片均无名称行；搜索 `38.png` 仅保留对应卡片，悬停标题和无障碍名称仍在；缩略图 640×360，Dialog 使用 3840×2160 原图并保留下载入口；关闭预览、清空搜索后列表恢复，控制台无错误。
- 证据：`.local-tests/resource-sidebar-names-20261002/` 中的测试/构建日志、`browser-smoke.json` 与 `sidebar-no-names.jpg`。
- 最终检查：Web lint、typecheck 再次通过；既有 smoke 5 项受影响用例可成功收集，仅同步定位方式，本轮未执行整套 E2E 或收费图片编辑验收。UI 交互由上述真实项目烟测覆盖，未新增/删除项目数据或请求图片生成。
- 本次属于低风险展示调整，无公共合同/数据迁移/依赖变化。回退只需还原名称行和原悬停位置后重建 Web，不改资源记录。交付前检查差异并仅提交本任务文件，预存用户变更保持原状。
