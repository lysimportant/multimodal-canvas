# New API 账号接入实施与验收记录

更新时间：2026-09-21。主任务 P1；身份、执行授权及数据迁移按 P0 验证。用户最新要求清空旧本地数据、不再保留备份，交付全新初始化的本地项目。本次交付以本地代码、独立 Docker、数据清空和合成账号验收为范围，不需要用户提供生产部署入口。生产部署、原 unknown 核账及外部付费调用留作后续事项，不计为本次已通过或阻塞项；已丢弃的旧项目不再等待归属转换。

本轮收口基线：Canvas `cf2fd7c03895ee83b327ab8b0dbd6eed04694173`，分支 `codex/generate-to-new-node`，上游 `origin/codex/generate-to-new-node`；New API `9152afc04ace3819bb550e67cb97cc3cc7bd7b19`，分支 `main`，上游 `fork/main`，Tag `v1.0.0-rc.37.custom.17`。Node `24.12.0`、pnpm `11.19.0`、Docker `29.7.2`、Go `1.26.0 windows/amd64`，已有依赖可用。主代理直接实施和核验，没有新增依赖；用户原有 `docs/resource-input-compatibility.md` 改动及 SHA256 保持不变。

## 全新本地初始化与旧媒体隔离（最新状态）

本轮 P0 数据操作基线为 `d7d00c2caf7da68a76e4fd90c4cac4a3fb40a333`，分支/上游与上述记录相同。Node `24.12.0`、pnpm `11.19.0`、Docker `29.7.2`、Compose `v5.4.0`，依赖已有；用户资源文档仍为唯一原有未提交改动。验收目标是完整本地栈可登录、分组可同步、项目/媒体/任务为空，旧媒体不能通过新实例读取。

- 故障原因：本次 `Dockerfile:2` 的 `auth.docker.io` 匿名令牌请求连接超时属于基础镜像网络故障。删除旧数据无法修复网络；当前使用已有配套镜像与 `--no-build --pull never`，未声称在线构建已恢复。
- 全新初始化：删除并重建 `canvas-newapi-local` 的 13 个容器和 13 个卷，30 条迁移成功，四个一次性服务退出 0，常驻服务健康。新本地 New API 管理员 ID 为 1，另有一个合成隔离测试用户；密码与 Key 不写入仓库。Canvas 登录后建立新身份，15 个分组、75 条免费 Mock 模型目录可用。
- 删除结果：桌面 `multimodal-canvas-backup-20260921-194647` 已删除；进一步删除 15 处已确认的旧账号/离线数据库/对象/队列备份路径，以及 9 个未挂载的恢复演练卷。清单和结果为 `.local-tests/newapi-account/fresh-reset-cleanup-{inventory,results}.json`。默认 `multimodal-canvas-app` 仍无容器、网络、卷；其他项目不受影响。
- 媒体隔离：API/Worker 只挂载新密钥卷，数据库/MinIO 使用新实例卷，未挂载宿主 `.data`、旧媒体或备份目录。项目、素材、素材版本、节点、Run、ProviderJob、发送意图均为 0，MinIO `canvas` bucket 中无对象。5 个旧素材下载地址均返回 404。
- 验收脚本：此前直接导入 `http-library.mjs` 会启动历史媒体验收，读取旧账号后登录失败；这不代表新应用能访问旧媒体。现已增加直接执行入口判断，导入时无请求，也不创建历史报告；旧 `media-account.json` 已删除。
- PC 烟测：真实 Chrome 未禁用 TLS 校验，完成登录自动同步、空项目/素材接口、旧素材 404、重复同步复用凭据、空工作台与退出会话 6 项检查。页面/控制台错误 0，Provider POST 总数 0。证据为 `local-docker/fresh-smoke-results.json`、`fresh-settings.png`、`fresh-workspace.png`；截图已复核。重新签发的公开 CA 已核对来源并加入当前用户信任存储。
- 启动入口：新增 `Docker-Local.cmd`，调用 `scripts/docker.ps1 -LocalNewApi`，固定当前电脑的配套项目、环境文件与 Compose overlay。仅支持 Start/Stop/Status；不构建、不拉取镜像，配置缺失不退回默认项目。Windows PowerShell 5.1 的 Status/Start 已实际退出 0，重复初始化和迁移成功；Docker 配置测试 14/14、PowerShell 语法检查通过。
- 配置补齐：空库重新写入仅限当前 Mock 主机、单个 IP 和 `8081` 端口的下载白名单，SSRF 校验保持开启；初始化脚本已同步该步骤。再次执行初始化与 Chrome 6 项烟测通过，仍为零生成。交付检查另包括 Markdown 解析、文档格式、diff 和新增内容秘密扫描；本轮仅改启动包装与文档，无业务源码/依赖变更，不重复全仓应用构建。交付 Tag 为 `v2026.09.21-fresh-local-initialized`。

当前入口仍为 <http://localhost:8080/>，本地 New API 为 <https://newapi.localhost:13443>。日常使用 `Docker-Local.cmd`，此入口依赖本机已建立的配置和镜像，不是新电脑的自动安装包。线上 New API、真实调用和业务源码均未修改；此前生成归档只作为历史验收记录，不在当前空实例中。删除操作按用户明确授权未新增备份，Git 回退只能恢复脚本/文档，不能恢复旧数据。原 unknown 仍只能按历史请求 ID 向上游核查，不重发请求。

## 旧本地环境归档清空（19:53，历史，归档现已删除）

本次数据操作按 P0 处理，基线为 `dfd64779b9cbf1e96395f00faf9e6b9ff52f83bf`，分支和上游仍为 `codex/generate-to-new-node` / `origin/codex/generate-to-new-node`。Node `24.12.0`、pnpm `11.19.0`、Docker `29.7.2`、Compose `v5.4.0`；依赖已有，无源码、迁移或依赖变更。目标仅为旧 Compose 项目 `multimodal-canvas-app`；验收标准是桌面备份可恢复、旧容器与卷清零、独立验收环境可用。线上 New API、真实供应商、其他本地项目和用户资源文档不在清理范围。

用户已明确要求把文件保存到桌面新文件夹再直接清空。备份目录为 `C:/Users/Sui/Desktop/multimodal-canvas-backup-20260921-194647`，包含 `canvas.dump`、11 个完整卷归档、Compose/镜像/容器清单、SHA256、三份清理前文档，以及原 unknown 审计和此前加密恢复证据。目录权限限制为当前用户、SYSTEM 和 Administrators，备份不进入 Git。

- 恢复校验：11 个归档在隔离 tmpfs 解压后，与停止的源卷逐文件 SHA256 一致；数据库实际恢复到无网络 PostgreSQL，46 张表的行数和内容摘要全部一致。复核 12 个数据备份文件的 SHA256 均与 manifest 相同。
- 已清空：19:53 删除旧项目 9 个容器、网络和全部 11 个卷；旧 18 个项目、65 个素材及 unknown 关联资料转为离线归档，不再保留在线或等待新账号认领。外部请求和费用结论没有因本地删除而改变。
- 空库验证：新建临时卷执行 30 条迁移，`migrate` 退出 0、失败迁移 0、27 张业务表均为空。默认 API 因缺 `NEW_API_ISSUER` 和生产 HTTPS 来源被拒绝启动，已停止；不将该验证记为默认整栈启动成功。临时项目的 9 个容器、网络和 9 个新卷均已移除，最终旧项目容器、卷、网络数量均为 0。日志见备份中的 `fresh-empty-migrate.log` 和 `fresh-empty-database-counts.txt`。
- 保留环境：`canvas-newapi-local` 的 13 个容器 ID、启动时间及 13 个卷名称与清理前相同，常驻业务服务健康，8080 首页及 `/health` 均为 200。未产生供应商请求。
- 检查：`node --test scripts/docker/config.test.mjs` 14/14，`git diff --check` 通过；四份文档均通过 Markdown 解析，Docker 文档和 TODO 的 Prettier 检查通过，计划及检查点保留基线已有的表格排版差异。本次仅同步四份文档，不重跑应用全仓构建。用户原有 `docs/resource-input-compatibility.md` 的 SHA256 仍为 `56B2C9D2BFB09DCC56720769B9CE12AED4877A29090DEDFBADD2F1FC5B3AA2A7`，不纳入提交。

恢复先按桌面 `README.md` 操作，在隔离数据库和对象存储核查，禁用 Worker/旧队列派发，不覆盖 8080 验收环境；Git 回退不能恢复卷或数据。交付 Tag 为 `v2026.09.21-legacy-local-reset`。后续只保留原 unknown 核查、生产发布和真实调用事项，不再要求旧项目归属转换。下文按历史时点保留，“旧库保留/待转换”不代表当前状态。

## 本地启动恢复（18:55，历史）

用户运行根目录 `docker compose up -d --build` 后，`multimodal-canvas-app-migrate-1` 退出 1。PostgreSQL 日志给出原始原因：“旧表 email_challenges 仍有 1 行；先完成已备份的 B5 清理，再部署本迁移”。该默认项目复用旧共享数据库，仍有 1 个用户、18 个项目、65 个素材、65 个 Run、27 条凭据、193 条旧目录和 1 个钱包。新迁移 010000—040000 已应用，050000 的保护检查失败、事务回滚且应用步骤为 0；没有清库、删除卷或标记迁移为成功。`--build` 更新镜像，不清理数据卷，此故障与线上 New API 的版本无关。

已从现有卷恢复独立 `canvas-newapi-local`：使用原 `local.env` 与两个 Compose 文件，`up -d --no-build --wait --wait-timeout 60` 退出 0；本地迁移退出 0，API、Worker、Web、New API 和设施健康。随后 PC 登录/换号 8/8，15 个分组、75 条目录，页面/控制台无新增错误；五个归档 SHA256 不变，10 succeeded / 2 failed、12 sent、Canvas usage ledger 0、复核新增生成 POST 0。此次没有重新生成素材。日志 `local-recovery-start.log`、`local-recovery-browser.log`、`local-recovery-audit.log`，报告仍在 `local-docker/`；之前的报告另存 `local-recovery-*-before.json`。

本次只补充[本地启动与迁移排障说明](docker-desktop.md)，不改应用源码、迁移、依赖或默认项目数据。`node --test scripts/docker/config.test.mjs` 14/14、`git diff --check` 通过；原用户资源文档 SHA256 未变。当前继续使用 `http://localhost:8080/`；浏览器中的旧登录事务可能过期，应从画布重新登录。默认项目的旧数据迁移继续保持阻断，后续按明确归属和备份清单处理，不能据本地恢复结果将其标记成功。

## 本地范围收口

逐项复核第 9 节、本地报告和当前工作区后，发现旧 `GET /v1/settings/ai/credentials` 没有消费者且已从 OpenAPI 退出，但实际仍返回 200。已删除处理器并纳入统一 410 边界，当前分组列表继续由 `/v1/account/newapi` 提供。OpenAPI 移除旧密码、验证码、邮件响应说明，旧界面设计文档明确标记已退役账号和 Key 流程。无需数据库迁移；API 更新前保留 `multimodal-canvas-api:before-local-final-20260921`，可按原卷回退。

回归先复现旧接口 200（1 failed / 31 passed），修复后旧路由、账号和 API 文档 89/89。全仓 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm build:runtime`、`pnpm db:validate` 通过；API 808 passed / 82 skipped，Web 932 passed，Worker 321 passed / 4 skipped。未改动的包可复用 Turbo 缓存；设施 skip 不算通过，真实 PostgreSQL/Redis 及 New API 三库证据继续引用下节的独立执行记录。日志为 `.local-tests/newapi-account/local-final-*.log`。

18:07 完成本地最终复核：API 已更新为镜像 manifest `sha256:6f9d73206eda0d63609e2de553e526bd30d4ce2e17f6d804c28a2a1c5a963009`，各业务容器 healthy，`/health` 为 200、旧凭据 GET 为 410。PC 浏览器 8/8、15 组、5 张截图，无额外授权确认，页面/控制台错误和生成 POST 增量均为 0；设置页截图已检查。最终只读审计再次确认五归档 SHA256 不变、10 succeeded / 2 failed、12 sent、Canvas usage ledger 0、五个渠道仍指向免费 Mock。两条早期失败继续保留，没有补发。

最后成功命令：`node .local-tests/newapi-account/local-docker/final-audit.mjs`，退出 0；浏览器与只读报告分别为 `local-docker/integrated-login-browser-results.json`、`local-docker/final-audit-results.json`。原报告另存 `local-final-browser-before.json`、`local-final-audit-before.json`。本轮使用 `v2026.09.21-newapi-local-complete` 标记本地收口；当前用户不需要补充部署资料，本地验收已完成。原 unknown、共享保留数据和用户文档未改动，New API 本轮没有源码变更。

## 受控轮换（17:41）

普通登录继续自动同步全部纳入组。维护接口仅允许已登录画布管理员轮换本人明确分组，须指定原版本；不向日常设置页增加 Key 操作。Canvas 先持久化意图并暂停该组新受理，排队、处理中、unknown 及已发送未收尾的请求阻止轮换。新提交与轮换共用凭据事务锁。回包丢失或进程重建后复用原操作，普通同步不擅自恢复。New API 验证原 Token/版本/指纹，事务更换 Key，保留 Token ID 和账务归属；人工 Key/期限变化或撤销继续拒绝。

Canvas 递增原 `credentialId` 的版本，节点/默认选择不变，旧版本密文存入增量表 `newapi_credential_rotations`；Worker 按原 ID/版本可读取历史密文，历史授权、outbox 和发送意图不改写。旧 Key 已失效，读取历史密文不代表上游继续接受它，也不得改用新 Key 重发旧请求。维护恢复、升级和回退步骤见[凭据轮换](credential-rotation.md)。

| 验证 | 结果与证据 |
|---|---|
| 实际数据库 | 账号/客户端 25/25、PG+Redis 执行 14/14，涵盖丢失回包、服务重建、旧快照拒绝、并发轮换/提交、非管理员/跨站/跨用户拒绝。日志 `rotation-integration-recovered.log`、`rotation-outbox-integration.log` |
| Worker 与全仓 | 历史凭据读取/重加密及授权定向 41 passed / 4 skipped；全仓 lint/typecheck/test/build/build:runtime 通过，API 807 passed / 82 skipped，Worker 321 passed / 4 skipped；设施跳过不算集成证据。日志 `rotation-worker.log`、`rotation-final-*.log` |
| New API | `go test ./... -count=1`、`go vet ./model ./controller`、`go build ./...` 通过；SQLite 3.50.4、MySQL 5.7.44、PostgreSQL 9.6.24 的新建、代表旧版升级、重复迁移、事务回滚及轮换通过。日志 `D:\newapi\.local-tests\rotation-*.log`。矩阵发现并修复权限配置查询未引用 MySQL 保留字；新增指纹列采用 VARCHAR，避免 PG 定长字符空值补空格 |
| 迁移 | 独立 Docker 从 60000 升至 70000，并重复执行无待迁移；全新临时数据库 30 次迁移及重复执行通过，schema validate 通过。初次使用随机 schema 时因历史 0001 固定 public 而拒绝，改用全新临时数据库验证，失败 schema 已清理，未改历史迁移 |
| 实际轮换/发送 | `local-docker/rotation-acceptance.json`：vip Token 13、credentialId 保持；版本 1→2、旧 Key 401、新 Key 200；原两个 vip 运行授权不变，幂等重复和普通同步不加版本、Key 或凭据行。新版本一次免费文字 POST 成功归档，New API log 14 quota 0，Canvas usage ledger 0，探针项目归档保留 |
| PC 与已有作品 | `local-docker/integrated-login-browser-results.json`：一体登录/换号/退出 8/8、5 图、额外生成 POST 0、非预期错误 0。17:39 `local-docker/final-audit-results.json`：原五归档 SHA256 不变，10 succeeded / 2 failed、12 sent、usage ledger 0、额外 POST 0 |

日志路径除单列 New API 外均相对 `.local-tests/newapi-account/`。一次 Windows Prisma 引擎断连导致测试失败，复核 Docker 数据库 healthy 后以新测试进程通过完整 25 项，失败日志保留；没有以重跑生成处理问题。旧宿主 13001 API/Worker 占用 Prisma DLL，停止这两个过时验收进程后生成客户端成功，现行 8080 Docker 保持正常。

部署前停止独立 api/worker/new-api 并备份双方库；`local-docker/rotation-backup/canvas.dump` SHA256 `FF5DD549A2245FA0D3B0AC55ACA8501A6694FAEDD82885D1068E6586BD3A2520`，`newapi/new-api.db` SHA256 `0470D1EB95A400AD88AADBCA328222926D32C9668967255299A9630732578AE5`，pg_restore 清单可读。API/Worker 保留 `before-controlled-rotation` 镜像，New API 保留 `canvas-integrated-login-20260921`。新栈已恢复 healthy，入口 `http://localhost:8080`，没有删除卷或共享业务记录。回退前停止新提交、核对待处理轮换并保留新增表/列和历史密文；旧备份不得直接覆盖轮换后新增作品。

本节受控轮换的本地验收已完成。共享归属、3 个原 unknown、线上配套部署及真实调用未完成；按用户最新范围，它们作为后续事项保留，不阻止本次本地验收关闭。

## 导入一致性与执行补证（16:40）

主代理继续完成本地缺口；基线为 Canvas `3603f3cf48bae1656c9165807ae2e4abe7a406fe`，New API `b1f7ca022332b4c62113690817867e31da3db5a0`。一体化登录两端已分别交付 Tag `v2026.09.21-newapi-integrated-login`、`v1.0.0-rc.37.custom.16`，远端分支及 Tag 解引用核验一致。

- 真实 PostgreSQL 故障复现：默认模型写入失败返回 500，但原画布 revision 从 1 变成 2。修复后画布、默认模型和项目更新时间在同一事务提交，失败全部回滚，解除故障后可用原 revision 重试。内存和文件适配器同一次保存默认值；原有调用参数兼容，无 schema 或依赖变更。
- 导入前校验节点 `assetId`、`resourceRefs` 和 `imageEditSource`：无权访问、归档、媒体类型不符或明确版本缺失返回 400 `asset_unavailable`，目标图和默认值不变。本人可访问的素材及原图片来源版本保留，跨项目 sourceNodeId 映射仍正确。工作流中的 runs/results 只保留导出元数据，不复制资产、不创建历史 Run、不转移账号归属；完整保留项目转换继续等待明确接收身份。
- 定向及真实数据库检查 94/94，包含身份集成 17/17、项目存储、API、导入和导出。复现日志 `import-atomicity-before.log`、`import-reference-before.log`；修复日志 `import-reference-integration.log`，路径均相对 `.local-tests/newapi-account/`。
- 实际 vip/auto 同名文字模型各调用一次免费 Mock，持久授权、Key 与 New API 消费记录一致。vip 使用 Token 13 并落到 vip；auto 使用 Token 7，按 `[default, vip]` 落到 default；排除组不参与，两个消费记录 quota 0、Canvas usage ledger 0。报告 `local-docker/group-send-acceptance.json`。
- 独立 Docker 中将免费 H3 任务保持处理中，确认授权/outbox/发送记录和上游任务 ID 落库后对 Worker 发 SIGKILL，再启动新进程。原 Run、授权指纹、outbox、attempt 和发送记录保持，原上游任务完成归档；创建 POST 总计 1，恢复及终态再恢复额外 POST 0。报告 `local-docker/worker-crash-acceptance.json`。Mock 的暂停标记已移除，Worker 恢复 healthy，未更改原 unknown 或共享数据。

本批 lint/typecheck/test/build/build:runtime/db:validate 全通过，API 807 passed / 80 skipped、Web 932 passed；skip 不计入集成验收，17/17 真实 PG 独立执行。全量检查曾发现旧组映射测试使用不存在的来源素材，已改为显式建立三个合成版本后验证原版本不变；修复的是测试前提，未放宽导入权限。日志 `reference-final-*.log`。API 镜像 `sha256:2bd6dc67375b9d36597e499160e2f76ee066da11fbd87ddbc02b7d5d81044144` 已部署 healthy；新浏览器 8/8、额外 POST 0，日志 `reference-browser.log`。回退使用 `multimodal-canvas-api:before-import-reference` 和原卷，会重新引入导入部分更新和非 mention 引用未校验问题。三个新增免费请求和对应原始证据保留，验收项目归档而不删除。

## 一体化登录（15:42）

用户明确不需要单独授权：普通登录由 New API 验证本人会话后自动连接 Canvas，后台兑换一次性码、同步本人全部纳入组，再进入画布。已有 New API 会话无需再次输入密码或点击授权。仅主动“切换账号”显示账号选择，新账号登录后直接返回画布。设置页保留同步、重新登录、切换账号、同步时间及账号/逐组错误，移除授权与撤销控件；后台撤销和权限失效机制保留。

`prompt` 只允许唯一 `select_account`，非法/空/重复参数 400 且不创建登录事务。取消登录校验本人 state 与浏览器绑定、原子消费事务，清理临时 Cookie 并安全回跳，原有 Canvas 会话不变；取消后不能再次兑换或跨浏览器取消。New API 保留固定 client/instance/精确回调、S256 PKCE、同源 POST、Session 校验和 nonce CSP。部署方启用账号接入即信任该固定一体化客户端，不能按任意第三方的自动授权使用。

| 验证 | 结果与证据（相对 `.local-tests/newapi-account/`） |
|---|---|
| Web 定向 | 26/26：登录页、会话请求和设置页；`integrated-login-web.log` |
| 真实 PostgreSQL | 身份集成 15/15、客户端 6/6，零跳过；`integrated-login-api-integration.log` |
| Canvas 全仓 | lint/typecheck/test/build/build:runtime/db:validate 全通过；`integrated-login-final-*.log`。Web 932 passed，API 802 passed / 78 skipped；skip 不算集成证据 |
| New API | `go test ./... -count=1`、`go vet ./controller`、`go build ./...` 全通过；日志在 `D:\newapi\.local-tests\integrated-canvas-login-go-*.log`。未修改模型、SQL 或迁移 |
| PC 浏览器 | `local-docker/integrated-login-browser-results.json`，1440×900，8/8、5 张截图；首次登录、已有会话直入、取消换号、同浏览器 A→B、旧 Cookie 401、旧标签清画布、退出及下次登录复用。实际加载 15 组/75 条模型，画布无授权按钮，Provider POST 增量 0。预期身份探测 401 和隔离 404 单列，非预期 pageerror/console/network/5xx 为 0 |
| 原作品与计费 | 15:42 `local-docker/final-audit-results.json`：五个原归档 SHA256 未变，6 succeeded / 2 failed，8 sent，Canvas usage ledger 0，5 个渠道仍指向免费本机 Mock，额外 POST 0 |

独立 `canvas-newapi-local` 的 api/web/new-api 已部署，入口 `http://localhost:8080`。New API 镜像 `forknewapi:canvas-integrated-login-20260921`。保留 api/web 的 `before-integrated-login` 镜像及 New API 前版命名镜像，可用原卷回退；没有数据库迁移或业务数据删除。源码回退会恢复额外授权确认，不会撤回已完成的会话退出。此前授权按钮验收只保留历史证据，当前 PC 合同以本节为准。

本批不关闭全计划。导入原子性、素材引用边界、非 default 发送及带授权的 Worker 崩溃接管已在后续补齐，见文首；合法受控 Key 轮换仍需实现。旧共享归属/3 个 unknown、线上部署和真实费用仍按原边界保留。

## 跨账号导入与显式分组修复（12:21）

本批沿用 P1 本地验收，分组授权和跨账号写入边界按 P0 检查。Docker 基线复现 A 导出、B 导入返回 400 `model_unavailable`；真实隔离 PostgreSQL 进一步暴露跨项目节点 ID 主键冲突。只有一个可用分组时，缺少凭据的模型建议以及优化/反推还会被隐式分配到目录中的分组。

修复后，导入移除源账号凭据、秘密和 URL，保留精确模型建议并返回 `MODEL_SELECTION_REQUIRED`。跨项目复制为节点和边分配新 ID，同步连线、组成员、批量根、完成动作目标及图片编辑来源，返回 `nodeIdMap`；内容、布局和节点尺寸保留，同项目导入保留 ID。非法默认模型结构在写入前返回 400 `invalid_schema`。New API 项目默认、节点执行、优化和反推均要求显式的本人 `credentialId + modelAlias`，仅非生产 Mock 保留目录回退。旧钱包、计费、广场及后台历史实际路由补齐 410 提示。

| 验证 | 结果及证据 |
|---|---|
| 导入与执行回归 | 导入/导出/API 90/90；优化/反推 42/42；旧入口 31/31、合并账号路由检查 36/36。日志 `continuation-import-remap.log` 及相关定向日志 |
| 真实 PostgreSQL | `canvas_newapi_final_test` 随机 schema，身份集成 13/13、零跳过；A 导出到 B 的三组同名模型目录，源图未变、无他人凭据、未选分组不创建 Run/授权，见 `continuation-newapi-account-integration.log` |
| 全仓检查 | `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm build:runtime`、`pnpm db:validate` 全部通过，日志 `continuation-final-*.log`；Turbo 测试任务 15/15，API 801 passed / 76 skipped，跳过项不作为集成证据。schema 校验使用仅进程内示例数据库 URL，不代表连库验收 |
| 当前镜像 | `canvas-newapi-local` 的 initialize/migrate/API/Worker/Web 构建和部署通过，日志 `continuation-local-build.log`、`continuation-local-deploy.log`；本地服务健康，入口仍为 `http://localhost:8080` |
| 双用户实际导入 | 12:16 的 `local-docker/workflow-import-probe.json`：导入 200、未选组执行 400、非法默认 400 且画布未写入、他人凭据 404；明确选择 B 分组后一次免费 Mock POST 成功归档，读取 200、跨用户 Run 404。两个探针项目已归档，保留原 Run 与证据 |
| 归档及费用复核 | 12:17 的 `local-docker/final-audit-results.json`：原五模型归档均 200 且 SHA256 不变，新增探针后共 6 succeeded / 2 failed，8 个发送意图均为 sent；五渠道仍只指向本地 Mock、价格均为 0、Canvas usage ledger 0，复核额外 POST 0 |
| PC Web | 12:21 的 `local-docker/web-pc-acceptance-results.json`：1440×900 双账号 13/13、10 张截图；15 组、刷新复用、已有结果、隔离及退出通过。预期 401/404 单列，非预期 pageerror/console/network/5xx 均为 0，额外 POST 0；已复核设置首尾、结果及第二账号工作台截图 |

重测曾因验收脚本未退出 New API 会话而触发 409 `AUTH_SESSION_LIMIT`。停止独立 New API、备份 SQLite 后，仅撤销用户 1/2 的 49 条活跃 Node 探针会话，保留浏览器会话和所有项目、Token、grant、账务；这些会话并非自然过期。中断后核对备份并恢复服务，备份为 `.tmp/newapi-cleanup/new-api-before-session-cleanup.db`。HTTP 探针在 Canvas 回调完成后退出其临时 New API 登录，避免继续积累会话；最终导入、归档和 PC 验收均在恢复后通过。该处理不涉及线上账号或旧共享数据。

接口兼容影响限于导入响应增加诊断和 ID 映射、跨项目节点/边 ID 重分配，以及缺少分组的生成请求明确拒绝。无需迁移现有数据；客户端应读取导入后的画布或 `nodeIdMap`，用户重新选择本人分组即可运行。回退本批代码不会还原已导入节点 ID、归档项目或撤销会话，并会重新引入导入冲突及隐式选组缺陷；独立数据库保留上述备份，共享 unknown 不变。

## 首轮本地部署与验收

本次目标为 P1 本地部署和验收，旧数据删除按 P0 管理。用户授权创建全新 Docker、管理员和分组，并使用线上 `test` 账号只读核对目录；真实供应商生成暂不产生费用。验收范围是登录、全部纳入组、Key 复用、账号隔离、五模型 Mock 归档、PC Web 和已确认测试数据清理。生产部署、未确认归属及真实费用不在本次执行范围内。

独立 Compose 项目为 `canvas-newapi-local`。Canvas 为 `http://localhost:8080`，New API 管理入口/issuer 为 `https://newapi.localhost:13443`，回环管理 API 为 `http://127.0.0.1:13010`。旧共享 Web/API/Worker 已停止，新栈使用独立网络、数据库、队列、对象及密钥卷；旧数据不会被首次登录认领。

| 项目 | 本次结果 |
|---|---|
| 账号及分组 | 本地管理员外部 ID 1、第二用户 ID 2；16 个配置组中接入 15 个 active 组、75 条目录。精确排除 `神秘分组`，保留 `auto` 和 `神秘分组-可用`；排除组原 Token 未改变 |
| 幂等及隔离 | 同步、重登复用原 credential；双用户项目、Run、凭据隔离；退出后会话返回 401 |
| 五模型闭环 | 文字、图片、`MiniMax-H3`、`wan3.0-video`、`wan3.0-video-prime` 均成功归档，读取 HTTP 200 且 SHA256 一致 |
| H3 原任务恢复 | 本地 TLS SAN 修正后仍被下载端口配置拒绝；`allowed_ports` 从错误数字数组改为 `["8081"]`，限定 Mock 域名及单个 Docker IP，SSRF 保持启用。原 Run 和上游任务恢复，新增创建 POST 0 |
| 无真实费用 | 五条渠道全部指向 `http://mock-provider:8081`，五个模型配置价格 0，Canvas usage ledger 0；本次未发送线上生成请求 |
| PC 浏览器 | 1440×900 双用户 13 项通过，10 张截图；15 组滚动展示、刷新、已有文字结果回显、隔离拒绝和双方退出通过。最终运行不忽略 HTTPS 证书错误，额外生成 POST 0 |
| 回归检查 | `pnpm lint/typecheck/test/build/build:runtime/db:validate` 通过；测试任务 15/15，API 753 passed / 75 skipped，跳过不算集成通过；清理和 Docker 脚本 27/27。schema 校验首次因宿主缺 `DATABASE_URL` 失败，随后使用仅进程内无密码的本地示例 URL 通过，不代表连库验证 |

两次早期 H3 失败仍留在本地数据库，最新原任务已恢复成功；首轮收尾时为 5 succeeded、2 failed，7 个发送意图均为 sent，无 unknown。失败现场保存为 `local-docker/verification-before-h3-recovery.json`，恢复报告为 `local-docker/h3-recovery-results.json`，五模型和只读复核分别为 `local-docker/verification-results.json`、`local-docker/final-audit-results.json`。这些路径均相对被忽略的 `.local-tests/newapi-account/`，其中账号材料只保存为 DPAPI 密文，证书私钥和秘密卷不提交。

线上只读报告 `online-test-readonly.json` 记录 `https://api.lolicon.beer` 的 `test` 登录成功、外部 ID 498、14 个可用组和模型目录；线上组包含 `神秘分组`、没有 `auto`。本地额外加入 auto 和相近名称以验过滤边界，不宣称线上已有这两个组。线上账号接入入口在前次预检仍为 404，目录可读不能证明配套账号合同已上线。

本机恢复启动使用现有覆盖层和密钥卷，不重新初始化账号或重发场景：

```powershell
docker compose --project-name canvas-newapi-local --env-file .local-tests/newapi-account/local-docker/local.env -f compose.yaml -f .local-tests/newapi-account/local-docker/compose.yaml up -d --wait --wait-timeout 240
node .local-tests/newapi-account/local-docker/final-audit.mjs
```

覆盖层属于此机器的验收材料，未作为通用部署配置提交；恢复后先核对 Mock IP 与精确白名单。停止环境保留卷，不能使用 `down -v`。旧共享清理结果及恢复点单独记录在下节。

本机 CA `Multimodal Canvas Local CA` 已进入当前 Windows 用户的 Root 信任库，指纹 `083D4DBB7D43C199E0FF4F2A993A2B3E8AB6EB69`；未写入机器级 Root。Node 使用指定 CA 且 `rejectUnauthorized: true` 验证 issuer 返回 200。Schannel 对无 CRL 的本地 CA 使用 best-effort 撤销查询后也返回 200；这不是公网证书或线上 HTTPS 验收。停用本地环境后可用 `certutil -user -delstore Root 083D4DBB7D43C199E0FF4F2A993A2B3E8AB6EB69` 撤销这张本机 CA 的信任。

连续双用户浏览器复测触发过 New API 默认全局限流 `360/180s`，部分分组按合同显示暂不可用。独立验收覆盖层现显式配置 `GLOBAL_API_RATE_LIMIT=3600` / `180s`、`CRITICAL_RATE_LIMIT=1000` / `60s`，两种限流仍启用；仅重建本地 New API 后，两账号均恢复 15 个 active 组，未新增模型生成。生产部署需按用户数、分组数和同步频率单独配置容量，不能用该本地参数替代生产限流验收。

最终 PC 报告为 `local-docker/web-pc-acceptance-results.json`，截图在同级 `web-pc-acceptance/`。未登录阶段每个浏览器的 5 次预期 401、主动跨用户打开项目的 1 次预期 404 单列；非预期 console/pageerror/request failure/5xx 均为 0。截图复核了设置表格首尾、已有结果和第二账号空工作台，无横向溢出或主要区域重叠。分组手动同步及重登复用以 HTTP 报告为准，最终 PC 场景只刷新页面和读取已有结果。

### 本地故障、禁用与撤销演练（08:52）

接续基线为 Canvas `d040bac1ed8a0415c2c15bab11f22e6ef776d2fa`，用户原有资源兼容文档仍是唯一未提交修改；Node 24.12.0、pnpm 11.19.0。此阶段补充第 9 节的实际运行证据，旧共享清理结果保持不变。

执行 `node .local-tests/newapi-account/local-docker/fault-acceptance.mjs`，报告 `local-docker/fault-acceptance-1789951946202.json`：11 项通过，退出码 0。脚本先确认五条渠道只指向本机 Mock，随后仅停止 `canvas-newapi-local-new-api-1`，未操作旧共享库或线上实例。

| 场景 | 结果 |
|---|---|
| 上游暂不可用 | 有效旧会话可读本人项目、Run 和原归档，内容 SHA256 不变；身份显示 unavailable |
| 故障时写入与生成 | 项目创建和单次生成探测均返回 503 / `upstream_unavailable`；Run、素材、项目和账务数量不变，Provider POST 增量 0 |
| 故障时登录与续期 | 已准备但未兑换的真实授权回调、旧会话刷新均返回 503；无 Set-Cookie，auth_sessions 总数仍为 28 |
| 上游恢复 | 原会话同步恢复 15 个 active 组，原 credentialId 和上游 Token ID 未变 |
| 禁用第二账号 | New API 管理接口禁用外部 ID 2 后，Canvas 同步返回 401 / `authorization_revoked`；该账号两个旧会话均不能读取项目 |
| 恢复与重新授权 | 重新启用账号不会复活旧会话，必须重新登录；产品撤销授权后旧会话失效，显式重新授权恢复 15 组且旧会话仍不可用 |
| 收尾与保留 | 本地服务已恢复 healthy，第二账号已启用，测试会话均退出；7 Run、5 素材、7 项目、0 usage ledger 及 30 条原分组绑定未变 |

本次不新增业务源码、依赖或 schema，已有完整 lint/typecheck/test/build 检查沿用同一业务代码版本；新增本机脚本通过 `node --check` 和实际运行。这里证明本地真实进程故障与权限控制，不替代线上 HTTPS 或真实供应商验收。

### 人工改期后的重新授权与探针收尾（09:14—09:40）

执行 `node .local-tests/newapi-account/local-docker/reauthorization-probe.mjs`，报告 `local-docker/reauthorization-probe-1789953249744.json` 为 `reproduced`：独立本地 New API 用户 ID 3 的 `default` 管理令牌原本 active，人工把令牌期限改为过去时间后同步变为 `unavailable`；再次完成显式授权后仍为 `unavailable`，原 Token ID 41、15 个 Token 数量和人工期限均保持不变，Provider POST 增量为 0。该结果证明人工修改过的管理 Token 不会被显式重新授权静默复活，符合 New API 合同；没有修改业务源码。

探针结束后按精确用户名和 ID 清理了本地独立栈，不触碰用户 1/2 或五模型归档：停止 New API 后备份 SQLite，并以 `canvas-recovery`、ID 3 为门禁删除其 15 个 Token、1 个 grant、15 个 managed-token 关系及认证数据；另备份 Canvas PostgreSQL，再删除对应的 1 个 New API identity、15 个分组 binding、15 个凭据和 2 个会话。探针在 Canvas 的项目、素材和 Run 均为 0。重启后 New API/Canvas 均 healthy；SQLite 用户数为 2、Token 分布为用户 1/2 各 16/15、managed-token 各 15/15，Canvas 用户/identity/凭据/binding 为 2/2/30/30。备份保留在被忽略的 `.tmp/newapi-cleanup/`，不写入 Git。

清理后重新执行 `node .local-tests/newapi-account/local-docker/verify.mjs` 和 `node .local-tests/newapi-account/local-docker/final-audit.mjs`：15 个纳入组、75 条目录、双用户隔离、五模型已有归档和 0 usage ledger 均通过，新增 Provider POST 为 0。

## 上一代码批次补齐结果

- `POST /v1/runs/:runId/recover` 已补齐：仅接受 `{}`，沿用原 Run/outbox/授权/发送身份；核对队列、用户、项目、attempt、retryOf、幂等键与三份快照指纹。成功或取消的任务不再投递，unknown/sending 拒绝，撤销拒绝，取消只恢复本地收尾。PostgreSQL/Redis 恢复集成 14/14，HTTP/运行/限流 82/82 通过。
- New API 人工改期不再被同步复活：普通 `Token.Update()` 在事务内锁管理关系和 Token，人工变更期限标记 `changed`，与配置一起提交或回滚；普通改名不终止管理，Canvas 内部续期不经此入口。过去时间、缩短期限、永久期限、撤销后改期、重新授权和失败回滚均覆盖；SQLite 3.50.4、MySQL 5.7.44、PostgreSQL 9.6.24 三库通过。
- 持久化回读原来遗漏 `videoMode`，使缺尾帧场景误发请求；现按领域合同读取节点字段，保留视频模式、完成动作、批量和资源字段，同时仍排除内部与废弃字段。真实 PostgreSQL 往返和缺尾帧预检回归 22/22 通过。
- Worker 的新请求发送意图移到最终请求持久化、资源复核后的发送边界。本地校验失败不再留下 unknown 发送记录；最终发送授权失效仍零 Provider POST。定向 69/69 通过。
- 普通、批量、DAG、显式优化、手动文本反推和取消后重试均有本地实际入口证据。特殊入口成功各 1 次 POST，取消原 Run 为 0；所有授权绑定同一所属用户/default/原 credential。终态恢复额外 POST 为 0，跨用户恢复为 404。
- 两个 Wan 的视频/音频参考已完成签名对象读取；H3 首帧另有非零合成计费对账。Mock 实际 GET 5 个冻结对象均 200，H3 500 quota = 0.001 USD，New API 用户/Token/分组/请求/任务/唯一消费日志一致，Canvas 账务记录为 0。只证明本机跨容器与 Mock 合同，不证明公网真实供应商。

上一代码批次最后完整检查：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm build:runtime` 均退出 0；Turbo 15/15，API 753 passed / 75 skipped，跳过项不计入集成通过。New API `go test ./...`、`go vet ./...`、`go build ./...` 和三库矩阵通过，独立 Docker 镜像重建后 healthy。完整日志为 Canvas `final-*.log`、`recovery-integration-final.log`、`recovery-routes.log`、`continuation-video-mode.log`、`continuation-send-boundary.log`；New API 日志在 `.local-tests/canvas-account-b0/continuation-*.log`。

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
| `shared-recovery-latest.json` | 加密密钥和 Redis 备份/隔离恢复；19 条非空凭据可解密，65 个队列任务载荷相同 |
| `shared-unknown-log-review.json` | 3 个旧请求仍为 unknown；原版本令牌的只读日志查询返回 401，未新建或修改任务 |
| `target-contract-preflight.json` | 目标站点公开 GET 预检：账号合同 404，尚不能进入正式账号验收 |

`media-final-results.json` 中 Mock Python 签名 URL 解析曾异常，原 Run `run_idem_0722de3888f0fa6b70a2965276f8408e9bdc9e0406245ca2fd93f205f528e0b9` 保持 unknown，不重发。成功报告曾被过严脱敏断言拒绝；非零计费脚本曾误认为无限 Token 的 remain quota 不递减。两项报告问题均以只读补证解决，原 failed 文件保留，不改写为全场通过。

独立对象代理为 `canvas-acceptance-object-tls`，Docker 网络别名 `assets.canvas-acceptance.example.com`。恢复 Worker 时须设置 `S3_PROVIDER_ENDPOINT=https://assets.canvas-acceptance.example.com`；`.local-tests/newapi-account/start-local.ps1` 的默认配置不包含此项。Mock 使用专用自签 CA 校验代理；TLS 私钥不进入报告或 Git。测试后的 New API SSRF 配置和 H3 价格均恢复，H3 价格回到 0；这不是生产配置建议。

## 旧共享测试数据已授权清理（2026-09-21）

按用户“删除其余已确认测试数据，保留 unknown 请求及关联证据”的授权，旧 Web/API/Worker 保持停止，重新备份并在独立副本完成恢复、清理和幂等重放。主代理复核清单及源预检后，于 08:37（Asia/Shanghai）完成原本地 Docker 数据库清理；没有访问线上 New API 或发送 Provider 请求。

| 项目 | 实际结果 |
|---|---|
| 删除范围 | 用户 `e6129ad9-7792-4116-9055-8c27d340b4ac`、项目 `40b73a55-4c5d-460e-8e12-8430ee51fba6`、1 个画布、3 个节点、15 条旧会话，共 21 行 |
| 保留范围 | 18 项目、65 素材、65 Run、27 凭据、112 对象、70 个 Redis 键；16 个 owner-null 项目全部保留；其他 1036 条会话未改 |
| unknown 证据 | 下节列出的 3 个原请求及其用户、项目、输入、Provider job、请求记录、队列载荷均保留；凭据 `a75a97d3-1a59-4b54-9ffb-fb6f6c33f4f9` version 18 未改 |
| 完整性 | 全部保留数据库行和 unknown 证据摘要一致；112 个对象逐项 SHA256 相同；Redis 逻辑内容及绝对过期时间一致，active/wait/paused 均为 0；外键校验及软引用检查无失败 |
| 未执行 | Run、素材、凭据、对象、Redis 键删除均为 0；未转换保留账号或资源归属，未运行 50000/60000 删表迁移，未改变保留用户状态 |

最终材料位于 `.local-tests/newapi-account/retirement-1789949636058/`。`manifest.json` 的规范化清单摘要为 `d9e13cb1f7498d507bc35989b225b425aa3a11e6a99411e2d1bb0987340d8b87`；完整数据库、对象、队列和密钥备份均为 DPAPI CurrentUser 密文，逐文件 SHA256、隔离恢复目标和重放证据在 `bundle.json`。清理后数据库摘要为 `228ebc0499207865e0edb5492c7101d665f3f525fdfd55dcb8f1418b1638cdfd`，unknown 证据摘要仍为 `fd0689de315da60012a887dc1ced3340e8cbeddc1819dbaf6c301dd08158ad3e`。

执行命令为 `node .local-tests/newapi-account/retirement-apply.mjs --mode source-apply`，显式指定上述目录的 `manifest.json`、`bundle.json`、完整 `--confirm` 摘要及 `--allow-source-apply APPLY_REVIEWED_LOCAL_RETIREMENT`。事务内重新锁表核对前置摘要，结果 `retirement-apply-state-source-apply.json` 为 `completed`、`applied=true`；源数据库从计划前置状态变为预期后置状态。清理前预检和副本重复执行分别有独立报告，不把它们当作源库重复删除。

恢复副本容器已停止，恢复卷和全部加密快照保留；需回退时使用当前 Windows 账户先恢复到独立副本并核对清单，再处理指定记录。DPAPI 不能证明异机灾备可用，Git 回退也不能恢复删除行。旧库仍保留 unknown 和未确认归属数据，禁止以本次清理完成为由直接删表、恢复旧 Worker 或把资源归给新账号。

## 此前共享备份与清理预览（历史）

以下记录为本次实际清理前的恢复点，当时共享源实例为原 8080 Compose，源数据未改。只读备份位于 `.local-tests/newapi-account/shared-review-1789940384573/`，恢复到 `canvas_shared_review_1789940384573_test` 及独立对象卷；副本仅应用删表迁移 50000 之前的增加结构迁移。旧 preview 的 `applyAllowed=false` 保留为历史证据，本次实际清理使用上节的新清单和摘要。

| 恢复点 | 大小与校验 |
|---|---|
| `database.dump` | 294889 bytes；SHA256 `aa8736db46279d0efa4ab9dc7035781de25af2a6c4a8219083180f78e136d659` |
| `canvas-objects.tar` | 163174912 bytes；SHA256 `c0a08de7ee8da0d2a148e032e5266dbc81022a0ae2339aaa047f773e0078b169` |
| 隔离恢复结果 | 2 用户、19 项目、65 素材、65 Run、74 Provider job，活跃 Run 0；对象逐字节相同 |
| `cleanup-preview.json` | digest `c9a9514d782c683c8b75f0e55fd7ab71dbf661ec62d24fc2429493571996b266`；21 行可清理、0 对象、1 用户暂缓、`applyAllowed=false` |

用户 `e6129ad9-7792-4116-9055-8c27d340b4ac` 的 21 行当时仅列入预览，现已按上节新清单清理。用户 `87d6b5ec-9ecf-413a-a8fc-d93a1e7f62f3` 因以下原请求 unknown 继续暂缓；本地 Run failed 不证明未收费，无上游任务/请求 ID 时不得补发或清理：

| Run | 精确模型 | 原请求 |
|---|---|---|
| `run_idem_acfd20789b825d0fa1890c811eaea91ec10aa25062a5fa55b81ddd25000bc734` | `grok-4.6` | `POST /chat/completions#1` |
| `run_0a78bfb2-a214-4ca1-baf5-d9e59cc9821f` | `gpt-image-2.5-sunburst` | `POST /images/edits#1` |
| `run_cf8ffdc5-9484-4b23-b5b5-3bab123b51e7` | `gpt-image-2.5-sunburst` | `POST /images/edits#1` |

仍需明确 owner-null 的 16 项目、19 素材和 27 共享凭据的归属；没有指定接收身份，不归给首次登录者。旧提交已冻结；后续转换前须核实上述请求与未结费用，确认保留身份并更新一致的备份、preview 和 digest。超出已授权删除范围的数据另行确认，不能用旧 digest 删除后续新增数据。

### 密钥与队列恢复补证（2026-09-21）

已从共享只读卷备份 canonical secrets，并从源 Redis 获取 RDB。归档只在内存经过 DPAPI 加解密，宿主文件只保存密文；备份目录关闭 ACL 继承且仅当前 Windows 用户可访问。恢复到新建 Docker 卷和 `--network none` 的 Redis，不连接共享业务网络，不启动 Worker。

| 项目 | 证据 |
|---|---|
| 密钥归档 | `shared-recovery-1789945220089/secrets.tar.dpapi`，29414 bytes，SHA256 `7791b2c08f6642b53edc754f91b094ad6fe98f758bb80e4f4f40638fc995d94f` |
| 密钥恢复 | 解密字节与原归档一致；恢复卷与源 secrets 逐文件相同；数据库副本 19 条非空凭据全部可解密，另 8 条原本为空，不计为解密成功 |
| 队列归档 | `shared-recovery-1789945220089/queue.rdb.dpapi`，271558 bytes，SHA256 `70b0f92144565076a7aa00de4919a88635d2e546ecbd1f72e9acf7ab6d9cbf9b` |
| 队列恢复 | 源与副本各 71 个 `bull:canvas-production:*` 键，65 个任务载荷逐项一致；前后 active/wait/paused 均 0，无新增执行 |
| 副本处置 | Redis 验证后停止，恢复卷保留；密钥与队列均未覆盖源数据 |

命令为 `node .local-tests/newapi-account/shared-recovery-backup.mjs`，结果 `shared-recovery-latest.json`。首次验证误把 8 条空凭据当作可解密密文，失败证据保留在 `previous-failed-evidence.json`；后续从已经验证的密钥恢复点继续完成，无重复源数据操作。DPAPI 恢复限定当前 Windows 账户，不能据此宣称异机恢复可用；本轮补证也不是冻结写入后的最终切换快照。

旧请求的原凭据版本均为 18，与恢复副本的凭据版本一致。两笔图片请求分别在 2026-09-17 12:42 UTC、16:16 UTC 提交并返回 HTTP 524，文字请求于 2026-09-18 06:04 UTC 报 `fetch failed`；没有上游任务 ID。对原令牌发起 `GET /api/log/token` 返回 401，故不能核对收费，也不能把本地 failed 改成确认未发送。需要上游管理员按这些时间、精确模型及原令牌查询原请求/消费日志；全过程没有创建 POST。

### 目标部署预检与执行条件

2026-09-21 07:06（Asia/Shanghai）对 `https://api.lolicon.beer` 做未登录 GET 预检：`/api/status` 返回 200，报告版本 `v1.0.0-rc.37.custom.1`；`/api/canvas/account` 和 `/api/canvas/authorize` 返回 404；`/v1/canvas/catalog` 返回预期的未鉴权 401。报告版本不是部署提交证明，但两个账号入口当前不可用，不能开始正式唯一登录验收。

08:53 再次只读检查上述四个路径，状态与报告版本均未变化，证据 `target-contract-preflight-1789951996174.json`。线上 `test` 登录权限不能补齐不存在的账号合同，也不能提供旧凭据所属请求的消费结论。用户最新确认的部署范围仍为本地 Docker，且真实费用暂停；未获得新部署入口或费用范围前不执行相关操作。

12:27 的四路径只读复核仍为 200/404/404/401，站点报告版本仍为 `v1.0.0-rc.37.custom.1`，见 `continuation-target-contract-final.json`；此次未登录、Provider POST 为 0。

可部署代码已经交付：New API `fork/main @ f31ac6ab7519cffe5f19e04a24e1aeaf7d4dcd26` / `v1.0.0-rc.37.custom.15`，Canvas `origin/codex/generate-to-new-node @ 2c3595daeace6a578566ab01e31cf75db3d9f732` / `v2026.09.21-newapi-acceptance`。正式执行仍需：

1. 确认目标服务器部署入口和生产操作授权；保留现有渠道、价格与用户数据，备份后部署配套版本，不用独立测试实例覆盖目标数据。
2. 确定正式 Canvas HTTPS 来源和受控 New API 管理员外部 ID。New API 启用 `CANVAS_ACCOUNT_ENABLED`、`CANVAS_BRIDGE_ENABLED`，issuer 固定为 `https://api.lolicon.beer`，client/instance 与 Canvas 一致，回调精确到正式 Canvas 的 `/v1/auth/newapi/callback`。不猜域名或扩大回调白名单。
3. 对共享项目明确删除/保留范围；unknown 关联证据继续保留核查。生成前须在目标环境验证账号隔离、分组幂等同步、排除组、受理时权限与旧页面拒绝。
4. 真实供应商验收另行确定精确模型、输入组合、单次与总费用范围；已有 unknown 不作为重试对象，不能用新的付费生成补原请求证据。

## 计划第 9 节逐项验收账本（2026-09-21）

下表按用户确认的本地范围记录。`隔离通过` 表示专用数据库/Redis/对象存储或本地代码合同已通过；`Mock/运行环境通过` 还包含本地 Docker New API、Worker 和合成供应商。表中生产、真实调用及共享转换的待办只说明后续边界，不作为本次通过条件。

| # | 验收项 | 状态 | 证据或剩余边界 |
|---:|---|---|---|
| 01 | 登录成功、取消、过期、重放、账号切换 | 本地运行环境通过 | 无授权确认的一体化登录、同浏览器换号、取消及旧会话失效通过；state/PKCE/重放集成通过，目标 HTTPS 仍待验 |
| 02 | 无邮箱、资料修改、同名重建 | 隔离通过 | New API 身份集成覆盖不可变外部 ID 和资源归属 |
| 03 | 旧登录及跨标签页切换 | 隔离通过 | 旧入口拒绝、退出撤销和迟到回调回归已通过 |
| 04 | 并发同步、上游已建但回包丢失 | 隔离通过 | 原 operation/token 复用测试通过，未增加成功组 Key |
| 05 | 首次全部组建 Key、增加组、切换模型 | Mock/运行环境通过 | 新 Docker 接入 15 个 active 组、75 条目录；同步/重登复用，新增组补建另有回归 |
| 06 | `神秘分组` 精确排除 | Mock/运行环境通过 | 新 Docker 包含 auto 和 `神秘分组-可用`，精确排除组原 Token 保持不变 |
| 07 | 多组模型汇总及选择 | Mock/运行环境通过 | 15 组目录/PC 通过；vip/auto 同名文字模型各一次实际发送，使用不同 Token，消费记录分别落在 vip/default 且排除神秘分组，见 group-send-acceptance.json |
| 08 | `auto` 范围与显式变化 | 隔离通过 | 空范围拒绝、排除组不路由；目标站点 Auto 顺序仍待验 |
| 09 | 部分组失败或令牌数量达限 | 隔离通过 | 限额保留成功组、失败组原因和 auto 空范围回归通过 |
| 10 | Key 从 G1 改到 G2 | 隔离通过 | 管理令牌人工改组/撤销和旧绑定失效回归通过；重新授权探针确认人工改期不会复活旧 Token |
| 11 | 账号组、模型限制及热缓存 | 隔离通过 | Redis 缓存失效和跨进程权限修订回归通过 |
| 12 | 预期分组受理竞态 | 隔离通过 | 受理前权限变化在 Provider POST 前拒绝且零发送 |
| 13 | 两用户、两分组、同名模型 | Mock/运行环境通过 | PC 双上下文项目、设置、凭据和退出隔离通过 |
| 14 | 凭据过期、撤销、断开、轮换 | 隔离及本地运行通过 | 账号/客户端 25/25、PG+Redis 执行 14/14、三库轮换通过；vip 保留凭据和 Token 13，版本 1→2，旧 Key 401、新 Key 200，历史授权不变；同操作重试不再轮换，新版一次免费 POST 成功，见 rotation-acceptance.json |
| 15 | 普通、批量、DAG、优化、反推、重试 | Mock/运行环境通过 | `entries-results.json`、`special-entries-results.json` 覆盖所有入口；本批优化/反推 42/42，缺少显式个人分组默认时拒绝，原选择失效不换组 |
| 16 | 入队失败、重启、重复消费、未知创建结果 | 隔离及本地运行通过 | 14/14 恢复集成、82/82 HTTP/运行/限流；独立 Docker SIGKILL 后以原授权、outbox、attempt、发送和上游任务身份恢复 H3，创建总计 1、恢复增量 0，见 worker-crash-acceptance.json；unknown 继续禁止自动重发 |
| 17 | 新旧任务混合及旧页面提交 | 隔离通过 | 旧报价/账务入口拒绝，模式从服务端快照回读；旧数据收尾仍待共享切换 |
| 18 | 保留项目、默认模型、导入导出 | 本地隔离及工作流导入通过 | PG 故障回归验证画布/默认同事务回滚；非 mention 素材/图片来源权限及版本在写前校验，本人原版本保留且节点引用映射；工作流不复制历史运行和资产。共享完整作品归属迁移不在本次范围，不推断 owner-null 接收身份 |
| 19 | 测试账号清理、外键、对象、队列、恢复 | 本地演练及已确认清理通过 | 隔离对象失败恢复、重复清理和备份恢复通过；旧本地源库精确删除 21 行；独立 Docker 探针用户 ID 3 及其 15 个 Token/Canvas 绑定已备份后清理。18 项目、65 素材、3 个原 unknown 及关联证据保留；旧库转换不在本次范围 |
| 20 | New API 不可用、禁用与撤销 | 本地运行环境通过 | 实际停止/恢复 New API、禁用/启用账号、产品撤销/重新授权共 11 项通过；只读可用、写入拒绝、旧会话不复活且零新增 POST，生产部署仍待验 |
| 21 | 旧广场、钱包及后台同步退出 | 隔离通过 | 新任务无 Canvas 钱包/报价写入；旧钱包/计费/广场/后台实际路由补齐 410，31/31 定向回归通过 |
| 22 | 手动 Key 管理与遗留引用清理 | 隔离及本地运行通过 | 普通界面不显示 Key 表单/连接操作；最后的旧凭据列表处理器退出，GET 统一返回 410，89/89 定向回归。共享旧引用继续按保留清单处理 |
| 23 | 平台商品字段与本机缓存退出 | 隔离及本地运行通过 | 节点/项目默认/优化/反推必须显式 credentialId + modelAlias；导入只保留模型建议，即使仅一个分组也不自动补凭据，未选组零 Run/授权 |
| 24 | 无本地货币门槛的目录 | Mock/运行环境通过 | 五模型目录与调用未创建 Canvas 报价；真实目录定价状态仍待验 |
| 25 | 报价提醒型自动反推退出 | Mock/运行环境通过 | 主动优化/手动反推各一次成功，未触发自动生成 |
| 26 | 迁出的通用执行能力 | 隔离通过 | Run、授权、outbox、取消、重试和恢复定向回归通过 |
| 27 | 旧只读钱包及邮箱运营入口退出 | 隔离通过 | 读取设置/账号不 upsert 钱包；历史只读钱包、核账和定价入口明确 410，生产旧入口部署状态待验 |
| 28 | H3、两个 Wan 与文字/图片 | 本地 Mock 通过 | 五模型各一创建 POST 并归档；媒体补证报告记录首尾帧、图片、签名视频/音频组合；真实调用另行安排 |
| 29 | 素材外部访问、费用及取消 | 本地 Mock 通过 | 5 次跨容器签名素材 GET 200；H3 一笔 500 quota/0.001 USD 合成对账；本地取消不伪记退款。公网素材访问和真实供应商费用另行安排 |
| 30 | PC Web 启动、连接、刷新、选模、生成、退出 | Mock/运行环境通过 | 既有 13 项及生成证据保留；当前一体化登录 8/8、5 张截图，登录后直接进入画布，无授权步骤，非预期错误 0、Provider POST 增量 0 |

本次按本地范围关闭，不要求用户部署线上 New API 或补充生产 HTTPS/管理员信息。共享旧库保留归属与原 unknown 核查、生产发布、真实供应商回执/插件版本单列到 TODO 后续项；这些事项没有被本地通过结果替代。当前使用独立 Docker 的 8080 入口，保留此前全部原始失败、未知请求和恢复证据。

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

共享实例清理前盘点为 2 个旧用户、3 个所属项目、58 个所属 Run、46 个所属素材；总 65 Run、74 Provider job 均为本地终态，但有 3 个原请求 unknown。钱包 1、旧报价/扣费/成本/核账/outbox 为 0；另有 owner-null 项目 16、素材 19 和共享凭据 27。本次已按文首新清单删除一个已确认测试账号及 21 行关联数据，保留 1 个旧用户和 18 项目；Runs、素材、钱包及共享凭据数量未变。未执行 DROP、清队列或删除对象，unknown 与未确认归属继续暂缓。

共享切换前按计划第 10 节：确认保留资源的目标身份、冻结旧提交、保存数据库/对象/队列/密钥恢复点、执行已复核清单、再部署配套两端及新迁移。旧数据门禁报错必须处理清单，不能绕过或直接改历史迁移。回退使用对应备份和对象 manifest；Git 回退不能恢复数据，也不能用旧备份覆盖切换后的新作品。

## 历次本地交付与后续切换记录

工程实现、隔离迁移/清理演练、PC Web 和五模型 Mock 已有首批验收。首批交付为 Canvas `ce6d5b4` / `v2026.09.21-newapi-accounts` 与 New API `727c274e7` / `v1.0.0-rc.37.custom.14`。本轮补齐恢复、视频持久化/发送边界和人工期限修复，交付 Tag 为 Canvas `v2026.09.21-newapi-acceptance`、New API `v1.0.0-rc.37.custom.15`，分别推送 `origin/codex/generate-to-new-node` 与 `fork/main`，实际提交和远端核验在任务交付中记录。

本次独立 Docker、PC 13 项检查、重新授权探针及已确认旧测试账号的 21 行清理已完成，文档交付 Tag 为 `v2026.09.21-newapi-local-acceptance`。生产部署、旧库 unknown 核查及保留归属转换、真实供应商素材外网访问/付费回执仍待完成；原 Run 恢复入口已实现，队列和密钥的隔离恢复证据已补齐。下一阶段从这些剩余条件接续，不重复本机合成验收。前一代码版本可回退源码，但会重新出现已修复的期限和发送边界问题；本次未新增 schema 迁移，代码回退不能复活已经 changed 的管理授权或恢复已删除测试数据。

本批跨账号导入、显式分组与历史入口修复使用 Tag `v2026.09.21-newapi-import-acceptance` 交付到当前 Canvas 上游分支。独立 Docker 已运行本批代码；完整检查、真实 PostgreSQL、双账号导入及 PC 证据见文首。New API 本批无源码改动，继续使用 `f31ac6ab7`；计划整体仍保留上述外部验收条件。
