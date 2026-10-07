# Image2Pro 画布调用适配检查点

## 目标与基线

2026-10-07，P1：修复 Image2Pro 已接入 New API 插件而画布仍阻断生成的问题，贯通精确模型识别、模式、参数、图片参考、公共任务轮询和结果归档。

- Canvas 起点为 `main @ 9255735`，上游 `origin/main`；New API 为 `main @ e8b93c77a`，上游 `fork/main`，两仓工作区均干净。
- Node v24.12.0、pnpm 11.19.0、Go 1.26.0；沿用现有依赖及锁文件。
- API 基线：`newapi-run-executor.test.ts` 与 `credential-model-catalog.test.ts` 共 11 项通过；Provider 基线 `video-contract.test.ts` 与 `resource-reference-order.test.ts` 共 160 项通过。
- 已在实现前双边核对两仓 AGENTS、New API `plugins/tasks/image2pro/plugin.js`、插件合同测试、Canvas 领域/Provider/API/Worker/Web 入口。新增适配不改变数据库及已有 Run 的冻结合同；回滚本次代码并重建即可，已经提交的公共任务 ID 仍按原路径恢复。
- 保留此前节点、连线及固定输入高度修复，不部署、不迁移用户数据、不调用收费上游。

## 合同边界

- 只识别 `无限制-Flash-中配-Video`、`无限制-Flash-MAX-Video`、`Seedance2.0 0.9r`，不按名称相似度扩大能力。
- 复用 `newapi-video-v1`：`POST /v1/videos`，`GET /v1/videos/{公共任务ID}`；不得保存插件上游的私有任务 ID 代替公共 ID。
- 文本与普通图片参考已确认；最多 9 张图片，不能当成首尾帧。音频、视频引用仍需上游支持证据，不凭插件兼容字段开放。
- 插件接收 `duration/seconds`、`ratio/aspect_ratio`、`images`，不接受 `resolution`、`quality` 或 `size`。Canvas 内部参数需显式映射；历史不兼容值须提示移除，不能静默忽略。
- 秒数允许正有限小数且不超过 3600；3600 是宿主安全边界，不是实际供应商成片时长保证。比例仅有非空、长度与控制字符约束，无已确认的供应商比例全集。
- 创建结果未知时保留提交状态，不重发收费 POST；恢复已有任务不重新检查原素材是否仍可用。

## 实现与回归

- Domain 共享三个精确型号的模式与参数合同，Web/API/Provider 均复用；模型目录缺少媒体声明时按精确 ID 补视频分类，保留账号目录自己的合同及授权。
- Web 不再向 Image2Pro 默认写入清晰度或推理强度；新建默认 5 秒，可逐键输入小数秒及自定义比例。旧参数保留并列出原值，用户点击“移除不支持的参数”后保存；刷新不会补回不支持字段。
- API 在冻结素材版本后、创建 Run/执行授权前校验参数、模式和参考数量。本地执行路径补齐 Image2Pro 图片提及/连线读取，保持取消及素材授权复查；持久快照不写 data URL。
- Provider 只发 `model/prompt/duration/ratio/images`，只接受宿主顶层公共 `id`，查询核对同一身份；新建结果未知不重发 POST，已受理任务不因旧参数或原图失效阻断查询。
- Worker 复用既有图片 data URL 水合和结果归档；专项验证冻结 v2、5.5 秒、公共 ID 查询及成片 URL 传给归档器。初轮合同回归通过，但未覆盖有效 Full-HD 图片的完整 data URL；后续发现的插件校验超时见下方 2026-10-08 记录。

| 验证      | 本轮结果                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Domain    | 全量 445 项通过                                                                                                                        |
| Provider  | 全量 815 项通过，含 24 项 Image2Pro 专项                                                                                               |
| API       | 原执行/目录基线 11 项通过；相关专项 151 项通过；最终 Image2Pro HTTP/预检/本地资源授权及恢复 20 项通过；模型目录与超时 19 项通过        |
| Worker    | 冻结素材、输出规范化和归档三个文件 278 项通过                                                                                          |
| Web       | 编辑器 240 项通过；App/WorkflowCanvas 198 项通过                                                                                       |
| 浏览器    | 1440×900 的 4 项 Image2Pro 冒烟通过；最终提示布局调整后文生视频再验通过，无控制台错误、未知网络或真实生成请求                          |
| New API   | `go test ./plugins -run '^TestImage2ProVideoContracts$' -count=1` 通过，真实 JS 插件引擎解码/查询/呈现样例，不访问收费上游             |
| 运行产物  | `pnpm test:runtime` 8 项通过                                                                                                           |
| 类型/构建 | `pnpm typecheck -- --force --only --concurrency=2`、`pnpm build -- --force --concurrency=2` 均 9 包通过、无缓存；保留既有大 chunk 提示 |

API 本地引用最初复现“Worker 未提供冻结版本内容”，添加视频图片水合后通过；旧 resolution 最初被受理为 202，加入 Run 前校验后明确 400 且零 Provider POST。格式检查曾在并行编辑测试文件时失败，按包重新格式化后通过；最终 `pnpm lint -- --force` 9 包通过、无缓存，文档 Prettier 与 `git diff --check` 通过。Web 首次单独构建遇到 Windows 临时目录删除权限错误，改用任务专属 TEMP/TMP 后通过；最终全仓构建也通过。

## 2026-10-07：初轮交付边界

尚未进行付费上游请求或目标生产验收，不宣称所有合法秒数/比例都能在上游成功成片。`TODO-CONSOLIDATED.md` 保留真实验收与音视频扩展任务。

本机 `http://localhost:8080` 是已有的 `multimodal-canvas-app` Docker 运行栈；源码与本机 `dist` 构建不会自动更新该容器。当前页面仍引用 `/assets/index-DL3lZr_f.js`，本轮构建产物为 `/assets/main-DmKGvrXV.js`。已分别完成 Web、API、Worker 镜像构建，标签为 `multimodal-canvas-{web,api,worker}:image2pro-20261007`，日志在忽略目录 `.local-tests/image2pro/`。

当前没有替换运行容器、执行迁移或修改其数据。实际更新需保持当前环境、回调与挂载，只替换这三个服务镜像，不启动 migrate 或初始化设施。原容器镜像仍保留，可用于回滚。按用户提供的生产操作规则，部署需要单独确认，不能把镜像已构建说成 8080 已生效。

## 2026-10-08：Flash-MAX 大图校验修复与本地联调

P1：落实已复现的插件校验超时，启动两个项目的隔离测试栈，区分本地调用链与供应商成片验收。恢复基线为 Canvas `main @ 1b9741c`、New API `main @ e8b93c77a`，两仓跟踪工作区均干净；沿用 Node 24.12.0、pnpm 11.19.0、Go 1.26.0 和现有依赖。

### 缺陷与修复范围

- 同一张有效 1920×1080 PNG 为 6,224,691 bytes，data URL 为 8,299,610 字符。Canvas API 本地水合和 Worker resolver 均按冻结版本读取，Provider 正确发送 `model/prompt/duration/ratio/images`，图片在默认 50 MiB 限制内。
- 原 Image2Pro 1.0.0 的 `isHTTPURL` 在判断协议前逐字符扫描整个 data URL。真实 Sobek 默认 5 秒期限中断，宿主 Pin/Prepare 返回 400 `Invalid task protocol request`；该前置拒绝不写使用日志，不代表请求没有到 New API。
- New API 插件 1.0.1 先判断 HTTP(S) 前缀，非 URL 不再执行 URL 字符扫描；保留凭据、控制字符、反斜杠及格式拒绝。没有增加超时、放宽 Base64/MIME 校验或改变字段、模型、计费合同。Canvas 无需再次调整序列化。
- 同图真实 Pin/Prepare 由原版 5,069 ms / 400 转为修正版 530 ms / 204。这个 204 是测试终点，不是供应商已生成视频。
- 回归写入现有 `plugins/image2pro_video_test.go`，测试内生成有效 Full-HD PNG，在默认期限下验证视频与 Responses 两协议解码、提交完整保留图片，并覆盖不安全引用及下载地址拒绝。

### 真实供应商结果

用户授权的本机直连使用 `https://api.image2pro.top/v1`，实时 `/models` 返回 200 且包含精确 `无限制-Flash-MAX-Video`。5 秒 / 16:9 的中立文生视频、普通参考图各提交一次，均返回 HTTP 502“视频任务失败（积分已退还）”，没有任务 ID；保留未知创建状态，没有自动重发或试跑其它型号。

官方示例为 `POST /v1/videos`，`duration:5`、`ratio:"16:9"`；幂等键支持正文 `client_request_id` 或请求头 `Idempotency-Key`。本轮使用请求头不构成缺字段。官方将视频 502 描述为提交上游失败；未公布 Flash-MAX 专属合法时长集合或参考图大小上限，供应商内部原因仍未知，不能用插件修复宣称其已解决。

### 本轮验证与运行边界

- `go test -mod=readonly ./plugins ./pkg/jsplugin ./middleware -count=1`、上述三包 `go vet`、插件 oxlint/oxfmt、Go 格式与差异检查通过；Linux/amd64、CGO=0 的宿主构建及专用 Docker 镜像构建通过。
- Canvas Provider Image2Pro 24 项、API Image2Pro/本地引用 20 项、Worker Image2Pro 1 项通过；Worker 同文件另 82 项未选中，不记为全量通过。
- 隔离 Compose 项目为 `mc-acceptance-test-image2pro-20261008`，使用新建专用卷、数据库、队列和合成账号，本地替身不转发真实供应商。数据库迁移只作用于新测试库；现有 `multimodal-canvas-app` 的 8080 服务与数据保留。回退仅停止专用测试栈，不删除卷或改动原服务。
- 新 API 镜像为 `forknewapi:image2pro-fix-20261008`；Canvas 三个服务使用已构建的 `image2pro-20261007` 产物。Web 入口 `http://localhost:8082`，New API 回环管理入口 `http://127.0.0.1:13010`，issuer `https://newapi.localhost:13443`。入口及健康检查、真实网页登录、授权回调和三个模型同步通过；有效插件为 factory 1.0.1，无数据库 override。
- `node .local-tests/image2pro-local-stack-20261008/e2e.mjs` 最终 6 项检查通过，1440×900 浏览器页面/控制台错误为 0。文生视频和上述原 Full-HD 图片 Run 均贯穿真实 API、Worker、New API 插件及 MinIO，完成公共任务查询、归档和内容读回；替身解码的图片字节数、SHA256 与原图一致。两份归档各为 2,326 bytes，SHA256 为 `b699fb045fedcc2e932ed65f2059c657ab0c18a5b6fcefc5813cc871f2d2ca6f`，是固定测试 MP4，不代表真实供应商成片。
- 本地替身累计 3 次创建 POST：首次 HTTP 素材地址导致已知归档失败，保留原 Run、独立失败报告和素材结果，没有重提交或改写业务数据；改为隔离 Caddy HTTPS 素材地址后，新文生用例和 Full-HD 用例各创建一次并成功。成功两例的上游 `Idempotency-Key` 与对应 New API 公共任务 ID 一致；Worker 仍为原 production 配置，没有放宽归档安全校验。
- 初始 `internal` Docker 网络使本机端口未发布，补充仅 Web/Caddy 使用的入口网络后恢复；New API、API、Worker、替身仍仅在隔离内网。专用栈保持运行，现有 8080 六个常驻服务仍 healthy。
- 新 CA 仅供隔离测试，未修改系统信任；浏览器测试如显式忽略测试证书错误，不能作为生产 TLS 验收。运行及脱敏结果保存在忽略目录 `.local-tests/image2pro-local-stack-20261008/`，真实直连报告在 `.local-tests/flashmax-real-api-20261008/`。

线上 `love.lolicon.beer` 尚未更新。数据库 override 可覆盖内嵌 factory，更新宿主后仍须核对有效插件为 1.0.1；本地修复与测试不能证明线上生效。生产更新及真实成片验收继续保留待办。
