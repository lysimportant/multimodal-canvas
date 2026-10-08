# 本站 HTTPS 视频参考素材

2026-10-07，P1。目标：视频模型直接读取用户部署的网站 HTTPS 素材接口，无需另配 `MC_S3_PROVIDER_ENDPOINT` 或购买第三方 OSS。基线 `main @ ae42743`，工作树干净；Node 24.12.0、pnpm 11.19.0，既有依赖。

实现范围：共享签名合同、API 只读版本素材路由、Worker 自动复用站点地址、部署说明与回归。签名限定 asset/version/project/owner，最长 1 小时，读取时验证当前所有权及归档状态。仅增加路由和临时签名，不改数据库结构、不迁移/覆盖素材；原 S3 显式配置保持兼容。回滚到前一应用镜像即可，旧签名接口随回滚关闭。

不包含：公网服务器部署、域名/DNS/证书申请、付费生成或用户项目写入。localhost 不具备远端读取能力，不能自动变成公网域名。链接来源使用现有受信任的 `CANVAS_WEB_URL`，不采信客户端 Host/转发头。

检查点：已核对现有存储、普通登录素材接口、站点配置与签名脱敏。Worker 基线定向 180 项通过，日志保留于忽略目录 `.local-tests/provider-assets/`。

实施过程中出现另一任务的“参考资料与正文解耦”并发修改，属于用户已有工作，保持原状。本任务用起点提交的独立工作树 `.local-tests/provider-assets/checkout` 验证，仅复制本站素材相关文件与 app.ts 的对应新增片段；隔离工作树用 `pnpm install --offline --frozen-lockfile` 复用本地缓存，依赖版本与锁文件不变。

## 实现与验证

- Worker 默认从 `CANVAS_WEB_URL` 取网站 HTTPS 来源，API 与 Worker 复用 `ASSET_ACCESS_URL_SECRET` 或 `API_JWT_SECRET`。Linux server 脚本已有域名配置、Compose 来源映射和 Docker 密钥注入，无需新增用户配置。显式公网 S3 签名保持优先。
- `/v1/provider-assets/:assetId/versions/:version/content` 只允许 GET/HEAD；独立用途的 HMAC 绑定账号、项目、素材、版本、签发和过期时间，最长 1 小时。读取重新验证账号与所有权，支持 Range；普通素材及写接口仍需登录。存储异常走既有脱敏错误边界，不能伪装成素材不存在。
- 仅临时执行快照携带签名地址；新增 Provider 回显地址的任务错误脱敏，覆盖日志、队列、持久化 Run。链接不写入用户节点。
- 定向验证：共享签名 13 项、Worker 素材/来源/启动配置 199 项、API 路由 8 项通过；覆盖冻结旧版本、个人素材、篡改/过期、跨账号/项目/版本、归档/停用、限流、GET/HEAD/Range、存储故障及普通接口认证。
- 独立工作树执行 `pnpm exec turbo run lint typecheck build --env-mode=loose --concurrency=2`，27/27 任务通过，缓存仅复用本轮同工作树结果；`pnpm build:runtime`、运行产物测试 8 项及 `git diff --check` 通过。Web 构建仍有既有的大块体积提示。
- 全仓测试等价命令为 `pnpm test:runtime` 后 `node node_modules/turbo/bin/turbo run test --env-mode=loose --concurrency=3 -- --maxWorkers=2`；设置任务临时目录、`WEB_PORT=5173`、`VITE_API_BASE_URL=http://localhost:3000`。最终 API 全套 1206 通过、108 设施跳过；Worker 817 通过、28 设施跳过；Domain 402、Provider 782，其余共享包全通过。Web 首轮 2450 通过、1 个既有 Skill 工作台用例超过 5 秒；单 Worker、`--testTimeout=15000` 复验该完整文件 28/28 通过，未改测试配置，不能把首轮全仓执行描述成一次全绿。
- 内存夹具的真实 localhost HTTP 联动通过：Worker 签发 → API GET 固定旧版本、HEAD、Range；缺失/篡改签名及普通接口均拒绝。本轮没有真实 Provider 请求，未把本机 HTTP 验证记为公网 HTTPS 验收。

## 本机更新与剩余边界

- 更新前活动 Run 为 0；保存 `multimodal-canvas-api:before-provider-assets-20261007` 与 `multimodal-canvas-worker:before-provider-assets-20261007` 回滚镜像。仅更新 API/Worker 代码产物，未重建 Web、迁移数据库或修改配置/数据卷。
- 两个服务健康，运行产物 SHA-256 与隔离构建一致；8080 `/health` 为 200，新增 GET/HEAD 与 POST、原普通素材接口在无授权时均为 401，API/Worker 启动日志严重错误为 0。用户项目节点摘要更新前后相同，原失败 Run 仍为 FAILED、未重试。
- 回滚：核对没有活动 Run，将上述两个回滚镜像重新标记为对应 `:local`，保持当前环境后仅重建 `api worker`；不删除卷。任务临时目录保留配置一致性检查脚本与验收日志，不包含真实密钥。
- 当前 `http://localhost:8080` 不是公网素材地址，相关远端参考生成仍明确阻断。部署到可被供应商访问的网站 HTTPS 域名后自动使用本站接口；目标环境的外部 GET/HEAD/Range、New API 插件版本、供应商真实生成与归档仍待独立验收。

## 2026-10-08 双环境公网读取补验

本阶段以 `main @ 093c575` 开始，目标是让本机和线上 Canvas 的冻结参考素材都能通过短期签名 HTTPS 地址被外部读取，并控制大素材读取时的 API 内存占用。不改变数据库格式、素材归属或存储桶权限。线上部署前先记录当前镜像和活动 Run；回滚仅替换 API 镜像并保留数据卷，临时本机隧道可用 `scripts/provider-asset-tunnel.ps1 -Action Stop` 在无活动 Run 时恢复 Worker 来源。

- 本机使用 `scripts/provider-asset-tunnel.ps1 -Action Start` 创建仅放行签名素材 GET/HEAD 的临时 Cloudflare HTTPS 隧道，并把 Worker 的 `CANVAS_WEB_URL` 指向本次域名。`-Action Status` 核对代理、隧道和 Worker 来源；无活动 Run 时用 `-Action Stop` 恢复。域名重启后会变化，不能把旧地址用于新任务或作为固定生产域名。公网无签名请求返回 401，其他路径由受限代理返回 404。
- 本机冻结 JPEG 从当前隧道完成匿名签名 HEAD 200、Range GET 206（1 字节）和完整 GET 200（127391 字节）；SHA-256 与源版本一致。Start/Stop/Start、PowerShell 5.1/7 语法、Caddy 配置及 Worker 健康检查通过。此时活动 Run 为 0。
- 线上 `https://love.lolicon.beer` 的冻结 v1 图片从独立外网完成签名 HEAD 200、Range GET 206 和完整 GET 200（395485 字节），SHA-256 与源版本一致；无签名读取仍拒绝。线上 Canvas 运行版本 `1b9741c`，New API 为 `06e25ca`，实际 Moon 插件 1.6.1，未见数据库插件覆盖，渠道包含 `sd2-930-fast`。公网读取不证明供应商出口已读取。
- API 原实现对 HEAD、Range 和完整 GET 都先将 S3 对象下载成 Buffer。当前源码改为按版本查询对象长度，HEAD 不下载内容，Range 只从对象存储读取指定字节，完整 GET 使用流转发；旧存储适配器保持兼容。该修复的测试已覆盖 S3 范围校验、文件存储、版本归属和路由响应。只有部署新 API 镜像后才能把实际环境的内存行为算作更新。
- 本机 Run `d7007413-c414-47f8-a163-dd300f97c253` 冻结 `sd2-930-fast`、720p、5 秒和 1 张 `referenceImage`，已完成并归档。产物为 `video/mp4` v1，对象存储读回 2292597 字节，内容 SHA-256 与版本、Run 记录一致。API 日志在创建后记录了该冻结图片的签名 GET，Worker 当时使用临时隧道来源；日志未证明请求方是供应商。本机 `provider_jobs.platformJobId` 与 New API task 39 的 ID 精确一致；对应 receipt 95716 和日志均显示 `sd2-930-fast` 已结算 quota 750000。Canvas Run 费用字段为空，仍以 New API 结算记录为准。
- 线上本次 Run `cf4cb137-30a3-479e-ad06-98642a07ef55` 冻结的是 `sd2-930-no-face`、720p、10 秒和 1 张 `referenceImage`，已完成并生成 READY MP4；New API 任务、结算收据和日志均记录 quota 1950000。用户确认 10 秒为有意选择，接受此 Run 作为本次线上单图参考链路验收；它不代表 `sd2-930-fast` 在线上也已单独验收。创建结果不明时只查询原 Run，不再次点击生成。
- 线上仅替换 API 镜像并等待健康，Worker、Web、PostgreSQL、Redis、MinIO 容器未重建，数据卷未改。旧 API 镜像保留 `before-streaming-20261008` 回滚标签；无需数据库迁移。公网 `/health` 返回 200。线上 Worker 与独立外网分别对冻结 PNG 验证无签名 HEAD 401、签名 HEAD 200、Range GET 206（单字节）和完整 GET 200（8041717 字节）；完整内容 SHA-256 与源版本相同。此前复验脚本失败源于临时进程未取得运行时注入的配置和包路径，修正测试环境后两侧均通过。实际部署环境现已使用流式 API；HEAD 不读取内容，Range 仅读取所需字节，完整 GET 按流转发。
- 发布后只读检查线上 Canvas 数据库，最新 Run 仍是上述 `sd2-930-no-face` 10 秒任务，未发现新的 `sd2-930-fast` 5 秒 Run。本机最新仍是上述 `d7007413-c414-47f8-a163-dd300f97c253` 成功 Run。2026-10-08 登录页面复核：线上“视频生成节点 6”和本地“视频生成节点 9”均显示已完成，有视频预览和下载入口，设置分别为 `sd2-930-no-face`、720P、10 秒、单图全能参考和 `sd2-930-fast`、720p、5 秒、单图全能参考。按用户实际提交规格，本次两端素材到视频归档链路已验收；不将线上结果扩展为其他精确模型的验收。
