# 节点拖动、首次 4K 与输入区域检查点

## 范围与基线

2026-09-30（Asia/Shanghai），P1：指定项目拖动性能与首次 4K 下载异常；P2：桌面输入区加高。完成本地优化、回归及部署；真实首次低像素的上游原因仍未确认，不以提示文案代替生成链路修复。

- 分支 `codex/generate-to-new-node`，起点 `390c7470142aa6bc8a7e70e870b259bf7958beb3`，上游 `origin/codex/generate-to-new-node`。
- Node v24.12.0，pnpm 11.19.0，Git 2.53.0.windows.1，依赖已安装；无根 README 或适用本地 AGENTS，遵循会话规则。
- 保留并排除用户原有变更：index.css 底部胶囊 z-index、CanvasNodeToolbar.test.tsx 对应测试及删除 docs/resource-input-compatibility.md。
- 不修改节点、图片、历史 Run 或数据格式；不重放旧任务、不插值放大、不自动补发收费请求。初始项目 revision 705、24 节点、13 连线、44 个 Run，无在途任务。

## 已完成修改

- 拖动时复用未变化的批次 Context、稳定节点动作回调并读取最新提交状态；连线路径按几何缓存，流星长度测量合并到绘制帧。
- 节点信息显示解码后的原图实际像素、当前设置及原始文件下载方式。结果切换不沿用旧尺寸；同图重复加载不重复更新。
- 不足所选像素时提示；stale 结果明确写“当前原图…；当前设置…（待更新）”，不把当前设置冒充历史请求。运行中与手动替换图不误报，下载仍保留原字节。
- 桌面快速输入区初始高度 145→180px，手动拉伸上限 180→240px；保留文本内部滚动、低高度桌面的面板滚动和移动端原布局，内容不得撑大节点外框。

## 现场证据与边界

- 节点 14：Run c5e93f44-d831-4242-ac82-a4e18e640544，资产 3e3778e3-8363-440c-80b1-3e09553988f4。原始 PNG IHDR、归档元数据及浏览器 naturalWidth/naturalHeight 均为 **1672×941**，原文件 1,870,170 字节；不是下载时才变小。
- 节点 13 首次 Run 198ba584-4aae-4b0e-adff-24d460c9f2fa 为 **1672×941**；第二次 Run 117865b0-55cf-4928-a50e-705ad069d2e2 为 **3840×2160**。
- 三次冻结参数均为 resolution=4k、aspectRatio=16:9；精确模型 gpt-image-2.5-sunburst，合同 openai-images，POST /images/generations#1、0 引用资源。
- 已部署 Worker bundle 含 4K→3840 与 size 映射；离线首次/再次调用均构造 size=3840x2160。归档原字节及 SHA-256 不变，缩略图独立保存。
- 历史完整请求体/原始供应商响应不可用，不能断言供应商忽略参数，也不能排除历史响应同时携带不同像素的 URL/base64。**未声称修复生成端首次 4K 异常。**

## 用户授权的渠道测试

2026-09-30 23:48:31（UTC+8），使用用户临时提供的测试 key；密钥只在进程内用于请求，不写源码、配置或报告。

1. GET `https://api.lolicon.beer/v1/models` 返回 200，13 个模型中没有精确 ID `gpt-image-2.5-sunburst`；未替换其它模型。
2. 按用户指定模型仅发送 **1 次** POST `https://api.lolicon.beer/v1/images/generations`。非秘密请求头：`Content-Type: application/json`；`Authorization: Bearer [REDACTED]`。

请求体：

```json
{
  "size": "3840x2160",
  "model": "gpt-image-2.5-sunburst",
  "prompt": "Create a highly detailed wide landscape photograph of a quiet alpine lake at sunrise, with mountains, pine trees and realistic reflections. Landscape composition, 16:9 aspect ratio. No text, logos or watermarks.",
  "n": 1
}
```

- HTTP **503**，error.code 为 **model_not_found**：default (distributor) 分组没有该模型可用渠道。
- x-oneapi-request-id：`202609301548319276026448268d9d6jx0qbmTv`。
- 未返回图片或任务/查询/下载地址；未自动重试；费用字段未返回，费用未知。该响应不能用于判断 4K 产出。
- 脱敏响应保存在被 Git 忽略的 `.local-tests/image-4k-authorized-response-20260930.json`。
- 此次记录保留为分组调整前的历史证据；后续进度见下一节。保留旧 Run，不以重复生成掩盖首次行为。

### 分组调整后的复测

2026-09-30 23:58:10（UTC+8），用户确认已修改分组，并允许请求失败时再请求第二次。本次最多获准 2 次创建请求，实际仅发送 1 次。

- GET 同一模型目录返回 200，模型数量从 13 变为 45，已列出精确模型 gpt-image-2.5-sunburst，supported_endpoint_types 为 image-generation、openai；这不等于上游已经成功生成。
- POST 沿用上一节相同 URL、非秘密请求头与完整 JSON 体，size=3840x2160、n=1，无图像引用，未更换模型或降低尺寸。
- 返回 HTTP **403**，error.code 为 **pre_consume_token_quota_failed**。接口报告当前 key 额度 **¥1.000000**，本次需要预扣 **¥2.187500**；这是预扣门槛，不是已发生的费用。
- x-oneapi-request-id：202609301558110072525338268d9d66TqgU4R5。
- 没有返回图片、任务 ID、查询或下载 URL；没有实际费用字段。额度不变时重复请求不能排除这一阻塞，因此未使用第二次请求机会，未自动充值或修改 key 设置。
- 脱敏请求与响应保存在 .local-tests/image-4k-recheck-20260930/report.json；密钥只用于进程内请求，随后清除，未写入报告或仓库。
- 下一步：由用户提高该 key 可用额度以满足预扣门槛，再继续真实 4K 验证。仍需核对原始响应中的 base64/URL 与实际像素；首次低像素的生成端原因保持未确认。
- 本次不修改产品代码或部署；仅同步检查点及未完成事项。验证范围为文档格式、脱敏检查与 Git diff，不把上一轮代码测试当成本轮重新执行。

## 新节点首次生成的端到端证据

用户随后要求直接在当前项目新建一个节点请求，以实际结果为准。按这一授权，通过项目原有的 gpt-image-2.5-sunburst · GPT_Image_4k 配置新建 **图片生成节点 16**；不替换项目凭据、不改旧节点、不覆盖旧结果。它与前述临时测试 key 的直连接口测试分开记录，不据此推断临时 key 额度已调整。

- 节点 ID：node_image_generate_e79e7d94-ddce-4e8e-9e1f-cf7fbd65a3f8。
- 首次 Run：62edb712-5a51-4a93-a3a9-8286584ae6fc；创建于 2026-09-30T16:05:11.704Z，完成于 2026-09-30T16:06:27.250Z，状态 SUCCEEDED，界面耗时 75 秒。
- UI 已确认 4K、16:9、1 份、请求像素 3840×2160；冻结快照同样为 resolution=4k、aspectRatio=16:9。使用上一节英文合成风景提示词，无图像引用。
- 本轮只点击一次“生成”；收尾查询该节点只有 1 个 Run，该 Run 只有 1 条请求记录，attempt=1、POST /images/generations#1、sendStatus=sent。此计数不推断供应商内部调度行为。
- 结果资产 3f09f733-30fa-4315-b074-ecd089a840c5，版本 1。浏览器解码及下载 PNG 的 IHDR 均为 **3840×2160**；文件 **13,061,142 字节**。
- 下载文件 SHA-256 为 baaf81f8bc6d01633f0f2d67b077a387d7247758cf09a5709cf7aace71b66913，与 Run 中归档原图记录完全一致，无缩放或转码。
- 内嵌浏览器的常规下载事件监听超时，界面未出现下载错误；随后通过同一节点原图元素的下载接口保存原文件到用户 Downloads/content.png，并完成字节数、像素及哈希比对。未把事件监听超时当作生成失败，未再次生成。
- 证据目录：.local-tests/new-node-4k-proof-20260930，含 run-result.jsonl、download-verification.json、node-16-first-run-original.png 及 node-16-first-run-proof.jpg。目录名按本次记录的 UTC 日期命名；不将大图或凭据提交 Git。
- 节点 16 与其结果保留在项目中，节点信息窗口显示实际像素与当前设置均为 3840×2160；浏览器无 console error。

结论：**当前项目新节点第一次生成即可得到真实 4K 原图，保存的图片与归档文件字节一致。** 本次未复现旧节点 14 的低像素首次结果；不能由一次成功推出历史问题已永久解决，旧 Run 的上游原始响应缺失仍保留为未结项。

## 性能与验证

确定性回归：48 节点、12 次位置更新的节点探针渲染 **576→12**，非目标节点 **564→0**；10 连线、12 次更新的路径计算 **120→12**；同帧 12 次路径变化的长度测量 **12→1**。这些是调用次数，不等于现场 FPS。

同机 Chromium 生产构建、100 节点/99 连线/100 成员组：优化前 groupDrag median 5079.37ms，优化后三轮为 2717.09、3901.73、3736.36ms；最后一轮 p95 4250.72ms（基线 5174.27ms）。负载有波动，报告所有轮次，不把最优值当稳定收益；该指标含 Playwright 输入过程，不是单帧耗时。证据在 `.local-tests/canvas-drag-before.log`、`canvas-fixes-e2e.log`、`canvas-fixes-final-browser.log`、`canvas-fixes-verified-browser.log`。

- Web 全量：94 文件、1485 项通过；Provider 全量 733 项、Worker 归档相关 221 项通过，新增 4 项首次/再次、base64/URL 保真回归。
- 最终根 `pnpm lint`、`pnpm typecheck`、`pnpm build` 均通过；两个改动 E2E 文件单独严格 TypeScript 检查通过。
- 最终桌面 E2E **14/14** 通过，覆盖悬浮预览、完整编辑器、参数保存/刷新、下载字节相等、180px 输入高度、长内容内部滚动、外框不变及底部按钮可到达。另有 100 节点性能用例通过。
- 修复 E2E 的过时夹具和选择器；完整编辑器悬停先等待动作稳定再读取坐标，避免入场动画导致坐标失效。早期失败不记为通过。
- 已检查 1920×1080 与 1366×768 截图；8080 实际节点 14 显示“当前原图 1672×941；当前设置 3840×2160（待更新）”，浏览器无 console error。
- Windows esbuild 临时文件偶发 Access is denied：仅本进程 TEMP/TMP 指向 `.local-tests/build-tmp` 后重跑，最终构建通过；已恢复环境，不改项目配置、不安装依赖。

## 本机部署与恢复

- 仅重建并更新 Web：`docker compose build web`；`docker compose up -d --no-deps web`。六服务均 healthy，API、Worker、Postgres、Redis、MinIO 的容器 ID 与基线相同。
- 回滚快照 `multimodal-canvas-web:before-drag-fix-20260930`，镜像 `sha256:b07f32a1325d1cff7e1bb6fd89c8575a927f18d9e03c28248b4a6320d21e2f36`。需要回滚时保留当前镜像，再将快照标记为 compose 的 Web 镜像并仅重建 Web；无数据迁移或数据回写。
- 收尾只读核对时，现场已有并行活动：revision 708、25 节点、13 连线、46 个 Run（17 FAILED、29 SUCCEEDED）。不把现场活动改回基线，也不将这些 Run 记为本轮测试创建；本轮直接 API 测试不进入应用数据库。
- 自建 5188 测试预览已关闭，保留用户 8080 服务。最新成功验证命令与日志：`pnpm build` / `.local-tests/canvas-fixes-build-final.log`；桌面验收 / `.local-tests/canvas-fixes-desktop-final.log`。
- 本轮交付分支 `codex/generate-to-new-node`，版本标记 `v2026.09.30-canvas-drag-image-pixels`；Git 提交及远端核对结果由交付回复记录。上游首次低像素原因继续留在 TODO，不记为已完成。
