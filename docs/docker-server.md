# Linux 服务器与通用 Docker Compose

本项目使用同一份 `compose.yaml` 支持 Linux 和 Windows Docker Desktop。Windows 脚本只是包装，服务器不需要 PowerShell、主机 Node.js 或 pnpm。

## 运行内容

- Web：Vite 正式静态产物，由 Caddy 提供，不启动 Vite 或热更新服务器；HTTP 和 HTTPS 的代理错误日志统一脱敏媒体签名与请求头。
- API / Worker：Node 24.12.0 执行独立打包产物，`NODE_ENV=production`、BullMQ、真实 New API 适配器。
- PostgreSQL 16：用户、会话、画布、资产、运行与凭据的持久化；首次通过 `prisma migrate deploy` 应用迁移。
- Redis 7：TLS、认证、AOF 持久化队列；MinIO：TLS、专用应用身份和私有 bucket。
- FFmpeg / ffprobe：包含在 API / Worker 镜像中，用于媒体元数据和预览；上传和下载均经同源 API，浏览器不会访问容器内部 MinIO 地址。
- 可选 Caddy：`local-https` profile 提供本机自签 HTTPS；`server` profile 提供公网 HTTPS 自动证书和续期。

基础条件：Linux 容器、Docker Engine 与 Compose 插件、足够的镜像构建磁盘和内存。首次构建需访问 Docker Hub、Debian HTTPS 仓库和 npm；镜像固定 Node/pnpm 版本，依赖遵守 `pnpm-lock.yaml`。建议从 4 CPU / 8 GB 内存开始，根据媒体任务负载调整；这不是容量性能承诺。

## 仅本机或已有 TLS 反向代理

在仓库根目录直接执行标准命令：

```bash
docker compose -f compose.yaml up -d --build --wait --wait-timeout 240
docker compose -f compose.yaml ps -a
```

访问 `http://localhost:8080`。只有该端口绑定 `127.0.0.1`，数据库、Redis、MinIO 和 API 不发布到宿主机。新服务器可先用 SSH 转发访问：

```bash
ssh -L 8080:127.0.0.1:8080 user@server
```

已有 TLS 反向代理可转发到服务器 `127.0.0.1:8080`，部署时设置 `MC_PUBLIC_ORIGIN=https://你的域名`。这个串联方式会由 Caddy 覆盖未被信任的转发头，限流看到的是已有代理地址，不适合多用户公网入口；需要真实客户端限流时使用下述 Caddy profile，或单独设计并验证可信代理链。Web 始终使用同源 API，修改域名不用重新编译前端。

也可使用 `bash scripts/docker.sh start`；后续 `build` 只构建镜像，`status` 查询，`stop` 停止但保留卷。

脚本只允许 action 选择 profile，忽略继承的 `COMPOSE_PROFILES`、`COMPOSE_ENV_FILES` 和默认 `.env`，防止普通 start 意外开启公网入口；它不会修改父终端环境。需要使用 `.env.compose` 时，使用明确带 `--env-file` 的标准 Compose 命令，不要用 `source` 加载脚本。

## 本地 HTTPS 与后续域名映射

不要求现在提供域名；启用本机 HTTPS 入口：

```bash
docker compose -f compose.yaml --profile local-https up -d --build --wait --wait-timeout 240
# 或：bash scripts/docker.sh https
```

访问 `https://localhost:8443`；可通过 `MC_HTTPS_PORT` 调整端口。HTTP `127.0.0.1:8080` 同时保留。证书由专用卷中的 Caddy 本地 CA 签发，不是浏览器默认信任的公网证书，也不修改宿主机信任库。需要本机浏览器信任时，先导出公开根证书，再按你所在系统的证书管理方式明确安装：

```bash
docker compose -f compose.yaml --profile local-https cp gateway-local:/data/caddy/pki/authorities/local/root.crt "$HOME/multimodal-local-ca.crt"
```

仅导出并信任 `root.crt`，不要导出或传播同目录私钥。该文件是公开证书，建议保存在仓库外，避免提交机器专属文件。

后续可以自行申请域名 HTTPS 并反代到同一台服务器的 `http://127.0.0.1:8080`；公网连接仍由你的反向代理加密，后端回环 HTTP 不对外发布。需要上游也使用 TLS 时，将反代上游设为 `https://localhost:8443`，明确使用 `localhost` 作为 SNI 并信任导出的 CA，HTTP Host 保留外部域名，本地入口支持这种转发方式；不要关闭证书验证。同时设置 `MC_PUBLIC_ORIGIN=https://你的域名` 后重新执行 `compose up -d`，无需重新编译 Web。不要直接把本机自签 HTTPS 当成公网域名证书。

外层代理默认不会被信任，API 限流看到的是外层代理地址；多用户公网部署应单独核验真实客户端转发链，或使用下面的一跳 `server` profile。此配置不自动开放注册策略或验证供应商公网 Webhook。

## 公网 HTTPS 入口

先将你自己的域名 DNS A/AAAA 指向目标服务器，开放 TCP 80/443，必要时开放 UDP 443。不要使用示例域名申请证书，也不要直接将未加密的登录入口发布到公网。

```bash
export MC_DOMAIN=canvas.your-domain.com
export MC_PUBLIC_ORIGIN="https://${MC_DOMAIN}"
docker compose -f compose.yaml --profile server up -d --build --wait --wait-timeout 240
```

或者设置 `MC_DOMAIN` 后运行 `bash scripts/docker.sh server`，脚本会按域名设置 HTTPS CORS 来源。Caddy 的证书和状态保存到专用卷中；更换机器时保留这些卷，避免不必要的重复签发。

可将 `.env.compose.example` 复制为被 Git 忽略的 `.env.compose`，填写非敏感选项，再始终指定：

```bash
docker compose --env-file .env.compose -f compose.yaml --profile server up -d --build --wait --wait-timeout 240
```

`MC_DOMAIN` 不含协议、端口或路径；`MC_PUBLIC_ORIGIN` 为对应的完整 HTTPS 来源，不带尾斜杠。`server` profile 不替代域名/DNS/防火墙检查。没有目标服务器权限与域名的本机验收，不代表真实公网证书已签发或生产入口已经验收。

Caddy 将 API 请求直接转发到 API，其他请求转发到静态 Web；两种入口都只有一个可信代理。`API_TRUST_PROXY_HOPS=1` 仅信任 RFC1918 / IPv6 ULA 私有网络中的直接对端，不信任更早的转发链或公网对端。必须保持 API 端口不向宿主发布，且不把不可信容器加入此网络；使用自定义非私有 Docker 网段或外层 CDN 时需重新配置并验收，不能改为无条件信任转发头。

## 首次账号与模型设置

1. 在网页注册自己的邮箱和密码。注册仍遵守原有安全规则，普通账号不会自动成为管理员。
2. 在拥有本机 Docker 权限的终端，将明确指定的已注册账号设为管理员：

```bash
docker compose -f compose.yaml exec -T api node docker/run.mjs admin your-email@example.com
```

3. 退出并重新登录，在网页设置中填写供应商 HTTPS 地址、API Key 和模型。Key 加密存入数据库；API / Worker 共用专用卷中的加密密钥，镜像、Compose 和构建日志中不包含真实 Key。

配置只使现有完整功能具备运行条件，不会凭空生成供应商权限。真实模型调用可能计费，必须由操作者明确发起。使用 Sub2API 的 `/v1/videos/generations` 时，按已确认供应商契约设置 `MC_VIDEO_CONTRACT=legacy-v1` 并重新创建 API / Worker；默认 `newapi-unified-v1` 使用 `/v1/video/generations`。历史异步任务保留原冻结契约，不因更新配置重发创建请求。

公开供应商 Webhook 可指向 `https://你的域名/v1/webhooks/newapi`，但必须另外核对供应商正式签名、编码和重放约定。密钥在专用卷中，不能随意重建。未确认的供应商功能和服务器验收继续以 `TODO-SERVER.md` 为准。

## 重启、数据与更新

六个长驻业务服务和可选 Caddy 使用 `restart: unless-stopped`。Linux 的 Docker daemon 需要由系统正常启动；之前运行中的容器随 daemon 恢复，手动停止的容器不会自行恢复，需要再执行 `compose up -d`。初始化、迁移和 bucket 创建是一次性任务，退出码 0 是正常状态。

项目名默认 `multimodal-canvas-app`，卷包括 `postgres`、`redis`、`minio`、`secrets`，服务器模式还使用 `gateway_data`、`gateway_config`，本机 HTTPS 使用 `local_gateway_data`、`local_gateway_config`。不要更换项目名后误认为数据丢失，也不要运行 `down -v`、`volume prune` 或删除 `secrets`。已有开发 `.data`、开发 Compose 数据和测试卷不会自动导入。

`secrets` 是原始密钥卷，仅初始化服务可挂载；`app_secrets`、`postgres_secrets`、`redis_secrets`、`minio_secrets`、`storage_secrets` 是按服务白名单生成的只读视图。文件采用对应服务 UID/GID 与 `0400` 权限，数据库、队列和对象存储不能读取 API 的 JWT 或凭据加密密钥。初始化可补齐中断留下的缺失文件，但内容冲突会失败，不覆盖或重生成既有密钥。备份应包含这些卷，恢复时必须与同一份原始密钥保持一致，不能手工修改派生视图来轮换身份。

更新前记录 Git 提交与镜像 ID，并对全部相关卷做一致备份。在无运行任务的维护窗口停止业务入口和 Worker，停止写入，再备份数据库、Redis、MinIO 和密钥；备份密钥应加密保存并限制访问。PostgreSQL 物理卷恢复须使用相同主版本，跨版本应采用官方逻辑备份迁移。恢复演练使用新项目名和新卷，不覆盖原卷。仅有数据库或仅有对象存储的备份不足以恢复完整任务和凭据。

```bash
docker compose -f compose.yaml images
docker compose -f compose.yaml --profile server --profile local-https stop
# 在维护窗口备份上述所有卷，确认备份可恢复后再更新。
git pull --ff-only
docker compose -f compose.yaml --profile server up -d --build --wait --wait-timeout 240
```

最后一行按之前实际使用的入口选择：本机 HTTPS 用 `--profile local-https`，只有 HTTP 时不加 profile；不要因更新而启用原先没有使用的公网入口。

回滚需要部署之前的镜像/提交，并确认其数据库迁移兼容性；不能假设回退代码会自动撤销数据库迁移。密钥卷必须保持同一份。初始化脚本生成的 Redis / MinIO CA 和服务证书有效期为 3650 天，到期前应按维护窗口备份并轮换，不能删除整个卷来续期。Caddy 本机叶子证书与中间证书是独立的短期证书，由 Caddy 自动续期，不能套用上述有效期。

## 诊断

```bash
docker compose -f compose.yaml --profile server --profile local-https ps -a
docker compose -f compose.yaml logs --tail 100 api worker migrate storage-init
docker compose -f compose.yaml --profile server logs --tail 100 gateway
docker compose -f compose.yaml --profile local-https logs --tail 100 gateway-local
```

依赖初始化故障时保留卷和日志，修复配置/网络后重新执行相同的 `up`，不要重建加密密钥或重复发起可能计费的模型任务。对外分享日志前先脱敏，不输出 `runtime.json`、口令文件、JWT 或 Provider Key。
