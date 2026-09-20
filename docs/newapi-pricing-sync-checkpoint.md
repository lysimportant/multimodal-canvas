# New API 广场价格与双向同步

## 目标与基线

- P1：直接展示 New API 原广场价格；管理员修改价格后保存草稿，在下一次明确点击同步时写回 New API。继续使用人民币钱包与上游最终回执，不建立第二套托管售价。
- 2026-09-20 起点：Canvas `codex/generate-to-new-node @ a9bb86e`，上游 `origin/codex/generate-to-new-node`；New API `main @ 8b6534ba9`，上游 `fork/main`。Canvas 原有 `docs/resource-input-compatibility.md` 不纳入本轮。
- Node 24.12.0、pnpm 11.19.0、Go 1.26.0；两仓库依赖已存在。Canvas 模型管理、路由、价格读取基线 43 项通过；New API `go test ./controller -run TestCanvas -count=1` 通过（默认 SQLite，不代表三库验收）。
- 已只读核验 `https://api.lolicon.beer/api/pricing`：33 个模型，包含固定、阶梯、任务规格及插件定价。模型 ID 和分组大小写保持原样。

## 合同、影响与回滚

- Canvas 管理页增加独立广场 URL，支持站点、`/pricing`、`/api/pricing`、`/v1` 和部署前缀。匿名读取原有 `/api/pricing` 与 `/api/status`，展示原币种、汇率、分组和完整规则。本轮无需改动 New API，`D:/newapi` 保持干净。
- Canvas 原广场展示算法复用 New API 表达式解析器，保留来源版权。单价、阶梯条件、规格、分组、插件变体均由上游数据决定；无法解析的表达式明确展示原规则，不能猜测免费。
- 改价使用 New API 已有 RootAuth 管理 PAT 与 `/api/option/model_pricing` GET/PATCH；普通调用 Key 只读目录。管理凭据独立加密保存，不进入模型选择、公开 DTO、日志或浏览器持久存储。
- 新增 Canvas 站点管理授权与改价草稿表；同站同模型共用一份草稿。使用上游 `expected_version` 与本地草稿修订防止覆盖并发修改。失败或结果不明时保留草稿，再读上游确认后才标记完成。
- 编辑、放弃草稿与同步还需匹配 `sourceRevision`；账户、地址及来源修订隔离前端缓存。换域名清除旧 PAT，旧站草稿保留，调用连接另行配置。撤销授权即使上游离线也能完成。同步领取使用时间戳 CAS，陈旧进程不得覆盖新尝试状态。
- 草稿不参与报价或结算；只有 New API 写回成功后的价格才生效。历史绑定、价格版本、报价、冻结和流水不修改。自动保存连接仅拉取，只有明确同步操作会推送待同步价格。
- 部署前备份数据库；迁移仅建表，无历史数据重写。回滚应用可保留新增表，不回灌旧账务备份。上游价格写回属于全站改价，界面应明确影响及冲突，旧价格保存在草稿基线中供审计恢复。
- 本轮不部署生产、不修改线上价格、不发起付费生成。仅用合成凭据及隔离数据库验收。

## 验收与检查点

- [x] URL 价格读取，复用原表达式、任务规格及插件显示；33 个真实公开模型逐项详情验证。
- [x] 管理授权、草稿保存、同步写回、重读一致、冲突与响应丢失恢复。
- [x] 多 Key 同站共享草稿、无权限拒绝、删除授权、凭据脱敏与换站隔离。
- [x] 定向及全量 lint/typecheck/test/build、真实数据库、PC Web 烟测与控制台检查。
- [x] 文档、diff、敏感内容检查；仅暂存本轮 41 个文件，未包含原有用户文档改动。

## 已取得的验证证据

隔离证据保存在 `.data/billing-implementation/`，不纳入 Git，不包含生产管理令牌。

- PostgreSQL **16.15**：`pricing-migration-check.cjs` 在两个新建独立 `_test` 数据库测试全新部署、旧版 22 个迁移升级到 23 个、再次 deploy 无待执行迁移、唯一约束与原钱包金额不变。`pricing-migration-result.json` 记录数据库名；不清除既有库。
- `newapi-square.integration.test.ts`：3 项真实 PostgreSQL 测试通过，覆盖重建服务恢复、并发修订、双同步只 PATCH 一次、授权失效、换站拒绝旧编辑器和钱包不变。行为测试使用随机 schema 的 `db push --skip-generate`，因为历史 `0001_init` 明确引用 public，不能用 schema 参数隔离整套历史迁移。
- `pricing-browser.cjs`：真实本地 New API controller/middleware + 独立 SQLite，在 `127.0.0.1:13082` 测试 RootAuth PAT、URL、草稿、写回和普通用户浏览。价格从 2.9 改到 3.2，保存草稿时估算仍为 1450000 配额，同步后为 1600000（每单位 500000、汇率 1）；钱包未变、生成请求 0、浏览器错误 0。
- `pricing-live-view.cjs`：只读真实站点全部 33 模型；1440×1000、1280×720 页面和弹窗检查、无横向溢出、浏览器错误 0。Token 阶梯、缓存与 wan3.0 插件规格截图已检查。
- 浏览器发现并修复 `PUT` CORS 预检缺失；补充真实 Fastify 预检回归。费用确认旧测试等待 focus effect 后再断言，消除高并发全量测试时的断言时序问题。
- Windows Prisma 引擎被原本地 API/两个 Worker 占用；先确认两个隔离队列 active/waiting/delayed 均为 0，短暂停止已核实的三个进程后正常 `pnpm db:generate` 成功，随后恢复 API 与原队列 Worker。临时客户端已被正常生成结果替代。
- 最终 `pnpm lint` 9/9、`pnpm typecheck` 15/15、`pnpm build` 9/9、`pnpm build:runtime`、设置隔离 `DATABASE_URL` 后 `pnpm db:validate` 全部成功。Vite 仍提示单个 bundle 大于 500 kB，不影响构建；本轮未扩展分包优化。
- `pnpm test` 15/15 任务成功：3249 项 Vitest 测试通过、125 项因未配置外部设施跳过、5 项既有待实现测试；另外 runtime 8 项通过。新增 3 项真实 PostgreSQL 测试已另行显式启用并通过，不能将全量跳过项视为已验收。

本地启动：先加载 `.data/billing-implementation/environment.ps1`（不输出其内容），`RUN_QUEUE_NAME=mc-acceptance-test-newapi-follow`、`WORKER_PROVIDER=newapi`，运行 `node apps/api/dist/server.mjs`；Web 为 `http://127.0.0.1:15173`。管理页已配置 `https://api.lolicon.beer/pricing`，没有保存线上 PAT。读目录不代表所有模型都已有可用调用 Key 或合同；可调用性仍由已保存连接决定。

OWASP 参考：Authentication Cheat Sheet、Session Management Cheat Sheet（2026-09-20 读取）。沿用真实管理员会话、TLS/显式本机 HTTP、服务端授权、加密存储、凭据不回显、撤销和失败分支测试；不宣称未经验证的全面合规。

子代理恢复后仍持续空消息，已中断；实现与验收由主代理完成。本轮实现、验证和文档同步完成。交付目标为 `origin/codex/generate-to-new-node` 与附注 Tag `v2026.09.20-newapi-square-pricing`，提交正文记录验证结果，远端状态以 Git 核验为准。原有 `docs/resource-input-compatibility.md` SHA256 保持 `56B2C9D2BFB09DCC56720769B9CE12AED4877A29090DEDFBADD2F1FC5B3AA2A7`，不纳入提交。生产部署、线上写回、真实付费生成和 New API 桥接的生产验收仍未执行。
