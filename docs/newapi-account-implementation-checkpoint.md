# New API 账号接入实施与验收记录

更新时间：2026-09-21。主任务 P1；身份、执行授权及数据迁移按 P0 验证。本记录覆盖本地代码、独立 Docker 和合成账号验收。生产部署、共享数据切换及外部付费调用单列。

本轮接续基线：Canvas `ce6d5b4234630891adc191974f99058fb77c225a`，New API `727c274e7861a3542339a771197b6141e86df912`。两端运行服务仍为独立环境；本轮没有执行共享清理或生产调用。

## 本轮补齐结果

- `POST /v1/runs/:runId/recover` 已补齐：仅接受 `{}`，沿用原 Run/outbox/授权/发送身份；核对队列、用户、项目、attempt、retryOf、幂等键与三份快照指纹。成功或取消的任务不再投递，unknown/sending 拒绝，撤销拒绝，取消只恢复本地收尾。PostgreSQL/Redis 恢复集成 14/14，HTTP/运行/限流 82/82 通过。
- New API 人工改期不再被同步复活：普通 `Token.Update()` 在事务内锁管理关系和 Token，人工变更期限标记 `changed`，与配置一起提交或回滚；普通改名不终止管理，Canvas 内部续期不经此入口。过去时间、缩短期限、永久期限、撤销后改期、重新授权和失败回滚均覆盖；SQLite 3.50.4、MySQL 5.7.44、PostgreSQL 9.6.24 三库通过。
- 持久化回读原来遗漏 `videoMode`，使缺尾帧场景误发请求；现按领域合同读取节点字段，保留视频模式、完成动作、批量和资源字段，同时仍排除内部与废弃字段。真实 PostgreSQL 往返和缺尾帧预检回归 22/22 通过。
- Worker 的新请求发送意图移到最终请求持久化、资源复核后的发送边界。本地校验失败不再留下 unknown 发送记录；最终发送授权失效仍零 Provider POST。定向 69/69 通过。
- 普通、批量、DAG、显式优化、手动文本反推和取消后重试均有本地实际入口证据。特殊入口成功各 1 次 POST，取消原 Run 为 0；所有授权绑定同一所属用户/default/原 credential。终态恢复额外 POST 为 0，跨用户恢复为 404。
- 两个 Wan 的视频/音频参考已完成签名对象读取；H3 首帧另有非零合成计费对账。Mock 实际 GET 5 个冻结对象均 200，H3 500 quota = 0.001 USD，New API 用户/Token/分组/请求/任务/唯一消费日志一致，Canvas 账务记录为 0。只证明本机跨容器与 Mock 合同，不证明公网真实供应商。

本轮最后完整检查：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm build:runtime` 均退出 0；Turbo 15/15，API 753 passed / 75 skipped，跳过项不计入集成通过。New API `go test ./...`、`go vet ./...`、`go build ./...` 和三库矩阵通过，独立 Docker 镜像重建后 healthy。完整日志为 Canvas `final-*.log`、`recovery-integration-final.log`、`recovery-routes.log`、`continuation-video-mode.log`、`continuation-send-boundary.log`；New API 日志在 `.local-tests/canvas-account-b0/continuation-*.log`。

PC 前端本轮没有源码变化。此前真实双用户 9 项烟测与四组选择/生成/退出截图均通过，pageerror/console/network/5xx 为 0；本轮已复核设置、生成、第二账号空工作台截图，Web、API、New API 健康检查均 200。浏览器工具在最终复核中发生调用路由异常，未将未执行的交互计作新增通过，也未重跑生成。镜像重建后的两账号 HTTP 烟测 6 项通过：四组 active、同步复用、已有结果读取、资源/凭据隔离、退出会话失效，新增 Provider POST 为 0，见 `final-surface-smoke-results.json`。

## 本轮证据索引

下列文件位于被忽略的 `.local-tests/newapi-account/`，仅含脱敏报告，不加入 Git。

| 文件 | 已证明内容 |
|---|---|
| `entries-results.json` | 批量与 DAG 各 2 次创建；原终态 Run 恢复零创建；跨用户 404 |
| `special-entries-results.json` | 优化、手动反推、取消后重试，各成功一次；取消原任务零创建 |
| `media-full-results.json`、`media-full-audit.md` | 原 16 场景证据；第 17 场景发现 videoMode 丢失，原失败报告保留 |
| `media-final-results.json` | 修复后缺尾帧、非法 H3 分辨率均正确拒绝且零 POST；后续 Mock 脚本异常单列 |
| `media-signed-recovered.json`、`media-signed-audio-recovered.json` | Wan 视频/音频成功记录的只读补证，额外创建为 0 |
| `media-billing-reconciled.json` | Wan Prime 视频/音频、H3 首帧成功；5 次签名 GET、500 quota/0.001 USD 对账 |
| `shared-review-latest.json` | 共享只读备份、隔离恢复、对象逐字节校验和清理 preview；`applyAllowed=false` |

`media-final-results.json` 中 Mock Python 签名 URL 解析曾异常，原 Run `run_idem_0722de3888f0fa6b70a2965276f8408e9bdc9e0406245ca2fd93f205f528e0b9` 保持 unknown，不重发。成功报告曾被过严脱敏断言拒绝；非零计费脚本曾误认为无限 Token 的 remain quota 不递减。两项报告问题均以只读补证解决，原 failed 文件保留，不改写为全场通过。

独立对象代理为 `canvas-acceptance-object-tls`，Docker 网络别名 `assets.canvas-acceptance.example.com`。恢复 Worker 时须设置 `S3_PROVIDER_ENDPOINT=https://assets.canvas-acceptance.example.com`；`.local-tests/newapi-account/start-local.ps1` 的默认配置不包含此项。Mock 使用专用自签 CA 校验代理；TLS 私钥不进入报告或 Git。测试后的 New API SSRF 配置和 H3 价格均恢复，H3 价格回到 0；这不是生产配置建议。

## 共享实例切换包：仅预览，暂不可应用

共享源实例为原 8080 Compose，源数据未改。只读备份位于 `.local-tests/newapi-account/shared-review-1789940384573/`，恢复到 `canvas_shared_review_1789940384573_test` 及独立对象卷；副本仅应用删表迁移 50000 之前的增加结构迁移。

| 恢复点 | 大小与校验 |
|---|---|
| `database.dump` | 294889 bytes；SHA256 `aa8736db46279d0efa4ab9dc7035781de25af2a6c4a8219083180f78e136d659` |
| `canvas-objects.tar` | 163174912 bytes；SHA256 `c0a08de7ee8da0d2a148e032e5266dbc81022a0ae2339aaa047f773e0078b169` |
| 隔离恢复结果 | 2 用户、19 项目、65 素材、65 Run、74 Provider job，活跃 Run 0；对象逐字节相同 |
| `cleanup-preview.json` | digest `c9a9514d782c683c8b75f0e55fd7ab71dbf661ec62d24fc2429493571996b266`；21 行可清理、0 对象、1 用户暂缓、`applyAllowed=false` |

用户 `e6129ad9-7792-4116-9055-8c27d340b4ac` 的 21 行仅列入预览，未 apply。用户 `87d6b5ec-9ecf-413a-a8fc-d93a1e7f62f3` 因以下原请求 unknown 暂缓；本地 Run failed 不证明未收费，无上游任务/请求 ID 时不得补发或清理：

| Run | 精确模型 | 原请求 |
|---|---|---|
| `run_idem_acfd20789b825d0fa1890c811eaea91ec10aa25062a5fa55b81ddd25000bc734` | `grok-4.6` | `POST /chat/completions#1` |
| `run_0a78bfb2-a214-4ca1-baf5-d9e59cc9821f` | `gpt-image-2.5-sunburst` | `POST /images/edits#1` |
| `run_cf8ffdc5-9484-4b23-b5b5-3bab123b51e7` | `gpt-image-2.5-sunburst` | `POST /images/edits#1` |

仍需明确 owner-null 的 16 项目、19 素材和 27 共享凭据的归属；没有指定接收身份，不归给首次登录者。本轮未独立备份/恢复密钥，也未完成队列恢复点，不能称为完整灾备。正式切换前须冻结旧提交，核实上述请求与未结费用，确认保留身份，重新生成 preview 和 digest，再对具体清单取得授权。不能直接用本次旧 digest 删除后续新增数据。

## 计划第 9 节逐项验收账本（2026-09-21）

下表把计划中的场景和证据分开记录。`隔离通过` 只表示专用数据库/Redis/对象存储或本地代码合同已通过；`Mock/运行环境通过` 还包含本地 Docker New API、Worker 和合成供应商；`目标环境待验` 不得解释为生产或真实供应商通过。

| # | 验收项 | 状态 | 证据或剩余边界 |
|---:|---|---|---|
| 01 | 授权成功、取消、过期、重放、账号切换 | 隔离通过 | 授权/会话/回放集成与双用户 PC 报告；目标 HTTPS 仍待验 |
| 02 | 无邮箱、资料修改、同名重建 | 隔离通过 | New API 身份集成覆盖不可变外部 ID 和资源归属 |
| 03 | 旧登录及跨标签页切换 | 隔离通过 | 旧入口拒绝、退出撤销和迟到回调回归已通过 |
| 04 | 并发同步、上游已建但回包丢失 | 隔离通过 | 原 operation/token 复用测试通过，未增加成功组 Key |
| 05 | 首次全部组建 Key、增加组、切换模型 | Mock/运行环境通过 | Docker smoke：4 个 active 组、重复同步复用；新增组补建逻辑有回归 |
| 06 | `神秘分组` 精确排除 | Mock/运行环境通过 | 目录为 `auto/default/vip/神秘分组-可用`，精确排除规则通过 |
| 07 | 多组模型汇总及选择 | Mock/运行环境通过 | 四组目录与 credential 归属在设置页和 API 通过 |
| 08 | `auto` 范围与显式变化 | 隔离通过 | 空范围拒绝、排除组不路由；目标站点 Auto 顺序仍待验 |
| 09 | 部分组失败或令牌数量达限 | 隔离通过 | 限额保留成功组、失败组原因和 auto 空范围回归通过 |
| 10 | Key 从 G1 改到 G2 | 隔离通过 | 管理令牌人工改组/撤销和旧绑定失效回归通过 |
| 11 | 账号组、模型限制及热缓存 | 隔离通过 | Redis 缓存失效和跨进程权限修订回归通过 |
| 12 | 预期分组受理竞态 | 隔离通过 | 受理前权限变化在 Provider POST 前拒绝且零发送 |
| 13 | 两用户、两分组、同名模型 | Mock/运行环境通过 | PC 双上下文项目、设置、凭据和退出隔离通过 |
| 14 | 凭据过期、撤销、断开、轮换 | 隔离通过 | 撤销后新提交拒绝，人工改期限不被同步复活；三库通过 |
| 15 | 普通、批量、DAG、优化、反推、重试 | Mock/运行环境通过 | `entries-results.json`、`special-entries-results.json`：普通、批量、DAG、优化、手动反推与取消后重试通过 |
| 16 | 入队失败、重启、重复消费、未知创建结果 | 隔离通过 | 14/14 恢复集成、82/82 HTTP/运行/限流；unknown 仍拒绝自动重发 |
| 17 | 新旧任务混合及旧页面提交 | 隔离通过 | 旧报价/账务入口拒绝，模式从服务端快照回读；旧数据收尾仍待共享切换 |
| 18 | 保留项目、默认模型、导入导出 | 部分通过；目标环境待验 | 资源归属与节点字段回读通过；共享 owner-null 项目接收身份未定 |
| 19 | 测试账号清理、外键、对象、队列、恢复 | 隔离通过；共享切换受阻 | B5 备份/恢复和清理工具通过；共享 preview `applyAllowed=false`，未执行删除 |
| 20 | New API 不可用、禁用与撤销 | 隔离通过 | 明确拒绝账号会撤销 Canvas 会话；目标部署故障演练仍待验 |
| 21 | 旧广场、钱包及后台同步退出 | 隔离通过 | 源码、路由和测试确认新任务无 Canvas 钱包/报价写入 |
| 22 | 手动 Key 管理与遗留引用清理 | 隔离通过 | 普通界面不显示 Key 表单/连接操作；共享旧引用仍待清单处理 |
| 23 | 平台商品字段与本机缓存退出 | 隔离通过 | 节点/项目默认/优化/反推使用 credentialId + modelAlias |
| 24 | 无本地货币门槛的目录 | Mock/运行环境通过 | 五模型目录与调用未创建 Canvas 报价；真实目录定价状态仍待验 |
| 25 | 报价提醒型自动反推退出 | Mock/运行环境通过 | 主动优化/手动反推各一次成功，未触发自动生成 |
| 26 | 迁出的通用执行能力 | 隔离通过 | Run、授权、outbox、取消、重试和恢复定向回归通过 |
| 27 | 旧只读钱包及邮箱运营入口退出 | 隔离通过 | 读取设置/账号不 upsert 钱包；生产旧入口部署状态待验 |
| 28 | H3、两个 Wan 与文字/图片 | Mock 通过；真实调用待验 | 五模型各一创建 POST 并归档；媒体补证报告记录签名视频/音频 |
| 29 | 素材外部访问、费用及取消 | Mock 通过；真实调用待验 | 5 次签名素材 GET 200；H3 一笔 500 quota/0.001 USD 对账；真实供应商待验 |
| 30 | PC Web 启动、连接、刷新、选模、生成、退出 | Mock/运行环境通过 | 双用户 9 项、0 pageerror/console/network/5xx；本轮未重复生成 |

计划仍不能关闭：共享 8080 实例切换、共享 unknown 请求处理、生产 HTTPS/管理员外部 ID、真实供应商回执/插件版本和密钥恢复点。详见检查点的共享切换包和 Provider 边界。

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

## 首批实现验证（本轮增量见文首）

命令在 Canvas 根目录执行，New API 命令在其仓库执行。脱敏原始日志位于 `.local-tests/newapi-account/`，不会提交生成噪声。

| 检查                                                       | 结果与证据                                                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint/typecheck/test/build/build:runtime/db:validate` | 首批通过，日志 `delivery-*.log`；Web 927、API 752、Providers 446、Domain 163、Execution 7 项通过。本轮 `final-*.log` 为更新后的检查，API 753 passed / 75 skipped；普通测试中的设施跳过单独启用 |
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

共享实例完成只读盘点、备份和隔离副本恢复：2 个旧用户、3 个所属项目、58 个所属 Run、46 个所属素材；总 65 Run、74 Provider job 均为本地终态，但仍有 3 个原请求 unknown。钱包 1、旧报价/扣费/成本/核账/outbox 为 0；另有 owner-null 项目 16、素材 19 和共享凭据 27。没有执行共享 apply、DROP、清队列或删除对象，精确预览和恢复校验见文首共享切换包。

共享切换前按计划第 10 节：确认保留资源的目标身份、冻结旧提交、保存数据库/对象/队列/密钥恢复点、执行已复核清单、再部署配套两端及新迁移。旧数据门禁报错必须处理清单，不能绕过或直接改历史迁移。回退使用对应备份和对象 manifest；Git 回退不能恢复数据，也不能用旧备份覆盖切换后的新作品。

## 本地交付与后续切换

工程实现、隔离迁移/清理演练、PC Web 和五模型 Mock 已有首批验收。首批交付为 Canvas `ce6d5b4` / `v2026.09.21-newapi-accounts` 与 New API `727c274e7` / `v1.0.0-rc.37.custom.14`。本轮补齐恢复、视频持久化/发送边界和人工期限修复，交付 Tag 为 Canvas `v2026.09.21-newapi-acceptance`、New API `v1.0.0-rc.37.custom.15`，分别推送 `origin/codex/generate-to-new-node` 与 `fork/main`，实际提交和远端核验在任务交付中记录。

生产部署、共享旧数据处理、真实供应商素材外网访问/付费回执仍待完成；原 Run 恢复入口已实现。下一阶段从共享 unknown 请求与保留归属、队列/密钥恢复点及目标环境配置开始，不重复本机合成验收。普通前一代码版本可回退本轮源码，但会重新出现已修复的期限和发送边界问题；本轮未新增 schema 迁移，不能通过回退代码复活已经 changed 的管理授权。
