# 未完成事项合并清单

更新时间：2026-09-05

本文件合并原 `TODO-NEXT.md`、`TODO-RESOURCE-MENTIONS.md` 和
`FIX-RESOURCE-MENTIONS.md` 中仍未完成、部分完成、外部依赖或明确暂缓的事项。
旧三份文档已删除；后续只维护本文件，避免同一事项在多个清单中重复或状态不一致。

## 状态与范围

**本轮按子项逐一验收：隔离基础设施、跨进程恢复、迁移兼容、安全、媒体、设置同步及真实文本/图片已有执行证据。整项状态不再用“本地没做完”笼统描述；未通过的供应商和实际部署条件在各项明确列出。最终质量门禁与归档见最新检查点。**

- `[x]` 当前声明范围内已有实现、执行证据和验收记录；不外推到未测试部署或模型。
- `[~]` 已有实现或部分证据，仍需外部环境、真实 Provider 或生产验收。
- `[!]` 依赖外部契约、凭据、权限或部署环境，当前无法仅靠本地代码完成。
- `[>]` 明确暂缓，排在当前 MVP 和生产基础验收之后。
- 本清单保留本轮已验收子项供审计；旧版本已完成的资源提及闭环不重复列为待办。

### 当前费用边界

- 本项目当前不向用户收费、不做本地额度扣减、不做账单结算；请求费用由上游 API/服务商计算和结算。
- 项目只记录供应商返回的 `usage`、状态、请求 ID 和可选费用字段。价格未知、费用字段缺失或没有本地收费策略，都不阻塞功能实现。
- 步数、Token、输入大小、并发、超时、搜索次数等限制只用于运行资源保护，不是本地收费授权条件。

## 已完成基线（不再列为未完成）

以下事项已有当前工作区代码、测试和提交证据，因此不从旧 `FIX` 清单中的历史 `[ ]` 继续复制：

- 资源提及编辑器、`@` 搜索、确认/取消、卡片、重复引用、撤销/重做和 PC Web E2E。
- `PromptDocument`、资源 ID/版本冻结、权限/MIME/大小校验、导入导出和 Mock 闭环。
- New API Chat Completions 的 `text`、`image_url`、`input_audio`、`video_url` 内容块映射；提及顺序和重复引用保持不变。
- 共享凭据密钥环已落地：`mc:v2:<key-id>` 密文、历史 key-id/旧 AES-GCM fallback、自动重加密和无法持久化轮换时 fail-closed；API 文件存储、Prisma 存储和 Worker 共用同一实现。
- `AiCredential.encryptionKeyId` 及迁移 `0014_ai_credential_encryption_key_id` 已加入；新旧密钥恢复、重加密和敏感信息不落日志均有测试证据。
- API/Worker 生产启动校验已覆盖 Redis/S3 TLS、CORS、端口、媒体工具和凭据密钥轮换配置；配置错误会在接受请求前显式失败。
- 本地价格/额度阻断已移除；目录价格只作为可选估算元数据，供应商费用只按返回值记录。
- 提交、类型检查、构建、格式检查、单元测试和 Mock E2E 的当前证据见“验证基线”章节。

## P0：生产基础设施与恢复

### `[~]` P0-REAL-INFRA-01 生产依赖与跨实例恢复

- [x] 专用 PostgreSQL/Redis/MinIO 部署，14 个迁移及 schema diff 零差异；旧数据升级、事务失败回滚、0014 保留旧密文与撤销墓碑验证通过。
- [x] S3 实际上传/下载、限定前缀与最小权限 29 项验证通过；拒绝越界、跨桶、错误凭据和匿名访问。
- [x] 多个独立 API/Worker 进程恢复同一冻结资源版本；Worker 保存任务 ID 后强制退出，后继经真实 BullMQ 租约接管，不重复 usage。
- [x] 合成文本/图片/音频经过真实 Worker/Prisma/MinIO 归档；移除专用队列记录后仍可从数据库恢复。
- [x] 真实文本与图片在用户指定 sub2 地址调用并经过同一归档链路，结果摘要与数据库关联一致。
- [!] 真实供应商异步视频任务的跨进程恢复还没有成功证据：该部署统一视频创建返回 404，归属 P1-VIDEO-CONTRACT-04；不能以合成平台任务替代。

隔离部署验收已执行，不连接或清理业务生产数据。实际部署地址、网络权限与回滚执行统一归属 P1-PRODUCTION-09。

### `[~]` P0-PROD-STARTUP-02 生产启动与安全边界

- [x] 独立 `NODE_ENV=production` API 与真实 HTTPS 代理完成 22 项入口验收：信任链、主机名、认证、CORS、伪造转发头、400/413、启动失败与代理 502 脱敏。
- [x] 真实 Redis 跨进程全局限流 9 项通过；故障时受限入口返回 `503/rate_limit_unavailable`，不回退进程内额度。
- [x] API/Worker key-id、旧 AES-GCM fallback、持久化失败关闭、撤销后冻结版本恢复通过；运行中实例同步、默认模型写入/撤销竞争和数据库锁后时钟排序通过。
- [x] 可观测性真实 HTTP collector 验证超时、503、重定向、容量和回调异常不改变主流程；API/Worker 均校验视频协议与 FFmpeg 配置。
- [!] 实际部署的域名证书、入口规则、告警接收端及配置回滚仍需部署配置位置和授权，归属 P1-PRODUCTION-09。本地 Node HTTPS 代理不是已上线的反向代理产品。

单机文件凭据仍只支持单 API 进程；Redis 故障时生产受限接口保持失败关闭。这是明确的运行边界，不是待修功能。

### `[~]` P0-MEDIA-OPS-03 真实媒体处理与可观测性

- [x] 真实 FFmpeg/ffprobe 与隔离 S3/Prisma 验证图片缩略图、视频 poster、音频 waveform、元数据和重复归档；修正 waveform 实际编码不是 PNG 的问题。
- [x] 文件存储改为 `${contentKey}.derivatives/`，消除源文件/目录冲突；历史 S3 `/derivatives/` 保持只读兼容，签名 URL 也按实际存在键选择，不迁移或删除旧对象。
- [x] DNS 解析和实际 socket 地址校验、下载截止时间、S3 超时、MIME 与解压后体积保护通过；媒体工具禁止二次联网，失败只影响辅助预览。
- [x] OTLP JSON/Sentry envelope 经过真实回环 HTTP collector 验收，超时、容量、503、重定向和脱敏故障与主运行隔离。
- [x] 等效隔离 Linux CI 全量通过：真实媒体/S3、HTTP collector 和 22 项 Web E2E 均执行；GitHub 原运行因账户 billing lock 未启动，不把账户问题当作代码失败。
- [!] 真实业务桶和外部遥测接收端的部署验证统一归属 P1-PRODUCTION-09。

## P1：真实 Provider、媒体覆盖与多 Key

### `[!]` P1-VIDEO-CONTRACT-04 New API 视频完整契约

- [x] 已按 New API 官方文档实现统一 `POST /v1/video/generations` 与同路径任务查询、`task_id/status/url/format/metadata`；保留显式 legacy 协议和旧任务恢复，不把 Sora multipart 混入 JSON。
- [x] API/Worker 新任务显式选择统一协议，POST 前持久化合同和 submitting 状态；旧平台 ID 按冻结协议查询，创建结果不明不自动重试，取消不丢平台身份。
- [x] Provider 包 266 项单 worker 测试通过，包含 54 项统一视频、未知状态/ID/MIME/下载、预取消和旧协议恢复边界；实际 UTF-8 请求体断言模型完整名称与空格均不被改写。
- [!] 两次分别授权的视频请求在 New API 单数统一路径返回 404；第二次严格使用 `grok-imagine-video-1.5（按次）`，没有改名或删后缀。已从 sub2 官方固定版本 README/源码确认该平台使用复数 `/v1/videos/generations`，对应显式 `legacy-v1`。正确端点的后续请求待用户确认，不能归咎于模型名或宣称生成成功。
- [!] 该部署的真实取消、Webhook 原始 body 签名/编码、时间戳重放、幂等范围和安全重试尚无确认契约。

当前解析 JSON 的通用 HMAC 框架不能冒充供应商正式 Webhook。缺少正式契约、缺少平台 ID 或结果不明时保持可诊断失败。

### `[~]` P1-MEDIA-COVERAGE-05 图片、音频与参考输入

- [x] 官方图片可选字段和 TTS voice/speed/格式/输入校验、严格媒体响应解析、下载及 Worker 归档已有定向验证；多输出与未知字段明确拒绝，不只取首项。
- [x] 用户指定 `gpt-image-2` 一次 HTTP 200，PNG 800639 字节经过真实 Worker/Prisma/MinIO 归档并读回验哈希，已人工查看有效图片。
- [x] 合成音频加真实 FFmpeg/ffprobe、文件存储/S3/Prisma 归档通过；新增音色、格式和语速 Web 控件及参数保存回归。
- [!] 真实 TTS 尚缺明确模型/voice 和调用授权；用户当前仅指定文本、图片、视频模型，不擅自用这些 Key 调用未授权音频模型。
- [!] 多参考图、跨媒体专用角色和供应商扩展字段归属 P1-PROVIDER-ROLES-07；不支持角色在请求前明确诊断，禁止静默丢弃。

### `[~]` P1-MULTIKEY-ROTATION-06 多 Key 轮换与历史恢复

- [x] 同一 DAG 多凭据冻结、幂等、历史 key-id/旧 AES-GCM、轮换写回与并发 CAS、撤销后排队任务只用冻结版本通过。
- [x] 长驻独立 Node 进程验证远端设置/模型/撤销变化；真实数据库屏障验证默认模型修改不能复活撤销 Key，应用时钟偏差和锁等待不破坏活动排序。
- [x] 独立 API/Worker 和真实 BullMQ 接管、历史引用读取与移除旧密钥后恢复通过；0014 从旧结构升级保留历史密文和墓碑。
- [x] 文本和图片分别用不同授权 Key 发起一次真实请求，内部运行、供应商 requestId 摘要、usage 和归档结果分别关联，没有合并到同一凭据记录。
- [!] 供应商后台实际撤销/轮换行为、同一真实多 Key DAG 和业务部署轮换仍没有授权实测证据；不自动替换 Key 或扩大收费请求。

本地 Key 轮换不是供应商 Key 轮换；不支持不同 current key-id 实例同时自动重加密。受控暂停、兼容窗口和回滚见 `docs/credential-rotation.md`。

### `[~]` P1-PROVIDER-ROLES-07 统一端口角色的真实映射

- [x] `prompt/content/transcript`、主输入、Chat 多媒体内容块、统一视频字符串首帧以及重复/顺序映射有契约与测试。
- [x] 未确认角色及其参数别名在网络请求前显式拒绝；多参考图、负面提示、尾帧、音轨、角色绑定、蒙版不静默降级或冒充生效。
- [!] 仍需目标部署对 `negativePrompt/lastFrame/audioTrack/style/character/mask` 及多参考图的正式字段契约和授权实测。图片 `style=vivid/natural` 字符串不等于“风格参考图”角色。

### `[x]` P1-REAL-E2E-08 隔离凭据、上游 usage 与最小真实请求证据

- [x] 用户明确提供三类测试凭据；通过无回显 stdin/进程内存注入，临时隔离数据库只存加密值，退出清理随机 schema，不把 Key 写入源码、夹具、日志或导出。
- [x] 文本 `gpt-5.5` 与图片 `gpt-image-2` 各一次 HTTP 200；真实 API 入队、Worker 执行、Prisma/MinIO 归档及读回摘要验证通过。
- [x] 供应商 requestId 摘要与持久化 payload 对应，文本 total_tokens=8694、图片 total_tokens=273；没有返回价格或费用时保持未知。
- [x] 视频首次 POST 返回 404；用户纠正模型名称并重新授权后，完整名称的一次请求仍为 404。两次分别保存失败证据，未自动切换协议重发；已确认 sub2 使用不同端点，后续调用另行确认。

本项只关闭“最小真实请求和证据链”，不代表视频、音频、所有参数或实际生产部署通过。当前仅有一个真实 origin：`https://ai.helunox.cc.cd`；New API 官方文档不是第二个已实测服务器。

### `[!]` P1-PRODUCTION-09 生产外部验收

在获得明确授权并与真实生产数据隔离后，仍需完成：

- 生产 S3 上传/下载、Redis 队列接管、跨实例恢复、TLS/反向代理和全局限流。
- OTLP/Sentry 投递、CI Runner、真实 Provider 回调、凭据轮换和媒体归档的故障演练。
- 迁移兼容窗口、回滚步骤、对象存储前缀和队列 namespace 记录。

本地 Docker、Mock 或历史测试不能替代生产验收证据。

## P2：明确暂缓

### `[>]` P2-SSO-10 外部身份系统

等待 OAuth 2.0/OIDC 或兼容 JWT 契约后接入，当前保留邮箱登录。

### `[>]` P2-USAGE-11 上游 usage 展示与可选对账

只做供应商 `usage`、状态和可选费用字段的展示/记录；本项目不实现收费、额度扣减或账单结算。该项是可观测性增强，不阻塞功能交付。

### `[>]` P2-RESOURCE-12 资源提及增强能力

- 语义搜索、OCR、音频转录、视频关键帧描述和批量引用。
- 搜索索引异步化、缩略图/元数据重建和大规模资源性能验证。

### `[>]` P2-DESKTOP-13 桌面端封装

Web MVP 和生产链路稳定后再接入 Tauri 桌面壳。

### `[>]` P2-COLLAB-14 协作与后置编辑能力

多人协作、插件市场、代码节点、完整视频剪辑器和复杂移动端画布。

## 外部依赖登记

| 依赖                                                | 影响事项                                                            | 处理原则                                             |
| --------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| Provider 创建/查询/取消/Webhook/签名/usage/幂等契约 | P1-VIDEO-CONTRACT-04、P1-PROVIDER-ROLES-07                          | 未确认不猜字段；无法表达时显式失败                   |
| 真实音频模型/voice、视频追加调用及平台轮换授权      | P1-VIDEO-CONTRACT-04、P1-MEDIA-COVERAGE-05、P1-MULTIKEY-ROTATION-06 | 三类测试 Key 已提供，文本/图片已通过；不扩大调用范围 |
| PostgreSQL、Redis/BullMQ、生产 S3 和部署权限        | P0-REAL-INFRA-01、P1-PRODUCTION-09                                  | 独立 namespace、bucket、数据库和回滚方案             |
| TLS/反向代理、OTLP/Sentry、CI Runner                | P0-PROD-STARTUP-02、P0-MEDIA-OPS-03、P1-PRODUCTION-09               | 先完成脱敏、失败隔离和演练，再接生产                 |
| 价格、预算、本地收费策略                            | 无                                                                  | 不作为功能阻断条件；费用由上游负责                   |

## 验收规则与执行顺序

1. 每个事项完成时记录修改文件、提交 ID、验证命令、环境类型、外部依赖状态和剩余风险。
2. 只有实现、相关测试/冒烟、文档证据、`git diff --check` 和 Git 状态检查全部具备，才能从 `[~]`/`[!]`/`[>]` 改为 `[x]`。
3. 先完成 P0 生产基础设施与恢复，再完成 P1 Provider 契约、真实请求和多 Key 生产验收；P2 按产品优先级安排。
4. 价格未知、上游未返回费用字段或本地没有收费模块时，继续推进功能；Token、并发、大小和超时限制只作为稳定性保护。
5. Mock 和静态代码可以证明应用内部闭环，不能证明供应商实际读取媒体或生产环境已经验收。

## 验证基线

### 2026-09-05 本地与隔离逐项验收检查点

- 基线：`main` / `9692ed8` / `v0.13.12`，Node `v24.12.0`、pnpm `11.19.0`、PowerShell `7.6.5`；原有 Provider 两文件改动保留后独立审核。仓库没有 README 或落盘 AGENTS，遵循本任务提供的规则。
- 本轮目标：逐项完成 P0/P1 本地实现与隔离验收，并使用用户随后授权的三类凭据完成最小真实请求；P2、收费模块、真实业务数据操作不在范围内。
- [x] 新建专用 `mc-acceptance-test-p0p1` PostgreSQL/Redis/MinIO，端口 `19432/19379/19900/19901`，不复用开发容器。可重复脚本 `scripts/verify-isolated.ps1` 要求 PowerShell 7，测试账号仅为合成值。
- [x] `./scripts/verify-isolated.ps1 -Action Test`：14 个迁移 deploy、schema diff 零差异、35 项数据库/恢复集成、9 项独立进程限流与 22 项真实 TLS 生产模式入口通过。日志 `.data/acceptance-integration-final.log`。
- [x] API 入队后更新源资源，独立 API 读回仍冻结 v1；真实 Worker 进程在写入平台任务标识后故意退出，后继 Worker 经 BullMQ 租约恢复，同一任务 ID、冻结媒体和内联提及保持一致。
- [x] 合成文本/图片/音频经过真实 Worker、PostgreSQL 和 MinIO 归档；内容摘要一致、usage 只记录一次；移除专用测试队列记录后，新 API 进程仍能从数据库恢复结果。队列及数据库快照不包含临时 data URL。
- [x] 运行中设置/撤销同步、并发撤销、应用时钟偏差和锁后时间排序通过；0014 旧结构升级保留旧密文，撤销状态及移除旧加密密钥后历史恢复通过。
- [x] 真实媒体、文件/S3 兼容和遥测脚本通过 40 项 API、35 项 Worker、21 项 Observability。S3 最小权限脚本连续两次各 29 项通过。
- [x] `pnpm install --frozen-lockfile`、`pnpm exec turbo run lint typecheck build --force --concurrency=1` 的 24 个任务通过；`pnpm exec turbo run test --force --concurrency=1 -- --maxWorkers=1 --minWorkers=1` 的 13 个任务全部通过且无缓存。单测通过数为 UI 3、Observability 21、Credential Crypto 7、Domain 24、Web 339、Provider 266、Worker 183、API 454；默认环境的设施跳过项由独立套件补验，不计作默认单测成功项。日志 `.data/acceptance-quality-final.log`、`.data/acceptance-units-final.log`。
- [x] 最终 PC Web 冒烟 22 项通过，44.3 秒；包含音频 voice/格式/语速、视频显式宽高的保存恢复与提交。已检查桌面截图、控件边界与控制台错误；独立预览位于 `http://127.0.0.1:5190`，使用独立本地数据目录，不含测试 Key。
- [x] 等效无外网 Linux CI 最终全量退出码 0，报告 `.data/mc-linux-ci-665b7a40bdd5`。锁文件离线安装、构建、lint/typecheck/format、全量单测、14 个迁移及 schema diff 均通过；独立 Redis 9、数据库/设置 35、TLS 22、媒体/S3 13、HTTP collector 3 项全部无 skip/TODO；Web E2E 22 passed，46.8 秒。原失败报告保留，新快照完整执行，没有改写历史失败或用部分成功代替全量通过。
- [x] 最终安全复核将 Windows 专用 PostgreSQL/Redis/MinIO 四端口限制为 `127.0.0.1`，S3 验收拒绝非回环绑定。仅重建本次测试容器、保留卷；补验迁移/schema diff、35+9+22 项集成及 29 项 S3 权限通过。日志 `.data/acceptance-loopback-integration.log`、`.data/acceptance-loopback-s3.log`。未修改原有开发服务。
- [x] 最终 Linux 源清单与当前应用源码、测试、Linux 脚本和 Docker 文件一致；后续差异仅验收文档和上述两个 Windows 脚本，脚本已实际补验，文档执行最终格式检查。源清单 SHA-256 为 `328E776E0B28CCD6AAF521C93654E0EC5AAA2A0BD60FDB45F96F7676026A8CC9`。
- [x] 精确扫描 354 份源码与验收日志，没有匹配用户提供的三把真实 Key；常见 Token/私钥模式扫描也无匹配。凭据只在无回显 stdin/进程内存中注入，临时数据库仅保留密文，按本次随机 schema 清理。
- 真实平台证据见 `docs/live-provider-acceptance.md`：同一 sub2 origin 的文本/图片各一次成功并归档；视频两次分别授权的单数端点请求均 404，完整模型名不被替换。已确认 Sub2API 官方使用复数视频端点，追加调用待明确确认。
- 本轮验收与兼容性修复随 `v0.13.13` 归档，对应提交可用 `git rev-list -n 1 v0.13.13` 查询。本检查点不关闭视频追加调用、音频模型/voice、供应商高级字段/回调契约、平台侧轮换和真实部署授权等外部事项。

### 2026-09-05 P0/P1 凭据恢复执行检查点

- 恢复起点：`main` / `424e109`，Node `v24.12.0`、pnpm `11.19.0`、Docker `29.7.2`。接手的凭据轮换代码尚未提交；复查发现文件轮换不写回和数据库轮换可破坏撤销及并发安全，不能沿用“已有实现即完成”的判断。
- 主要修复：文件启动重加密写回前不放行；Prisma API/Worker 写回保留 `id/version/updatedAt`，使用旧密文/key-id/版本/时间 CAS，失败不返回凭据或底层敏感诊断；拒绝重复历史 key-id，补充 GCM 篡改和 key-id 不匹配测试。
- 依赖和迁移：共享 credential-crypto workspace 包、API/Worker 依赖、锁文件和既有 `0014_ai_credential_encryption_key_id` 一并验收；`pnpm install --frozen-lockfile` 通过，无新增第三方版本。先备份再迁移，写入 v2 后不能直接回滚到旧解密器，细则见 `docs/credential-rotation.md`。
- 隔离设施：全新 Compose 项目 `mc-integration-1788571283145`，PostgreSQL/Redis/MinIO 端口 `18432/18379/18900`，与现有开发容器分离；合成凭据仅用于该测试栈。迁移 deploy 成功，schema diff 为零；真实 Prisma/Redis/MinIO 集成 20 passed，包含独立 API/Worker 进程、撤销状态保持和数据库 CAS 竞争。
- 真实入口冒烟：`NODE_ENV=production` 的 API 与 Worker 启动，健康检查和 `401/200` 授权边界通过；不调用 Provider、未启用媒体工具，不包含 TLS 代理或生产部署验收。
- 当前验证：低并发强制全量单测通过，API 402 passed / 11 skipped / 2 个既有 TODO，Credential Crypto 7 passed；其他包结果见 `.data/p0p1-all-tests.log`。普通测试跳过的数据库场景另行执行上述 20 项集成；剩余跳过不可算完成。最终质量与界面验证见本轮提交说明。
- 最终验证：`pnpm exec turbo run lint typecheck build --concurrency=1`、`pnpm format:check` 和 diff 检查通过；桌面 Web Mock E2E 20 passed，追加 Worker 写回失败回归后定向 16 passed。从暂存区导出的独立源码构建通过 API/Worker 类型检查、85 项定向测试和 20 项真实集成，排除对未提交 Provider 代码的依赖。
- 归档与恢复：本检查点随 `v0.13.12` 对应提交归档，提交 ID 可通过 `git rev-list -n 1 v0.13.12` 查询；原有 Provider 取消两文件保留未提交。仅停止本轮新建的隔离 Compose 项目并保留测试卷，不操作既有开发服务；启动冒烟的 API/Worker 子进程已退出。
- 下一步仍需编码/验证：运行中实例的设置/撤销缓存同步、冻结媒体跨 API/Worker 恢复、图片音频归档与参考角色映射、生产媒体工具和可观测性故障隔离。外部依赖另列：真实 Provider 契约/隔离凭据/请求授权、TLS 部署、外部追踪与 CI Runner。P0/P1 保持未完成，不因本轮修复改为 `[x]`。

### 2026-09-05 P0-PROD-STARTUP-02 执行检查点

- 目标：关闭生产 Redis 故障时的本机额度回退，验证跨进程共享窗口、重启恢复和 HTTP 故障边界；不扩展到 P1/P2，不接触生产数据。
- 起点：`main` / `c81411a`，上游 `origin/main`；Node `v24.12.0`、pnpm `11.19.0`、Docker `29.7.2`，依赖已存在，无需安装新包。
- 工作区：接手时已有密钥轮换、Provider 取消、启动配置及迁移等未提交修改，保留但不混入本轮限流提交。
- 实现：`apps/api/src/rate-limit.ts`、`runtime-rate-limit.ts`、`app.ts`、`index.ts` 和 `openapi.ts` 完成生产故障关闭、首次连接等待、1 秒命令超时、冷却恢复、HTTP 503 和脱敏诊断；对应测试、独立 Redis 配置及 CI 步骤随同维护。部署影响和回滚见 `docs/production-rate-limiting.md`，无需数据迁移或新增依赖。
- 恢复记录：最初 `pnpm test` 命中缓存；强制并发重跑遇到 Windows `VirtualAlloc failed` 后，核对工作区并改用低并发重跑通过。集成测试子代理未交付完整文件，主 Agent 停止其执行、检查状态后接手完成，不把等待或缓存作为验收结果。
- 全量测试：`pnpm exec turbo run test --force --concurrency=1 -- --maxWorkers=1 --minWorkers=1` 通过；追加最终 API `vitest run --maxWorkers=1 --minWorkers=1` 为 400 passed、6 skipped、2 个既有 TODO。其他包 Worker 157、Providers 131、Web 290、Domain 24、Observability 15、Credential Crypto 5、UI 3 passed。普通测试跳过的真实 Redis 场景已单独执行；PostgreSQL/S3 等未配置场景不算通过。
- 定向与隔离验证：限流模块 42、入口策略 6、HTTP/OpenAPI/真实监听冒烟 8、OpenAPI 引用 6 均通过；专用 `vitest.rate-limit-integration.config.ts` 在本机 Redis 随机测试前缀下 9 passed，缺配置时按预期非零退出。两个独立 Node 进程共享窗口、重建后额度不重置、不同前缀互不影响；无 `FLUSHDB`、数据清理或生产连接。
- 提交独立性：从暂存区导出的源代码快照重新构建 Domain/Observability/Providers 后，API 类型检查、62 项定向测试和 9 项真实 Redis 验证通过；不依赖接手时未提交的密钥轮换和 Provider 源码修改。
- 质量与界面：`pnpm exec turbo run lint typecheck build --concurrency=1`、`pnpm format:check`、`git diff --check` 通过；`CI=true WEB_PORT=5187 pnpm test:e2e` 为 20 passed，使用独立测试端口避免复用用户开发服务。
- 归档：本检查点随 `v0.13.11` 对应限流修复提交归档；提交 ID 可用 `git rev-list -n 1 v0.13.11` 查询，提交说明包含验证与兼容性边界。详细本地输出位于被忽略的 `.data/todo-*.log`，不提交原始环境或连接凭据。
- 下一步：继续 P0 隔离部署中的 TLS/反向代理、跨实例凭据与队列恢复、告警及回滚演练；缺少授权的真实生产和供应商事项继续保持 `[~]` / `[!]`，本轮不将整个合并清单标为完成。

### 历史已提交基线

- 提交：`06bc654`（`feat: 完善资源提及映射并移除本地收费阻断`），标签：`v0.13.10`。
- `pnpm test`：API 328 passed/5 skipped、Worker 149、Providers 127、Web 290、Domain 24、Observability 15、UI 3。
- `pnpm test:e2e`：20 passed。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm format:check`、`git diff --check`：通过。
- 上述基线证明当前本地/隔离测试状态，不替代本文件标记为 `[~]` 或 `[!]` 的真实生产和供应商验收。
