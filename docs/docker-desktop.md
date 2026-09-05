# Windows Docker Desktop 完整本地运行

## 运行范围

项目的运行核心是同一份跨平台 `compose.yaml`，支持 Windows Docker Desktop 和 Linux 服务器。本文的 CMD/PowerShell 只是可选的 Windows 便捷包装，不是部署前提。Linux 服务器上的域名、HTTPS 与启动步骤见 [Linux 服务器部署](docker-server.md)。

此入口使用根目录 `compose.yaml`，项目名固定为 `multimodal-canvas-app`。运行正式构建的 Web、API 和 Worker，以及 PostgreSQL、Redis、MinIO；不是 `pnpm dev`，不使用 Vite 开发服务器或内存任务模式。`initialize`、`migrate`、`storage-init` 是一次性初始化服务，成功执行后退出，不应作为常驻服务手动重启。

默认浏览器地址是 <http://localhost:8080/>，仅向 `127.0.0.1` 发布入口端口。可以额外启用 <https://localhost:8443/>，同时保留 HTTP 8080 供本机访问或后续域名反向代理。数据库、Redis、对象存储和应用内部端口不面向局域网或公网开放。生产构建不等于公网部署；域名、公网证书、认证策略和供应商回调需要独立配置与验收。

## 首次启动

1. 安装并打开 Windows Docker Desktop，完成其首次安装引导、许可确认及 WSL 2/虚拟化配置，使用 **Linux containers**。脚本不会替你修改系统功能、全局 Docker context 或容器模式。
2. 保持网络可用。第一次需要下载基础镜像、安装镜像内依赖并构建应用，耗时取决于网络和机器性能；主机不需要另外安装 Node.js 或 pnpm。
3. 在项目根目录双击 `Docker-Start.cmd`。从其他目录或快捷方式启动也可以，入口以自身文件路径定位项目。
4. 等待 Compose 健康检查完成，脚本会打开默认浏览器。若初始化、构建或健康检查失败，窗口保留错误，不会宣称启动成功或自动重复变更操作。

脚本兼容 Windows PowerShell 5.1 和 PowerShell 7。双击入口使用系统自带的 Windows PowerShell 5.1，`ExecutionPolicy Bypass` 仅作用于该进程，不修改机器或用户策略。组织策略禁止脚本时，请联系管理员处理，不要自行关闭安全机制。

Docker CLI 不在 `PATH` 时，脚本会检查 Docker Desktop 的标准全机和当前用户安装目录。引擎未就绪时，Start/Build/Https 可以隐藏启动已安装的 Docker Desktop，并最多等待约 180 秒；仍未就绪则显式失败。引擎就绪后，Compose 服务健康等待上限是 180 秒，首次镜像下载和构建耗时另计。尚未完成 Desktop 首次引导的机器，可能需要先手动打开 Desktop 处理提示。

## 管理员首次引导

1. 首次打开网页后正常注册账户。注册保持默认普通用户 `USER` 权限，不会因“第一个注册”而自动成为管理员。
2. 在项目根目录打开 PowerShell，明确指定刚才注册的邮箱。下面的邮箱只是示例，必须替换为你自己的已注册账户：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\docker.ps1 -Action Admin -Email 'user@example.com'
```

3. 命令成功后，退出网页账户并重新登录，使用原来的密码。

Admin 通过 `docker compose exec -T api node docker/run.mjs admin <email>` 调用容器内管理入口，只提升明确指定、已经存在的账户。它不会重置密码、创建账户、输出令牌或密码；账户不存在或执行失败时返回错误。API 必须已经运行，Admin 不会代替 Start 启动 Desktop 或应用。日常双击 Start 不会执行管理员提权，不需要重复引导。

不要把不存在的默认账号当作管理员，也不要为了绕过登录而关闭认证。对本机 Docker 的控制权可用于管理员提权，应按管理员权限保护本机与 Docker Desktop 的访问。

## 日常使用

- **启动**：双击 `Docker-Start.cmd`。已有镜像时直接使用；只有缺少应用镜像时才按需构建。
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

| 当前终端环境变量    | 默认值              | 含义                                                                              |
| ------------------- | ------------------- | --------------------------------------------------------------------------------- |
| `MC_HTTP_PORT`      | `8080`              | 仅在本机 `127.0.0.1` 发布的 Web 入口端口。                                        |
| `MC_HTTPS_PORT`     | `8443`              | 启用 local-https 时的本机 HTTPS 端口；与 HTTP 端口不同，仅绑定 `127.0.0.1`。      |
| `MC_VIDEO_CONTRACT` | `newapi-unified-v1` | 视频供应商协议，可选 `newapi-unified-v1` 或 `legacy-v1`；应与实际供应商契约匹配。 |

仅在供应商明确使用 legacy-v1 协议时，按实际配置启动：

```powershell
$env:MC_VIDEO_CONTRACT = 'legacy-v1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\docker.ps1 -Action Start
```

该变量由 Compose 传入应用，不代表填写了供应商凭据，也不会授权任何收费调用。不要只因某次生成失败就切换协议或重发任务。与端口变量一样，后续 Start/Build 应保持相同设置；双击入口不会保存终端中的变量。启动命令显式使用空环境文件，**不会加载开发 `.env` 中的密钥或配置**。

## 数据与供应商配置

生产应用使用独立 named volumes 持久化密钥、PostgreSQL 数据、Redis 数据和 MinIO 对象；可选 HTTPS 网关另有证书和配置数据卷。停止、重开 Docker Desktop 或重新构建镜像不会主动删除这些卷。不要单独丢弃密钥卷，否则已有加密供应商凭据可能无法解密；数据库与对象卷也需要保持一致备份。

原始 `secrets` 卷只挂载给初始化服务。各服务使用独立的 `*_secrets` 只读视图与匹配容器身份的文件权限，基础设施无法读取 API 的 JWT 或凭据加密密钥；已有卷再次初始化不会轮换密钥，遇到内容不一致会明确失败。备份必须保持原始密钥、派生视图和业务数据一致，不要通过删除卷排障。

这是**新的独立数据环境**：不会自动导入旧 `.data`、开发数据库、测试卷或根目录 `.env`，旧环境中的账户、项目、资源和供应商配置不会自动出现在此处。需要旧数据时应先制定并验证迁移与备份方案，不要直接复用旧卷或把生产迁移指向开发数据库。

完成登录后，在网页的 AI/供应商设置中填写自己的 Provider API key、地址和已确认支持的模型。不向源码、Compose、CMD、文档或日志粘贴真实密钥。启动脚本不会调用付费 API；首次启动与登录不代表已配置供应商，也不代表真实生成任务已验收。点击真实生成可能产生费用，结果不明时应先查询已有任务，不重复创建。

本机回环地址不能被外部供应商直接访问。真实供应商回调、模型权限、账户余额、外网连通性及供应商端取消/签名/幂等契约，不由本地启动成功保障；未确认项仍以 [TODO-SERVER.md](../TODO-SERVER.md) 和相关供应商验收文档为准。

## 失败与恢复

1. 保留失败窗口中的错误与退出码，打开 Docker Desktop 检查引擎状态、Linux containers 模式和本项目容器状态。
2. 运行 `-Action Status`。Start/Build/Https/Stop 失败后脚本已经尝试只读查询状态；查询也失败时会明确说明状态无法确认，不盲目重启。
3. 修复提示的问题后再次 Start，或用 Https 恢复本地 HTTPS；只有需要重新构建代码或修复构建失败时使用 Build。状态为成功退出的 initialize/migrate/storage-init 属于正常现象，失败退出则必须先检查对应初始化或迁移错误。
4. 需要暂停时使用 Stop 保留所有卷。涉及回退版本或数据库迁移时，先确认目标版本兼容性和可恢复备份；启动脚本不执行降级迁移、数据恢复或删除操作。

如需分享容器日志，请先检查并脱敏：不得将 API key、登录令牌、数据库连接凭据或个人数据提交进 Git。可以提供 Compose 服务名、退出码及脱敏后的错误片段。
