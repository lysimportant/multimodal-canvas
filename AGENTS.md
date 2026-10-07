# multimodal-canvas 项目指南

本文件适用于整个仓库。项目路径均相对仓库根目录；先遵守用户本轮范围，再按下述入口理解和修改项目，不把历史方案当成当前实现。

## 1. 项目定位与阅读顺序

这是以 **PC Web 为优先**的多模态创作画布：用户组织文字、图片、音频和视频节点，通过连线与资源引用生成内容，保存素材版本、任务记录和画布。前端采用 React、React Flow、Ant Design；后端是 Fastify API、BullMQ Worker、Prisma/PostgreSQL、Redis 和 S3/MinIO。账号授权、分组及上游费用由 New API 负责，不另建旧钱包或邮件账号体系。

开始工作时按任务阅读，不需要通读所有历史记录：

| 入口                                                                                                                        | 用途                                                                          |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [TODO-CONSOLIDATED.md](TODO-CONSOLIDATED.md)                                                                                | 当前未完成、受阻、后置事项；不能当作全部功能已验收的证明。                    |
| [next.md](next.md) 与 `docs/*-checkpoint.md`                                                                                | 需求背景、专项检查点、最近验证与恢复位置；核对日期和当前代码。                |
| [New API 接入检查点](docs/newapi-account-implementation-checkpoint.md)                                                      | 身份、凭据、队列隔离与切换边界；后台待办另见 [TODO-ADMIN.md](TODO-ADMIN.md)。 |
| [管理页面说明](apps/web/src/management/README.md)                                                                           | 资源、运行、审计、服务状态页面的职责边界。                                    |
| [TODO-SERVER.md](TODO-SERVER.md)                                                                                            | 目标环境、真实供应商和生产设施仍需完成的验收。                                |
| [Agent 公共底座](TODO-AGENT-COMMON.md)、[画布 Agent](TODO-AGENT-CANVAS-NODE.md)、[独立页面 Agent](TODO-AGENT-STANDALONE.md) | 当前为待评审方案，不能描述成已实现功能；两种入口共用公共契约。                |

根目录目前没有 `README.md` 或 `TODO.md`，使用上述真实入口，不凭空引用不存在的文件。遇到历史文档的失效链接，先查 Git 历史及用户改动，不能擅自恢复已删除文件。

## 2. 模块地图

| 路径                                         | 职责与修改入口                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/App.tsx`                       | 工作区编排：画布、历史、保存、生成、资源联动。这里仍持有大量画布状态，不能假定全部状态在 Zustand。              |
| `apps/web/src/workspace/`                    | `WorkflowCanvas.tsx` 负责画布交互，`AssetNode.tsx` 负责节点展示与尺寸，`NodeQuickEditor.tsx` 负责参数和提示词。 |
| `apps/web/src/state/`                        | 工作区偏好及按用户隔离的节点模型偏好；修改需检查会话切换和持久化兼容。                                          |
| `apps/web/src/management/`                   | 资源、任务、安全审计和服务状态；隐藏 UI 不能替代服务端授权。                                                    |
| `apps/api/src/`                              | Fastify 启动、接口、身份与所有权校验、持久化、上传及 Run 创建；入口 `index.ts`。                                |
| `apps/worker/src/`                           | 队列消费、执行、Provider 调用与结果归档；入口 `index.ts`。                                                      |
| `packages/domain/src/`                       | 共享类型、Zod 校验、画布/输入合同、模型能力、提示词 Skill 与短视频复刻规则。公开数据格式修改先从这里核对。      |
| `packages/execution/src/`                    | 持久执行授权、Run/outbox 原子受理与 Provider 发送意图防重；不依赖旧钱包。                                       |
| `packages/providers/src/`                    | Provider 适配、精确模型/合同字段映射、任务状态和错误处理；不能根据相似模型名推断能力。                          |
| `packages/credential-crypto/src/`            | 凭据加解密与密钥轮换。                                                                                          |
| `packages/observability/src/`                | 共享日志、指标与链路观测。                                                                                      |
| `packages/ui/src/`                           | Ant Design 薄适配、主题和共享组件；保留表单语义，不另建平行组件体系。                                           |
| `prisma/schema.prisma`、`prisma/migrations/` | 数据模型与已纳入版本管理的迁移；不得用清库替代迁移或兼容处理。                                                  |
| `scripts/`、`docker/`                        | 构建、隔离验收、Docker 启动和运维工具；运行前辨明副作用。                                                       |

主要执行链为：Web 提交 → API 校验并冻结输入/资源版本、模型与凭据 → 原子保存 Run、ExecutionAuthorization 与 RunOutbox → 队列派发 → Worker 执行图并调用 Provider → 归档素材版本与状态 → Web 获取结果。分析、提示词优化和媒体生成是不同动作，不因展示页面、换资源或恢复会话而自动执行生成。

## 3. 环境与启动

- 使用 pnpm workspace + Turborepo。根 `package.json` 固定 `pnpm@11.19.0`；CI 和 Dockerfile 当前固定 Node `24.12.0`。版本以这三处文件为准，不擅自升级依赖或改用另一份锁文件。
- 依赖缺失时先核对清单、锁文件和实际运行时；用 `pnpm install --frozen-lockfile`。不要安装无关全局包；本项目常规运行不要求 Python 或 `rpython`。
- 配置参考 [.env.example](.env.example) 和 [.env.compose.example](.env.compose.example)。真实环境文件、密钥、素材及用户数据不进入 Git，也不打印到日志或回复。
- 真实登录/执行需要可达且登记了精确回调地址的 New API；生产队列与账号授权需要数据库。`WORKER_PROVIDER=mock` / `RUN_SERVICE=memory` 是测试能力，不等于完整登录和真实生成环境。

API/Worker 入口只读取 `process.env`，现有 `dev` 脚本**不会自动加载根 `.env`**。先以安全方式将所需配置注入当前进程环境，再按包启动或显式选择 Turbo 环境透传；`--env-mode=loose` 只透传已有环境，不是环境文件加载器。`turbo.json` 当前未声明环境白名单，不能假定默认模式会保留全部业务配置。

开发常用命令（在根目录执行；外部设施和上述环境注入需先完成）：

```powershell
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
pnpm exec turbo run dev --parallel --env-mode=loose
```

`pnpm db:generate` 只生成 Prisma Client，不迁移数据库，根 `build/dev` 不会自动先执行它。服务端五个共享包导出 `dist`，首次运行或修改共享包后先构建；`packages/ui` 则直接导出源码。`dev` 没有构建前置任务，不能指望应用 watch 自动重编共享包。`pnpm build:runtime` 在常规构建后生成 API/Worker 的 `dist/server.mjs`，不启动服务。

`pnpm dev` 是默认环境模式下的并行启动脚本，使用前注意上述环境透传条件；开发启动不替你启动 PostgreSQL、Redis、MinIO 或 New API。仅启动 Web 可用 `pnpm --filter @multimodal-canvas/web dev`；默认 Web 端口 5173、API 端口 3000，以环境配置和实际日志为准。端口被占用时明确选择并报告替代端口，不停止不属于本任务的服务。浏览器 API 地址由 `apps/web/src/workspace/contracts.ts` 的 `VITE_API_BASE_URL` 控制；开发默认 `http://localhost:3000`，正式 Web 构建使用空值访问同源接口。修改端口/来源需同步核对 CORS 与登录回调，不能把 Vite 的 127.0.0.1 地址和 localhost 注册地址混用。

- `docker-compose.dev.yml` 仅提供开发 PostgreSQL、Redis、MinIO 及 bucket 初始化，不是完整应用。
- `compose.yaml` 是完整正式构建运行栈。Windows 用 `./scripts/docker.ps1 -Action Status` 查询；用户要求启动时用 `-Action Start -NoBrowser`。`-Action Build -NoBrowser` **会重建并启动**，不是只构建。启动流程含迁移，先确认目标环境与数据风险。
- 通用 Compose 与已有 `-LocalNewApi` 环境不能混用；后者要求本机已完成对应初始化。具体步骤见 [Windows Docker](docs/docker-desktop.md)、[Linux/Compose](docs/docker-server.md) 和 [冒烟检查](docs/docker-smoke.md)。
- `pnpm db:migrate` 是 `prisma migrate dev`，仅用于明确的开发库。数据库、队列、对象存储的清理、迁移或覆盖先说明影响、备份与回滚，破坏性操作单独取得用户授权。

## 4. 验证方式

代码任务的常规检查为：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

`pnpm test` 包含运行产物测试与各包测试；`pnpm test:runtime` 只验证运行产物打包。`lint` 主要是 Prettier 检查，不能替代类型检查和业务回归。先做受影响模块专项，再做与风险匹配的完整检查；报告失败、跳过项和未测范围，不能用缓存或历史通过记录冒充本轮结果。

定向测试可直接调用包内工具，例如：

```powershell
pnpm --filter @multimodal-canvas/web exec vitest run src/App.test.tsx src/workspace/WorkflowCanvas.test.tsx
pnpm --filter @multimodal-canvas/domain exec vitest run src/prompt-skills-toolkits.test.ts src/video-recreation.test.ts
pnpm --filter @multimodal-canvas/web exec playwright test e2e/video-recreation.spec.ts --workers=1
```

- Web 浏览器测试入口是 `pnpm test:e2e`，配置为 `apps/web/playwright.config.ts`。`WEB_PORT` 默认 5173；设置 `WEB_BASE_URL` 后使用已有站点，不再自动启动 Vite。先确认目标、Mock/拦截覆盖和写入范围，不能把现有用户项目当测试夹具。
- UI 修改至少验证启动、核心交互和控制台错误；涉及布局需实际检查 PC 截图。性能比较使用相同节点/边/媒体负载、窗口与构建，避免 HMR 或并行构建干扰，不以渲染次数直接冒充 FPS。
- Web 单测按 `VITE_API_BASE_URL=http://localhost:3000` 的开发契约验证；不要把正式构建的同源空值带入单测，运行前隔离环境。API 测试需留意 `WEB_PORT=5173` 的默认 CORS 基线及环境泄漏。设施测试使用隔离 `TEST_DATABASE_URL`、Redis namespace、S3 bucket/prefix，不能指向用户数据库或对象。
- Windows 隔离验收入口为 `./scripts/verify-isolated.ps1 -Action Start`，随后 `-Action Test`，结束用 `-Action Stop`；首次执行前阅读脚本及端口/项目参数。它需要 Docker，测试阶段会对专用库执行迁移，并涉及 OpenSSL。缺少设施导致的跳过不算集成测试通过。
- Mock、隔离集成、本机 Docker、真实 Provider、生产部署是不同证据层级；只有实际完成的层级才能标记通过。
- **纯文档任务**可使用格式、路径/命令核对和差异检查作为等价验证，无需无故触发迁移、部署或付费请求。`.prettierignore` 排除了 `AGENTS.md`，检查本文件须显式运行 `pnpm exec prettier --check AGENTS.md --ignore-path .gitignore`。

## 5. 画布修改的硬约束

- 节点外框不得被提示词、分析摘要、图片或视频内容撑大；只允许用户显式拖拽调整尺寸，预览在既定边界内滚动或裁切。
- 拖动是高频路径。保持节点回调、Context value 和未变化节点的引用稳定，不让坐标更新向所有节点广播；不能仅靠 `React.memo` 假定隔离成立。
- 回调/Context 新增时同步检查 `apps/web/src/App.test.tsx` 的稳定性覆盖及 `apps/web/src/workspace/WorkflowCanvas.test.tsx` 的真实订阅渲染测试；性能专项见 `apps/web/e2e/next-performance.spec.ts`。
- 生成、分叉、连接引用、组移动和迟到事件需保留所有权、历史、冻结版本与保存语义。默认 PC Web 优先，移动端扩展不挤占本轮范围。

## 6. 应用内 Skill 与短视频复刻

### 应用内 Skill

这里的 Skill 是**产品内提示词能力**，不是 Codex 全局 Skill：

- 定义、稳定 ID、指令版本和资源占位符校验：`packages/domain/src/prompt-skills.ts`。
- Web 调用：`apps/web/src/prompt-skills.ts`；节点入口及用户 Skill 工作台位于 `apps/web/src/workspace/` 的 `PromptSkillPanel.tsx`、`SkillWorkbench.tsx`。
- 来源和适配关系见 [工具包映射](docs/prompt-skills-toolkits.md)；能力与恢复边界见 [Skill 检查点](docs/prompt-skills-checkpoint.md) 及 [工具包检查点](docs/prompt-skills-toolkits-checkpoint.md)。目录数量、ID 和版本以当前代码为准，不沿用旧文档的数量。
- `G:/novel-studio/doument-canvas` 中秋月盈、灰灰、洲洲工具包是外部只读参考，不是运行依赖。使用其内容先读该目录说明并保留来源；不自动运行附件或下载脚本，不把留存快照当成当前在线状态或授权证明。
- 节点显式优化后直写提示词且可撤销；工作台升级先预览、采用到草稿，再单独保存。优化提交独立文字 Run，不读取引用媒体内容，也不自动生成媒体；资源 token 的数量、顺序、元数据与冻结指令版本必须保持兼容。

### 整条短视频复刻

入口与恢复流程见 [短视频复刻检查点](docs/video-recreation-node-checkpoint.md)。主要实现：`apps/web/src/video-recreation.ts`、`apps/web/src/workspace/VideoRecreationPanel.tsx`、`packages/domain/src/video-recreation.ts`。

- 这是普通 `video` 节点附加 `videoRecreation` 配置，不能未经迁移设计新增第五种持久化媒体类型。
- 对明确版本的**整条短视频**分析，不默认增加片段选择。用户逐角色绑定人物；商品可选，不提供替换时保留原商品，不臆造商品功效。
- 原视频、人物、商品冻结资源版本；换人物/商品只本地重组提示词，不重复分析。分析和最终生成分别由用户显式点击，不能串成未经确认的收费请求。
- 版本级分析通过 `purpose=video_recreation` 与普通反推隔离。首次分析先保存画布；创建结果未知时保留原幂等键、模型和凭据身份，有 `runId` 后只查询该任务；分析结果已返回但保存失败时只补保存。
- 全片时长、输入角色或模型能力不支持时明确阻断；不能静默截短、加速、取整非整秒时长或丢弃引用。真实模型成片效果需独立验收。

## 7. Provider、身份与安全

- 以实时模型目录、精确模型 ID 和已确认 Provider 合同校验能力；前端提示不能替代 API/Worker/Provider 边界校验，未知组合明确失败，不静默降级。
- New API 插件新增或变更能力、字段及其语义时，必须在实施规划阶段与 `D:/newapi/AGENTS.md` 和对应插件合同完成双边核对，明确双方适配范围；核对 Canvas 的精确模型 ID、生成模式/路由、请求与持久化序列化，并据此安排受影响的合同回归。复现或基线测试可先行，不能等到回归测试阶段才判断另一侧是否需要适配。不得从插件字段名称推断 Canvas 已支持对应能力。
- 模型 API 的自然语言执行指令默认英文；用户界面与开发说明默认中文。模型 ID、URL、字段、代码、引用 token 及语言本身有意义的用户原文保持不变。
- 付费创建请求结果未知时先查记录与任务 ID，不自动重发 POST；重试和幂等范围以确认的供应商合同为准。不要凭本地取消推断远程任务已取消，不猜测取消接口。
- Webhook 签名校验必须基于原始 UTF-8 body，不重新序列化 JSON；回调、时间窗口、重放和跨进程恢复的真实合同仍按 TODO 独立验收。
- 资源与任务持续验证所有者，管理员使用专用接口；管理员映射使用 New API 不可变用户 ID，不按邮箱、昵称或首个登录用户提权。账号/凭据切换须隔离缓存、迟到响应及旧队列消费者。
- 真实密钥不得进入源码、文档、测试、日志或构建产物。排查配置只读取必要的非敏感字段；轮换见 [凭据轮换](docs/credential-rotation.md)。

## 8. 工作方式、交付与当前边界

1. 先确认 Git 仓库、当前分支/上游、HEAD、已有改动、运行时/依赖及测试基线，记录目标级别 P0/P1/P2、验收标准和不做事项。没有 Git 时先提醒用户，除非用户明确不要 Git；已有修改和删除一律保留。
2. 用户问“为什么/诊断/汇报”时先只读，不擅自修复。实现任务先复现或确认需求，小步修改，不顺带重构、格式化全仓或引入无关依赖。
3. 中文 JSDoc/TSDoc 与现有注释风格一致；公开 API、跨模块符号和复杂逻辑说明用途、参数语义、返回、错误及副作用，不用模板注释复述代码。
4. 可独立并行的任务按模块划清子代理责任，默认继承主模型并使用 `reasoning_effort: "max"`；避免并发修改同一文件，主代理统一检查差异和验证结果。
5. 阶段完成更新本任务对应的 TODO/检查点。断线重连后重读本文件、检查点与 Git 状态，从最后验证点继续；只重跑可安全重复的检查，不把临时失败当成完成。
6. 提交前检查完整差异、敏感内容及用户原有改动。完成任务后仅提交本任务文件，使用中文 Conventional Commit，正文说明目标、影响、验证、兼容和风险。小改动验证后推当前上游；大改动还需中文附注 Tag。先核对 remote/branch/upstream，推送后核验远程引用；无上游时如实说明，不强推、不创建空提交。

截至 **2026-10-04** 的待办提示（不是完成声明）：

- 短视频复刻入口的拖动广播已通过稳定回调修复；原因、红绿回归、实际构建对照及验收边界见 [拖动回归检查点](docs/canvas-video-recreation-drag-checkpoint.md)。新增节点 Context 时继续保留真实订阅测试，不能只核对外层回调。
- 供应商真实合同/成片效果、New API 共享或生产切换、目标生产环境、超大画布持续验证及存量 E2E 失败等仍按对应 TODO 和专项检查点推进。修改本指南时同步移除已关闭的临时提醒，但不能只凭旧测试通过记录关闭任务。
