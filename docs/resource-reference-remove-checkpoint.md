# 资源引用移除保留正文检查点

2026-10-05，P1。目标：文字、图片、音频和视频节点的资源条点击 × 后，移除当前节点对应资产版本的连线及引用，提示词逐字保留，引用名称转为普通文字。

## 基线与边界

- `main`，起点 `7a2c3ed`，上游 `origin/main`；开始时工作区干净。
- Node `v24.12.0`、pnpm `11.19.0`，沿用已安装的依赖与锁文件。
- 修改前 `ResourceMentionEditor.test.tsx`、`App.resource-mention-sync.test.tsx` 共 89 项通过；其中旧用例明确要求解绑后保留连线，解释了资源卡片不能消失的行为。
- 不删除资源库文件、来源节点、其他节点连线或同资产其他版本。不改变生成模式、节点尺寸、Provider 或账号配置；没有数据库迁移或环境变量变更。
- 真实项目在独立浏览器会话中跳到登录页。交互回归使用合成项目与 API Mock，不编辑用户现有画布或发起生成。

## 实现与恢复位置

- 资源条按 `assetId + assetVersion` 移除文字绑定，将全部原始文字交给画布父层。
- 画布层一次保存文档、引用及连线，使撤销、重做和自动保存保持一致；错误保留当前图与文字并显示原因。
- 编辑器、App 和图更新已接通；保留其他资产版本及目标节点、图像编辑原图输入。新增回调纳入拖动稳定性检查。
- `pnpm lint`、`pnpm typecheck` 通过；受影响 Web 任务为本轮实际执行，其余未改包由 Turbo 复用缓存。`pnpm build` 完成 9 个任务，Web 为本轮实际构建；沿用已有大块体积提示。
- `pnpm test:runtime` 8/8；图更新函数 50/50；编辑器与 TextPromptEditor 相关测试 89/89。
- `WEB_PORT=5191`、`VITE_API_BASE_URL=http://localhost:3000` 下运行 `pnpm --filter @multimodal-canvas/web exec playwright test e2e/resource-mention-picker.spec.ts --workers=1 --retries=0 --grep '节点资源条解绑|video 完整编辑器解绑'`，4/4 通过。覆盖文字、图片、音频快捷编辑器和视频完整编辑器、原文保留、来源保留、其它引用保留、保存刷新、一次撤销/重做及浏览器错误检查。
- 浏览器用例最初在自动保存已完成后才记录旧 revision，导致视频用例误报；已改为操作前记录，不要求无改动保存也增加 revision。
- 并行子代理曾因 429 中断；恢复后核对指令、Git 和检查点，确认遗留测试进程已退出，再以最多两个 Vitest worker 接手。此前独立审查未发现本次正常解绑路径的阻断问题。
- 全量 Web Vitest 130 文件、2398 项：2393 通过、5 项超时。App 别名和两个画布用例单独重测通过；图片修改重试用例在停止并行负载后通过（11.3 秒）；Skill 新建用例在修改前 `7a2c3ed` 也复现 5 秒超时，本轮仅用 CLI `--testTimeout=15000` 验证通过（5.7 秒），没有修改存量测试阈值。全量运行本身不能记为全绿，测试耗时稳定性仍是存量限制。
- 本轮日志位于 Git 忽略目录 `.local-tests/reference-remove/`，包括全量、超时复测、修改前对照和部署后浏览器记录。源码与测试已复核，没有新增依赖、环境文件或凭据。

## 本机 Docker 验收

- 标准 `docker compose ... build web` 的编译成功，但后续打包 API 依赖时访问 npm 的 `@msgpackr-extract/msgpackr-extract-linux-arm` 失败；没有修改仓库 Dockerfile 或锁文件。
- 使用 `VITE_API_BASE_URL=''` 直接运行 `pnpm --filter @multimodal-canvas/web build`。首次遇到 Windows esbuild 临时文件占用，给本次进程设置独立临时目录后成功。将产物及现有两份 Caddy 配置打入 `caddy:2.10.2-alpine`，运行层与 Dockerfile 的 Web 阶段一致；临时打包文件在 `.local-tests/reference-remove/web-image/`。
- 仅执行 `docker compose --env-file .env.compose -p multimodal-canvas-app -f compose.yaml up -d --no-deps --no-build --pull never --wait --wait-timeout 90 web`。Web 为 healthy，`http://localhost:8080/health` 返回 200；API、Worker、数据库和存储保持原容器。
- 新镜像：`sha256:5e848a06918df6ffa2c4428320fc89a9e55aa9fdd83255850e08a4a103b4ba98`。网页实际返回 `main-DebSc2JJ.js` 的 SHA-256 与构建文件一致：`ebfed0a1d7b3465dabff66d3f4cb42fdc0de29177634eec0770a433c2aa32cd8`。
- 设置 `WEB_BASE_URL=http://localhost:8080`，重复执行上述四项浏览器回归，4/4 通过（24.7 秒），控制台及页面错误为空。测试仍是 API Mock 和合成项目，不代表已修改或验收用户的真实项目数据，也没有执行真实生成。

## 回滚

仅涉及 Web 编辑逻辑，持久格式不变；回退本次代码或 Web 镜像即可恢复旧行为。旧镜像已保留为 `multimodal-canvas-web:before-reference-remove-20261005`，将它标记回 `multimodal-canvas-web:local` 后使用上面的只更新 Web 命令即可回退。用户执行移除后可用画布撤销恢复，不覆盖画布或资源数据。
