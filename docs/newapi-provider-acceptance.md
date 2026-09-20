# Provider 当前合同与验收边界

更新时间：2026-09-21。本文承接已删除的收费/多连接/价格同步文档中仍适用的合同与未完成项。当前身份接入证据见[实施检查点](newapi-account-implementation-checkpoint.md)，更广泛的供应商任务见[待办汇总](../TODO-CONSOLIDATED.md)。

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
- 已发布 outbox 对应 Redis job 丢失后的受控恢复入口仍是独立运维缺口；须按原 Run、请求身份、授权和归档证据恢复，不能新建任务掩盖丢失。

## 本地 Docker 验收（2026-09-21）

独立合成用户通过 Canvas → New API 授权后，五个目录项均可调用。以下场景均完成 API 提交、Worker 执行、归档和授权下载；每个场景的供应商创建 POST 为 1 次。

| 精确模型             | Canvas 合同               | 本轮输入                   | 归档内容             |
| -------------------- | ------------------------- | -------------------------- | -------------------- |
| `canvas-media-text`  | `openai-chat-completions` | 纯文字                     | text/plain，18 bytes |
| `canvas-media-image` | `openai-images`           | 文字生成图片               | image/png，70 bytes  |
| `MiniMax-H3`         | `newapi-video-v1`         | 文生视频，5 秒、768P、16:9 | video/mp4，24 bytes  |
| `wan3.0-video`       | `newapi-video-v1`         | 文生视频，5 秒、720P、16:9 | video/mp4，24 bytes  |
| `wan3.0-video-prime` | `newapi-video-v1`         | 文生视频，5 秒、720P、16:9 | video/mp4，24 bytes  |

H3 首次归档被私网素材保护拒绝。独立 New API 随后使用现有配置，只允许 `mock-provider` 的单个 Docker IP 与 8081 端口，SSRF 保护保持启用。Worker 修复了重新登录更新权限修订后阻断原视频查询的问题：首次创建仍校验当前权限，已受理视频通过持久授权、取消状态和原发送身份继续查询。原 Run `run_idem_a191ea289dcfa4efdf894684c77085d0a6ee34587d843426c96c7b90e60424a0`、上游任务 `task_dPkAARYWiXyj8YVVRx5rI8z5u2mVK4oC` 恢复成功，额外创建 POST 为 0。

此前文字结果未知和图片私网地址失败的任务保留原记录，未补发它们的创建请求。成功图片场景使用标准 `b64_json`。报告位于被忽略的 `.local-tests/newapi-account/media-results.json`、`media-acceptance.md` 和 `media-h3-before-recovery.json`，不含可用凭据。

这里的图片和 MP4 是最小合成数据，仅证明协议、任务身份、归档和读取闭环；没有验证画质、编码兼容性或真实时长。首尾帧及图片/视频/音频参考的映射回归已通过，其目标部署外部素材读取与真实模型组合仍按下一节取证。

## 未取得的证据

本次本机 New API 与 Mock 联调不替代真实供应商验收。实际模型/输入组合的外部 URL、真实供应商回执、New API 最终费用归属、插件生效版本及生产部署继续单列；未获授权时不为补验收重复付费生成。真实合同不清楚的模式保持不可调用。
