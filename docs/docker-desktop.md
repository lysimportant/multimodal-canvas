# Windows Docker Desktop 完整本地运行

## 运行范围

项目的运行核心是同一份跨平台 `compose.yaml`，支持 Windows Docker Desktop 和 Linux 服务器。本文的 CMD/PowerShell 只是可选的 Windows 便捷包装，不是部署前提。Linux 服务器上的域名、HTTPS 与启动步骤见 [Linux 服务器部署](docker-server.md)。

此入口使用根目录 `compose.yaml`，项目名固定为 `multimodal-canvas-app`。运行正式构建的 Web、API 和 Worker，以及 PostgreSQL、Redis、MinIO；不是 `pnpm dev`，不使用 Vite 开发服务器或内存任务模式。`initialize`、`migrate`、`storage-init` 是一次性初始化服务，成功执行后退出，不应作为常驻服务手动重启。

默认浏览器地址是 <http://localhost:8080/>，仅向 `127.0.0.1` 发布入口端口。可以额外启用 <https://localhost:8443/>，同时保留 HTTP 8080 供本机访问或后续域名反向代理。数据库、Redis、对象存储和应用内部端口不面向局域网或公网开放。生产构建不等于公网部署；域名、公网证书、认证策略和供应商回调需要独立配置与验收。

### 当前电脑的 New API 本地验收环境

当前电脑使用单独的 `canvas-newapi-local` 项目，包含已配套的本地 New API 和免费 Mock。**双击根目录的 `Docker-Local.cmd` 启动这套环境**：显式选择本地配置，使用已有镜像，不构建、不拉取镜像，也不清空数据。配置或镜像缺失时明确失败。

根目录直接运行通用 Compose 命令，或使用 `Docker-Start.cmd`，操作的是 `multimodal-canvas-app`，不会自动选中这套本地环境；通用入口必须先按下文提供真实 `MC_NEW_API_*` 配置。两个项目各自保存数据库卷，但 Web 默认都使用 8080，同一时间只能有一个占用该入口。

在已保留配置和镜像的当前电脑，从仓库根目录启动、查看状态或停止：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/docker.ps1 -LocalNewApi -Action Start -NoBrowser
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/docker.ps1 -LocalNewApi -Action Status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/docker.ps1 -LocalNewApi -Action Stop
```

直接使用 Compose 的等价启动命令为：

```powershell
docker compose --project-name canvas-newapi-local `
  --env-file .local-tests/newapi-account/local-docker/local.env `
  -f compose.yaml `
  -f .local-tests/newapi-account/local-docker/compose.yaml `
  up -d --no-build --pull never --wait --wait-timeout 180
```

画布入口为 <http://localhost:8080/>，New API 为 <https://newapi.localhost:13443>。从画布重新发起登录，不复用浏览器中已过期的回调或登录事务 URL。此环境使用本地合成账号，不依赖线上 New API 是否更新。

查看状态或保留数据地停止时，保留相同的 `--project-name`、`--env-file` 和两个 `-f` 参数，将末尾 `up ...` 替换为 `ps -a` 或 `stop`。这里的 `.local-tests` 配置、证书和合成账号不进入 Git；此命令仅用于已建立该环境的电脑，不是新克隆仓库的通用初始化命令。

2026-09-21 晚按用户“不再保留旧数据”的最新要求，已删除桌面归档并将本地环境的 13 个卷重新初始化，随后删除已确认的离线数据库/对象/队列备份、旧账号文件和 9 个恢复演练卷。30 条迁移成功；新管理员登录后同步 15 个分组、75 条免费 Mock 目录。项目、素材、素材版本、节点、任务及 `canvas` bucket 均为空，旧素材地址返回 404。旧脚本导入不再自动读取历史账号或发送请求；应用容器不挂载宿主 `.data` 或验收备份。

本次重新初始化生成了新的内部 CA，已核对其来源并导入当前用户证书存储，浏览器未关闭 TLS 校验即可完成登录。历史迁移记录中的桌面归档和恢复副本已经删除，不再作为可用恢复来源；Git 回退不能恢复这些数据。

## 首次启动

1. 安装并打开 Windows Docker Desktop，完成其首次安装引导、许可确认及 WSL 2/虚拟化配置，使用 **Linux containers**。脚本不会替你修改系统功能、全局 Docker context 或容器模式。
2. 保持 Docker Hub、Quay.io、Debian HTTPS 仓库和 npm 可访问。第一次需要下载基础镜像、安装镜像内依赖并构建应用；MinIO Server 与 `mc` 从 `quay.io/minio` 获取，并保留仓库固定的 SHA-256 digest。耗时取决于网络和机器性能；主机不需要另外安装 Node.js 或 pnpm。
3. 当前电脑已有配套 New API 环境时，在项目根目录双击 `Docker-Local.cmd`。需要启动通用 `multimodal-canvas-app` 时，先按下节配置真实 New API 站点，再运行标准 Compose 命令或 `Docker-Start.cmd`。
4. 等待 Compose 健康检查完成，脚本会打开默认浏览器。若初始化、构建或健康检查失败，窗口保留错误，不会宣称启动成功或自动重复变更操作。

脚本兼容 Windows PowerShell 5.1 和 PowerShell 7。双击入口使用系统自带的 Windows PowerShell 5.1，`ExecutionPolicy Bypass` 仅作用于该进程，不修改机器或用户策略。组织策略禁止脚本时，请联系管理员处理，不要自行关闭安全机制。

Docker CLI 不在 `PATH` 时，脚本会检查 Docker Desktop 的标准全机和当前用户安装目录。引擎未就绪时，Start/Build/Https 可以隐藏启动已安装的 Docker Desktop，并最多等待约 180 秒；仍未就绪则显式失败。引擎就绪后，Compose 服务健康等待上限是 180 秒，首次镜像下载和构建耗时另计。尚未完成 Desktop 首次引导的机器，可能需要先手动打开 Desktop 处理提示。

## New API 登录与管理员

通用 `multimodal-canvas-app` 启动前，按 [.env.compose.example](../.env.compose.example) 创建被 Git 忽略的 `.env.compose`，将 `MC_NEW_API_ISSUER`、`MC_NEW_API_CLIENT_ID`、`MC_NEW_API_INSTANCE_ID` 和回调地址替换为真实站点配置。`MC_NEW_API_ISSUER` 是 Compose 输入，传入 API/Worker 容器后名称为 `NEW_API_ISSUER`；issuer 必须从浏览器和容器实际可达，非回环地址使用 HTTPS。New API 端必须登记相同客户端、实例与精确回调地址，回调路径为当前浏览器入口的 `/v1/auth/newapi/callback`。仅配旧网关地址或保留示例域名无法完成登录。

`.env.compose` 不会被 Compose 或 `Docker-Start.cmd` 自动选中。使用该文件时，从仓库根目录为同一项目的启动、状态和停止命令都显式保留 `--env-file`、`-f` 和项目名：

```powershell
docker compose --env-file .env.compose -f compose.yaml -p multimodal-canvas-app up -d --build --wait --wait-timeout 180
docker compose --env-file .env.compose -f compose.yaml -p multimodal-canvas-app ps -a
docker compose --env-file .env.compose -f compose.yaml -p multimodal-canvas-app stop
```

`Docker-Start.cmd` 使用临时空环境文件，不读取 `.env.compose` 或开发 `.env`；只有从同一终端启动时，当前进程中已设置的 `MC_NEW_API_*` 才会传给 Compose。本机既有 `canvas-newapi-local` 不需要这组通用站点配置，继续使用 `Docker-Local.cmd` 和它自己的配套文件。

用户点击“使用 New API 登录”，授权后自动建立内部资源身份，并同步本人全部开放分组的 Key；原始分组精确等于“神秘分组”时排除，开放的 auto 同样接入。画布只显示分组模型，Key 加密保存在服务端。账号密码、注册和账单由 New API 管理。

需要后台资源管理时，将 New API 不可变用户 ID 加入 `MC_NEW_API_ADMIN_USER_IDS`，重新创建 API 并重新登录。可用 `-Action Admin -NewApiUserId '123'` 同步已经登录且被配置允许的身份；该命令不能绕过部署允许列表。昵称和邮箱不用于认领旧账号。

旧 Canvas 数据切换必须先完成[账号接入计划](newapi-account-integration-plan.md)中的清理预览、备份恢复与队列隔离。新授权任务使用独立 `MC_RUN_QUEUE_NAME`，旧 Worker 不能领取新队列。

## 日常使用

- **启动通用栈**：完成上面的真实 New API 配置后运行 `Docker-Start.cmd`；双击不会加载 `.env.compose`。已有镜像时直接使用，只有缺少应用镜像时才按需构建。本机配套环境使用 `Docker-Local.cmd`。
- **本地 HTTPS**：双击 `Docker-HTTPS.cmd`，或运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\docker.ps1 -Action Https`，启用可选 `local-https` profile 的 `gateway-local`。默认打开 HTTPS 8443，HTTP 8080 仍保留，初次访问需要信任内部 CA。
- **停止**：双击 `Docker-Stop.cmd`。包含 `server` 和 `local-https` profile，只停止本项目已经创建的服务和网关，保留数据库、对象存储、队列、密钥及证书卷；不创建未启用的网关，不影响其他 Compose 项目。
- **查看状态**：在项目根目录运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\docker.ps1 -Action Status`。包含两个网关 profile 的只读查询，不会启动 Docker Desktop 或应用。
- **代码更新后重新构建**：运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\docker.ps1 -Action Build`。这是 `up --build`，成功后启动新镜像并打开浏览器；不是仅构建。
- **不自动打开浏览器**：在 Start/Build/Https 命令后添加 `-NoBrowser`。

Start 的核心操作是以下命令；脚本还显式传入经过检查的本机 context、绝对 Compose 路径和一个临时空 `--env-file`，确保不自动加载仓库 `.env`：

```text
docker compose -f compose.yaml -p multimodal-canvas-app up -d --wait --wait-timeout 180
```

Build 在相同操作上增加 `--build`；Https 增加 `--profile local-https`；Stop/Status 均增加 `--profile server --profile local-https`，分别执行 `compose stop` 与 `compose ps --all`。普通 Start 仍使用 HTTP，不会主动启用或停止已有的 HTTPS 网关。Windows 包装脚本只由 Action 选择 profile，执行 Compose 时临时忽略继承的 `COMPOSE_PROFILES`，退出时恢复，不修改用户环境。脚本不会执行 `down -v`、删除卷、清理镜像或停止占用端口的其他程序。不要在排障时自行执行删除卷命令或 Docker Desktop 的清空/恢复出厂设置。

### 本地 HTTPS 与证书信任

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\docker.ps1 -Action Https -NoBrowser
```

该入口访问 <https://localhost:8443/>。`gateway-local` 使用 `localhost` 主机名和 Caddy 内部 CA，不需要公网域名或公网证书。Compose 健康不表示 Windows 或浏览器已经信任此 CA；首次访问出现证书不受信任提示时，不要通过关闭 TLS 校验绕过问题。

应先从本项目 `gateway-local` 容器导出 **公开根证书** `/data/caddy/pki/authorities/local/root.crt`，保存到用户主目录等仓库之外的位置，具体命令见 [服务器与本地 HTTPS 部署文档](docker-server.md)。确认来源与指纹后，通过 Windows 证书导入向导将其导入当前用户的“受信任的根证书颁发机构”，再访问网页。使用独立证书存储的浏览器还需按其证书管理方式导入。不要导出、复制或分享 CA 私钥，也不要把机器专属证书提交到仓库；信任根证书是影响当前用户证书验证的安全操作，应由你明确决定，启动脚本不会自动执行。

请使用 `https://localhost:<端口>`，不要未经确认替换为 IP 或其它域名，否则证书主机名或 Caddy 站点匹配可能不符。保留本地网关证书数据卷可延续同一 CA；删除卷后重新签发的 CA 不会自动取得原有信任。

HTTP 与 HTTPS 使用同一套账户和业务数据，但属于不同的浏览器来源，切换入口后可能需要重新登录；不应为此重复注册或初始化数据。

后续自行配置公网域名 HTTPS 反向代理时，可以继续把上游指向 **`http://127.0.0.1:8080`**，由外部代理负责公网证书与 TLS 终止。若选择 HTTPS 8443 作为上游，还需信任内部 CA、设置 `SNI=localhost` 并保留外部域名的 HTTP Host；本地入口允许该 Host 转发到 API，不必把 API 的 Host 改成 localhost。转发头仍按可信代理边界处理，不能只做端口替换。代理不在本机时需要安全隧道或独立网络方案，回环端口不会直接对外开放；更多配置见 [Linux 服务器部署](docker-server.md)。

### 只打开 Docker Desktop 是否会自动恢复

首次成功启动后，常驻服务采用 `restart: unless-stopped`：之前仍处于运行状态的容器，在 Docker 引擎重新启动后会自动恢复，例如退出并重新打开 Docker Desktop。一次性初始化服务不适用此策略。

**手动停止过的容器不会自动恢复**，即使重新打开 Docker Desktop 也一样。使用过 `Docker-Stop.cmd`，或在 Desktop 中手动停止本项目后，HTTP 使用再次双击 `Docker-Start.cmd` 恢复；本地 HTTPS 需要双击 `Docker-HTTPS.cmd` 或再次运行 `-Action Https`，单独 Start 不会恢复已停止的 HTTPS 网关。没有启用 Docker Desktop 的系统登录启动选项时，Windows 登录本身也不保证引擎运行；脚本不会修改这个设置。

自动重启策略不等于按依赖健康顺序重新编排，也不保证供应商或网络一直可用。引擎重启后发现服务异常时，先查看 Status 和 Docker Desktop 的容器状态；不要反复点击 Build 或删除数据。镜像不会因启动 Desktop 自动更新，代码更新后需要显式 Build。

### 修改本机端口

默认端口被其他程序使用或被 Windows 保留时，脚本明确失败，不终止占用进程、不静默换端口。在 PowerShell 中设置当前终端环境后启动：

```powershell
$env:MC_HTTP_PORT = '8088'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\docker.ps1 -Action Start
```

此时地址为 <http://localhost:8088/>，仍仅绑定 `127.0.0.1`。允许端口范围为 1 至 65535。该设置只在当前终端及其子进程有效，不会写入用户或系统环境；之后从桌面双击仍使用其继承环境中的端口，未设置则恢复默认 8080。再次运行 Start/Build 时请保持相同 `MC_HTTP_PORT`；脚本不从 `.env` 读取或保存端口。

本地 HTTPS 可单独选择端口，两个端口不能相同：

```powershell
$env:MC_HTTP_PORT = '8088'
$env:MC_HTTPS_PORT = '8444'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\docker.ps1 -Action Https
```

此时 HTTPS 地址为 <https://localhost:8444/>，HTTP 地址为 <http://localhost:8088/>。Https 在启动前分别检查 `web` 的 HTTP 端口与 `gateway-local` 的 HTTPS 端口；另一服务占用同一端口仍视为冲突，不会因属于同一 Compose 项目就放行。后续运行 Https 时请保持相同变量设置。

### 可选环境变量

| 当前终端环境变量    | 默认值            | 含义                                                                                                 |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `MC_HTTP_PORT`      | `8080`            | 仅在本机 `127.0.0.1` 发布的 Web 入口端口。                                                           |
| `MC_HTTPS_PORT`     | `8443`            | 启用 local-https 时的本机 HTTPS 端口；与 HTTP 端口不同，仅绑定 `127.0.0.1`。                         |
| `MC_VIDEO_CONTRACT` | `newapi-video-v1` | 视频供应商协议，可选 `newapi-video-v1`、`newapi-unified-v1` 或 `legacy-v1`；应与实际供应商契约匹配。 |

Worker 容器将 `MC_WORKER_CONCURRENCY` 映射为 `WORKER_CONCURRENCY`：未设置时默认同时处理 4 个独立 Run，显式值必须是 1..20 的整数；空值、小数及越界值会在连接队列前拒绝启动。直接运行 Worker 时使用 `WORKER_CONCURRENCY`。需要回滚为串行时设为 `1`，由部署方在确认没有执行中任务后更新 Worker；调整环境变量不会改变已运行的进程，也不会主动取消任务。该上限按 Worker 进程计算，多副本会叠加；只改变跨 Run 并发，不改变单 Run DAG 依赖、防重复发送、unknown 禁止自动重发或 New API 计费合同。

仅在供应商明确使用 legacy-v1 协议时，按实际配置启动：

```powershell
$env:MC_VIDEO_CONTRACT = 'legacy-v1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\docker.ps1 -Action Start
```

该变量由 Compose 传入应用，不代表填写了供应商凭据，也不会授权任何收费调用。不要只因某次生成失败就切换协议或重发任务。与端口变量一样，后续 Start/Build 应保持相同设置；双击入口不会保存终端中的变量。启动命令显式使用空环境文件，**不会加载开发 `.env` 中的密钥或配置**。

## 数据与供应商配置

生产应用使用独立 named volumes 持久化密钥、PostgreSQL 数据、Redis 数据和 MinIO 对象；可选 HTTPS 网关另有证书和配置数据卷。停止、重开 Docker Desktop 或重新构建镜像不会主动删除这些卷。不要单独丢弃密钥卷，否则已有加密供应商凭据可能无法解密；数据库与对象卷也需要保持一致备份。

原始 `secrets` 卷只挂载给初始化服务。各服务使用独立的 `*_secrets` 只读视图与匹配容器身份的文件权限，基础设施无法读取 API 的 JWT 或凭据加密密钥；已有卷再次初始化不会轮换密钥，遇到内容不一致会明确失败。备份必须保持原始密钥、派生视图和业务数据一致，不要通过删除卷排障。

首次建立该 Compose 项目时使用独立数据环境，不会自动导入旧 `.data`、开发数据库、测试卷或根目录 `.env`。同名项目之后再次启动会复用原有 named volumes；`--build` 只更新镜像，不会清空数据库或将旧卷变成新库。需要旧数据时应先制定并验证迁移与备份方案，不要把“已重新构建镜像”当作“已经完成数据迁移”。

完成 New API 登录后，在画布选择所属分组和已确认支持的模型。不向源码、Compose、CMD、文档或日志粘贴真实密钥。启动脚本不会调用付费 API；首次启动与登录不代表真实供应商生成已验收。点击真实生成可能产生费用，结果不明时应先查询已有任务，不重复创建。

本机回环地址不能被外部供应商直接访问。真实供应商回调、模型权限、账户余额、外网连通性及供应商端取消/签名/幂等契约，不由本地启动成功保障；未确认项仍以 [TODO-SERVER.md](../TODO-SERVER.md) 和相关供应商验收文档为准。

## 失败与恢复

### 构建时 Docker Hub 令牌请求超时

`Dockerfile:2`、`failed to fetch anonymous token` 和 `auth.docker.io` 连接超时表示基础镜像构建前的网络请求失败，还没有进入数据库迁移。`--build` 仍可能访问镜像仓库；删除数据卷不能修复这个错误。

当前电脑已有配套镜像时使用 `Docker-Local.cmd`，其启动带 `--no-build --pull never`。需要从源码重建时，仍须验证 Docker 引擎到 Docker Hub 和 Quay.io 的 DNS/代理连通性。

### MinIO 镜像提示 `pull access denied`

当前 `compose.yaml` 使用 `quay.io/minio/minio` 和 `quay.io/minio/mc`，仅明确了官方 Quay.io registry，两个镜像的固定 digest 没有变化。若错误中的镜像仍为不带 `quay.io/` 的 `minio/mc@sha256:...`，说明使用的是旧 Docker Hub 引用；先取得包含当前 `compose.yaml` 的完整版本再重试，不要删除 digest、改用 `latest` 或删除数据卷。

Compose 会并行拉取多个服务镜像。一个镜像失败后，PostgreSQL、Redis 或 MinIO Server 等其他项目可能显示 `Interrupted`；这表示本轮操作被中止，不等于这些镜像也分别不可用。该失败发生在初始化和迁移之前，应以首个明确的 pull 错误为排障起点。

### API 因缺少 New API issuer 而 unhealthy

若镜像、初始化和迁移已经成功，但 API 日志显示 `StartupConfigurationError` 和 `NEW_API_ISSUER is required`，说明通用项目没有取得 New API 站点配置。宿主侧应设置 `MC_NEW_API_ISSUER`，Compose 将其映射为容器内的 `NEW_API_ISSUER`；不要把示例地址或猜测的站点填进去，也不要通过放宽生产启动校验绕过。

当前电脑要使用已经配套的本地 New API 时，停止占用 8080 的通用项目后使用 `Docker-Local.cmd`，保留其现有数据卷。确需启动通用项目时，补齐真实 `.env.compose` 后使用上文三条带相同参数的命令恢复、查询或停止；不需要删除卷或重新迁移。

### `migrate` 因旧账号数据停止

如果 Compose 提示 `service "migrate" didn't complete successfully: exit 1`，先读取具体错误：

```powershell
docker compose logs --tail 100 migrate
docker compose logs --tail 200 postgres
```

`20260921050000_retire_legacy_accounts_billing` 会检查旧账号、手动凭据、钱包等数据是否已经收尾；存在保留记录时主动回滚，不执行删表。Prisma 有时只显示 `current transaction is aborted`，PostgreSQL 日志保留先前的具体门禁原因，例如“旧表 email_challenges 仍有 1 行”。这是旧数据库数据阻止新迁移，不是镜像缓存或线上 New API 未更新。

2026-09-21 首次清理时，按当时要求先归档 `multimodal-canvas-app`，核对 11 个卷与数据库 46 张表后删除旧容器和卷。用户随后明确改为“不再保留旧数据”；桌面归档及已确认的恢复副本已删除，外部 unknown 的费用结论仍未知，不重发原请求。

此前默认 Compose 的空库测试仅证明迁移成功，API 因缺少 `NEW_API_ISSUER` 和生产来源配置未启动。之后已使用上面的配套 `canvas-newapi-local` 从空卷完成整栈启动和浏览器登录；当前访问 <http://localhost:8080/>。

### 其他启动失败

1. 保留失败窗口中的错误与退出码，打开 Docker Desktop 检查引擎状态、Linux containers 模式和本项目容器状态。
2. 运行 `-Action Status`。Start/Build/Https/Stop 失败后脚本已经尝试只读查询状态；查询也失败时会明确说明状态无法确认，不盲目重启。
3. 修复提示的问题后再次 Start，或用 Https 恢复本地 HTTPS；只有需要重新构建代码或修复构建失败时使用 Build。状态为成功退出的 initialize/migrate/storage-init 属于正常现象，失败退出则必须先检查对应初始化或迁移错误。
4. 需要暂停时使用 Stop 保留所有卷。涉及回退版本或数据库迁移时，先确认目标版本兼容性和可恢复备份；启动脚本不执行降级迁移、数据恢复或删除操作。

如需分享容器日志，请先检查并脱敏：不得将 API key、登录令牌、数据库连接凭据或个人数据提交进 Git。可以提供 Compose 服务名、退出码及脱敏后的错误片段。
