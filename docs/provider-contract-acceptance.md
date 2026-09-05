# Provider 契约与验收

更新时间：2026-09-05。记录 `packages/providers` 的技术契约、本地测试及 API/Worker 关联链路的验收状态。

## 基线与完成边界

- 起点：`main` / `9692ed8`，Node `v24.12.0`，pnpm `11.19.0`，依赖已安装；仓库没有 README 或额外 AGENTS 文件。
- Provider 初始测试基线为 131 项；原有请求和轮询取消行为保留，并通过定向回归独立验证。
- 新增测试首先复现 11 项失败：流式响应取消挂起、预取消恢复丢失平台身份、未知参考参数透传/静默丢弃及 `n` 被静默覆盖。
- 本地适配器验收与真实供应商验收分开：单测、loopback HTTP 和文档 GET 不证明供应商受理、计费幂等、媒体可访问或 Worker 归档成功。
- New API 官方契约与实际 Helunox/Sub2API 部署分别核对，不能以模型清单证明协议兼容。生成调用须显式授权并限制次数，凭据不得写入源码、文档或日志；已发送但结果不明的请求不得自动重试或切换协议重发。

## 官方来源与只读访问证据

首轮来源表对应 2026-09-05 10:06–10:15（Asia/Shanghai）的无鉴权 HTTPS GET；后续 10:49–10:58 的 Sub2API 身份和路由调查见独立小节。所有访问使用系统正常 TLS 校验，没有修改代理、关闭证书校验或扫描业务路径。只保留状态、标题和契约摘录，不保存完整网页、Cookie 或凭据。

| 来源                                                              | HTTP / 证据                                                                                      | 已确认内容                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [New API 文档首页](https://docs.newapi.pro)                       | 200，最终 `https://docs.newapi.pro/en`，标题 `New API - The Foundation of Your AI Universe`      | 页面链接到 `QuantumNous/new-api`、官方 Apifox 和文档目录。                                                                                                                                                           |
| [官方 Apifox](https://apifox.newapi.ai/)                          | 200，标题 `文档说明 - NewAPI`                                                                    | 公开文档入口，不执行调试面板。                                                                                                                                                                                       |
| [官方文档索引](https://apifox.newapi.ai/llms.txt)                 | 200，266 行；响应 Date `Sat, 05 Sep 2026 02:15:01 GMT`                                           | 后续 `.md` 链接直接来自该索引，不是猜测路径。索引检索未发现视频取消、视频 Webhook 或幂等保证，不能据此推断平台绝对不支持。                                                                                           |
| [生成图像](https://apifox.newapi.ai/385320132e0.md)               | 200，OpenAPI 3.0.1 / info 1.0.0                                                                  | `POST /v1/images/generations/`；`model/prompt/n/size/background/moderation/quality/stream/style/user`，响应 URL/base64/usage。文档带尾斜杠，代码既有路径不带；当前部署图像真实链路已通过，不外推其他部署的路由行为。 |
| [ImageGenerationRequest](https://apifox.newapi.ai/224065303d0.md) | 200                                                                                              | `style=vivid/natural`、`response_format=url/b64_json`、`n=1..10`，不同模型约束不同；当前归档接口仅支持一项，因此不接受 `n>1`。                                                                                       |
| [文本转语音](https://apifox.newapi.ai/383826485e0.md)             | 200                                                                                              | `POST /v1/audio/speech`；必需 `model/input/voice`；input 最多 4096 字符；voice 为 alloy/echo/fable/onyx/nova/shimmer；speed 0.25–4；格式 mp3/opus/aac/flac/wav/pcm。                                                 |
| [通用视频创建](https://apifox.newapi.ai/383844576e0.md)           | 200                                                                                              | `POST /v1/video/generations`，JSON；image 为字符串，返回 `task_id`。支持的字段与 Sora 并不相同。                                                                                                                     |
| [通用视频查询](https://apifox.newapi.ai/383844577e0.md)           | 200                                                                                              | `GET /v1/video/generations/{task_id}`；queued/in_progress/completed/failed；成功返回 url/format/metadata。                                                                                                           |
| [Sora 视频创建](https://apifox.newapi.ai/383844578e0.md)          | 200                                                                                              | `POST /v1/videos`，multipart/form-data；`model/prompt/seconds/input_reference`，返回 `id`。                                                                                                                          |
| [Sora 视频查询](https://apifox.newapi.ai/383844579e0.md)          | 200                                                                                              | `GET /v1/videos/{task_id}`；返回 id/status/progress 等字段。                                                                                                                                                         |
| [Sora 视频内容](https://apifox.newapi.ai/383844580e0.md)          | 200                                                                                              | `GET /v1/videos/{task_id}/content`；代理视频文件流，文档响应 MIME 为 video/mp4。                                                                                                                                     |
| [用户给出的 sub2 主页](https://ai.helunox.cc.cd)                  | 200；标题 `Helunox - AI API Gateway`；响应正文 697207 字节；Date `Sat, 05 Sep 2026 02:07:01 GMT` | 首轮未提取静态超链接；后续解析实际加载的脚本及注入配置，已找到运营方教程和 Sub2API 官方项目，详见下节。未扫描业务路径，也不据页面外观认定兼容。                                                                      |

一次发现过程中的无效链接也明确记录：`https://www.newapi.ai/en/docs` 返回 404（QN Platform），不能作为契约证据；随后回到已确认的 `docs.newapi.pro` 和页面实际链接的 Apifox 继续核对。

公开文档复核命令示例（仅 GET，输出文档文本，不携带鉴权）：

```powershell
$page = Invoke-WebRequest -Uri 'https://apifox.newapi.ai/383826485e0.md' -TimeoutSec 25 -UseBasicParsing -SkipHttpErrorCheck
$page.StatusCode
($page.Content -split "`n") | Select-Object -First 110
```

### Helunox/Sub2API 身份与路由证据

公开主页标题为 `Helunox - AI API Gateway`。其实际加载的脚本包含 `Sub2API` 标识，并直接链接 `Wei-Shaw/sub2api` 项目，足以将公开前端识别为 Helunox 品牌的 Sub2API 系部署，而不是据页面外观认定 New API 兼容。站点注入的 version 为空，实际后端提交版本未公开。

下列链接均通过无鉴权 GET 返回 HTTP 200；网页和脚本仅作静态解析，不执行登录、阅读计数或生成 POST。

| 来源                                                                                                                                                    | 访问证据与结论                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [主页实际脚本](https://ai.helunox.cc.cd/assets/index-B9eRoPy0.js)                                                                                       | 2026-09-05 10:50:38；包含 `sub2api_locale`、默认站名 `Sub2API` 和 `Wei-Shaw/sub2api` 官方项目链接。                                                                                                                            |
| [主页](https://ai.helunox.cc.cd/)的公开配置                                                                                                             | 10:52:03；`site_name=Helunox`，`doc_url=https://bk.apiclub.top/blog/1785703542`，`api_base_url=https://ai.apiclub.top`。配置中的另一域名不等于可以自动替换当前请求 origin。                                                    |
| [运营方教程](https://bk.apiclub.top/blog/1785703542)及[公开 Markdown 正文](https://bk.apiclub.top/article-base-info/content/1785703542)                 | 10:52:38 / 10:55:44；正文标题为“Helunox API 服务站使用教程（纯文字版）”，明确列出用户提供的站点。正文接口来自教程自身加载的 `ArticleDetail-mHAQXslW.js`，不是猜测路径。教程未说明视频路由，也未列出“按次”模型别名。            |
| [Sub2API 官方 README，第 750 行](https://github.com/Wei-Shaw/sub2api/blob/b1748c4ea99ce2120401a269142aa071e18a84da/README.md#L750)                      | 固定提交 `b1748c4ea99ce2120401a269142aa071e18a84da`；10:58:19 再次核对原始 Markdown。明确列出 Grok 的 `/v1/videos/generations`、`/v1/videos/{request_id}`，下一行列出 `grok-imagine-video-1.5`。创建要求分组开启媒体生成权限。 |
| [同一提交的路由注册](https://github.com/Wei-Shaw/sub2api/blob/b1748c4ea99ce2120401a269142aa071e18a84da/backend/internal/server/routes/gateway.go#L268)  | `/v1` 路由组注册 `POST /videos/generations`、`GET /videos/:request_id`，并提供 `POST /videos` 别名；没有据此把请求改成 Sora multipart。                                                                                        |
| [同一提交的响应处理说明](https://github.com/Wei-Shaw/sub2api/blob/b1748c4ea99ce2120401a269142aa071e18a84da/backend/internal/service/grok_media.go#L511) | 10:54:06；公开成功示例为 `status: done`、`video.url`、`video.duration`，状态说明为 pending/done/expired/failed。                                                                                                               |

因此，有公开契约依据的候选创建与查询路径是 `POST https://ai.helunox.cc.cd/v1/videos/generations` 和 `GET https://ai.helunox.cc.cd/v1/videos/{request_id}`。现有适配器应为重新获授权的新任务显式选择 `videoContract: 'legacy-v1'`，API/Worker 配置为 `NEW_API_VIDEO_CONTRACT=legacy-v1`，并冻结 `payload.contract=legacy-v1`。不能重写之前任务的冻结合同，也不能通过恢复逻辑重发 POST。公开上游源码不代表该站当前部署版本、分组权限和完整参数范围已经实测通过。

用户指定的模型必须完整保留为 `grok-imagine-video-1.5（按次）`，括号前没有空格。带空格的 `grok-imagine-video-1.5 （按次）` 是另一字符串；Provider 对两者都原样序列化为 UTF-8 JSON，不插入或删除空格、不移除后缀、不自行替换为官方文档中的裸模型名。公开文档未列出这两个部署别名，不能据此推断模型不支持。

### 视频契约的明确差异

`NewApiVideoProvider` 支持显式 `videoContract: 'newapi-unified-v1' | 'legacy-v1'`，构造器默认 `legacy-v1`。API/Worker 已接入 `NEW_API_VIDEO_CONTRACT` 显式配置并传递构造选项；Provider 包自身不读取该环境变量、不自动识别部署协议。

统一协议使用 `POST /v1/video/generations`，JSON `image` 为字符串，只读取顶层 `task_id` 作为平台任务 ID；查询为 `GET /v1/video/generations/{task_id}`，解析官方状态、`url/format/metadata`。完成响应没有有效 HTTP(S) URL 时失败，绝不回退到 legacy 内容端点。查询 ID 不同、状态或格式未知也明确失败。

统一创建允许 `model/prompt/image/duration/width/height/fps/seed/n/response_format/user`：model 来自 modelAlias，image 仅由已验证 firstFrame 角色映射；duration 为正有限数值秒，width/height/fps 为正整数，seed 为安全整数；当前仅支持 `n=1` 和 `response_format=url`。不把 resolution/size/quality/aspectRatio、Sora 文件字段或未知参考参数转换为猜测字段。`inferenceStrength` 属于内部配置，不发送到供应商。

`legacy-v1` 保留 `POST /v1/videos/generations`、JSON `image: { url }`、`request_id` 等行为，创建/查询路径和图片引用对象与已核对的 Sub2API 官方 README 相符。README 未提供完整响应 schema；同一提交源码的 `status: done` 和 `video.url` 示例可由现有 legacy 解析器读取，未发现已确认的响应形状冲突。其他兼容别名不因此获得官方保证，当前不扩展解析结构。此协议与 New API 通用视频及 Sora 创建契约不同；Sora multipart 暂不支持，不能传 `sora-v1`。

通用视频的 `metadata` 是开放对象，并不定义每个模型的负面提示、角色、音轨或参考图语义；这些角色不能通过 `metadata` 绕过校验。Webhook 原始 body、签名算法/编码、时间窗口和重放契约仍未确认，不采用推测的 Webhook 合同。

### 冻结合同与安全恢复

新视频任务（包括 legacy）必须提供 `onProviderJob`，并在任何 POST 前成功持久化以下增量；缺失或失败分别返回 `VIDEO_CONTRACT_PERSISTENCE_REQUIRED` / `VIDEO_CONTRACT_PERSISTENCE_FAILED`，零请求。

```ts
new NewApiVideoProvider({
  baseUrl,
  apiKey,
  videoContract: 'newapi-unified-v1',
});

// onProviderJob 在 POST 前收到的增量，尚无 platformJobId。
const pendingUpdate = {
  provider: 'newapi',
  status: 'queued',
  progress: 0,
  payload: {
    contract: 'newapi-unified-v1',
    phase: 'submitting',
    modelAlias,
  },
};
```

创建返回 task_id 后再次等待 `onProviderJob` 持久化 platformJobId 及 `phase: 'submitted'`，再查询。构造器参数只决定尚未冻结的新任务，不覆盖历史记录。

| 已有记录                                                      | 恢复行为                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| `payload.contract=newapi-unified-v1` 且有平台 ID              | 只查询官方统一路径，即使构造器配置 legacy。                  |
| `payload.contract=legacy-v1` 或 `newapi-video-v1` 且有平台 ID | 只查询旧 `/v1/videos/{id}`，保留原合同标识。                 |
| 有平台 ID 但没有合同                                          | 按 legacy 查询并输出 `contract=legacy-v1`，不能套新协议。    |
| 无平台 ID 且 `phase=submitting`                               | `VIDEO_SUBMISSION_UNKNOWN`，禁止重放创建；先在供应商侧核对。 |
| 任何未知合同，包括 `sora-v1`                                  | `VIDEO_CONTRACT_UNSUPPORTED`，零请求。                       |

无需数据库 schema 迁移：使用现有 payload；上线前保留现有任务记录并备份。配置回滚只影响新任务，不能重写、清空旧 ID 或冻结合同；回滚二进制也必须保留统一合同的恢复能力，不能退回不识别合同的旧代码。合同回调成功但 POST 前崩溃也按结果未知处理，这是避免重复计费的保守边界，不证明供应商已受理。

成功视频通过 `payload.requestId` 返回脱敏关联 ID，通过 `payload.mediaMetadata` 返回 `duration/width/height/fps/seed` 数值，不保存签名 URL 或任意 metadata。Worker 持久化必须保留 contract、phase、requestId 和 mediaMetadata，尤其不能丢失无平台 ID 时的 `phase=submitting` 防重放标记。

## 本地验收映射

| 范围           | 已验证行为                                                                                                                                                                 | 仍不代表什么                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 普通请求取消   | 请求前、请求中、响应体读取中取消返回 `ABORTED`、不可重试；释放流、监听和计时器；完成进度回调中取消不返回成功。                                                             | 不代表供应商未受理或远程任务取消。                                                                      |
| 视频取消与超时 | 创建、查询、轮询等待、受保护下载（响应头及响应体）受信号控制；下载 MIME 和大小受限；本地真实 loopback HTTP 下载取消会关闭连接。                                            | 不代表存在远程取消接口。                                                                                |
| 身份与恢复     | 预取消保留传入平台 ID；创建后先持久化身份；恢复只 GET，不重新 POST；进度/持久化回调异常保留身份、脱敏且不自动重试。                                                        | 请求已发送但没有读到任务 ID 时无法推断平台是否受理；需供应商核对。                                      |
| 成功请求关联   | 普通 text/image/audio 成功通过 providerJob.payload.requestId 输出 header ID，缺失时按顶层 request_id/requestId/id 回退；脱敏并限制长度，保留 usage，不设置 platformJobId。 | completion ID 是关联信息，不是视频平台任务身份；无 ID 时不伪造。                                        |
| 统一视频合同   | 54 项定向回归覆盖合同冻结、创建参数、ID/状态/URL/format/metadata、旧记录恢复及失败关闭；真实 loopback HTTP 覆盖创建、查询和同源二进制下载。                                | 本地响应替身不证明 sub2 部署支持该协议或所选模型支持全部通用字段。                                      |
| 重试边界       | 每次执行标准生成/视频创建最多发送一次 POST；发送稳定 `idempotency-key`；视频创建传输结果不明返回非重试诊断。                                                               | 稳定 key 不能证明上游去重、免费重试或避免重复收费；429/网络错误的 retryable 仅是临时故障分类。          |
| 图片参数       | 保留已知参数及原有尺寸/质量别名；仅支持一项输出；标准 `style=vivid/natural` 与图参考角色区分；别名冲突、透明 JPEG、未知选项或流式模式显式拒绝。                            | 不保证所有模型接受任意 size/quality；既有 aspect_ratio 扩展仍需部署合同。                               |
| 音频参数       | 显式 voice、speed 边界、格式枚举、input 长度；请求参数完整断言；原始音频/JSON URL/base64 解析与 MIME 校验。                                                                | 不扩展到转录、翻译、克隆音色或未确认新音色。                                                            |
| 参考角色       | 文本 prompt/content/transcript、Chat 资源提及顺序/重复保持；生成端点拒绝未支持提及、多个主输入、多首帧、损坏首帧和跨媒体错误。                                             | 不支持未知 reference_images/negative_prompt/last_frame/audio_track 等绕过参数。                         |
| 媒体输出       | 拒绝损坏 base64、错误 MIME、多项输出静默丢弃；合法远程 URL交给 Worker。                                                                                                    | Provider 不预取或 HEAD 探测图片/音频 URL；带鉴权下载、SSRF 边界、过期 URL及归档由 Worker/API 链路验收。 |

### 兼容性与范围影响

- 可选 signal 只控制本地请求、轮询和下载；调用方须传递取消信号，不能将本地中止解释为远程任务已取消。
- 不新增依赖、不改变数据库 schema 或远程取消接口；payload 新增合同冻结阶段与数值媒体元数据，快照格式不迁移。
- 未提供 voice 的音频调用现在在发送前明确失败，不再把缺必需参数的请求发到供应商。模型配置/调用方应显式设置已支持 voice；不能无声明补默认音色。
- 未知图片/音频/视频参数不再盲透传或静默丢弃；`n>1`、多项结果和不支持的流式模式明确失败。需要新字段时必须补正式来源、模型适用范围及测试。
- `output_format` 为已有映射，限制为 png/jpeg/webp；官方图像页面只在透明背景描述中涉及该字段，详细支持范围仍需部署确认。未新增 `output_compression`、`partial_images` 或其他未核实字段。
- UI 已提供独立的可选 `width/height` 像素输入，无默认值，按正安全整数保存恢复；清空仅删除对应字段，非法值阻止生成，原有参数保留。不从 `resolution/aspectRatio/size` 推算宽高；统一协议仍显式拒绝不受支持的旧参数，不能猜测供应商字段。
- 包测试、API/Worker 定向测试和真实媒体验收分别记录，不互相替代；文本、图片和视频最小闭环已通过，不代表音频、高级视频字段或供应商回调契约已通过。

## 手动真实验收入口

`packages/providers/src/acceptance-runner.ts` 和 `acceptance-cli.ts` 提供独立的手动入口。该入口仅完成本地替身测试和未授权失败关闭冒烟；已通过的真实文本、图片验收使用 Worker/DB/S3 链路，不是此简易入口。

启动必须由操作者通过进程环境/密钥管理显式注入：

| 环境变量                         | 要求                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PROVIDER_ACCEPTANCE_AUTHORIZED` | 精确为 `I_ACCEPT_UPSTREAM_CHARGES`，不是已有授权证明；未获用户授权时不得设置。                              |
| `PROVIDER_ACCEPTANCE_PLATFORM`   | 仅接受协议标识 `newapi`；值为 `sub2` 时拒绝，不自动推断兼容性。                                             |
| `PROVIDER_ACCEPTANCE_MEDIA_TYPE` | 仅 text/image/audio；该简易入口不实现视频持久化回调，因此拒绝视频，视频通过具有合同持久化能力的调用链验收。 |
| `PROVIDER_ACCEPTANCE_BASE_URL`   | 必需，HTTPS，不含用户信息、查询串或片段；不猜服务地址。                                                     |
| `PROVIDER_ACCEPTANCE_MODEL`      | 必需，隔离项目中明确授权的模型。                                                                            |
| `PROVIDER_ACCEPTANCE_API_KEY`    | 必需，只经密钥注入，不写命令行、文档、日志或源码。                                                          |
| `PROVIDER_ACCEPTANCE_PROMPT`     | 必需，明确的最小验收文本，不自动生成请求内容。                                                              |
| `PROVIDER_ACCEPTANCE_VOICE`      | 音频必需，当前文档确认的音色之一。                                                                          |

配置并获得授权后，由操作者手动运行：

```powershell
pnpm --filter @multimodal-canvas/providers build
node packages/providers/dist/acceptance-cli.js
```

入口不加载 `.env`，没有默认模型、Key 或服务；每次最多一次生成请求、30 秒超时、不自动重试、不访问返回媒体 URL。退出码为成功 0、请求失败 1、缺授权/配置或不支持合同 2。

输出仅包含随机内部 `runId`、HTTP 状态、请求次数、供应商请求 ID 的 SHA-256 指纹、输出种类和允许列表内的 usage 计数/明确费用字段；不输出原始请求 ID、prompt、Key、模型响应文本、媒体、签名 URL 或任意 metadata。没有 usage 时保持未知，不估算价格。入口不完成 Worker 归档，不等价于 P1-REAL-E2E 全链路通过。

重复手动启动会创建新的运行 ID，**可能再次收费**；失败或超时不能直接重跑，必须先在供应商侧按关联证据核对。sub2 的模型目录 GET 只能证明部署模型信息，不能单凭主页、展示名或模型列表推断视频协议。

## 验证结果

本地包定稿验证命令：

```powershell
pnpm --filter @multimodal-canvas/providers test --maxWorkers=1 --minWorkers=1
pnpm --filter @multimodal-canvas/providers typecheck
pnpm --filter @multimodal-canvas/providers lint
pnpm --filter @multimodal-canvas/providers build
pnpm exec prettier --check docs/provider-contract-acceptance.md
git diff --check -- packages/providers docs/provider-contract-acceptance.md
```

前次定稿单 worker 测试为 265 passed（原有 131、新增边界 54、入口安全 17、成功关联 9、统一视频 54），无 skip；包 typecheck、lint、build、文档格式及任务范围 diff 检查均通过。统一创建返回未知状态时也保留已读到的平台 ID，不因解析失败重新创建。

本次仅将既有 Unicode 模型测试扩为无空格、带空格两个用例，并检查实际 Request 的 UTF-8 请求体，未改动生产代码。定向验证 2 passed；2026-09-05 11:04 的全包单 worker 验证为 **266 passed，无 skip**（index 132、边界 54、入口安全 17、成功关联 9、统一视频 54），typecheck、lint、build、文档格式及 diff 检查通过。

CLI 子进程失败关闭冒烟通过：对子进程显式传入空 `PROVIDER_ACCEPTANCE_AUTHORIZED`，观察到退出码 2、`status=blocked`、`requestCount=0`、`code=EXPLICIT_AUTHORIZATION_REQUIRED`，不读取用户凭据、不发送网络请求。源码、测试和本文档不包含真实密钥、Token、连接凭据或原始调试日志；公开 URL 和测试合成值不作为真实凭据。

API/Worker 的显式视频配置接线已完成，对应两组定向测试分别为 58 passed、77 passed，构建通过。真实文本、图片和视频已通过同一 origin 的 Worker/DB/S3 全链路，文本 requestId 和视频平台任务身份摘要均已持久化。这些证据不外推到未测试模型、参数或媒体类型。

视频 UI 的宽高输入及对应组件回归已实现，覆盖数值保存恢复、清空、边界校验及不改写 legacy 参数。工作区最终验收记录包含 PC Web 冒烟 22 passed，覆盖视频显式宽高的保存恢复与提交；这属于本地交互验收，不证明上游模型接受具体像素范围。

真实视频的前两次调用分别经过一次性授权，均使用单数 `/v1/video/generations` 并返回 HTTP 404；第三次仅在确认 Sub2API 复数契约并重新获得测试凭据后，使用 `legacy-v1` 成功完成创建、查询、下载和归档。三次请求均保留独立证据，未因 404 自动重试或切换协议。

## 尚未验证与支持边界

1. 当前 Helunox/Sub2API 部署的取消、Webhook、幂等/重复计费契约、分组权限细节和指定模型完整参数范围；创建、查询、下载和归档最小闭环已经成功。
2. 真实音频生成、voice 配置及 Worker/DB/S3 归档链路；文本和图片的成功不能代替音频验收。
3. 供应商 Webhook 原始签名、远程取消、幂等期限和作用域、重复请求计费及回调重放规则。稳定 key、429 或网络错误不能证明安全重试。
4. Sora multipart、多参考角色和其他未确认模型扩展暂不支持；新增映射须有正式契约与定向测试，不能用通用 metadata 代替。
