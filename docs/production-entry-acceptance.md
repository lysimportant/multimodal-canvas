# CI 与生产模式入口隔离验收

## 范围与结论

本次维护 `.github/workflows/ci.yml`、`apps/api/src/production-proxy.test.ts`、本文档，
以及后续授权的 `Dockerfile.acceptance`、`.dockerignore`、`scripts/verify-linux-ci.ps1/.sh`，
不修改 API `app/startup/index`、Provider 契约、其他 Agent 的测试或 TODO；不提交、推送、
修改 Secret 或访问生产环境。

本地 HTTPS 代理与独立 `NODE_ENV=production` API 已完成真实网络入口验收。
2026-09-05 最终完整隔离 Linux CI 已全部通过，精确快照与结果见文末。
这不是生产部署验收，也不是供应商、媒体归档、外部追踪或整个 P0/P1 的完成证明。

## 已证实的 CI 问题

- 根 `package.json` 固定 `pnpm@11.19.0`。`pnpm view pnpm@11.19.0 engines --json`
  返回 `node >=22.13`，原 CI 的 Node 20 不兼容；现固定 Node `24.12.0`，与本地验证一致。
- 原 CI 只执行根格式检查，没有执行各包 `lint`；现加入 `pnpm lint`。
- 原 `typecheck/test` 的 Turbo `^build` 会构建依赖，未发现凭据恢复因缺少 dist 被静默跳过的证据。
  为覆盖新增动态导入 Worker 源码的独立进程用例，现明确先 `pnpm build`，再 typecheck、
  单元测试和独立集成测试，不依赖机器上残留的 workspace 产物。
- 单元测试显式禁用 Turbo 缓存并限制单 worker；独立集成同样使用单 worker。
  不覆盖集成用例的 `120_000` 毫秒超时，保留 BullMQ 约 60 秒的真实崩溃接管窗口。
- 真实 Redis、Prisma/Redis/MinIO、生产模式入口、真实媒体/S3 分别生成 JSON 报告。
  CI 要求每份报告测试数量大于零、全部通过、没有 skip/TODO；报告缺失也失败。
  这是执行完整性检查，不是语句覆盖率统计。
- 普通单元测试未显式配置依赖时允许跳过真实设施测试；这些跳过不算验收通过。
  独立 CI 步骤分别启用 `REQUIRE_RATE_LIMIT_INTEGRATION`、`REQUIRE_INTEGRATION_SERVICES`
  和 `REQUIRE_PRODUCTION_ENTRY`，缺配置时失败，最终再检查报告，防止遗漏。

## 入口测试边界

- 用 OpenSSL 在系统临时目录生成有效期一天的临时证书和私钥，显式使用临时空配置。
  不安装证书、不读取或覆盖用户证书配置、不把私钥写入仓库。
- HTTPS 客户端仅对该请求传入 `ca`，保留 `rejectUnauthorized: true`。
  不设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`，不修改系统信任库或全局 Agent。
- 分别验证默认信任链拒绝自签证书，以及即使信任该证书仍拒绝错误主机名。
- 真实 API 子进程运行 `src/index.ts`，生产启动校验照常执行；使用 PostgreSQL、Redis/BullMQ
  和 S3 配置，不替换 `buildApp`，不注入内存限流器。
- 子进程环境仅保留必要操作系统变量，再显式设置测试连接和随机合成凭据。
  API 与 TLS 代理只监听 `127.0.0.1` 的临时端口；不继承 Provider、遥测或 TLS 环境配置。
- 测试只接受 `127.0.0.1` 的明确 test/ci 数据库与 bucket，Redis 必须指定专用数据库 1-15。
  为每次运行创建随机 PostgreSQL schema 和队列名称，不读写生产表、不执行 FLUSHDB。
- API 退出后才删除本次随机 schema 和证书目录；关闭所有代理连接并等待子进程退出。
  隔离 Redis 队列元数据随测试设施生命周期处理，不清理其他应用键。
- 只访问健康、设置读取、认证/CORS 与错误输入路由，不创建 Provider 请求。
  S3 在这里是生产启动所需配置，不能据此声称 S3 上传下载或媒体归档通过。

## 验证命令

先准备已授权的一次性本机 PostgreSQL、Redis、MinIO，不能填入生产连接。
现有 `scripts/verify-isolated.ps1` 可用于准备和运行基础设施验收；本文不修改该脚本。

```powershell
pnpm exec turbo run build --force --concurrency=1
pnpm --filter @multimodal-canvas/api typecheck
pnpm --filter @multimodal-canvas/api exec vitest run src/startup-config.test.ts src/app-guards.test.ts src/rate-limit-http.test.ts --maxWorkers=1 --minWorkers=1
```

在当前终端进程中配置 `TEST_DATABASE_URL`、`TEST_REDIS_URL`、`TEST_S3_ENDPOINT`、
`TEST_S3_REGION`、`TEST_S3_BUCKET`、`TEST_S3_ACCESS_KEY`、`TEST_S3_SECRET_KEY` 后运行：

```powershell
$env:REQUIRE_PRODUCTION_ENTRY = 'true'
# Windows 的 OpenSSL 若不在 PATH，指向已经安装的 Git 所附二进制。
$env:OPENSSL_PATH = 'C:\Software\Git\usr\bin\openssl.exe'
pnpm --filter @multimodal-canvas/api exec vitest run src/production-proxy.test.ts --maxWorkers=1 --minWorkers=1 --reporter=default --reporter=json --outputFile=../../test-results/ci/production-entry.json
```

Linux Runner 使用已有的 `openssl` 命令，不需要上述 Windows 路径。
`REQUIRE_PRODUCTION_ENTRY=true` 且缺少任一必需配置时，命令必须非零退出。
不用该开关的普通测试只验证隔离配置保护，并明确跳过真实入口组。

## 本轮证据

基线：`main` / `9692ed8`；Node `v24.12.0`、pnpm `11.19.0`、Docker `29.7.2`、
OpenSSL `3.5.5`。没有安装新依赖或修改 manifest/lockfile。

本轮新建 Compose 项目 `mc-entry-ci-1788574281057`，仅绑定回环随机端口：
PostgreSQL `32771`、Redis `32770`、MinIO `32768`，与既有开发服务分离。

| 检查                         | 结果                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| 原入口基线                   | startup/CORS/认证/限流 75 项通过                           |
| 全 workspace 强制构建        | 8 个任务通过，无 Turbo 缓存命中                            |
| 隔离迁移                     | 14 个迁移成功，schema diff 为零                            |
| 真实 Redis 跨进程限流        | 9 项通过，无 skip/TODO                                     |
| HTTPS 生产模式入口           | 22 项通过，无 skip/TODO                                    |
| 入口强制验收缺配置           | 如预期非零退出，未启动 API                                 |
| 工作流静态校验               | YAML 解析成功；构建先于 typecheck/集成；单 worker 配置成立 |
| 新增 BullMQ 崩溃接管完整集成 | 23 项通过，崩溃接管约 65 秒，全部约 100 秒，无 skip/TODO   |

入口覆盖 TLS 信任与主机名、健康 `200`、认证 `401/200`、伪造转发头、
允许及拒绝来源的 CORS、解析 `400`、体积 `413`、启动配置失败、上游退出 `502`，
并检查日志和响应未泄露合成请求凭据。

报告输出到被 Git 忽略的 `test-results/ci/*.json`；构建日志为 `.data/entry-ci-build.log`。
CI 配置保留报告 artifact 7 天，不上传临时证书、私钥或原始进程日志。

## GitHub 只读核验与剩余条件

2026-09-05 通过 GitHub 公开 REST API 只读核验已提交运行：

- 提交：`9692ed8c9aececdb889aa90ae81a668cd98efbd8`。
- [运行 33937026266](https://github.com/lysimportant/multimodal-canvas/actions/runs/33937026266)
  的结论为 failure，但 job 尚无已执行步骤。
- check run `101226836114` 的注释为：
  `The job was not started because your account is locked due to a billing issue.`
- 当前机器没有 `gh` 命令，所以使用公开只读 API，没有安装 gh、提供认证令牌或修改远程状态。

该 GitHub 失败是账户/Runner 启动阻塞，不能归因于本轮代码；Node 20 与 pnpm 11
的不兼容是另一个通过版本元数据证实的配置问题。

GitHub 专属外部条件：仓库负责人解除 GitHub 账户限制，主代理按授权流程提交后触发 Runner，
再核对完整 workflow、JSON 报告及 artifact。账户限制不阻塞下面的等效隔离 Linux 验收。
实际部署仍需授权的 TLS 域名/证书、反向代理/入口规则和真实网络边界演练；
本地 Node 代理不是可直接部署的反向代理产品，也不证明 HSTS、证书轮换、真实客户端 IP
传递/限流策略、生产配置回滚或外部告警投递已通过。

本次仅改变 CI 顺序与测试入口，不引入运行时迁移或用户数据格式变化；回滚可仅恢复 CI
文件并移除新增测试，不得以此回退已存在的生产认证和限流保护。

## 等效隔离 Linux CI

新增 `Dockerfile.acceptance`、`scripts/verify-linux-ci.ps1` 和
`scripts/verify-linux-ci.sh`。Docker 依赖层固定官方 `node:24.12.0-bookworm-slim`，
在容器内安装 `pnpm@11.19.0`、锁文件依赖、FFmpeg/ffprobe、OpenSSL 及 Playwright Chromium。
不修改主机全局运行时、代理、证书或 Docker 配置。

```powershell
# SnapshotPath 必须是包含本轮修改的完整干净快照，不能传旧 HEAD 或直接传工作区。
./scripts/verify-linux-ci.ps1 -SnapshotPath 'G:\isolated-snapshots\current-index' -PrepareOnly
./scripts/verify-linux-ci.ps1 -SnapshotPath 'G:\isolated-snapshots\current-index'
```

- 按主代理授权，正式验收也可使用 `git ls-files --cached --others --exclude-standard`
  列出的完整当前工作区文件快照，排除全部 `.env` 变体、用户配置与生成目录；不要求先暂存。
  最终提交须与报告中的逐文件 SHA-256 比对，不能把旧快照的通过结果直接套用到新源码。
- 快照拒绝真实 `.env`、认证 `.npmrc`、宿主 `node_modules/dist/.data/.git` 及符号链接；
  构建只 COPY 干净快照，不挂载任何宿主目录。记录全部源文件 SHA-256，避免旧 HEAD 或漏文件混淆证据。
- 测试容器使用 `network=none`；新建 PostgreSQL、Redis、MinIO 侧车共享它的网络命名空间，
  因此 `127.0.0.1` 只指向这次设施，没有宿主端口，也无法访问外部 Provider 或生产网络。
- 锁文件离线安装、显式 workspace 构建、lint/typecheck、格式检查、强制全量单 worker 测试、
  迁移、独立集成、TLS、真实媒体/S3、HTTP 遥测和单 worker Web E2E 都在 Linux 容器内运行。
- 基础依赖或构建失败立即退出；其他独立检查失败时写入 `checks.txt` 并继续收集证据，
  最终只要存在失败就非零退出，避免一个格式问题掩盖全部后续验收结果。
- 集成调用项目 `test:integration`，随仓库配置包含 Prisma 与设置同步套件，不硬编码单文件。
  保留 BullMQ 崩溃接管用例的 120 秒超时。媒体显式打开 `MEDIA_REAL_TESTS/MEDIA_OPS_INTEGRATION`。
- 退出时复制 JSON、E2E 失败附件和执行日志到 `.data/mc-linux-ci-*/`，仅清理本次带随机标签的容器；
  不删除输入快照或依赖镜像。不连接原有默认开发数据库、Redis 或 MinIO。

依赖准备已通过：Node `24.12.0`、pnpm `11.19.0`、FFmpeg `5.1.9`、OpenSSL `3.0.20`、
Playwright `1.62.1`，无外部网络的 Chromium 启动/渲染冒烟成功。
镜像为 `multimodal-canvas-acceptance:local`，准备阶段摘要
`sha256:1ebd2078ff6a5e9957e458735eeca17140814920911430b9a4ce85e2c4b955c4`。
首次 Docker Hub 连接和 APT 下载曾临时失败，重试后完成；下载重试有次数上限且不关闭 TLS 校验。

准备日志为 `.data/linux-ci-prepare.log`。

### 全量 Linux 执行记录

2026-09-05 已完成第一轮全量执行，非仅准备依赖：

- 快照：`.data/linux-ci-final-1788576878709`。
- 报告：`.data/mc-linux-ci-44394aab95c1`；完整日志：`.data/linux-ci-final-run.log`。
- `source-manifest.json` SHA-256：
  `3A1B10CC0930BDFDAC0FE139701626D6E65538FDEFBEE1FCF1B5BE555FF2ACBA`。
- 镜像：`sha256:4ae2278b1fdf0ebbbbedc48ce05fd712cfa175fc560c54213a8f6f1614de7d4b`。
- 锁文件离线安装、Prisma generate、8 个 workspace 构建、lint、typecheck 与格式检查通过。
- Domain 24、Observability 21、Crypto 7、UI 3、Providers 265、Web 315、Worker 183 项通过。
- API 普通测试 451 通过、3 失败、49 跳过；三项失败均为旧 catalog 事务 mock，
  由设置 Agent 修复；不能将这轮整体标为通过，历史失败报告保持原样。
- 真实 Redis 9、Prisma/设置同步 35、生产 HTTPS 22、媒体/S3 13、HTTP collector 3 项通过；
  所有独立套件的非空、无 skip/TODO 报告门禁通过。
- Web E2E 21 项通过，耗时 46.5 秒；此快照尚不包含最终视频 width/height 控件。
- 命令退出码为 1，仅 `unit` 失败；会话 `90659` 已结束，四个运行容器已清理。

### 最终完整 Linux 验收通过

设置 mock、视频像素控件和 Provider 精确 UTF-8 模型字符串测试交付后，重新执行了全部步骤：

```powershell
./scripts/verify-linux-ci.ps1 -SnapshotPath 'G:\multimodal-canvas\.data\linux-ci-release-1788577740957' -Scope full
```

- 会话 `62825` 最终退出码为 **0**，没有剩余运行会话。
- 开始时间：`2026-09-05T03:09:20.4307577Z`；最终 Web E2E 于约 `03:15:42Z` 完成。
- 快照：`.data/linux-ci-release-1788577740957`；284 个文件，容器内逐一核对全部 SHA-256 一致。
- 报告：`.data/mc-linux-ci-665b7a40bdd5`；完整日志：`.data/linux-ci-release-run.log`。
- 源清单：`.data/mc-linux-ci-665b7a40bdd5/source-manifest.json`，SHA-256：
  `328E776E0B28CCD6AAF521C93654E0EC5AAA2A0BD60FDB45F96F7676026A8CC9`。
- 锁文件 SHA-256：`90CDE98306C97B269530BF613D217E6D7F78C47CF8159A90DC6ECEC1F77BAF87`。
- 镜像 ID：`sha256:6f1141eacc402af2e85095ea917e32e85029a74bafe6e31ce910a1e0e1588d7d`。

| 验收步骤                                        | 最终结果                                         |
| ----------------------------------------------- | ------------------------------------------------ |
| frozen/offline install、Prisma generate         | 通过                                             |
| 全 workspace build、lint、typecheck、根格式检查 | 全部通过，无 Turbo 缓存替代执行                  |
| Domain / Crypto / UI / Observability 单元测试   | 24 / 7 / 3 / 21 项通过                           |
| Provider / Web / Worker / API 单元测试          | 266 / 339 / 183 / 454 项通过                     |
| 迁移及 schema diff                              | 14 个迁移成功，零差异                            |
| 真实 Redis 跨进程限流                           | 9 项通过                                         |
| Prisma 与设置同步集成                           | 24 + 11 = 35 项通过                              |
| 生产 HTTPS 入口                                 | 22 项通过                                        |
| 真实媒体与 S3/Prisma                            | 5 + 8 = 13 项通过                                |
| 真实 HTTP collector                             | 3 项通过                                         |
| 独立集成 JSON 报告门禁                          | 全部非空、零失败、零 skip、零 TODO               |
| 最终 Web E2E                                    | 22 项通过，46.8 秒，零 skip / flaky / unexpected |

API 普通单元测试仍按设计跳过未启用的真实设施组；不将这些跳过作为通过数量。
随后五份独立套件 JSON 全部启用并通过，因此没有用普通单元 skip 替代实际验收。
本轮真实文本崩溃接管用例耗时约 94.5 秒，整组集成约 131.4 秒；
120 秒限制是单用例超时，不是整个测试文件的总时长，未调整租约、轮询或超时来缩短验收。

Web 已覆盖音频参数和可选视频 width/height 的保存、清空、恢复和请求提交。
桌面截图保存在报告的 `ci/playwright/` 下，文件名为 `audio-desktop.png`，
并由 Playwright JSON 附件记录关联到对应测试。

运行时核验 `NetworkMode=none`、挂载列表为空、宿主端口映射为空。
退出后按 `multimodal.acceptance=mc-linux-ci-665b7a40bdd5` 标签查询，剩余容器为零；
四个本次容器及其匿名卷已清理，默认开发设施未改动。快照、报告和镜像保留供主代理审计。
先前退出码为 1 的报告仍保留，不覆盖、不改写为成功。

最终运行结束时生产源码哈希无变化；后续证据文档和主代理 TODO 的变化只需文档格式核验。
Windows 专用启动脚本后续将四个端口限制为本机回环地址，S3 权限脚本增加回环绑定门禁；
主代理实际重建本次设施并保留卷，重新执行 35+9+22 项集成与 29 项权限验证通过。
该补验记录位于 `.data/acceptance-loopback-integration.log` 和 `.data/acceptance-loopback-s3.log`，
不将旧 Linux 快照的通过结果外推到修改后的 Windows 脚本。
主代理提交前仍须按源清单检查新增、删除与修改文件，发现实现或测试变化时补跑相关检查。
本 Agent 没有提交、推送或访问生产环境。

### 可选增量补验

脚本也支持经逐文件差异审核后的增量补验，例如：

```powershell
./scripts/verify-linux-ci.ps1 -SnapshotPath 'G:\isolated-snapshots\current-workspace' -Scope delta -Packages api,web,providers
```

增量模式仍离线安装、生成 Prisma、构建全部 workspace，再执行根格式检查、指定包的
lint/typecheck/单 worker 测试；指定 Web 时运行 E2E。不启动基础设施侧车，不重复接管套件。
报告显式保存 `scope` 和包名；增量成功本身不是一次全量 Linux 验收通过证明。
