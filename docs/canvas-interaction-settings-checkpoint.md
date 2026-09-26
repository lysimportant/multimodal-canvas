# 画布输入缩放、并发设置与资源抽屉检查点

更新时间：2026-09-26。P1：PC Web 画布交互与生成调度设置。

## 基线

- 分支 `codex/generate-to-new-node`，起点 `ea461479226c4ad9bc0cefa1539434269be21b65`，上游 `origin/codex/generate-to-new-node`。
- Node `v24.12.0`、pnpm `11.19.0`；依赖已安装，沿用锁文件，不计划引入新依赖。
- Docker 的 Web、API、Worker、PostgreSQL、Redis、MinIO 均运行且健康；Web 为 `http://localhost:8080`。
- 用户已有 `docs/resource-input-compatibility.md` 修改，SHA256 为 `56B2C9D2BFB09DCC56720769B9CE12AED4877A29090DEDFBADD2F1FC5B3AA2A7`，不得覆盖或包含在提交中。
- 根目录没有 README.md；依据 `TODO-CONSOLIDATED.md` 和 `docs/node-resource-concurrency-checkpoint.md` 恢复范围。上一轮验证不能代替本轮验收。
- 本轮改动前 WorkflowCanvas 与 NodeQuickEditor 测试 160/160 通过，日志 `.data/canvas-interaction-baseline.log`。

## 验收目标

- [x] 节点输入面板跟随画布缩放；手动调整节点宽度时输入区域适配，内容不反向撑大节点。
- [x] 实际任务默认并发 20；管理员设置页可保存并调整到大于 20 的合法整数，调度生效且不取消已在运行的任务。
- [x] 经用户确认，仅当前账号已配置为 Canvas 管理员；真实会话刷新后可编辑生成并发，实际保存值仍为 20，详见下方权限配置续接。
- [x] 资源栏默认只显示顶部至搜索框；悬停/点击展开，收起后下方画布可见且可交互。
- [x] 外观连接选项文字、说明、预览互不重叠；新增沿源节点到目标节点运行的单亮点短尾迹特效。
- [x] 相关回归、lint、typecheck、test、build、PC 浏览器与 Docker 启动检查通过。
- [x] 检查任务 diff、凭据模式与用户修改；代码交付范围为本文记录的四项及对应回归，Git 交付按当前分支和下述标签核验。

## 边界与风险

- 不恢复历史丢失图片、不扩展音频和移动端、不调用真实付费 Provider、不修改用户画布数据。
- 保留同节点防重复提交、未知请求禁止重发、原有归档恢复和权限隔离。
- 并发设置涉及服务端调度与新增配置合同：优先沿用现有持久化/队列机制，不做数据库迁移；写操作复用已有权限校验，拒绝非法值，不把界面成功提示当成 Worker 生效证明。
- 抽屉和连线偏好兼容旧本地存储。缩放只改变输入面板显示与定位，不改持久化节点外框。
- 部署前记录旧镜像和服务状态；仅重建涉及的应用服务，保留数据库、Redis 和对象存储卷。失败时可回切旧镜像；新增可选设置保持旧数据可读。

## 分工与恢复位置

- 主代理：输入面板缩放、隔离浏览器验收、集成检查、文档、部署与提交。
- 并发代理：API/Worker 配置与设置页，必要共享合同及单测。
- 资源代理：ResourcePanel、App 资源栏集成、工作区布局和抽屉偏好。
- 外观代理：AppearancePicker、连线效果与独立测试；偏好允许值在资源代理完成后串行集成。
- 资源与外观代理已交接并关闭；主代理已串行接入 `shooting-star` 偏好及全部旧特效兼容测试。
- 输入面板定向测试 38/38 通过；资源抽屉和偏好集成测试 53/53 通过。Web typecheck/build 已通过，保留原有大 chunk 提示。
- 静态产物浏览器已通过滚轮缩放、显式拖拽尺寸、180px 最小节点操作栏三项；只有手动拖拽会修改节点尺寸，没有 Provider 提交。
- Vite 首轮完整浏览器回归有超时及 trace 写入异常，未放宽 timeout。已切到固定构建和独立输出目录，不把该轮结果算通过。
- 静态验收定位出抽屉点击收起后重开的真实问题：替换鼠标下的箭头 SVG 会产生伪悬停；保留同一 SVG 并旋转后，悬停/固定/收起/Escape 与下方画布命中测试通过。
- 13 项静态浏览器回归已有前 12 项通过；最后一项纠正为现有“资源拖入提示词后确认引用”合同，不新增拖入画布复制节点行为。真实拖放发现并修复 link/copy 不匹配，以及原生拖拽结束后残留悬停两处问题；修复后该项单独通过，日志 `.data/canvas-interaction-drag-final-browser.log`。ResourceMentionEditor 48/48、ResourcePanel 19/19 通过。
- 并发模块已交接并关闭代理。有界本地上限配合 Redis 全局上限，不使用极大领取容量或私有 marker 唤醒。管理员 GET/PATCH `/v1/admin/generation-concurrency` 持久保存队列级正安全整数；未配置返回明确 503，界面允许确认后初始化/恢复，不伪称默认值已保存。
- 正式服务只读检查：实际队列 `canvas-accounts-v1`，旧 Worker 环境并发为 4，全局并发元数据未设置；active/waiting/paused/delayed 均为 0。本轮还没有调用真实 Provider 或改用户画布。
- 全库回归发现并修正两组过时测试：启动门禁不再把 21 当非法值；11 处从资源库添加图片的旧测试现在先悬停展开抽屉。没有为了旧测试回退新行为。画布交互 59/59 重新通过。另修正 ProjectHub 测试中 AntD 选项刚挂载就断言可见的竞态，保留可见性要求并等待其真正显示，不放宽超时或改业务代码。
- 全库 `pnpm lint`、`pnpm typecheck`、`pnpm test:runtime`、`pnpm exec turbo run test --concurrency=2 -- --maxWorkers=2 --minWorkers=1`（`WEB_PORT=5173`）及 `pnpm build` 均通过。日志 `.data/canvas-interaction-final-{lint,typecheck,runtime,test,build}.log`。Web 为 84 文件、1,232 测试通过；运行时为 8/8。根测试中依赖特定数据库/外部环境的条件跳过不计作通过。
- 静态构建 13/13 严格 Mock 浏览器验收通过，日志 `.data/canvas-interaction-final-preview-complete-browser.log`；所有外部/未知请求、重复生成和 console/pageerror 异常均为零。E2E 文件还单独经 `tsc --noEmit --strict` 检查，不依赖忽略 e2e 的 Web tsconfig。
- 构建仍保留已有的大 chunk 警告；拆包不属于本轮范围。
- 回滚镜像已保留为各应用的 `rollback-canvas-settings-20260926-ea461479` 标签。按实际 linux/amd64 manifest 验证与运行容器一致，而不是把容器 config digest 误当 image index。记录 `.data/canvas-interaction-deployment-rollback.json` 与 `.data/canvas-interaction-rollback.override.yaml`；不复制容器环境或凭据进镜像。
- 已完成本地 Web/API/Worker 镜像构建和空队列门禁后的服务更新，未运行 migrate 或重建基础设施。当时剩余用户决策为普通账号是否获得部署级管理权限；随后已获授权并完成真实会话验收，见下方权限配置续接。

## 并发隔离验证与生效边界

- 主代理重新执行并落盘 Worker 141/141、API 25/25，日志为 `.data/canvas-interaction-isolated-worker-final.log`、`.data/canvas-interaction-isolated-api-final.log`。包括真实 Redis 默认 20/第 21 等待、1→32、3→1、多 Worker 全局约束、配置缺失/断连暂停及恢复、客户端重建后保留设置。
- 使用已有独立测试容器 `canvas-result-recovery-test` 的 `redis://127.0.0.1:16389/0`；夹具限定该地址并使用 UUID 队列，仅回收自己创建的测试数据。合成 Provider 禁止外部 fetch，不连接正式业务 Redis、不触发付费生成。
- Worker 验证命令：`pnpm --filter @multimodal-canvas/worker exec vitest run src/generation-concurrency.test.ts src/generation-concurrency.integration.test.ts src/worker-concurrency.integration.test.ts src/startup-config.test.ts src/startup-entry.test.ts --maxWorkers=2 --minWorkers=1 --fileParallelism=false`；上述独立地址通过 `WORKER_CONCURRENCY_TEST_REDIS_URL` 显式传入。
- API 验证命令：`pnpm --filter @multimodal-canvas/api exec vitest run src/generation-concurrency.test.ts src/generation-concurrency.integration.test.ts --maxWorkers=2 --minWorkers=1 --fileParallelism=false`，使用同一独立测试环境。
- 上限按 Run 计，不改变单个 Run 的 DAG 顺序。满载扩容要等待在途任务完成后的调度机会；缩容不取消在途任务。设置保存不等于强行立即改变活动任务数量。
- 配置每秒读取，单次最多等待两秒；故障检测并非瞬时或严格三秒 SLA。元数据缺失到检测暂停前，多 Worker 总量可能超过旧全局值，但每个 Worker 仍保留有限本地上限。
- 首次启动用 `meta.concurrency` 的 HSETNX 原子初始化，已有保存值优先；运行中丢失则暂停，管理员可显式恢复。数据丢失后重启只能按初始值初始化，不能恢复已经丢失的旧设置。升级 BullMQ 时需重新验证这一元数据字段合同。
- 故障用例断开的是隔离配置客户端，不代替 Redis 灾难恢复、网络分区、持久卷丢失或真实 Provider 限流/计费验收。

## 本地部署与最终验收

- 构建命令 `docker compose --progress plain build api worker web`；部署命令 `docker compose up -d --no-deps --no-build --wait --wait-timeout 180 --timeout 1800 api worker web`。构建和启动日志分别为 `.data/canvas-interaction-docker-build.log`、`.data/canvas-interaction-docker-deploy.log`。
- 更新前 active/wait/paused/delayed 均为 0；更新后六个服务健康。PostgreSQL、Redis、MinIO 的容器 ID 与启动时间完全不变，没有执行迁移、删除或覆盖数据卷。门禁和结果见 `.data/canvas-interaction-deploy-gate.json`、`.data/canvas-interaction-deployment-after.json`。
- 新 Worker 环境 `WORKER_CONCURRENCY=20`，实际 Redis `bull:canvas-accounts-v1:meta` 的 `concurrency` 为 20；不只是改界面默认数字。API/Worker 内置 health 命令均通过，Web `/health` 为 200。
- 正式 8080 产物再次完成 13/13 严格 Mock 浏览器验收，日志 `.data/canvas-interaction-deployed-browser.log`。所有写操作仍被隔离夹具拦截，不写真实画布或配置。
- 独立真实页面只读冒烟：登录加载提示可见、项目正常恢复，原有 3 个节点 ID 和 5 个资源与更新前一致；资源栏默认紧凑，浏览器 error 日志为零。未编辑提示词、点生成、重试历史 unknown 请求或保存真实并发设置。
- 初次真实设置页验收显示普通用户权限提示，默认 20 的队列行为已生效；随后用户确认授予当前账号 Canvas 管理员，权限配置与非 Mock 验收见下节。
- 回滚可使用已保存的覆盖文件，仅切回应用镜像及旧 Worker 初值 4；不清除新增 Redis 配置或用户数据。回滚前仍须核实在途任务，不能强制中断付费请求。
- 本轮提交范围显式排除 `docs/resource-input-compatibility.md`，原 SHA256 保持不变。交付分支 `codex/generate-to-new-node`，目标 `origin`，标签 `v2026.09.26-canvas-interaction-settings`；具体提交与远端同步结果以 Git 记录及本轮任务报告为准。

## 当前账号管理员配置续接（2026-09-26）

- P1 权限配置，起点 `b3d68178eb6c95913e6dff9d5932f78ba1de871a`；工作区仅有上述用户文档修改，运行时与依赖未变化。
- 授权范围：只调整当前已登录账号的 Canvas 角色，不修改 New API 站点角色、其他账号、生成并发或画布数据，不发送生成请求。
- 身份依据：新开的后台页能恢复用户指定私有项目且显示普通用户；项目路由按会话用户过滤所有权，数据库仅按项目 owner 关联受信任 issuer 与不可变外部 ID。未按昵称或邮箱认领。
- 修改前：允许名单为空，目标角色为 `USER`，六服务健康；当前库没有其他账号。身份与容器只读基线保存于被 Git 忽略的 `.data/canvas-admin-permission-baseline.json`，不记录密钥或完整会话。
- 已在被 Git 忽略的 `.env` 追加 `MC_NEW_API_ADMIN_USER_IDS`；渲染前后配置比较确认仅允许名单变化。运行 `docker compose up -d --no-deps --no-build --wait --wait-timeout 180 --timeout 1800 api`，API 健康后执行现成 `docker compose exec -T api node docker/run.mjs admin <已核实的外部 ID>`。目标角色已为 `ADMIN`，允许名单同时保证后续登录不会恢复为普通用户。
- 权限为账号级：同一账号其他仍有效的会话也会读取最新角色，不是仅给当前浏览器开放按钮。回滚需恢复原空允许名单、仅重建 API，并让精确目标重新完成登录以同步为 `USER`；若需立即降权则另行授权精确目标的数据库角色恢复，随后验证管理员接口返回 403。仅移除名单或回退 Git 不会自动撤销已有 `ADMIN`，现成 admin 脚本只能提权。无需数据迁移、删除卷或重发任务。
- 真实浏览器验收：后台页刷新即可读取新角色，无需注销原会话；设置 → 生成并发显示当前保存 20，输入 21 后保存按钮启用，再改回 20 并重新读取，确认保存值仍为 20。未点击保存并发，浏览器 error 日志为零。原画布页未刷新或编辑。
- 运行后检：只重建 API 且镜像未变化，其他五个服务的容器 ID 与启动时间不变；六服务健康，API/Worker 内置 health 通过，Web `/health` 返回 200。其他账号角色摘要、项目 revision 和节点/边/资源数量、Run 总数均未变化；Redis 全局并发仍为 20，active/wait/paused/delayed 均为 0。
- 证据：`.data/canvas-admin-permission-config.json`、`.data/canvas-admin-permission-api-recreate.log`、`.data/canvas-admin-permission-role-apply.log`、`.data/canvas-admin-permission-after.json`、`.data/canvas-admin-permission-browser.json`。这些本地记录不进入 Git，提交中不包含个人身份或真实凭据。
- 本轮检查：显式 `WEB_PORT=5173` 执行 `pnpm lint`、`pnpm typecheck`、`pnpm build`，均退出 0；日志为 `.data/canvas-admin-permission-{lint,typecheck,build}.log`。构建仍只有既有的大 chunk 警告，未改依赖或源码。文档 Prettier、`git diff --check` 与 admin 脚本语法检查通过。
- 子代理独立权限回归：隔离 Vitest runner（入口 `node --input-type=module -`）禁用 `.env` 读取与网络，仅执行 auth、auth-service、auth-routes、generation-concurrency、auth-store-concurrency 的内存测试，5 文件、42 用例通过，2 个文件持久化用例按只读范围跳过；准确输入脚本与结果见 `.data/admin-permission-regression.log`。本轮未重复全库及数据库/Redis 集成测试，也未执行真实生成。
- 收尾：任务 diff 与凭据检查通过，用户文档 SHA256 不变。只提交本检查点，不提交 `.env`、本地身份记录或用户文档修改；交付分支 `codex/generate-to-new-node`，目标 `origin`，单独注释标签 `v2026.09.26-canvas-admin-permission`。配置已在本地生效，不会通过 Git 自动传播到其他部署；提交与远端核验记录见 `.data/canvas-admin-permission-delivery.json`。
