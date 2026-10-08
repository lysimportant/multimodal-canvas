# Yuan 视频调用适配检查点

## 目标与基线

2026-10-08，P1：修复 Yuan 插件已接入 New API，但画布无法调用视频及全能参考的问题。

- Canvas 起点为 `main @ e77928544327d00d5f3ae2fdbfbc7fe89f7beb58`，上游 `origin/main`；New API 为 `main @ 06e25caa06a347d85f990a1558e672a66f4ee50b`，上游 `fork/main`。开始时两仓干净。
- Windows、Node 24.12.0、pnpm 11.19.0、Go 1.26.0；沿用已安装依赖和锁文件，没有数据库、价格、凭据或部署配置变更。
- 实施前核对两仓 AGENTS、New API 插件 API v1 和 `plugins/tasks/yuanliu/plugin.js` 的 `MODEL_SPECS`，以及 Canvas 的模型、模式、冻结输入、Provider 和恢复合同。
- 验收范围是精确型号、参数和参考素材序列化、公共任务查询恢复、非法请求拒绝、PC 参数交互及本地回归。真实供应商生成和现有站点升级另行验收。

## 原因与实现

原画布没有 Yuan 的精确模型合同，模式判定不能开放全能参考；Worker 将素材水合为 Data URL，而 Yuan 只接受 HTTP(S) 地址；API 内存执行没有对应媒体水合路径。New API 的 Canvas 目录又仅声明文字输入，估价沿用通用的 9 图、3 视频、3 音频限制。

- [型号合同](../packages/domain/src/yuanliu-video-contract.ts) 登记插件已有的 13 个精确上游 ID 及固定 `Yuan-` 别名，包括历史 `Yuan-Seedance-2.5-Official`。这不是实时上架声明；LW 和其它未适配的 `Yuan-`、`yl_` 名称明确拒绝，不借用通用生成协议。
- 仅允许 `text_to_video`、`omni_reference`。提示词及显式整秒时长必填，默认清晰度 `720p`、比例 `16:9`；HD 2.0 仅 5/10/15 秒，YL1 仅 30 秒，其余型号采用各自范围。每类参考上限取插件合同，Canvas 总数最多 40 项；不开放首尾帧、编辑、延长或自动时长。
- API 在冻结输入之后、保存 Run 和执行授权之前校验型号、模式、参数和参考数量。字段同义值冲突、非法时长、超限引用及未知组合返回 400，零 Run、零 Provider POST。执行时缺少可用公网签发器则明确失败，不退回 Base64。
- API 与 Worker 共用原有本站 HTTPS 签发器，使用受授权的资产、项目、所有者和冻结版本。API 通过 `getOwnership()` 复核归属，兼容已有项目内 `ownerId=null` 的资产；签名和临时 URL 只用于执行，不写入冻结快照、队列或请求说明。
- Provider 发往 New API `POST /v1/videos` 的正文使用 `model/prompt/duration/resolution/aspect_ratio`，参考位于 `metadata.content` 的 `reference_image`、`reference_video`、`reference_audio`。显式重复输入和不同冻结版本保持顺序；提示词中对同一已连接身份的重复提及沿用既有合并语义。
- 只保存、查询宿主顶层公共 `id`。已有公共任务按冻结合同恢复，原素材失效、旧参数或目录变化不能触发新的创建请求；创建结果未知不自动重发 POST。
- New API 桥接按已定价可执行渠道的实际映射取媒体能力交集，不用公开别名猜测路由；未知、混合或歧义映射保持失败关闭。估价复用真实插件解码，非法 Yuan 参数返回 400，全程不访问供应商。
- Web 复用现有模式菜单、参数选择器和时长控件。打开旧画布不改写字段；用户明确调整时收敛 `seconds/durationSeconds`、`size/video_resolution`、`ratio` 等同义字段。未知参数和旧推理强度须显式移除，离散时长只能选择该型号合法值。节点外框尺寸不随内容变化。

## 安全边界

共享签发器是既有实现的搬移，保留 HMAC、用途隔离、3600 秒 TTL、冻结版本和所有者约束；Worker 原导出继续兼容。地址来源只取服务端配置，不取请求 Host；显然私网、HTTP、凭据和带查询的来源拒绝。

核对 [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) 和 ASVS 5.0.0 的相关边界。回归覆盖篡改、过期、跨用户/资产/版本读取、授权撤销与日志脱敏，不据此宣称整体 ASVS 合规。公网 DNS 和供应商实际读取仍需目标环境验证。

## 本轮验证

| 范围              | 结果                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- |
| Domain / Provider | 完整测试 534 / 999 项通过；两包 typecheck、lint、build 通过                            |
| API               | 完整测试 1333 项通过、108 项跳过；最后仅增强持久画布断言，四套专项 101/101 再次通过    |
| Worker            | 完整测试 890 项通过、28 项跳过；最后补充显式重复引用断言，四套专项 270/270 再次通过    |
| credential-crypto | 完整 14/14 通过；API、Worker、凭据包 typecheck、lint、build 通过                       |
| Web 单测          | 137 个文件、2626 项全部通过；包含参数编辑器及既有画布交互回归                          |
| 其它共享包        | execution 56、observability 21、UI 16 项全部通过                                       |
| 运行产物          | runtime 测试 8/8 通过，API/Worker 的 `dist/server.mjs` 打包成功                        |
| 全仓检查          | build、typecheck、lint 各 9 包全部通过、零缓存；保留既有大 chunk 提示                  |
| PC 浏览器         | 1440×900、1366×768 的 10 项 Yuan 场景全部通过，控制台错误为 0；10 张最终截图已逐张检查 |
| 既有参数合同      | `LJ-Full\|Image2Pro` 浏览器筛选 14 项通过，包含既有 Image2Pro 回归                     |
| New API           | 完整 Go 测试 44 包通过、81 条件用例跳过；vet/build、Canvas 桥接和 Yuan 插件专项通过    |

浏览器验证服务为 `http://127.0.0.1:5187/`，业务请求全部由合成夹具拦截；测试覆盖图片、视频、音频的固定 v3 引用、显式清理旧字段、离散时长、刷新后参数、一次提交及节点尺寸。日志和截图位于 `.local-tests/yuanliu-canvas-20261008/`，不代表已有 8080 站点生效。

Worker 混合场景实际发送图片 v2、图片 v2、图片 v1、视频 v1、音频 v1 共 5 项；4 个冻结对象各读取及签发一次。模拟创建、公共 ID 查询、归档和请求记录保持相同顺序，持久记录不含签名、令牌或媒体字节。

New API 隔离 HTTP 报告为 `D:/newapi/.local-tests/yuanliu/run-1791468938728-81d075/http-report.json`：13 别名创建和轮询、19 非法请求零 POST、未知 503 不重发、内容鉴权和合成结算通过；17 次 POST 均发向回环模拟服务。二进制 SHA256 为 `2523ba936c1ef44146b9e494d8af9aa420c1cbf6e34b44623e1bb600719134c8`，专用进程已停止。

完整九包合计 6489 项通过，另有 runtime 8 项通过；API/Worker 的 136 项设施条件跳过不计为通过，本轮未运行真实数据库、Redis、S3 集成。

最终全仓命令为 `npx --yes pnpm@11.19.0 exec turbo run build --force --concurrency=2`、`exec turbo run typecheck --force --only --concurrency=2`、`exec turbo run lint --force --concurrency=2`。Web、execution、observability、UI 的完整测试采用 `--maxWorkers=1 --no-file-parallelism`；Web 使用 `VITE_API_BASE_URL=http://localhost:3000`，API 使用 `WEB_PORT=5173`，TEMP/TMP 和设施环境隔离。最终 Web 耗时 1048.22 秒，日志 `web-full.log`；构建、类型、格式、runtime 及其余共享包日志同在 `.local-tests/yuanliu-canvas-20261008/`。

初次全仓命令的额外 `--` 将 Turbo 参数传给 TypeScript，因命令格式错误退出；改用上述 `pnpm exec turbo` 后 9 包通过，未修改源码或检查配置。浏览器初次有两个场景将 `auto` 误查为中文选项名称，修正测试定位后全部 10 项通过。最终源码没有因此降低型号约束。

## 交付与恢复

- 本轮属于两仓配套修复，本地实现与检查已完成。交付引用为 Canvas `origin/main` 和 New API `fork/main`，使用中文附注 Tag `v2026.10.08-yuanliu-canvas`；具体提交和同步状态以该 Tag 及远端分支核验为准。
- 部署需同时更新 Canvas Web/API/Worker 与 New API，并核对有效 `yuanliu` 插件、渠道映射和已有管理员价格。本站素材签名需 API/Worker 使用一致的网站 HTTPS 来源和密钥；源码推送或本机构建不会自动更新已有容器。
- 回滚时停用 Yuan 新建并保留在途公共任务 ID，回退本轮两仓应用提交并重建；不删除渠道、任务、价格、历史素材或数据库。没有数据迁移。
- 真实供应商读取本站冻结素材、各型号实际受理和成片、最终费用及目标部署仍未验收。保留 `TODO-CONSOLIDATED.md` 的 P1-02/P1-03，不重复发送历史未知请求。
