# multimodal-canvas 项目指南

本文件适用于整个仓库。先遵守用户当前要求，再核对当前代码和运行结果。旧方案、Git 历史和本地测试报告不能替代当前实现或目标环境验收。

## 当前架构

- PC Web 多模态画布，支持文字、图片、音频、视频节点、资源引用、版本与任务记录。前端 React / React Flow / Ant Design；API Fastify；Worker BullMQ。
- New API 管理身份、分组、模型调用权限、供应商模型能力、定价、预扣、计费与账单。Canvas 不实现钱包、余额、报价、估价、预扣或金额账本。
- Canvas 不按模型名、目录能力、媒体类型、参数白名单或已知型号限制用户的模型选择与生成输入，不重复判定时长、数量、分辨率、比例、模式或引用能力。新型号和未知能力也能提交，由 New API / 上游返回是否支持。
- 协议和字段映射仍属于 Canvas 的传输职责：按实际端点序列化用户输入，保留资源引用与参数，不静默删除、降级或替换。不把协议序列化规则扩展成模型能力门禁。
- PostgreSQL 保存用户归属、画布、任务、授权和资源元数据；Redis 保存队列与运行配置；Cloudflare R2 保存素材对象。R2 是部署必需项，不部署 MinIO。数据库默认 PostgreSQL，可选 Neon，不能强制用户采用 Neon。
- 外部 New API 独立部署。本仓库 Docker 不再包含本地 New API / 免费 Mock 配套环境，也不依赖 `.local-tests` 中的机器专属文件。

入口为 [README.md](README.md)。旧 `docs/*-checkpoint.md`、根目录 TODO / next 方案与旧 Docker 配置可从 Git 历史查看，不恢复为当前入口。

## 模块地图

| 路径                                                | 职责                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/web/src/App.tsx`、`workspace/`、`state/`      | 画布编排、节点/参数编辑、资源与会话状态                          |
| `apps/web/src/management/`                          | 用户资源、任务、管理员审计与服务状态；不包含计费后台             |
| `apps/api/src/`                                     | 身份、所有权、画布/资源/Run 持久化、上传、资源读取               |
| `apps/worker/src/`                                  | 队列消费、生成请求、轮询、结果归档和恢复                         |
| `packages/domain/src/`                              | 共享数据结构、提示词 Skill、引用与短视频复刻；不维护模型能力限制 |
| `packages/providers/src/`                           | New API / Provider 端点序列化与结果解析                          |
| `packages/execution/src/`                           | 持久执行授权、Run/outbox 原子受理、发送防重                      |
| `packages/credential-crypto/src/`                   | 凭据加解密与密钥轮换                                             |
| `packages/observability/src/`、`packages/ui/src/`   | 日志观测、共享组件与主题                                         |
| `prisma/schema.prisma`、`prisma/migrations/`        | 当前数据模型与已发布迁移历史                                     |
| `compose.yaml`、`Dockerfile`、`docker/`、`scripts/` | 构建与 R2 部署                                                   |

执行链：Web 显式提交 → API 核对身份、数据结构和资源归属并冻结版本 → 原子保存 Run、ExecutionAuthorization、RunOutbox → Worker 转发参数 → New API / 上游执行 → R2 归档 → Web 读取结果。

## 必须保留的边界

模型能力开放不取消以下检查：

- 登录、凭据归属、管理员授权、用户/项目/资源/任务所有权与跨账号隔离。
- 请求数据结构、引用存在性、冻结版本、图关系一致性、必要的协议字段。
- 上传/下载路径安全、SSRF、签名和 Webhook 原始 UTF-8 字节验证、敏感信息脱敏。
- 幂等受理与发送记录。创建结果未知时查原 Run / task，不自动重发 POST；本地取消不等于上游取消。
- 用户显式执行。分析、提示词优化、最终生成是独立动作，换资源、恢复会话或浏览页面不自动调用模型。
- 保持模型 ID、URL、字段名、引用 token、代码和用户原文。API 的自然语言执行指令默认英文，界面与开发说明默认中文。

## 画布与提示词

- 节点外框不能被提示词、图片、视频或分析摘要撑大，只能由用户显式拖拽调整；内容在边界内滚动或裁切。
- 保持高频拖动路径的回调、Context value 和未变化节点引用稳定。不能只靠 `React.memo` 推断隔离成立；改 Context 时检查真实订阅测试。
- 保留生成、分叉、连接引用、组移动、迟到事件的所有权、版本与保存语义。默认 PC Web 优先。
- 应用内 Skill 定义在 `packages/domain/src/prompt-skills.ts`，节点与工作台位于 `apps/web/src/workspace/`。这不是 Codex 全局 Skill；来源说明见 README。
- 优化直写提示词可撤销；工作台先预览、采用草稿，再保存。资源 token 的数量、顺序、元数据和冻结指令版本保持兼容。
- 短视频复刻仍为普通 video 节点附加配置，分析整条明确版本的视频，用户逐角色绑定人物；不臆造商品功效，不偷偷截短、加速或丢弃引用。模型是否支持交给 New API / 上游。

## 环境与部署

- 使用 pnpm workspace + Turborepo，版本以 `package.json`、Dockerfile 和 CI 为准；当前 Node 24.12.0、pnpm 11.19.0。
- 依赖缺失先核对清单与锁文件，用 `pnpm install --frozen-lockfile`。不改用另一份锁文件，不安装无关全局包。
- `pnpm db:generate` 只生成 Prisma Client，不迁移数据库。服务端共享包导出 dist，首次运行或共享包变更后先构建。
- API/Worker 开发入口不自动加载根 `.env`；`--env-mode=loose` 只透传已经注入的进程环境。配置用私有环境文件，不能打印或提交。
- Docker 使用显式 `--env-file`，按 README 配置 R2 和外部 New API；Neon 为可选覆盖层。必须同步 issuer、client、instance 与精确回调来源。
- R2 bucket 保持私有，素材通过受鉴权或短时签名的 API 读取。供应商引用必须使用供应商可达的 HTTPS 来源，日志隐藏签名。
- 不把生产 R2、Neon、数据库、用户项目当测试夹具。旧对象存储卷和私有环境文件不得为了配置清理而删除。
- `prisma/migrations/` 是已发布历史，即使含旧计费结构也保留。旧物理表/列不因本轮源代码清理自动删除；数据删除、转换或迁移另列影响、备份、回滚与授权。

## 工作与验证

1. 开始核对分支、上游、HEAD、Git 状态、运行时、依赖和测试基线；保留已有修改。记录目标、验收与范围。
2. 诊断/汇报先只读。实施任务小步修改，不顺带重构、升级依赖或覆盖用户配置。
3. 源码与公开符号说明默认中文，遵循现有 JSDoc/TSDoc 等标准格式。说明非显然业务语义、参数、返回、错误和副作用，不写复述代码的模板注释。
4. 独立任务按模块委派，默认继承主模型，`reasoning_effort: "max"`，`fork_turns` 为 none 或所需正整数。不同代理不并发编辑同一文件；主代理统一检查和验证。
5. 断线后恢复工具，重读本文件、任务检查点与 Git 状态，从最后已验证位置继续。依赖和开发服务临时故障不能当任务完成。
6. 修改业务代码后运行受影响回归，再运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`git diff --check`。Docker 另检查 Compose 渲染、入口脚本和运行时配置；文档检查格式、链接和命令。
7. UI 变更用隔离 Mock 进行 PC 浏览器烟测，检查交互与控制台；涉及布局实际检查截图。单测、Mock、真实 R2/Neon、上游、生产是不同证据层级，跳过不算通过。
8. Web 单测隔离 `VITE_API_BASE_URL=http://localhost:3000`、API CORS 基线 `WEB_PORT=5173`。设施测试只使用明确的 `TEST_*` 连接和专属对象前缀。
9. 交付前检查完整 diff、敏感信息、未完成项与现存数据影响。只提交任务文件，中文 Conventional Commit，正文记录目标、变更、验证、兼容和风险。
10. 小改动推当前上游；跨模块或部署工具等大改动还需中文 annotated Tag。核对 remote/branch/upstream 后推送，核验远程引用，不强推。不能用提交掩盖尚未完成的工作。
