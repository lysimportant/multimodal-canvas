# 本地计费与模型广场执行方案

更新时间：2026-09-06。状态：方案已整理，尚未实施。

本文是后续开发和验收的执行手册，不代表已经完成数据库迁移、钱包扣款、真实支付或生产发布。本阶段只新增方案文档，不修改业务代码。

## 基线与证据

- 当前项目已有按 Provider 凭据刷新模型目录、保存能力/限制/可选价格，以及按目录价格生成 `estimatedCost` 的能力：[`apps/api/src/settings.ts`](../apps/api/src/settings.ts)、[`apps/api/src/usage-policy.ts`](../apps/api/src/usage-policy.ts)。
- 当前 `UsageLedger` 只记录 Provider 明确报告的金额，不能作为用户钱包、冻结流水或退款账本。
- Sub2 视频真实验收返回了任务状态、视频内容和时长，但没有 usage 或费用字段：[`docs/live-provider-acceptance.md`](live-provider-acceptance.md)。
- Provider 路由、响应、取消、重试和 usage 边界的已知证据见 [`docs/provider-contract-acceptance.md`](provider-contract-acceptance.md)。
- 管理员、普通用户和配置权限的现有入口见 [`docs/admin-operations.md`](admin-operations.md)；账户基线见 [`TODO-ADMIN.md`](../TODO-ADMIN.md)。
- 当前未完成事项仍记录在 [`TODO-LOCAL.md`](../TODO-LOCAL.md)；本方案对应其中的上游 usage 展示与对账增强。

## 目标与边界

目标是建立一个由平台控制的模型广场和本地虚拟余额系统：管理员配置 Provider，平台维护可售模型和价格，普通用户使用余额提交任务，任务完成后生成可审计账单。

第一阶段不接支付宝、微信、Stripe 等真实支付，不把 Provider 返回的模型列表或价格直接当作最终售价，不把未知的 Provider 成本记为零，不在结果不明时自动重发可能计费的请求。

## 产品角色和主流程

### 管理员

1. 在管理设置中维护 Sub2/New API 凭据。
2. 刷新各凭据的 `/v1/models` 模型目录。
3. 审核模型能力、媒体类型、限制和上游价格信息。
4. 设置平台售价、计费单位、倍率、最低收费和是否上架。
5. 给用户充值虚拟余额，查看账单、成本和待对账任务。

### 普通用户

1. 登录后在头像菜单进入“余额与账单”或“模型广场”。
2. 查看已上架模型的能力、限制、计费方式和预计费用。
3. 提交任务时由平台后端使用管理员配置的 Key 调用 Provider。
4. 任务完成后查看用户收费、Provider 成本状态和任务关联 ID。

### 任务收费流程

```text
选择模型
  → 固定价格版本并计算报价
  → 检查可用余额并冻结额度
  → 调用 Provider，持久化 request_id/task_id
  → 成功：按实际用量结算并释放多余冻结
  → 明确失败：释放冻结
  → 超时或结果未知：保持待对账，不自动重发
```

同一个逻辑任务只能有一个用户收费记录。Provider 重试、Webhook 重放、Worker 重启和浏览器重复提交必须通过幂等键落到同一条记录。

## 模型广场

### Provider 同步不是售价同步

可以从 Sub2 或 New API 的 `/v1/models` 获取模型 ID、名称、媒体类型和部分能力元数据。当前项目已经支持按凭据刷新模型目录；`ModelCatalogEntry.price` 也可以保存 Provider 返回的价格字段。

但同步结果只能分为三类：

| 数据                                | 用途                     | 是否可直接作为用户售价 |
| ----------------------------------- | ------------------------ | ---------------------- |
| 模型 ID、名称、媒体类型、能力、限制 | 目录展示和请求校验       | 可以作为目录基础       |
| Provider 声明的价格或 pricing 字段  | 成本参考、管理员初始报价 | 不自动覆盖             |
| Provider 实际 usage/账单记录        | 成本对账                 | 不直接决定用户售价     |

Provider 可能省略价格、使用不同单位、按账户组倍率计费，或者只在后台 usage 中记录 `actual_cost`。视频费用还可能依赖模型族、分辨率、秒数、数量和倍率。因此自动刷新模型时必须保留原始响应和刷新时间，并把价格标记为 `provider_declared`，由管理员审核后才可发布。

### 模型状态

每个模型在平台内至少有以下状态：

- `draft`：刚同步，未审核，普通用户不可见。
- `published`：已审核并有有效平台价格，可供普通用户选择。
- `paused`：暂时下架，历史任务仍可查询。
- `unavailable`：Provider 不再返回或能力检查失败，新任务不可提交。

建议保存以下字段：

| 字段                                       | 说明                                        |
| ------------------------------------------ | ------------------------------------------- |
| provider、credentialScope、upstreamModelId | 上游来源和模型 ID；凭据本身不展示给普通用户 |
| displayName、mediaTypes                    | 平台展示名称和支持的文本/图片/视频/音频类型 |
| capabilities、limitations                  | 上游能力和限制的原始快照                    |
| providerPricing                            | Provider 返回的原始价格                     |
| platformPricing                            | 平台实际收费规则                            |
| pricingVersion                             | 用户报价和历史账单使用的版本                |
| status、sortOrder、featured                | 上架状态、排序和推荐位                      |
| lastSyncedAt、lastVerifiedAt               | 最近同步和最近人工/自动验证时间             |

### 价格规则

平台价格必须是版本化规则，不能覆盖历史价格。支持的单位建议包括：

- `per_run`：每次任务固定价；
- `per_input`：每个输入、每张图片或每个文件；
- `per_token_input`、`per_token_output`：输入/输出 Token；
- `per_second`：视频或音频每秒；
- `per_unit`：Provider 明确定义的其他单位。

规则还应支持货币、精度、最低收费、平台倍率和生效时间。视频应把模型、分辨率、时长、数量作为报价输入；文本应保存输入 Token、输出 Token 和缓存 Token（如果 Provider 提供）。

推荐默认策略是“Provider 成本参考 + 平台独立售价”：

```text
平台售价 = 固定平台规则
或
平台售价 = Provider 成本参考 × 平台倍率，并经过最低价/最高价限制
```

倍率只用于生成平台报价，不能反推 Sub2 的真实 `actual_cost`。

## Provider 成本与用户收费

系统必须保存两条金额：

1. `user_charge`：按平台已发布的价格版本扣除用户余额。
2. `provider_cost`：Provider 明确返回的费用，或通过管理 usage 对账得到的成本。

两者可以不同。Provider 没有返回费用时，平台仍可以按已发布规则向用户收费，但成本状态必须是 `unknown` 或 `pending_reconciliation`，不能记为零。

### Sub2/New API 处理规则

- 普通 `/v1/models` 响应用于同步模型目录，不保证提供完整计费规则。
- 普通生成响应不应假设包含 `actual_cost` 或 `total_cost`。
- 视频状态 body 通常提供模型、状态、视频 URL、时长；若创建快照中保存了分辨率，可用“模型 + 分辨率 + 时长 + 价格版本”重建平台报价。
- 重建结果是平台计价或成本估算，不等于 Provider 已确认的实际扣款。
- 有管理员权限时，优先保存 `request_id`/`task_id`，再通过 Provider usage 管理接口按任务对账；当前公开证据显示管理员 usage 支持按 `request_id` 查询，但普通 Gateway usage 主要是聚合统计。
- Provider 返回明确金额和货币时，保存原始 usage、解析后的 `provider_cost`、来源和解析时间；重复事件不能覆盖首条事实。

## 钱包和账本设计

### 建议的数据模型

以下是实施时的 Prisma 设计方向，名称可以在编码阶段调整：

| 模型                 | 关键字段                                                                      | 作用                                         |
| -------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| `Wallet`             | `userId`、`currency`、`availableMinor`、`reservedMinor`、`version`            | 用户余额和并发版本                           |
| `WalletEntry`        | `walletId`、`kind`、`amountMinor`、`runId`、`reservationId`、`idempotencyKey` | 追加式充值、冻结、扣款、释放、退款、调整流水 |
| `PricingVersion`     | `provider`、`modelId`、`mediaType`、`unit`、`rules`、`effectiveFrom`          | 不可变价格版本                               |
| `RunCharge`          | `runId`、`quote`、`providerCost`、`finalCharge`、`pricingVersion`、`status`   | 一次运行的收费和成本关联                     |
| `ReconciliationItem` | `runId`、`requestId`、`status`、`reason`、`lastCheckedAt`                     | 结果未知和成本待对账队列                     |

金额使用最小货币单位整数或 Decimal；禁止用 JavaScript 浮点数作为账务来源。`UsageLedger` 继续保存 Provider 事实，但不直接承担钱包余额和冻结状态。

### 结算状态

`RunCharge.status` 建议使用：

- `QUOTED`：已固定价格版本并生成报价；
- `HELD`：已冻结用户余额；
- `SETTLED`：已按最终用户收费结算；
- `RELEASED`：任务失败或取消后释放冻结；
- `PENDING_RECONCILIATION`：Provider 结果或成本未知，等待人工/自动对账；
- `REFUNDED`：管理员批准退款并产生反向流水。

冻结、结算、释放必须在数据库事务内锁定钱包行，并对每个动作使用唯一 `idempotencyKey`。余额不足必须在 Provider POST 前返回，不得先调用后补扣。

## API 与页面执行清单

### 管理员 API

建议增加以下接口，具体路由沿用当前 `/v1/admin` 权限边界：

- `GET/POST /v1/admin/model-marketplace/sync`：刷新指定凭据的模型目录；
- `GET /v1/admin/model-marketplace/models`：查看草稿、已发布和下架模型；
- `PATCH /v1/admin/model-marketplace/models/:id`：审核、上架、排序和设置平台价格；
- `GET/POST /v1/admin/pricing-versions`：创建和查看价格版本；
- `GET /v1/admin/wallets/:userId`、`POST /v1/admin/wallets/:userId/adjust`：查看余额和人工充值/调整；
- `GET /v1/admin/reconciliation`：处理 Provider 成本未知和结果未知任务。

### 普通用户 API

- `GET /v1/model-marketplace`：只返回已发布模型和平台价格；
- `GET /v1/account/wallet`：余额、冻结余额和币种；
- `GET /v1/account/billing`：个人账单和任务关联信息；
- `GET /v1/runs/:id/charge`：查看单个任务报价、最终收费和对账状态。

普通用户响应不得返回 Provider Key、凭据 ID、内部成本明细或管理接口地址。管理员页面可以额外查看 Provider 成本、原始 usage 摘要和 request/task ID。

### 页面入口

- 头像菜单：新增“余额与账单”“模型广场”；保留独立退出命令。
- 设置 Dialog：管理员显示 Provider、模型同步、定价和成本对账入口；普通用户显示主题、背景、可用模型和个人账单摘要。
- 模型广场卡片：显示媒体类型、能力、计费单位、平台价格、最近验证时间和“暂不可用”状态。
- 提交任务前：显示报价、价格版本摘要和余额不足提示；不在前端决定最终扣款。

## 分阶段实施

### P0：账务内核

- 完成 Prisma 模型、迁移和钱包事务服务。
- 实现冻结、结算、释放、退款、余额不足和并发幂等。
- 将一次 Run 的报价和价格版本快照持久化。
- 增加重复提交、Worker 重启、部分失败、超时未知的回归测试。

### P1：模型广场和管理员配置

- 复用现有 `/v1/models` 刷新能力，保存原始模型目录和同步时间。
- 增加模型审核、上架、平台定价版本和上下架状态。
- 增加管理员充值、账单查询和成本/用户收费分栏展示。
- 普通用户只能选择已发布模型，后端继续使用管理员 Key。

### P1：Provider 对账

- 为每个 Provider 任务保存 `request_id`/`task_id`、创建快照和最终响应摘要。
- 支持明确 usage 金额的自动入账。
- 对 Sub2 管理 usage 增加按任务 ID 的对账适配；失败进入人工队列，不自动重发。
- 建立 Provider 成本缺失、金额冲突和价格版本不一致的告警。

### P2：真实支付与商业化

- 在虚拟余额和对账稳定后再接真实支付。
- 增加充值订单、支付回调、退款、支付对账和风控。
- 真实支付上线前完成备份、回滚、签名验签、重复回调和财务对账演练。

## 验收标准

### 功能验收

- 普通用户只能看到已发布模型和平台价格，不能读取 Provider Key。
- 余额不足时一次 Provider 请求都不发送。
- 同一幂等任务只产生一条用户收费记录。
- 成功、失败、取消、超时未知和部分 DAG 失败分别进入正确结算状态。
- Provider 成本与用户收费可以不同，并能通过 run/task ID 关联。
- 价格版本更新不会改变历史账单。

### 工程验收

实施每个阶段后至少运行：

```powershell
pnpm exec prettier --check docs/billing-and-model-marketplace-plan.md
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

涉及 Prisma 迁移时，另外在隔离数据库运行 `pnpm db:validate`、迁移回归和并发账务测试。真实 Provider 验收必须遵守 [`docs/live-provider-acceptance.md`](live-provider-acceptance.md) 的一次请求、结果未知不重发和凭据脱敏规则。

## 回滚与未决问题

- 钱包和账单迁移发布前必须备份数据库，并确认新增表和余额流水可恢复；不能用旧数据库快照覆盖已经产生的账务记录。
- Provider 价格或 usage 契约变化时，停止自动同步售价，保留最后一个已审核价格版本，新增模型进入 `draft`。
- 结果未知时保持冻结并进入对账队列；不能用“任务失败”推断 Provider 未扣费。
- 当前尚未确认用户使用的 Helunox/Sub2 部署版本是否向客户端返回费用字段，也未确认其价格配置、倍率和管理 API 权限；这些属于上线前的外部契约验收。
- 当前方案不承诺 Provider 成本一定可从普通响应 body 计算；真实成本以明确费用或可核对的 Provider usage 为准。

本方案完成后，`TODO-LOCAL.md` 中的 P2 usage 项仍需在实际编码、迁移和验收完成前保持未完成状态。
