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

## 2026-09-20：8080 广场接入与 H3 映射检查点

- P1：接入用户实际使用的 `http://localhost:8080`，定位并修复 `MiniMax-H3: missing_profile`。Canvas 基线为 `codex/generate-to-new-node @ 37f37bc`；本轮仅同步文档，保留原有 `docs/resource-input-compatibility.md` 改动。New API 基线为 `main @ 6f25a7b84`。
- 用户登录并授权配置后，已在 8080 管理页保存 `https://api.lolicon.beer/pricing` 并读取。数据库来源修订为 1、快照 33 个模型、价格草稿 0 条；`/models` 可见 New API 原价，两个 Wan 模型已有可用连接。本轮没有修改线上价格或钱包。
- 用户已启用线上桥接；原已保存 Key 的目录 GET 成功。`MiniMax-H3` 仍返回 `missing_profile`，`wan3.0-video`、`wan3.0-video-prime` 均为 `newapi-video-v1` 且可用。因此这次故障不是广场缺价格、缺 Key 权限或桥接开关关闭。
- 只读管理页确认渠道使用官方 `hailuo` 插件，映射为 `MiniMax-H3 → h3`。用户确认仅名字不同，其余采用现有 H3 协议。线上 Hailuo 1.1.3 未声明 `h3`，其生成分支也会落到旧版 `/v1` 协议；New API 本地修复为 1.1.4，精确识别 `h3` 并沿用 H3 `/v2`，不修改渠道映射、模型价格或未知别名的阻断规则。
- New API 全量 `go test -mod=readonly ./... -count=1`、`go vet -mod=readonly ./...`、构建与插件 lint 通过；最终 Hailuo 参数边界及目录/预估/入口回归通过。默认 SQLite 的桥接测试不等同三库验收；本次未改数据库行为。
- Canvas `pnpm --filter @multimodal-canvas/worker exec vitest run src/billing-execution.test.ts` 28/28、`pnpm --filter @multimodal-canvas/web exec vitest run src/marketplace/newapi-square.test.tsx` 4/4 通过。
- 已核对现有结算：上游 `/v1/canvas/estimate` 预估并冻结 CNY；最终以原 Key、原请求 ID、模型和任务匹配的 `/v1/canvas/receipts/:requestId` 净 quota 结算，使用冻结汇率并按用户确认预算封顶。未完成回执保持待核实；不再维护独立售价，也不使用 Key 余额变化推断单次费用。
- 下一步须取得生产插件更新授权，部署 New API Hailuo 1.1.4，再同步 8080 连接并只读核验 H3 可用。上传覆盖版本可能优先于工厂插件；需要核对实际生效版本。保留旧版本以便回退，不覆盖账务数据。真实付费生成和最终扣款未执行，仍不能标记为生产验收完成。

New API 的具体文件、回归命令和部署回退步骤记录在其仓库 `verification/hailuo-h3-alias.md`。已经删除的历史连接不会因为同步自动恢复；旧画布节点如仍绑定旧连接，需重新选择当前连接，不能把改价或广场展示当作重新绑定。

## 2026-09-20：H3 图片提及与媒体预估

- P1，起点 Canvas `692e6eb` / New API `9470bf372`。8080 当前 H3 已发布且合同为 `newapi-video-v1`，但冻结能力仍为 `mentionMediaTypes: ["text"]`；New API 桥接目录硬编码只支持文字，导致图片在 API 预检阶段被拒绝。
- 验收目标：对外精确 MiniMax-H3 的真实 Hailuo H3 路由声明已实现的媒体能力；预估按冻结输入携带无 URL 的类型/角色描述，继续复用 New API 原插件用量与价格；未知或混合渠道保守处理。保留显式能力校验、精确模型名与历史绑定。
- 兼容与回滚：新增可选 `input_media`，老文本请求保持兼容；旧宿主收到新字段应拒绝而非漏算。没有数据库、价格、凭据或依赖变更，无需数据迁移；部署前记录并保留双方旧镜像，回滚代码后重新同步目录，不回灌钱包或历史任务。两端应配套更新后再开放媒体生成。
- 不在范围：生产部署、修改上游价格、真实付费生成、广场重构。原有 `docs/resource-input-compatibility.md` 不修改、不纳入提交。
- 基线：API 报价与提及预检 45 项通过；New API `TestCanvasBridgeHailuoMappedH3` 通过。Node 24.12.0、pnpm 11.19.0、Go 1.26.0，依赖已存在。
- 实现：New API 仅为画布已适配的对外 `MiniMax-H3`，根据实际 Hailuo 插件与精确 `MiniMax-H3`/`h3` 上游路由开放媒体，同名模型的可执行且已定价渠道取交集。Canvas 从节点直接连线、冻结提及生成 `input_media`，复用 Provider 的同资产版本去重及模式预检；类型、角色、9 图/3 视频/3 音频边界由两端校验，估算不携带真实 URL。H3 视频预估沿用插件原有 15 秒输入视频预留，最终仍以回执结算，不另写价格公式。
- 回归：Canvas 传输测试 60 项、API 报价/广场同步/提及 71 项通过；H3 预估与实际请求角色一致、同版本去重/不同版本保留、首尾帧和参考互斥均通过。HTTP 报价入口复现原错误，并验证新能力可报价而不生成；同步新增能力绑定，旧绑定和原定价不变。New API 真实插件测试覆盖渠道 35/61、原名/映射、未知/混合路由和媒体边界；合成原表达式在 5 秒时纯文字 500000 quota、1 图 500500、2 图 501000，未调用上游。
- 全量检查：`pnpm lint` 9/9、`pnpm typecheck` 15/15、`pnpm test` 15/15、`pnpm build` 9/9、`pnpm build:runtime` 通过。全量 Vitest 3280 项通过、125 项外部设施测试跳过、5 项既有待实现；审查后补齐中间 DAG 冻结版本去重、收紧对外别名，新增三项 API 回归；最终相关 71 项及 API 类型/lint/build/runtime、New API 桥接/vet/build 另行通过。New API `go test -mod=readonly ./... -count=1`、`go vet -mod=readonly ./...` 与宿主构建通过。未改变数据库行为，默认 SQLite 的测试不宣称三库验收；Web 既有大包构建提示保留。
- 恢复：子代理消息正文丢失，通过临时交接文件恢复分工；主代理完成最终集成。证据在 `.data/billing-implementation/h3-media-*` 与 New API `.local-tests/h3-media-*`。没有更改 8080 运行容器或线上宿主，没有真实生成或扣款。
- 下一步：授权后配套更新 Canvas 与 New API 宿主（必须重建镜像），确认 Hailuo 1.1.4 生效，重新同步 8080 的原连接；只读检查 H3 新绑定包含 image，再验证只读报价。真实生成与最终扣款仍需单独授权。本轮交付目标 Canvas `origin/codex/generate-to-new-node`、Tag `v2026.09.20-h3-media-inputs`；New API `fork/main`、Tag `v1.0.0-rc.37.custom.13`，线上行为尚未修复。
