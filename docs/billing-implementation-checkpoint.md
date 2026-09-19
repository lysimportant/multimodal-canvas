# 平台计费实施检查点

更新时间：2026-09-19。状态：核心实现、隔离 PC Web 和全部补丁后的完整检查已通过，已具备本轮代码交付条件；尚未启用生产收费，外部合同、支付和运维上线条件继续保留。

## 目标与范围

按[方案](billing-and-model-marketplace-plan.md)实施统一平台服务端计费。用户已确认结算币种为人民币 `CNY`；上游成本保留原币种，首期不自动换汇。独立平台模型、版本化调用绑定与价格、钱包事务、各提交入口及 PC Web 广场/后台/账单已接通，当前以最终验收结果决定交付状态。真实支付、生产迁移和付费 Provider 验收不在当前自动执行范围。

数据库改动采用新增表和可空关系，不删除或追扣历史任务，不清空资产、usage、目录或凭据。迁移先在专用隔离数据库验证；真实环境升级前备份数据库和密钥。已有冻结及流水后回滚只能停止新任务并使用兼容版本处理存量，不用旧备份覆盖新流水。

## 基线

- 分支 `codex/generate-to-new-node`，起始提交 `6efecde`。
- 原有未提交修改仅 `docs/resource-input-compatibility.md`，本任务不编辑、不提交该文件。
- Node `v24.12.0`，pnpm `11.19.0`，PowerShell `7.6.5`；项目依赖存在。
- 现有 `multimodal-canvas-app` 服务运行中，本任务不修改该环境；单独建立隔离设施。
- 实施前 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。2,899 通过、70 skipped、5 pending；后两项为未执行设施测试，不能计为通过。日志在 `.data/billing-implementation/baseline/`。

## 分工与执行

用户要求分发 100 个 subagent；当前环境最多同时运行 4 个代理（含主代理）。按独立模块分批派发，每批最多 3 个子代理，记录实际派发与验证结果，不把未启动的代理算作完成。

1. 第一批：任务运行路径只读审计、模型及前端接入只读审计、基线检查，均已完成。
2. 主代理：数据库合同与迁移、跨模块集成、文档、最终验收和 Git 交付；其他代理按明确文件范围领取实现。
3. 第二批：纯领域金额与定价合同、Worker 交付先于成本持久化修复、平台模型服务与路由；前两项已完成，平台模型 15 项定向测试已通过。
4. 第三批：API 报价与全部提交入口、Worker 钱包授权与逐项结算、PC Web 管理页面已实现并完成各自定向验证。
5. 第四批：账务一致性、API 参数与兼容边界、outbox/取消及 Worker 恢复复核；运行别名、已归档项释放和成本持久化时序问题均修复并回归，完整检查与隔离浏览器闭环通过。累计实际启动 8 个不同子代理，达到代理任务数量限制后复用已有代理，未启动 100 个独立代理。

## 当前实现

- 新增独立平台模型、版本绑定/价格、钱包/追加流水、报价/逐项收费、Provider 成本、待核实、outbox 及切换标记；迁移在 `mc-acceptance-test-billing` 专用设施部署成功，Prisma schema diff 无差异。现有应用数据库未修改。
- 模型 API 支持候选同步与选中导入、手工草稿、版本绑定和价格、发布校验及旧引用唯一映射。同步不覆盖人工字段和售价，更换 API 保留平台身份及历史版本；普通响应使用字段白名单，不暴露凭据或成本。
- 生成、批量、工作流、提示词优化、资源反推及显式重试共用五分钟人民币报价和确认身份。付款人来自真实会话，Run、报价消费、余额冻结和 outbox 同事务写入；工作流报价覆盖全部实际收费节点。
- PC Web 已增加 `/models`、`/admin/models`、`/admin/billing`、`/account/billing`，节点/默认模型读取同一平台目录；执行前显示最高费用和余额。自动反推只提醒进入面板确认，不再静默调用。
- Worker 验证逐项冻结授权，先持久化可恢复交付证据，再按实际计量结算。执行结果未知保持待核实，已知任务身份和交付证据用于恢复，成本缺失不得触发新的生成。
- Provider 返回后先严格持久化脱敏 `received` 收据及明确费用。正常路径仍按归档→用户结算→上游成本处理；取消或归档失败路径只补原响应成本，不把收到响应当作用户交付。旧 `UsageLedger` 无法精确保留的十二位原币种费用只保存在 `ProviderCost`，并记录 `legacy_unrepresentable` 和原因，不舍入、写零或阻断已确定交付。
- 已归档结果在最多三次队列尝试后仍无法恢复账务时，进入独立 `worker_recovery` 事项；后台可查询依据但不能释放或对已归档子项重新生成，必须按原 Run 恢复账务，恢复成功再关闭事项。`settlement_conflict` 保留原消费，后台只读提示核对原流水及计量后另行退款，不能按成本确认或执行释放关闭。
- 钱包金额使用 `10^-9 CNY` nanos 和 `Decimal(38,0)`，业务用 `BigInt`，JSON 为完整十进制字符串。原币种成本使用 `Decimal(38,12)`，支持规范化指数文本，超出精度明确拒绝。
- 管理员释放/确认成本、事项关闭及操作者/原因审计同事务；首条成本事实不覆盖，裁决证据独立保存。新成本冲突重开已关闭事项并保留旧决策，已裁决重复事实不重开，迟到交付不重新扣款。
- 数据库 UUID、普通 `run_*` 和幂等 `run_idem_*` 恢复同一外部运行身份，查询、列表、账单、取消和重试均命中原账务；缺失映射时明确拒绝。待核实调用允许只读报价，但实际重试确认返回 409，不冻结或发起新调用。删除运行历史后仍可凭外部运行编号查原账单。
- 人工释放在同一事务内检查已归档证据和开放 `worker_recovery`，即使同时存在可见 `execution` 事项也不能释放应恢复账务的冻结。
- 账务后台新增“收费与成本”，按任务查询收费项及原币种成本摘要；详情和待核实“查看依据”读取同一份交付计量、观察事实、独立裁决和分页审计。服务端一致读事务配合嵌套字段白名单，避免返回凭据、用户输入和生成正文。
- 已新增共享本地包 `@multimodal-canvas/billing`，通过 pnpm workspace/lockfile 链接，无新增外部运行依赖。接口和错误边界已登记 `billing-openapi.ts` 并与已有提交接口合并。

## 当前计量与运行限制

- 输入 Token 尚无可信计量，虽可维护 `per_token` 规则，提交仍返回 `metering_unavailable`，不能将估算输入作为收费依据。
- 每个真实调用当前仅支持 `n=1`；多结果通过独立批量调用处理，不能用一次 POST 请求多个结果却按一项计费。
- `per_second` 报价要求明确正整数时长；`output_metadata` 仅使用归档后 `ready` 的可信时长。`provider_usage` 秒数合同尚未接通，缺实际计量时用户收费项仍待核实。
- `per_character` 仅支持输入完整冻结的 `openai-audio`，按 Unicode 码点计数，限 1–4096；连线/提及导致输入未确定时拒绝此计费方式。
- 待核实事项期限为 24 小时，后台显示逾期但不自动释放、补扣或重发；外部 usage 对账接口、通知和运营处理制度仍需验收。
- 正式模型调用要求 `DATABASE_URL` 和 `RUN_SERVICE=bullmq`，内存模式仅允许 Mock。API/Worker 需共享数据库、队列名称、加密密钥和资产存储，不能让成本写入失败成为第二次 Provider POST。
- 首期仅管理员发放内部测试额度，个人账户没有自充值入口；余额不足提示联系管理员补充测试额度。
- 运维对原失败 job 执行 `job.retry('failed')` 会恢复整个 DAG。已归档子项不重复 POST，尚未发送且已授权的下游节点可能首次执行；仅全部执行节点已归档或已有持久取消意图时，恢复才保证零新增 POST。已发布 outbox 对应 Redis job 丢失的安全重建入口尚待实现及验收。
- 当前没有恢复 API/CLI；同 job 修复仅有集成测试演示，需按[运维恢复边界](billing-and-model-marketplace-plan.md#运维恢复边界)核对队列、指纹、归档证据及已耗尽尝试。长期数据库失败可能连恢复事项都无法写入，不能只靠后台待办监控故障。

## 已取得的阶段证据

以下是各逻辑阶段的实际结果；重复覆盖的测试不能与下方最终全量结果相加。

| 范围              | 命令或证据                                                                               | 已验证结果                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 迁移              | `prisma migrate deploy`、`prisma migrate diff --exit-code`                               | 三个新增迁移在独立 PostgreSQL 部署，schema 无差异                                                           |
| 金额和规则        | `packages/domain/src/billing.test.ts`                                                    | 65 项通过，覆盖精度、单位、计量来源和上限                                                                   |
| 钱包与裁决        | `pnpm --filter @multimodal-canvas/billing test`，显式 `TEST_DATABASE_URL`                | 17 项通过，其中 16 项使用真实隔离 PostgreSQL；含并发冻结/裁决、幂等、回滚、冲突重开、小额精度与迟到不重扣   |
| 账务 API          | `cost-api-test.log`，`vitest run src/billing-routes.test.ts`                             | 5 项通过，覆盖真实管理员身份、原子入口、金额序列化、成本详情权限及嵌套字段白名单                            |
| 完整提交 API      | `vitest run src/billing.integration.test.ts`，隔离 PostgreSQL + Redis；`outbox-test.log` | 8 项通过，覆盖人工模型→报价→额度→Run/冻结/outbox、队列失败恢复、取消交错、争用、未知重试阻断、换 API 与权限 |
| 平台模型服务/路由 | 模型服务及路由定向测试                                                                   | 15 项通过，含导入/手建、版本、发布、同步不覆盖、换 API 与响应白名单                                         |
| Worker 交付顺序   | 成本持久化修复阶段定向测试                                                               | 309 项通过、3 项设施门控跳过；仅代表该阶段                                                                  |
| Worker 账务适配   | `vitest run src/billing-execution.test.ts src/billing-worker.test.ts`                    | 初期 15 项通过；最新完整与真实设施恢复结果见下方                                                            |
| PC Web 管理页     | `cost-ui-test.log`，`management-pages.test.tsx` 及既有管理测试                           | 8 项计费管理测试及此前 21 项既有管理测试通过，包含原币种成本与用户结算分离展示                              |
| 成本只读详情集成  | `cost-integration.log`，隔离 PostgreSQL + Redis                                          | 完整提交 API 8 项再次通过，其中包括成本冲突、人工裁决和只读查询，原始成本事实不被裁决覆盖                   |
| PC Web 全量测试   | `test.log` 中 Web 任务                                                                   | 77 个文件、1,138 项通过；同一日志中的 API 任务失败，不能将整份日志认定为全量通过                            |
| 隔离基础设施      | `infrastructure-final.log`                                                               | 39 项 PostgreSQL/设置同步、9 项 Redis、22 项 HTTPS 生产模式代理测试全部通过，迁移无待执行且 schema 无差异   |
| 管理员浏览器      | `admin-smoke.cjs`、`admin-models.png`、`admin-browser-errors.json`                       | 手工新建、绑定、¥0.06 按次定价、发布及账务页通过；采集的 `pageerror` 为空                                   |
| 用户浏览器        | `browser-final.log`、`smoke-result.json`、`worker.log`                                   | 模型广场→¥0.12 报价→确认→真实队列 Worker 执行与归档→`succeeded`/`SETTLED`；采集的 `pageerror` 为空          |
| 退款与核实释放    | `refund-result.json`、`refund-admin.png`                                                 | 已结算项退款、旧待核实项释放成功，最终可用余额 ¥10、冻结 ¥0；采集的 `pageerror` 为空                        |
| 上传入口回归      | `upload-transport-final.log`                                                             | 修复测试入口配置后 31 项通过，后续完整 API 回归通过                                                         |
| 类型/构建/格式    | billing build/typecheck、API typecheck、Web build、定向 Prettier                         | 对应阶段通过；Web 构建仍有既有大包提示                                                                      |
| 全量类型检查      | `typecheck.log`                                                                          | 该阶段 15 个任务成功，补丁后的完整结果见下方                                                                |

上述相对日志和浏览器产物均位于 `.data/billing-implementation/`；数据库合成记录与 API 集成报告另保留在隔离库和 `.data/billing-integration/`。浏览器使用真实 API、BullMQ、Worker、PostgreSQL 和隔离 MinIO，Provider 为 Mock，真实 Provider POST 次数为零。生成验收 Run 为 `run_a89eddd4-9cc3-4d89-acb0-dd06acf2993b`，报价和结算均为 `120000000` nanos。`browser-final.log` 前段显示的是旧失败任务，新提交的 `DELIVERY` 和 `smoke-result.json` 已确认成功；旧 `browser-smoke.log` 不能作为成功证据。

最终浏览器 `final-browser-result.json` 与 `browser-release.log` 已在全部补丁后的 API/Worker 运行包重启后确认报价取消、费用不变、成本详情和账户切换；取消时执行 POST 为 0，`pageerror`、`console.error`、失败响应均为空。管理员通过真实 UI 确认合成成本 `0.000000000123 USD`，详情同时保留人民币消费和退款，不自动换汇。1440×1000 页面截图已检查；模型广场首行被固定页头遮挡的问题已修复，Web 构建和浏览器重验通过，产物为 `*-final.png` 与 `web-build-final.log`。最新重验时间为 2026-09-19 11:57（Asia/Shanghai）；`final-browser.log` 保留此前阶段结果。

旧 `test.log`、`lint.log` 及 `cost-web-typecheck.log` 中的失败保留为排查记录，`*-final.log` 为中间阶段完整检查结果。运行别名、已归档项释放和成本事实持久化问题均已修复；全部补丁后的最终结果以 `*-release.log` 为准。

## 最终完整检查

| 检查                 | 证据                    | 结果                                                                                                        |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm lint`          | `lint-release.log`      | 9/9 任务成功                                                                                                |
| `pnpm typecheck`     | `typecheck-release.log` | 15/15 任务成功                                                                                              |
| `pnpm test`          | `test-release.log`      | 15/15 任务成功，工作区包 3,086 项及 runtime 8 项通过，合计 3,094；116 skipped，另有 5 pending，均不计入通过 |
| `pnpm build`         | `build-release.log`     | 9/9 任务成功；Web 仍有既有的 500 kB chunk 提示                                                              |
| `pnpm build:runtime` | `runtime-release.log`   | API、Worker 生产运行包生成成功，分别为 1,280,329 / 766,051 字节                                             |
| `pnpm db:validate`   | `schema-final.log`      | Prisma schema 有效；迁移无差异证据见 `infrastructure-final.log`                                             |

全量通过数含 Web 1,141、Worker 343、API 924 项。普通全量运行的 116 skipped 分别为 billing 22、Worker 15、API 79；API 总数还包含 5 项设施门控 pending，不当作通过。账务数据库测试、12 项提交集成、12 项 Worker 真实 PostgreSQL/Redis 测试，以及基础设施 39/9/22 项已分别显式启用验收，结果独立记录，不与全量数相加。

Worker 最新真实设施报告为 `.data/billing-worker-integration/billing_worker_test_f9eb07ec7bff4ab59c0396d1bfda1637/report.json`，12 个场景通过，覆盖内置 Mock 归档、收到响应后取消或归档失败、收据成本/usage 恢复、旧账本不可表示的高精度成本、结算/成本/usage 自动恢复、自动恢复耗尽后从持久 ProviderJob 修复原 Run、已归档且持久取消的补账，以及投递前持久取消。十个已发送场景的 `providerCalls` 均为 1，投递前取消为 0；仅内置 Mock 场景记录归档资产而不报告调用计数。

两项 API/账务补丁的证据为 `billing-p1-final.log`（23 项通过，其中 22 项真实 PostgreSQL）和 `api-p1-final.log`（80 项通过，含 12 项真实 PostgreSQL/Redis 提交集成），API typecheck、相关 build、Prettier 和 diff 检查通过。别名测试分别覆盖有/无幂等键；已归档证据和开放恢复事项的人工释放防护在事务内验证。这些定向结果不与上方全量相加。

Worker 成本时序补丁定向结果为常规 343 项通过、15 项设施跳过，另行显式启用的上述 12 项真实 PostgreSQL/Redis 测试全部通过；未重复发起已有子调用，原币种高精度事实在旧 usage 无法表示时仍保留。

## 代码交付与下一步

本轮交付使用分支 `codex/generate-to-new-node` 和附注标签 `v2026.09.19-platform-billing`，目标为 `origin`（`https://github.com/lysimportant/multimodal-canvas.git`）。通过标签定位本轮代码，推送结果以远端分支提交及标签解引用的双重校验为准；本地回执存放于 `.data/billing-implementation/git-delivery.json`。原有 `docs/resource-input-compatibility.md` 修改不纳入本轮提交。

后续按 P2-03 的外部合同、运维和上线条件独立验收，不用本次 Mock 结果替代真实费用或支付证明。

隔离环境启动、测试命令和 Mock 浏览器步骤见[方案的隔离验收说明](billing-and-model-marketplace-plan.md#可重复的隔离-mock-验收)。生产操作遵循同文档的迁移/回滚限制：先停止新受理并备份数据库、存储和密钥；已有新流水后不得恢复旧快照覆盖账务，也不得降级到不理解冻结快照的旧 Worker。

P2-03 保持未完成。后续仍包括外部逐任务 usage/可信 Token 与时长合同、真实支付、生产备份恢复及上线验收、待核实运营告警、已发布队列任务丢失后的安全重建，以及结算冲突纠错和事项关闭流程；这些不能用本次隔离 Mock 结果替代。
