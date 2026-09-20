# New API 账号接入实施与验收记录

更新时间：2026-09-21。主任务 P1；身份、执行授权及数据迁移按 P0 验证。本记录覆盖本地代码、独立 Docker 和合成账号验收。生产部署、共享数据切换及外部付费调用单列。

## 基线与环境

- Canvas：`codex/generate-to-new-node @ 9a0bed9`，上游 `origin/codex/generate-to-new-node`，远端 `https://github.com/lysimportant/multimodal-canvas.git`。
- New API：`main @ 43ee5dbf9`，交付目标 `fork/main`，远端 `https://github.com/lysimportant/forknewapi.git`。保留此前 H3、Wan、渠道及计费定制。
- Node 24.12.0、pnpm 11.19.0、Go 1.26.0、Docker Server 29.7.2、PowerShell 7.6.5；依赖沿用项目锁文件。
- 原始 Canvas 单测基线：Turbo 15 项任务成功；API 983 passed / 85 skipped。跳过项不作为验收通过。
- 用户原有 `docs/resource-input-compatibility.md` 未修改，不纳入本任务提交。SHA256：`56B2C9D2BFB09DCC56720769B9CE12AED4877A29090DEDFBADD2F1FC5B3AA2A7`。
- 独立 Canvas 设施 `mc-acceptance-test-newapi-accounts`：PostgreSQL 19432、Redis 19379、MinIO 19900/19901。联调库 `canvas_newapi_e2e`，最终集成库 `canvas_newapi_final_test`；Worker 使用 Redis DB13，集成使用 DB15。
- 本地页面 `http://localhost:5173`，API `http://127.0.0.1:13001`，New API `http://127.0.0.1:13000`，Mock `http://127.0.0.1:18081`。原 8080 Compose 与共享数据库保持原状态。
- 本机启动：`.local-tests/newapi-account/start-local.ps1`，可用 `-Services api,worker` 单独恢复后台；合成账号与配置位于两仓被忽略的 `.local-tests/`，凭据不写入源码、报告或提交。

## 实现与 C01—C12 去向

| 项目                         | 当前实现或退出位置                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B0/B2 唯一身份               | `newapi-account-client/service/routes.ts`、Prisma NewApiIdentity/LoginTransaction/GroupBinding；New API 新增固定客户端、S256 PKCE、一次性 code、受限 grant 及幂等组 Token 合同 |
| 全部分组                     | 首次同步全部开放组，每组固定 operation ID；包含开放的 auto，精确排除 `神秘分组`，相近名称保留；重复登录复用组 Key，人工改组/禁用/删除明确失效                                  |
| C01/C02 旧公开价格与本地换算 | 旧价格导入器、domain billing/newapi-pricing 和本地人民币结算已删除；通用目录/回执合同保留在 `packages/domain/src/newapi-contracts.ts`                                          |
| C03/C04 分组模型身份         | `NewApiAccountSettings`、Web `query/models.ts`、项目默认、节点分叉、优化/反推与偏好改用本人 credentialId + modelAlias；旧商品偏好明确丢弃，不静默换组                          |
| C05 报价入口                 | 生成/批量/DAG/重试/优化/反推切换到普通运行提交；Web 报价客户端、弹窗、API 账务提交和 OpenAPI 已删除，旧请求明确拒绝                                                            |
| C06 自动报价反推             | 删除只弹费用提示的自动反推 hook、开关与偏好；保留用户主动反推                                                                                                                  |
| C07 旧账号经营               | 删除密码注册/登录/恢复、邮件与旧用户运营入口；管理员按受控 New API 不可变用户 ID 配置，资源/任务/必要审计保留                                                                  |
| C08 旧钱包                   | 删除钱包读写、退款、额度、核账处理器；新账号和查询不再建钱包；B5 清理工具仅面向迁移前的明确旧数据清单                                                                          |
| C09 稳定运行身份             | `packages/execution` 保存原子 Run/执行授权/outbox 与发送意图；API 独立派发 outbox、取消先落库，重复消费沿用同一任务身份                                                        |
| C10 Worker 合同              | `executionBindings` 冻结逐节点凭据/协议/组权限；首次发送前复核，上游受理时再次权威校验；结果未知不重发，已有视频任务继续原身份轮询                                             |
| C11 结构清理                 | 前向迁移 50000 删除 19 个旧模型及旧账号/商品列；60000 删除无消费者的 AiCredential.defaultModels，超时改从凭据所属 NewApiIdentity.preferences 读取                              |
| C12 配置/工具/测试           | 生产不再装配手动 Key 或文件账号设置，旧 fixture/工具/锁依赖已退出；部署示例、Docker smoke、管理员工具与 Linux 验收包列表同步；测试显式注入合成目录                             |

旧业务模块、生产配置与运行消费者已退出。保留项只有通用执行/资源/审计能力、历史迁移、迁移前清理工具和明确拒绝旧请求的边界；不是继续提供旧钱包或独立账号。

## 验证

命令在 Canvas 根目录执行，New API 命令在其仓库执行。脱敏原始日志位于 `.local-tests/newapi-account/`，不会提交生成噪声。

| 检查                                                       | 结果与证据                                                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint/typecheck/test/build/build:runtime/db:validate` | 通过；日志 `final-*.log`。全仓测试 Turbo 15/15 任务成功；Web 927、API 752、Providers 446、Domain 163、Execution 7 项通过；普通测试中的设施跳过单独启用                                     |
| API 最终 PostgreSQL/Redis/MinIO 集成                       | 32/32，通过；`api-integration-b6-final.log`，覆盖账号、全部组、并发登录/重放、资源隔离、凭据恢复、历史迁移和跨进程文字/图片/音频冻结归档                                                   |
| Worker 全量含 PostgreSQL                                   | 322/322，通过、无跳过；`worker-recovery-final.log`，包含双用户超时偏好隔离及重新登录后原视频任务恢复                                                                                       |
| 额外资源与持久化集成                                       | 37/37，通过；`account-resource-final.log` 的独立 `admin_account_test_newapi` 资源测试 2 项，以及 `api-extra-integration-final.log` 的 Run/Skill 35 项                                      |
| HTTPS 生产模式入口                                         | 22/22，通过；`production-entry-final.log`，真实 TLS 代理、Cookie 会话、CORS、错误脱敏与缺配置拒绝启动                                                                                      |
| Redis 跨进程限流                                           | 9/9，通过；`rate-limit-final.log`                                                                                                                                                          |
| 清理与 Docker 配置脚本                                     | 25/25，通过；`tool-tests-final.log`                                                                                                                                                        |
| PC 浏览器                                                  | 真实双用户 9 项检查通过；四组 active、保存默认模型、单次文字生成归档、项目/凭据/设置隔离与退出；pageerror/console/request failure/5xx 均为 0。报告 `web-pc-smoke-results.json`，截图已检查 |
| Web 合成 Playwright                                        | 5/5，通过；覆盖 1440、1024、390 宽度；已登录空工作台不再显示登录按钮，有独立回归                                                                                                           |
| 新版 Docker smoke                                          | 11 项检查通过，`docker-smoke-report.json`；固定节点 ID 已改为包含项目 UUID，支持重复运行，两个账号均退出                                                                                   |
| New API Go                                                 | `go vet ./...`、`go test ./...`、`go build ./...` 通过                                                                                                                                     |
| New API 数据库矩阵                                         | SQLite 3.50.4、MySQL 5.7.44、PostgreSQL 9.6.24：fresh、upgrade、repeat、数据/索引/唯一约束通过；`database-matrix-final.log`                                                                |
| New API 前端                                               | 认证改动 lint/typecheck、redirect 回归 7/7 通过；此前全量 1693/1695，两项既有超时单独重跑均通过                                                                                            |
| New API 最终镜像                                           | Docker 重新构建并健康启动；`rebuilt-newapi-smoke.json` 的 7 项检查通过：登录、四组 active、包含 auto、精确排除、同步/重登复用及退出失效                                                    |

优化任务的真实 PostgreSQL/Redis 队列恢复也已启用：`prompt-queue-final.log` 1/1 通过，终态移除后不重发。

媒体逐模型闭环记录在 `media-acceptance.md`；本地 Mock 成功不等于外部供应商或真实费用验收。更广范围的供应商条件见 [Provider 验收边界](newapi-provider-acceptance.md)。

五模型本地 Mock 均通过：文字、图片、`MiniMax-H3`、`wan3.0-video`、`wan3.0-video-prime` 各完成归档和读回，每场景一个创建 POST。H3 遭私网地址拦截后使用独立实例的精确 Mock 白名单恢复；同时修复 Worker 对已受理视频重复校验首次发送权限修订的问题。原 Run/上游任务不变，恢复零新增 POST。此前 unknown/失败任务保留，未用新提交覆盖原记录。

## B5/B6 数据演练与回退

B5 工具 `scripts/newapi-cleanup.mjs` 默认 preview，精确用户 UUID、实例 fingerprint 和计划 digest 共同限定范围；执行前在 Serializable 事务中复核数据，unknown/sending、活跃任务、未结费用、跨范围引用均暂缓。数据库提交后对象失败可用原计划续做，不新增 Provider POST。

隔离演练通过：20 行/3 个独占对象清理，共享对象保留；对象连接失败后原计划恢复及重复执行；pg_dump 与 5 对象 manifest 恢复；无旧 Prisma delegate 的 raw-only 客户端验证通过。B5 独立容器已停止，备份与卷保留，报告 `b5-acceptance.md`。

B6 两次前向迁移有显式事务和遗留数据门禁，不改已应用历史迁移。9 项验收通过：fresh/repeat、脏库拒绝、失败不丢旧行/列、清理后 upgrade/repeat、数据库恢复、旧凭据偏好拒绝以及转换后 repeat；`b6-migration-results.json`。联调与最终测试库已迁至 60000，schema diff 为零。

共享实例目前仅做只读盘点：2 个旧用户、3 个所属项目、58 个所属 Run、46 个所属素材；总 65 Run、74 Provider job 均为终态，钱包 1、旧报价/扣费/成本/核账/outbox 为 0；另有 owner-null 项目 16、素材 19 和共享凭据 27。没有执行共享 apply、DROP、清队列或删除对象。

共享切换前按计划第 10 节：确认保留资源的目标身份、冻结旧提交、保存数据库/对象/队列/密钥恢复点、执行已复核清单、再部署配套两端及新迁移。旧数据门禁报错必须处理清单，不能绕过或直接改历史迁移。回退使用对应备份和对象 manifest；Git 回退不能恢复数据，也不能用旧备份覆盖切换后的新作品。

## 本地交付与后续切换

工程实现、隔离迁移/清理演练、PC Web 和五模型 Mock 验收已完成。最终恢复修复后复跑全仓 `lint/typecheck/test/build/build:runtime`，记录在 `delivery-*.log`。本批交付 Tag 为 Canvas `v2026.09.21-newapi-accounts` 与 New API `v1.0.0-rc.37.custom.14`，分别对应当前 Canvas 分支与 fork/main；实际提交及推送核验结果在任务交付中提供。

生产部署、共享旧数据处理、真实供应商素材外网访问/付费回执及已发布 outbox 丢失 Redis job 的运维恢复入口继续列为独立待办。下一阶段从共享清单与备份恢复点开始，不重复本机合成验收，也不用本地结果代替目标环境证据。
