# 完整生产 Compose 合成验收

## 范围与前提

仅针对 `mc-acceptance-test-docker`，唯一 HTTP 入口为 `http://localhost:18080`。
不可用于 `multimodal-canvas-app`、开发栈或用户已有设施，不读取 `.env`。
必需服务为 Web、API、Worker、PostgreSQL、Redis、MinIO；不限制 Compose 总服务数量，
兼容可选 server/Caddy profile，但本验收不请求外部域名、不测试公网证书。

主 Agent 负责构建、启动和重启 Compose。脚本不执行 `up`、`restart`、`stop`、`down`、
卷删除或真实 Provider 请求，也不自行管理 fixture 容器。
所有必需服务须 healthy；Web 仅绑定 `127.0.0.1:18080`，内部服务不发布端口。
API/Worker 必须使用 `NODE_ENV=production`、`RUN_SERVICE=bullmq`、
`WORKER_PROVIDER=newapi`、`S3_UPLOAD_MODE=proxy`、`S3_DOWNLOAD_MODE=proxy`，
使用独立卷和 TLS Redis/MinIO。API/Worker 未显式配置下载代理时，脚本在请求业务接口前失败。

主机需要 Node 24、可连接本机 Linux engine 的 Docker CLI，以及仓库锁定的本地依赖。
ZIP 解码复用 `apps/api` 的 `fflate`，缺失时在仓库根目录执行 `pnpm install --frozen-lockfile`。
远程 Docker context、`DOCKER_HOST`/TLS 客户端覆盖配置会被拒绝。
Linux 也从主机执行脚本，应用验证对象始终是生产镜像，不运行开发服务器。

## 启动 HTTPS Fixture

以下命令由主 Agent 在隔离栈健康后执行。fixture 不挂载源码目录或其他数据卷；
只读挂载单个脚本及本项目 `minio_secrets` 视图卷（不挂载原始 secrets），读取
`/run/multimodal/secrets/minio/{public.crt,private.key}`，监听 `0.0.0.0:9443`。
通过共享本项目 MinIO 的网络命名空间提供 `https://minio:9443`，不发布主机端口。
fixture 完全合成内容，不访问网络、不读取真实 Provider key、不记录请求正文/鉴权头。

### Windows PowerShell

在 `G:\multimodal-canvas` 执行，Docker context 必须与主 Agent 启动隔离栈时一致：

```powershell
$project = 'mc-acceptance-test-docker'
$minio = docker compose -f compose.yaml -p $project ps -q minio
if ($LASTEXITCODE -ne 0 -or !$minio) { throw 'Test MinIO is not running' }
$container = (docker inspect $minio | ConvertFrom-Json)[0]
if ($container.Config.Labels.'com.docker.compose.project' -ne $project -or $container.Config.Labels.'com.docker.compose.service' -ne 'minio') { throw 'MinIO labels mismatch' }
$volume = (docker volume inspect "${project}_minio_secrets" | ConvertFrom-Json)[0]
if ($volume.Labels.'com.docker.compose.project' -ne $project -or $volume.Labels.'com.docker.compose.volume' -ne 'minio_secrets') { throw 'Secret volume labels mismatch' }
$fixture = (Resolve-Path .\scripts\docker\provider-fixture.mjs).Path
docker run -d --name "${project}-provider-fixture" --label "io.multimodal.smoke.project=$project" --label 'io.multimodal.smoke.fixture=mc-acceptance-provider-v1' --network "container:$($container.Id)" --read-only --cap-drop ALL --security-opt no-new-privileges --mount "type=volume,source=${project}_minio_secrets,target=/run/multimodal,readonly" --mount "type=bind,source=$fixture,target=/fixture.mjs,readonly" node:24.12.0-bookworm-slim node /fixture.mjs
if ($LASTEXITCODE -ne 0) { throw 'Fixture creation failed; inspect existing state, do not remove volumes' }
```

### Linux Shell

在相同仓库根目录执行，先由主 Agent 只读确认项目及卷标签：

```bash
project=mc-acceptance-test-docker
minio=$(docker compose -f compose.yaml -p "$project" ps -q minio)
test -n "$minio" || exit 1
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$minio")" = "$project" || exit 1
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$minio")" = minio || exit 1
test "$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "${project}_minio_secrets")" = "$project" || exit 1
test "$(docker volume inspect --format '{{index .Labels "com.docker.compose.volume"}}' "${project}_minio_secrets")" = minio_secrets || exit 1
docker run -d --name "${project}-provider-fixture" \
  --label "io.multimodal.smoke.project=$project" \
  --label io.multimodal.smoke.fixture=mc-acceptance-provider-v1 \
  --network "container:$minio" --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=volume,source=${project}_minio_secrets,target=/run/multimodal,readonly" \
  --mount "type=bind,source=$(pwd)/scripts/docker/provider-fixture.mjs,target=/fixture.mjs,readonly" \
  node:24.12.0-bookworm-slim node /fixture.mjs
```

已有同名容器时不要盲目重复创建或删除：先核对其标签、挂载和 NetworkMode。
fixture 使用自己的 `io.multimodal.smoke.*` 标签，不冒充 Compose 服务，避免干扰可选 profile。
脚本 `before` 还会再次核验 fixture，确认其共享的是当前 MinIO 容器。

## 两阶段执行

```text
node scripts/docker/smoke.mjs --self-test
node scripts/docker/smoke.mjs before
```

`before` 从主机加载当前脚本。容器侧 Prisma 断言代码通过 `exec -T api node` 传入，
不依赖镜像构建时 COPY 的 smoke 快照。管理员引导严格使用
`docker compose -f compose.yaml -p mc-acceptance-test-docker exec -T api node docker/run.mjs admin <本次合成邮箱>`。

`before` 通过后，主 Agent 确认目标项目再执行下面的重启命令。
不启用 server profile，不重启初始化/迁移服务，不重启用户运行栈：

```text
docker compose -f compose.yaml -p mc-acceptance-test-docker restart --no-deps postgres redis minio api worker web
```

等待六个服务重新 healthy 后执行：

```text
node scripts/docker/smoke.mjs after
```

`after` 要求每个必需服务的 StartedAt 晚于 before 完成时间，逐项复查同一项目、
画布、上传图片、生成结果、版本内容、导出 ZIP、Run、ProviderJob 和 UsageLedger，
并复查浏览器实际使用的同源短期签名 URL 和图片 thumbnail。
重启 MinIO 后旧 fixture 网络命名空间可能失效；`after` 不调用 fixture 或刷新模型，
因此仍可验证持久化。需要下一次独立实验时，由主 Agent 核验后处理自己创建的 fixture；
本脚本不自动删除或重建它。

## 验收内容

- 真实注册、登录、普通用户 403、注销后 401，以及容器管理员提权后重新登录。
- 保存画布、读回修订号、拒绝过期 revision，持久化项目和已上传资产引用。
- PNG 上传 `init -> PUT(204) -> complete`，SHA-256、内容读取和 FFmpeg thumbnail。
- 上传图片、生成文本、生成图片分别通过 Bearer 签发 `POST /v1/assets/:id/access-url`，
  再无 Bearer GET 返回地址，并与鉴权读取的原始内容比较 SHA-256。
- 上传图片和生成图片的已有 thumbnail 同样覆盖鉴权 GET、`derivative: "thumbnail"`
  签发及无 Bearer GET；派生缺失时明确失败，不重新生成或上传。
- 签名 URL 只接受固定 ORIGIN 下、匹配已知资源的根相对路径，以及唯一非空 `access_token`。
  在 GET 前通过 `localUrl` 再核验源，拒绝内部 MinIO 地址、绝对地址（包括同源绝对地址）、
  协议相对地址、反斜杠、控制字符、额外查询参数或资源替换；不跟随重定向。
- 通过真实生产 API、BullMQ、Worker、S3、Prisma 完成一次文本及一次图像生成。
- body/header 两种幂等键输入指向同一 Run；fixture 精确检查只有两次上游 POST、两次创建。
- 文本只报告 token，UsageLedger 必须为零，不能把目录的 9.99 估算当作扣费。
- 图像明确报告合成金额 0.0123 USD，必须且只能产生一条 0.012300 USD generation 记录。
- 验证工作流 JSON、结果 ZIP manifest 及 ZIP 内原始资产 SHA-256，使用已锁定 fflate。

单个生成最多轮询 120 秒；网络请求最多 30 秒；不会调用 retry/cancel 或自动重发创建。
这是生产链路合成验收，不代表真实外部供应商、视频、音频、收费或公网回调已验收。

## 报告与恢复

仅 `.data/docker-smoke-report.json` 保存脱敏身份、ID、内容摘要、阶段、容器启动时间、
计数和验证结果，目录已被 Git 忽略；原子写入期间可能短暂存在同目录 `.tmp`。
密码、token、含短期签名的 URL、真实 Provider key、响应原文和连接串均不写报告、日志或命令参数。
随机密码仅在进程内，注册产生的密码摘要由真实认证服务正常保存于隔离数据库。

由于密码不落盘，`after` 和已完成报告的重跑会先校验数据库只含本报告的合成账号、
项目和资产，核对账号 UUID、`smoke-<suite UUID>@example.invalid`、显示名、项目所有权、
唯一合成 Provider 指纹及 Run。只有完全匹配，才将这个合成账号的 scrypt v1 密码摘要
轮换为新的进程内随机密码，然后调用正常登录 API；不签造 JWT，不跳过认证。
此窄范围运维写入只针对脚本创建的合成账号，其余恢复步骤只读，结束时注销该账号会话。

再次执行 `before` 只验证报告中的已知数据，不新建项目、上传或生成；再次执行 `after`
同样不会创建 Run 或新增 usage。发现未知 Provider 或其他业务数据直接失败，不覆盖配置。
不要同时执行两个验收进程，避免并发轮换同一合成账号的密码。

补充同源下载验证后，报告仍为 `schemaVersion: 1`，沿用原有 before/after 字段和资产 ID。
已有通过报告无需重新创建 before 数据：由主 Agent 更新并重构镜像、等待目标六服务健康后，
直接执行 `node scripts/docker/smoke.mjs after` 即可。新增的 POST 仅签发 60 秒资源访问 URL，
不创建资产、派生、Run 或 usage，不刷新模型、不调用 fixture 或任何外部 Provider。
旧报告中原有的 `after_passed` 不代表这项新增检查已经通过，以新版脚本成功复验为准。

若报告仍为 `initializing`，脚本明确失败，不把部分成功当作完整验收，不自动重建；
保留报告中的已知 Run ID，由主 Agent 检查相应记录和失败阶段。注册/上传/创建返回不明时
尤其不可删除报告后重跑，避免重复提交。断线后重新核对标签、报告及只读查询，禁止删除卷。

## 静态验证与契约来源

```text
node --check scripts/docker/smoke.mjs
node --check scripts/docker/provider-fixture.mjs
node scripts/docker/smoke.mjs --self-test
pnpm exec prettier --check scripts/docker/smoke.mjs scripts/docker/provider-fixture.mjs docs/docker-smoke.md
```

契约来自 `apps/api/src/auth-routes.test.ts`、`apps/api/src/app.test.ts` 的上传、
画布和幂等测试，以及 `apps/api/src/export.ts`、`packages/providers/src/index.test.ts`
和 `apps/worker/src/index.ts` 的结果与 usage 策略。`--self-test` 只测试纯函数，
不启动 HTTPS、不请求 API、不连接 Docker；不能替代 before/after 的运行结果。
