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
