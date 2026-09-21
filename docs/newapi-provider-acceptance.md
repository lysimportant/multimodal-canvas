# Provider 当前合同与验收边界

更新时间：2026-09-21。本文承接已删除的收费/多连接/价格同步文档中仍适用的合同与未完成项。用户已明确本次仅完成本地测试；本文的本地 Mock 与跨容器素材证据用于本次验收，目标环境和真实付费调用留作后续，不要求当前部署线上 New API。当前身份接入证据见[实施检查点](newapi-account-implementation-checkpoint.md)，更广泛的供应商任务见[待办汇总](../TODO-CONSOLIDATED.md)。

## 精确模型与素材

- `MiniMax-H3 → h3` 保留原 New API 渠道映射。Hailuo 1.1.4 对映射后的 `h3` 使用 H3 `/v2` 协议；Canvas 保留对外精确 `MiniMax-H3`，未知别名、未声明或混合渠道不能猜测能力。
- `wan3.0-video` 与 `wan3.0-video-prime` 使用 `newapi-video-v1`，Canvas 创建端点为 `/v1/videos`。不同实际插件/渠道的输入限制独立验证，不能以 H3 的规则套用 Wan。
- H3 已有图片/视频/音频引用与首尾帧的映射回归。上游目录按实际可执行且有定价的渠道能力取交集；同一冻结资产版本去重，不同版本保留，首尾帧与参考模式互斥。
- 真实外部供应商必须能读取同一冻结版本的素材 URL。按具体部署设置外部可达的对象入口并验证短期签名 GET；本机 localhost 地址成功不能证明外网可达。
- Hailuo、Moon、Doubao 等插件的实际生效版本必须在目标环境重新核对，上传插件可能覆盖工厂版本。Moon Wan3/Seedance 与小写 `minimax-h3` 的后续合同仍见 `next.md`，不得用此前版本号代替当前核对。

## 执行、费用和恢复

- 新任务只有 New API 计费；Canvas 持久保存执行授权、Run/outbox、逐节点凭据版本和发送意图。保留 Provider 原请求、轮询请求、上游任务身份，未知创建结果不重复 POST。
- 取消只保证本地停止后续工作；供应商实际取消和退款没有通用保证。未返回费用时保持未知，不能伪记为零或以补发获取费用。
- 每次调用只支持单个交付结果，`n != 1` 明确拒绝。批量任务是独立授权的逻辑调用。
- 对原失败 job 的恢复可能首次执行尚未发送的 DAG 下游；只有所有节点已归档或有持久取消意图时，才可要求恢复零新增 POST。长期数据库故障仍需外部监控，不能依赖数据库中的恢复记录本身。
- 已补齐 `POST /v1/runs/:runId/recover`：仅接受空对象，复用原 Run、授权、快照和发送身份；已发送/结果不明项拒绝自动重发，成功任务不再投递，取消只做本地收尾，跨用户访问返回 404。集成恢复 14/14、HTTP/运行/限流 82/82 通过。

## 本地 Docker 验收（2026-09-21）

以下生成、归档和恢复结果属于重置前的历史验收。用户随后要求彻底清空旧本地数据；当前 `canvas-newapi-local` 已从空卷初始化，只保留新账号、分组和免费 Mock 配置，项目/素材/任务均为空。旧素材地址已验证为 404，本轮没有重新生成；删除和最新登录验收见[实施检查点](newapi-account-implementation-checkpoint.md)。

用户确认先完成本地验收、暂不产生真实费用。重置前的独立部署为 `canvas-newapi-local`，Canvas `http://localhost:8080`、New API issuer `https://newapi.localhost:13443`。15 个接入组、75 条模型目录和五模型归档读取均通过，详见[实施检查点](newapi-account-implementation-checkpoint.md)。五条实际渠道均只指向本机 Mock，模型配置价格全部为 0；这里不使用线上 `test` 的 Key 生成。

新部署的 H3 曾因本地证书缺少素材域名 SAN、随后下载端口配置类型错误而失败。最终以字符串数组 `["8081"]` 配置端口，并白名单限制 Mock 域名与单个 Docker IP；SSRF 保持启用。原 Run `run_idem_6bae53cade2730911f3b69c2c9b15661f7aaedffa6ad0be605d8d0e27ef21277` 和上游 `task_JysK7tsI2la52SMM5sIovCqM8VuY6cIZ` 恢复归档，额外创建 POST 为 0。两次早期失败保留；报告 `local-docker/h3-recovery-results.json` 与 `local-docker/verification-results.json` 位于 `.local-tests/newapi-account/`。后续只读下载复核不再创建任务。

此前首批独立合成用户通过 Canvas → New API 授权后，五个目录项均可调用。以下场景均完成 API 提交、Worker 执行、归档和授权下载；每个场景的供应商创建 POST 为 1 次。

| 精确模型             | Canvas 合同               | 本轮输入                   | 归档内容             |
| -------------------- | ------------------------- | -------------------------- | -------------------- |
| `canvas-media-text`  | `openai-chat-completions` | 纯文字                     | text/plain，18 bytes |
| `canvas-media-image` | `openai-images`           | 文字生成图片               | image/png，70 bytes  |
| `MiniMax-H3`         | `newapi-video-v1`         | 文生视频，5 秒、768P、16:9 | video/mp4，24 bytes  |
| `wan3.0-video`       | `newapi-video-v1`         | 文生视频，5 秒、720P、16:9 | video/mp4，24 bytes  |
| `wan3.0-video-prime` | `newapi-video-v1`         | 文生视频，5 秒、720P、16:9 | video/mp4，24 bytes  |

H3 首次归档被私网素材保护拒绝。独立 New API 随后使用现有配置，只允许 `mock-provider` 的单个 Docker IP 与 8081 端口，SSRF 保护保持启用。为补齐需要外部对象入口的组合，另建仅在独立 Docker 网络可达的 TLS 对象代理 `assets.canvas-acceptance.example.com`，Worker 以专用 `S3_PROVIDER_ENDPOINT` 启动，Mock 实际 GET 5 个冻结对象均为 200；这证明跨容器读取，不证明公网供应商可达。Worker 修复了重新登录更新权限修订后阻断原视频查询的问题：首次创建仍校验当前权限，已受理视频通过持久授权、取消状态和原发送身份继续查询，恢复不增加创建 POST。

此前文字结果未知和图片私网地址失败的任务保留原记录，未补发它们的创建请求。成功图片场景使用标准 `b64_json`。报告位于被忽略的 `.local-tests/newapi-account/media-results.json`、`media-acceptance.md` 和 `media-h3-before-recovery.json`，不含可用凭据。

这里的图片、MP4、PNG 和 WAV 是最小合成数据，仅证明协议、任务身份、归档和读取闭环；没有验证画质、编码兼容性或真实时长。首尾帧及图片/视频/音频参考的映射回归已通过。H3 首帧场景另有一笔非零计费对账：New API 用户 7、default、Token 19、`MiniMax-H3`，500 quota = 0.001 USD，回执和唯一消费日志一致，Canvas usage ledger 为 0；无限 Token 的 `remain_quota` 递减属于既有计数语义。签名视频/音频和该计费场景均只创建一次，补充报告为只读恢复记录。

## 媒体组合补证

补充组合按精确模型分别记录；成功组合各一次创建并完成查询/归档，拒绝组合供应商 POST 为 0：

| 精确模型 | 输入组合 | 本地结果 |
|---|---|---|
| `MiniMax-H3` | 两张图片提及、首尾帧、图/视频/音频混合参考 | 3 个独立场景通过；`media-full-results.json` |
| `MiniMax-H3` | 首帧、非零合成价格 | 通过；`media-billing-reconciled.json`，请求 `202609202221586332587258268d9d6tlIe2yiL`、任务 `task_QQboKexjcyLT4bwqWk9M8SD48FJCPVCj` |
| `wan3.0-video` | 首帧、首尾帧、参考图连线 | 3 个独立场景通过；`media-full-results.json` |
| `wan3.0-video-prime` | 首帧、首尾帧、参考图连线 | 3 个独立场景通过；`media-full-results.json` |
| `wan3.0-video` | 签名视频、签名音频参考 | 2 个独立场景通过；`media-signed-recovered.json`、`media-signed-audio-recovered.json` |
| `wan3.0-video-prime` | 签名视频、签名音频参考 | 2 个独立场景通过；`media-billing-reconciled.json` |
| 两个 Wan | `@` 图片提及 | 当前目录不声明该能力，明确拒绝，不能以参考图连线成功代替 |
| 两个 Wan | 未配置 Provider 对象入口的视频/音频参考 | 4 个场景在 POST 前拒绝；配置隔离 TLS 代理后，使用新场景单独取证 |
| `MiniMax-H3` | 文生模式附参考图、非法分辨率 | 明确拒绝；非法分辨率保留原错误且零 POST |
| `wan3.0-video` | 首尾帧模式缺尾帧 | 发现并修复持久化遗漏 `videoMode`；修复后明确拒绝且零 POST |

`media-full-results.json` 和 `media-final-results.json` 含原失败现场，只逐项引用其中已经核实的结果。Mock URL 解析异常留下的 unknown 原请求未重发；原始失败文件和只读补证同时保留，未把整份失败报告改成成功。

## 后续目标环境验证（本次范围外）

本次本机 New API 与 Mock 联调不替代真实供应商验收。已取得的签名 GET 只证明独立对象代理和 Canvas 冻结版本读取；仍未取得真实供应商外部 URL、真实供应商回执和生产插件生效版本。队列和密钥已完成当前 Windows 账户下的隔离恢复，限制见[实施检查点](newapi-account-implementation-checkpoint.md)。线上 `test` 已获准登录并核对分组/模型，但目标站点两个账号入口在预检仍为 404；用户明确暂不产生真实费用，真实生成继续暂停，合同不清楚的模式保持不可调用。
