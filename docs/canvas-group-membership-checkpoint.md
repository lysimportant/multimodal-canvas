# 分组归属与整理溢出修复检查点

## 范围与基线

- 2026-10-02，P1；分支 `codex/generate-to-new-node`，起点 `2eda6cbcb020038e9115a11d6557f08c495a06fd`。
- Node v24.12.0、pnpm 11.19.0，复用项目锁文件和本地依赖，无新增依赖。
- 修复组框覆盖节点后未归属、不能随组移动，以及整理时页面滚动范围异常。保留五列整理、连接层级、节点尺寸/内容/连线、一次撤销重做和保存刷新。
- 不修改 Provider、数据库、生成流程；验收只用同源隔离合成项目，不操作真实项目或供应商。
- 起点用户改动 `apps/web/src/index.css`、`apps/web/src/workspace/CanvasNodeToolbar.test.tsx` 和 `docs/resource-input-compatibility.md` 删除保持原样，排除本轮提交；两项现存文件 SHA-256 与起点一致。
- 主证据 `.local-tests/group-membership-arrange-20261002/`；溢出基线、A/B 及截图 `.local-tests/canvas-group-overflow-20261002/`。

## 原因与实现

- 创建空组、移动/调整组框原先未同步 `nodeIds`；整组移动只读取已有成员。四条真实浏览器失败用例分别覆盖创建、扩框、旧空组首次移动及整理前补归属。
- 新增纯函数沿用节点中心、24px 内边距及最小重叠组优先级，只吸纳未归属节点，不抢其他组成员、不改变节点坐标或尺寸。已有成员即使暂在框外也保留，归属上限仍是 500，超限明确报错且计算不部分写入。
- 在创建、组交互开始/结束、整理前同步归属，不在移动每帧扫描。缩放尾帧同步 refs；归属与本次几何编辑共享一次历史，整组轻量拖动态、临时隐藏连线和原有批量卡牌优化保留。
- 页面溢出来自挂在 body 下的分组浮卡：整理后绝对定位锚点移到远处，离场动画撑大文档。A/B 只切换定位时高度为 3205→900→3205。仅对该浮卡使用 fixed，不改变组背景/节点/标题层级，不通过禁止整页滚动掩盖问题。
- 1600×900 合成视口中，50%/100%/200% 缩放的原高度峰值分别为 1645/3205/6326；修复后三档各 90 帧始终是 1600×900，scrollX/Y 保持 0。没有把本次复现描述成永久扩张或页面自动滚走。

## 验证与恢复

- 原相关单测基线 86/86；新增 6 个归属纯函数用例。主回归 12 文件 **337/337**，包括 App、WorkflowCanvas、分组、历史、保存、布局、批量卡牌与工具栏。
- 新归属 E2E **5/5**：新建、扩框、旧空组第一次拖动、整理前修复，以及空组移动覆盖后下次整组移动；验证成员跟随、一步撤销重做、尺寸内容保留和保存刷新。
- 原分组/整理 E2E **12/12**；三档溢出加一个真正空组的追加 E2E **4/4**。共 **21 个浏览器场景**通过，收集页面与控制台错误为空。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 全仓通过；仍有既有大 chunk 提示，未扩大范围拆包。独立只读审查未发现新缺陷。
- 首次冻结构建遇 Windows 全局 Temp 下 esbuild 文件删除 Access denied；改用本轮本地临时目录后构建通过，未安装/升级任何依赖。
- 子代理关闭后其 5189 预览进程停止，已重读检查点、规则和 Git 状态，使用同一冻结目录恢复服务并完成追加验证，未把连接中断当作完成。
- 空组追加用例确认“适配所有节点”并不包含无成员空组；保留既有缩放策略，通过实际画布平移验证空组可找回及浮卡正常，不宣称所有组会在整理后自动进入视口。

## 可复现命令

- 主回归：`pnpm --filter @multimodal-canvas/web test src/App.test.tsx src/workspace/WorkflowCanvas.test.tsx src/workspace/CanvasGroupLayer.test.tsx src/workspace/CanvasNodeToolbar.test.tsx src/canvas-auto-arrange.test.ts src/workspace/CanvasNodeToolbar.arrange.test.tsx src/canvas-utils.test.ts src/workspace/generation-batch-view.test.ts src/canvas-history.test.ts src/canvas-group-utils.test.ts src/canvas-persistence.test.ts src/canvas-editor.test.tsx`。
- 浏览器：设置 `WEB_BASE_URL` 为已运行的隔离静态预览地址，执行 `pnpm --filter @multimodal-canvas/web test:e2e e2e/canvas-group-membership.spec.ts e2e/canvas-group-overflow.spec.ts e2e/canvas-group-menu.spec.ts e2e/canvas-auto-arrange.spec.ts`。禁止使用 8080 或真实项目；夹具拒绝外部和未声明写入。
- 冻结预览：使用隔离端口的 `VITE_API_BASE_URL` 构建到 `.local-tests/`，再 `pnpm --filter @multimodal-canvas/web exec vite preview --host 127.0.0.1 --port 5189 --strictPort --outDir G:/multimodal-canvas/.local-tests/canvas-group-overflow-20261002/fixed-dist`。不在真实用户项目点击整理。

## 发布、回退与后续

- 功能、回归及本地发布已完成。只替换 web 为 `4f369d96d78b`，其余五个容器 ID 保持不变，六个服务均 healthy。8080 项目入口 HTTP 200；从实际入口 `index-CIMJ3u65.js` 解析到 `main-C6BoGAoX.js` / `main-Bv37J3Ag.css`，已检查归属提示和浮卡 fixed 样式确实存在。任务提交、中文 annotated Tag 及推送结果以 Git 记录为准。
- 已从实际运行 web 容器保存不暂停服务的回退镜像 `multimodal-canvas-web:before-group-membership-overflow-20261002`（原镜像 digest 已失效）；后续只替换 web，不重启 API/Worker/存储，不动数据卷。
- 回退：将上述镜像标记为 `multimodal-canvas-web:local`，执行 `docker compose -f compose.yaml up -d --no-deps web`。无数据库或文档格式迁移；前端回退不重写已保存画布，单次归属/布局编辑可以通过撤销恢复。
- 后续待办（不在本轮实施）：若需要整理后立即看到所有节点和空组，再定义包含空组的自动适配及极大画布缩放策略；本轮不强制缩放，也不改变既有五列的组块顺序。
- 验证限于 Chromium PC 合成项目，不外推真实超大媒体项目或其他浏览器性能。
