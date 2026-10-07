# 资源引用加载与悬浮预览修复

2026-10-07，P1。修复 `@` 引用的小预览、悬浮卡片显示面积及资产读取链路中的重复请求。

## 基线与验收范围

- 起点 `main @ 0775bdd`，上游 `origin/main`，任务开始工作区干净。
- Node `24.12.0`、pnpm `11.19.0`，依赖及锁文件沿用现有版本。
- 已复现悬浮容器约 280×210px，实际图片仍受 27×27px 缩略条样式约束；组件类名未命中已有悬浮布局规则。
- 旧代码的版本图片代理路径在申请访问地址和读取内容时分别下载当前对象与指定版本，共四次完整对象读取；这是代码路径证据，不代表线上耗时占比。
- 验收要求：图片引用使用同一冻结版本的缩略图，反复悬浮复用可用预览，悬浮媒体完整适配容器；版本原图代理只读取一次完整对象，所有权、缺失资源和存储错误仍正确处理。
- 不改变节点外框、持久化资源格式或生成行为，不调用付费 Provider，不部署生产。此次无数据库及依赖变更；回滚恢复本任务之前的应用代码即可。

## 执行检查点

- [x] 核对代码、版本、上游和工作区，完成只读问题定位。
- [x] 缩略图缓存基线 13/13；API 资产、访问地址及所有权基线 47/47。
- [x] 修复悬浮布局和按版本缩略图入口，验证原图查看与下载保持原文件。
- [x] 合并相同授权请求并隔离账号切换、失效和重试。
- [x] 使用无内容授权检查并消除版本 GET 的重复完整对象读取。
- [x] 完成专项、PC 浏览器、lint/typecheck/test/build 和最终差异检查。
- [x] 同步结果及交付前检查；提交、远端与 Tag 核验结果以 Git 引用和本次交接为准。

本地 Web 验收入口为 `http://127.0.0.1:5187/`，启动命令：`pnpm --filter @multimodal-canvas/web dev --host 127.0.0.1 --port 5187 --strictPort`。浏览器验收使用隔离合成接口，不能当作线上部署或真实存储延迟验收。

## 已验证结果

- 悬浮组件改用 `resource-mention-hover-preview`，与资料条的 27px 样式分离；图片/视频填满可用内框并等比显示，不改变节点外框。本站图片行内、选择器、资料条和 hover 共用冻结版本缩略图，完整详情及下载仍请求原图。
- 签名请求按会话代次、资产、目标版本合并。精确版本签名最多复用 30 秒且提前 5 秒失效，闲置条目上限 64；可变无版本地址只合并在途请求。显式重载、错误、最后消费者卸载、账号/角色切换及迟到响应均有专项覆盖。
- Prisma/S3 的授权阶段通过元数据与 HEAD 检查存在性，版本内容 GET 只下载所选对象。代理版原图链路由四次完整对象读取变为一次；旧自定义 BlobStore 缺少 `exists` 时保留兼容完整读取。所有权、direct/proxy、对象缺失、错误传播与旧适配器回退专项 57/57。
- PC 浏览器 3/3：横图/竖图分别覆盖快捷和完整编辑器、反复悬浮仅一次缩略图 GET、零原图授权直至打开详情、详情恢复 960px 原图、下载字节与原文件一致、冻结 v1、节点尺寸及提示词不变；缺失目录元数据仍安全降级。无未声明请求、console error、pageerror 或 Provider 调用。日志 `.local-tests/resource-mention-preview-browser-final.log`，截图 `apps/web/test-results/mention-preview-final/`，横图快捷与竖图完整截图已目视检查。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm build:runtime` 通过；运行产物测试 8/8。沿用既有大 chunk 提示。最终 `pnpm exec turbo run lint typecheck --force` 的 24/24 task 无缓存通过；构建对未变化包复用缓存，API/Web 构建本轮实际执行。
- 初次 `pnpm test` 遇到系统 TEMP 的 Vitest `mkdir EPERM`，改用逐包单 worker 完成等价回归。已验证 Credential Crypto 13、Domain 406、Observability 21、UI 16、Execution 56、Providers 789、API 1233、Worker 861 项；API 108 与 Worker 28 项设施条件跳过，不算真实设施验收。
- Web 首轮全量 2474 passed / 20 failed；失败均为 `App.resource-mention-sync.test.tsx` 的严格 Mock 未声明三条冻结版本缩略图路径。精确补齐后该文件 20/20。同轮另出现未改动 `RequestPromptDialog` 1600ms 复制反馈定时器在卸载后触发；该文件与修正资源同步文件联合复跑 39/39，零未处理错误。再次执行 `pnpm --filter @multimodal-canvas/web exec vitest run --maxWorkers=2 --minWorkers=1` 为 136 文件、2494/2494，通过且无未处理错误，日志 `.local-tests/resource-mention-preview-web-final.log`。
- 最终只读复核补出跨资产重载边界：重试 A 后切到 B 不应清除 B 的既有或在途签名。已限定只有同一资产授权键的 reload 代次增长才失效，并补两项组合回归。此后 AssetPreview 三文件 63/63、Web typecheck/构建及 PC 专项再次通过；未无故重复无关全仓测试。最终构建遇到 esbuild 系统 TEMP 删除权限错误，改用已忽略 `.local-tests/mention-preview-build-temp` 后重试。
- 最终 PC 浏览器专项再次 3/3，截图目视检查、任务差异、敏感字面量/调试输出扫描及 `git diff --check` 通过。任务开始无用户改动，没有依赖/锁文件、数据库或线上配置变更。

## 验证边界

旧 `node-hover-preview.spec.ts` 扩展集缺少版本缩略图接口及原图尺寸响应头；仅在本地试验补齐后，4K 两档 DPR 像素回归通过，两个原图下载场景继续停在旧输入高度 180px（当前 102px）。试验性旧夹具修改已撤回，原图下载由本次新增场景完整覆盖。不宣称旧扩展集通过。

额外以严格 no-emit 单独检查整个 `resource-mention-picker.spec.ts` 出现三处旧错误（节点类型推断、Window 断言、`resultAsset` 字段），提取 `0775bdd` 原始文件确认同样三处错误；项目常规 typecheck 不包含 E2E。这些旧测试清理归入 `TODO-CONSOLIDATED.md` 的 P2-08，本次没有放宽生产契约或替换旧断言。

未部署线上站点，未实测线上网络与 S3 延迟，不能承诺具体加载秒数。真实 S3/Prisma 设施验收仍待独立配置与验证。

交付目标为 `origin/main`（`https://github.com/lysimportant/multimodal-canvas.git`），附注 Tag `v2026.10.07-resource-mention-preview`。变更无数据迁移，回退应用提交即可；上线需另行部署并核验目标环境。
