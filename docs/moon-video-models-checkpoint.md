# Moon 新视频型号映射修复

日期：2026-10-07。P1，承接 TODO-CONSOLIDATED.md 的 P1-02。

## 问题与验收范围

8080 本机画布中，用户指定的“视频生成节点 2”使用 `sd2-930-fast`、全能参考、9 秒、720p、16:9，并连接一个冻结图片版本。Canvas 的精确模型表没有该 ID，因此请求在供应商创建 POST 前被拦截。失败运行没有平台任务 ID。另一个节点使用的 `grok-v1.5-video` 也不在旧模型表内。

目标是按照 `D:/newapi/plugins/tasks/moon/plugin.js` 的现有正式映射补齐 Moon 底价 Seed、PT、2.5 official 与 Grok 型号，同时对齐 Web 参数、API 冻结版本、Provider 输入预检和 Worker 素材传输。不能将不同系列简单作为旧 Seedance/Grok 的别名；未知型号、超限素材和未确认模式保持拒绝。

验收包含精确型号矩阵、真实插件桥接的离线组合校验、冻结素材 URL 回归、PC 浏览器 Mock 冒烟及 lint/typecheck/test/build。范围不含付费生成、线上 New API 部署、创建公网存储或修改用户节点、正文、素材、数据库格式。

## 基线与恢复

- 仓库：`G:/multimodal-canvas`，`main @ 77e3da8`，上游 `origin/main`，开始时工作树干净。用户当前聊天目录 `G:/novel-studio` 的已有资料移动与删除不属于本次任务。
- Node 24.12.0、pnpm 11.19.0，使用既有锁文件与依赖，不新增依赖。
- 定向基线：domain `src/index.test.ts` 68 项、Provider `src/video-contract.test.ts` 121 项通过。
- 首轮全量测试因系统临时目录 `EPERM` 失败；改用本任务 `.local-tests/moon-video-models/tmp` 并显式透传环境重新运行，不改用户环境配置。日志保留在忽略目录 `.local-tests/moon-video-models/`。
- 修正临时目录后的基线：Domain 382、Provider 768、Worker 784、API 1197 项通过，Worker/API 分别保留 28/108 项设施跳过；Web 高并发基线有 20 项失败（以超时为主），并出现 SkillWorkbench 测试期间的派生异常。最终检查限制 Vitest 并发，单独确认是否为既有负载问题，不以该基线冒充通过。
- 本机 Compose 项目为 `multimodal-canvas-app`。当前 `NEW_API_VIDEO_CONTRACT=newapi-video-v1`，`S3_PROVIDER_ENDPOINT` 为空。新 Moon 参考输入要求供应商可访问的 URL；字段修复不等于已具备公网素材配置，也不等于真实成片验收。用户确认尚未创建 OSS。

## 执行检查点

- [x] 只读核对指定节点、精确目录型号、失败阶段与实际容器代码，确认原因是新增型号未接入 Canvas。
- [x] 补齐共享合同、Provider、Web 和 Worker，执行定向回归。
- [x] 完成 lint/typecheck/build、全仓测试覆盖及失败项复验、本机 PC Mock 冒烟；测试执行差异见下方。
- [x] 保留原镜像后更新本机 API/Worker/Web，核验健康状态和用户项目数据保持不变。
- [x] 检查最终差异、格式和新增内容的凭据模式；以本检查点所在任务提交及 `v2026.10.07-moon-video-models` 附注 Tag 交付 `origin/main`。

阶段证据：Worker 冻结素材 73 项、API 冻结版本与提及 51 项通过。PT 引用音频也需保存选定版本时长，因此 API/Worker 沿用已有可选时长字段补齐音频传递，不新增数据库字段。离线跨插件矩阵实际调用 Moon 1.6.0 的 `decodeRequest` 与 `buildSubmitRequest`，118 个组合通过，HTTP 请求数为 0；覆盖新型号及原 Seedance、Wan、H3 的兼容组合。

## 型号与素材边界

新增精确型号共 14 个：`sd2mini`、`sd2-930-face`、`sd2-930-fast`、`sd2-930-no-face`、`sd2.5-30-10-face`、`sd2.5-30-10-10-480`、`sd2.5-30-10-10`、`sd2.5-30-10-10-per-request`、`seedance2.0-9-3-3-PT`、`seedance2.5-30-10-10-PT`、`seedance2.0-fast-PT`、`seedance-2-5-official`、`artsdance-2-0-pro-260801`、`grok-v1.5-video`。合同取自本地 New API `ac5ae9c91` 的 Moon 1.6.0；未确认目标线上插件版本。

- `sd2-930-fast` 支持 720p、5–15 秒、9 图/3 视频/3 音频；Face 与 PT fast 的视频引用限制单独保留。
- 新 Grok 支持 720p/1080p、4–15 秒和最多 7 张参考图，不开放尾帧、视频或音频引用；不能套用旧 `grok-imagine-video-1.5` 合同。
- PT 的参考视频与音频按选定版本逐项校验 2–30 秒，无文档依据的总时长限制不额外添加。
- 没有实现映射的模式在 Web 明确禁用；Worker/Provider 仍在外发前独立校验，不能只依靠按钮禁用。现有 API 冻结版本后受理入队，素材数量/组合的权威合同检查仍发生在 Worker/Provider，直接调用 API 的非法组合可能先收到 202 再失败；提前到 API 返回 400 的通用预检不属于本次映射修复。

第三方 OSS 不是必要条件。现有 Worker 可使用自建 MinIO/S3 的公网 HTTPS 入口，通过 `MC_S3_PROVIDER_ENDPOINT` 生成限时签名 URL。自建后端也可以按冻结资源版本提供签名素材接口，但当前普通素材接口依赖用户鉴权，不能直接拿给远端模型；这种后端代理需要单独实现和验证。两种方案都必须允许供应商在有效期内读取实际媒体内容，不能使用 localhost、Docker 内网地址或需要网页登录的链接。

本次不迁移数据库，不覆盖用户画布，不重试原失败任务。更新本机应用仅替换 API/Worker/Web 代码，保留数据卷；回滚使用更新前镜像标签。公网素材入口未配置期间，相关参考生成仍须明确失败，不能把本机地址或 Base64 当成供应商可读取的 URL。

## 最终验证与本机更新

- `pnpm exec turbo run lint typecheck build --env-mode=loose --concurrency=2`：27/27 任务通过，包含本轮生成的缓存结果。`pnpm build:runtime` 通过。Web 构建仍有既有的单块超过 500 kB 提示。
- 全仓测试使用任务临时目录、`WEB_PORT=5173`、`VITE_API_BASE_URL=http://localhost:3000`。非 Web 全套通过；最终 Domain 402、Provider 782、Worker 798、API 1198 项通过。Worker/API 的 28/108 项设施跳过保留，不能当作真实设施验收。运行产物测试 8 项通过，其余共享包测试通过。
- Web 全套首轮 2441 通过、6 失败：2 项新增测试的选项名称匹配过宽，已改为前缀匹配；4 项既有重交互用例超过 5/15 秒。3 项在单 Worker、原超时下通过，Skill 工作台用例在 15 秒阈值下通过。最终 NodeQuickEditor + SkillWorkbench 两个完整文件 253 项通过（单 Worker、15 秒阈值），其余失败项逐项复验通过。没有修改无关业务代码或持久化测试超时配置，也不将首轮 `pnpm test` 描述为一次全绿。
- `WEB_PORT=5179` 的 Playwright Mock：1/1 通过，分别提交 `sd2-930-fast`、`grok-v1.5-video` 并拦截全部 API；未知型号禁用且不提交。控制台/pageerror 为 0。已检查 PC 截图，测试没有使用用户的 8080 项目。
- Moon 1.6.0 实际插件的离线请求矩阵最终 118/118，通过 `decodeRequest` 到 `buildSubmitRequest`，真实 HTTP 请求 0。新底价系列错误的 `@imageN` 在 Provider POST 前拒绝，合法 `@图片N` 原文与素材顺序保留。
- 本机更新前核对活动 Run 为 0；为 API/Worker/Web 保存 `before-moon-models-20261007` 镜像标签，再仅替换三个应用代码镜像。三个服务均健康，`http://localhost:8080/health` 为 200，API/Worker/Web 的容器产物哈希与本轮构建一致。
- 更新前后用户项目全部节点行摘要一致；原失败 Run 仍为 FAILED、平台任务 ID 为空，未重试。API/Worker 启动日志没有严重错误。认证后的用户项目交互和真实成片未执行。

回滚入口：将 `multimodal-canvas-api/worker/web:before-moon-models-20261007` 分别重新标记为对应服务的 `:local`，保持现有配置后用 `docker compose up -d --no-deps --no-build --pull never api worker web` 重建三个应用容器。须先核对活动 Run；不删除数据卷、不运行迁移。

外部待验事项仍为：供应商可访问的素材 HTTPS 入口、目标 New API 的 Moon 插件版本、获得付费范围授权后的真实生成及归档。自建存储/代理可满足素材要求，不需要购买第三方 OSS。
