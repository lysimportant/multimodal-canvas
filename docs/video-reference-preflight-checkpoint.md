# 视频参考素材发送前检查

2026-10-07，P1。基线 `main @ 525d5c2`，工作区干净；Node 24.12.0、pnpm 11.19.0，使用现有依赖。

目标：用户部署后，视频创建前检查本次签发的素材链接，及时识别域名、签名、反向代理或媒体响应问题，避免把不可读取的参考资料直接提交给供应商。线上 `sd2-930-fast` 的 `invalid_reference` 尚未取得实际外发链接，不能把本地修改描述为已验证的线上根因修复。

验收：冻结版本、权限和原始快照保持不变；本站与显式 S3 链接检查有超时、禁止重定向、不携带账号凭据、不泄露签名；失效链接在生成 POST 前失败；已创建任务恢复仅查询原任务。覆盖正常媒体、401/403/404、HTML/重定向、网络超时和重复引用。

范围：仅本地实现、测试、文档与 Git 交付。由用户部署后验收供应商读取；不操作线上项目、不重新生成、不迁移数据库或修改存储桶权限。不新增供应商、依赖或必填配置。回滚使用本次之前的 API/Worker 镜像并保留数据卷及在途任务。

## 检查点

- 已读取当前指南、素材签名实现、Moon 型号检查点及待办。现有源码对 `sd2-930-fast` 要求公网 URL，本站签名接口已经存在；当前缺少发送前的实际可读性验证。
- 基线专项：`pnpm --filter @multimodal-canvas/worker exec vitest run src/asset-reference-resolver.test.ts src/provider-asset-url.test.ts src/startup-config.test.ts --maxWorkers=2`，199/199 通过。
- 生产 Worker 默认对本站或显式 S3 刚签发的地址执行一次 GET，请求 `Range: bytes=0-0`；整个连接与首字节检查共用 15 秒期限，读取后取消响应，不跟随重定向、不发送登录凭据。S3 使用 GET 签名，不能拿 HEAD 检查代替。重复引用复用同一预检，不获取节点任意外部地址。
- 检查 HTTP 状态、媒体类型、非空响应与 206 范围；401/403 提示核对签名及存储权限，404/410 提示路由与冻结版本，HTML 提示反向代理或登录拦截。错误不记录 URL、签名、远端正文或底层网络异常。已受理视频恢复继续跳过素材解析和预检。
- 修复显式 S3 endpoint 的 DNS 尾点绕过：`localhost.`、`minio.`、`objects.local.` 不再被当作公网地址。回归先出现对应 3 项失败，修复后通过；仅规范化校验副本，合法公网 endpoint 原文保留，不改变签名 Host。这是独立复现的缺口，未证明线上用了这些地址。
- 上游继续拒绝 `invalid_reference` 时，保留 HTTP 状态、外层错误码与原文，并提示核对素材可读性及 Worker/API/网关版本；不自动重试。支持错误直接返回及网关 `fail_to_fetch_task` 中嵌套 JSON 两种形态。

## 验证

- Worker resolver、preflight、workflow-worker：226/226 通过；启动配置与签名来源：125/125 通过；Provider 全套：789/789 通过。
- 本机真实 HTTP 冒烟：内存 API 以回环地址随机端口启动，使用合成账号与素材，签发器 → Worker 预检 → API Range GET 返回 206，HEAD 返回 200；存在 v2 时仍读取冻结 v1。故意错配签名密钥返回 401，后续 Provider 调用次数为 0。正常流程只捕获一次模拟 Provider POST，外网请求为 0。测试适配器仅将合成 HTTPS 来源映射到回环 HTTP，不等于公网 TLS 或供应商验收。
- `pnpm exec turbo run lint typecheck build --env-mode=loose --concurrency=3`：27/27 任务成功（其中 6 项未变化依赖使用缓存）；Web 有既有大 chunk 提示。`pnpm test:runtime`：8/8 通过。
- 全仓测试：Web 134 个测试文件、2463 个测试全部通过；运行产物测试 8/8 通过。日志与冒烟脚本保存在忽略目录 `.local-tests/video-reference-preflight/`，不含真实账号凭据。

## Canvas / Moon 本地桥接补验

2026-10-07，P1，基线 `main @ 7c7c1f1`；Node 24.12.0、pnpm 11.19.0，复用既有依赖。此阶段读取 Canvas 生产链，在忽略目录 `.local-tests/moon-reference-bridge/` 保存合成夹具，与独立本地 New API/Moon Mock 联调；不修改 Canvas Provider 源码、现有 8080 环境、Compose 或用户数据。真实授权测试单列于下一节。

- 合成普通 PNG 以 v1 写入内存素材存储，再写入内容不同的 v2。`StoredAssetReferenceResolver` 仍冻结读取 v1，使用正式签名器生成 `/v1/provider-assets/:assetId/versions/1/content?access_token=...`，原始快照保持不变。
- 两次正式发送前预检均使用 `GET` 和 `Range: bytes=0-0`，未携带 `Authorization`，返回 206；测试映射完整保留 pathname 与 query。对同一签名 URL 的无登录完整 GET 返回 200、`image/png`，字节数与 SHA-256 均和合成 v1 一致。
- `NewApiVideoProvider` 的唯一创建请求为 `POST /v1/videos`。`sd2-930-fast` 普通参考图在 `metadata.content` 中保持 `{ type: "image_url", role: "reference_image", image_url: { url } }`；首帧负例保持 `role: "first_frame"`。两条夹具复用同一个有效签名 URL，未将首帧静默改成普通参考图。
- Canvas 与 Moon 上游格式不同：Canvas 的 `metadata.content` 需要保留媒体类型和角色；Moon 底价上游的普通 `images` 元素要求 URL 字符串。本地 New API Moon 插件 1.6.1 的修复边界是仅在最终提交时按原顺序把普通图片对象转换为 URL 字符串，并在上游 POST 前拒绝 `first_frame`/`last_frame`，避免把无法表达的帧角色静默降级。该说明来自本地插件代码与合成夹具，不表示插件已部署到用户或生产环境，也不表示真实 Moon 上游已经接受请求。
- 独立于上述 Canvas 夹具自检，隔离 HTTP 联调使用 18335 的真实本地 New API 网关和 18336 的 Moon Mock：普通参考图只产生一次上游 POST，最终 `images` 元素为保留 query 的原签名 URL 字符串；Mock 以该 URL 无登录读取冻结 v1 PNG。任务查询达到 `completed`，内容接口返回的字节与 Mock 成片一致；9 秒、1 张参考图按本地测试定价扣除 55000 quota。首帧负例返回 400，上游 POST 数与扣费均未增加，证明 1.6.1 在本地网关边界拒绝而未静默降级。该层级仍是合成素材与 Mock，不替代真实供应商或生产验收。
- 合成 HTTPS 来源只在测试适配器中精确映射到 `http://127.0.0.1:18337`。它验证签名、查询参数、匿名读取和请求体桥接，不验证公网 DNS、受信任 TLS、供应商出口网络或目标生产环境。线上 `invalid_reference` 是否消失仍需部署对应 Canvas API/Worker 和 New API 插件后，以一次受控真实请求独立确认。

## Moon 普通参考图真实补验

2026-10-07，用户授权使用临时视频 Key 只创建一次 `sd2-930-fast`、720p、5 秒视频。修复后的本地 Moon 1.6.1 插件将 Canvas 格式转为 `images: ["https://love.lolicon.beer/demo/field-study-poster.jpg"]`，通过现有线上 New API 转发；生产插件与渠道配置未改动。该公开演示图匿名 GET 返回 200、`image/jpeg`，与仓库原图逐字一致。

北京时间 14:18:49 创建受理，任务 `task_LQtrgo1g9LAsKjD6qcRHuYzzeFeQj9Og`；后续仅查询原任务，最终 `completed / 100%`，创建至完成约 193 秒。内容接口返回 1,053,895 字节 MP4；独立 Chromium 实际播放成功，1280×720、容器时长约 5.167 秒、无媒体或页面错误。最终查询网关日志记录本次费用 750,000 quota，按当前计价为 1.5 美元。完整非敏感请求、时间、费用和制品校验见 New API 仓库已有 `verification/moon-video.md`；真实 Key 未进入源码、日志或文档。

本次通过的是公开图片的真实上游链，以及签名素材路由的本地跨项目链；尚未证明原失败项目的签名 URL 可被供应商出口读取。实际修复交付在 New API Moon 插件 1.6.1，Canvas 本次仅补文档。用户已确认生产 API/Worker 为 `7c7c1f1`，环境中的 `CANVAS_WEB_URL` 正确；无需为此补验改 `.env`、切换对象存储或重新部署无代码变化的 Canvas。部署 New API 后检查实际生效插件版本，注意自定义覆盖版可能优先于内置版，再对原项目完成验收。

## 部署后核对

1. 按现有部署方式拉取本次代码并重建 **Worker 和 API**，不要只更新 Web。记录更新前提交与镜像，保留原项目名、环境文件、密钥及数据卷；本次没有数据库迁移。沿用[服务器更新流程](docker-server.md#重启数据与更新)，不要切换原先未使用的 Compose profile。
2. 网站外层使用 Nginx 等代理时，确认有效的 `MC_PUBLIC_ORIGIN=https://love.lolicon.beer`，它会提供两服务的 `CANVAS_WEB_URL`。不要填 localhost、Docker 服务名或仅浏览器能访问的登录页。默认部署共用签名密钥卷；自定义部署需保持 API/Worker 的 `ASSET_ACCESS_URL_SECRET` 或 `API_JWT_SECRET` 一致，不要打印或重新生成真实密钥。
3. 没有显式公网 S3 需求时，保留 `MC_S3_PROVIDER_ENDPOINT` 为空，使用本站签名路由。已配置该值时，它优先于本站；必须实际返回媒体，不能是控制台、登录地址或内网 MinIO。不要为解决错误公开整个存储桶。
4. 由用户在目标节点发起一次测试。如果显示预检失败，根据明确的 HTTP/媒体/超时提示修正部署，避免反复生成。如果仍收到上游 `invalid_reference`，保留 Run ID、创建时间和原错误，核对线上网关插件及供应商网络读取情况；Worker 自己可读不能证明供应商出口可读。

素材链接有效期仍为 1 小时；本轮未改变供应商排队、签名期限、取消或付费请求恢复合同。回滚使用更新前 API/Worker 镜像，不删除卷、不重发已受理任务。
