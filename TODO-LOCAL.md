# Local 未完成任务

更新时间：2026-09-05

本文件是本机开发、隔离 Docker、等效 CI、loopback 服务及明确授权的隔离真实 Provider 请求的唯一待办清单。Local 验收只表示应用具备部署候选条件，不能关闭对应的 Server 验收；部署侧任务见 [TODO-SERVER.md](TODO-SERVER.md)。

状态说明：

- [~] 已有部分实现或部分证据，仍需完整验收。
- [!] 依赖外部平台、正式契约或具体配置。
- [>] 明确暂缓，当前不进入实施范围。

## Local 门槛（已有证据）

下列本地或隔离能力已有证据，仅作为部署前门槛：

| 任务                    | 已有 Local 证据                                                                                                                                                  | 对应的 Server 验收                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| P0-PROD-STARTUP-02      | 独立 NODE_ENV=production API、loopback HTTPS、启动失败保护和隔离 Redis 全局限流；见 [docs/production-entry-acceptance.md](docs/production-entry-acceptance.md)。 | 真实域名证书、反向代理、HSTS、客户端地址传递、外部告警和生产回滚。    |
| P0-MEDIA-OPS-03         | 隔离 MinIO/S3、真实 FFmpeg/ffprobe、媒体归档和回环 HTTP collector；见 [docs/media-ops-acceptance.md](docs/media-ops-acceptance.md)。                             | 真实业务 S3/IAM、生产 OTLP/Sentry、生产对象回滚和外部接收端故障演练。 |
| P1-MULTIKEY-ROTATION-06 | 应用侧密钥冻结、历史恢复、CAS 和隔离 API/Worker 进程验证；见 [docs/credential-rotation.md](docs/credential-rotation.md)。                                        | 供应商后台撤销和轮换，以及业务部署中的兼容窗口、暂停写入及回滚。      |
| P1-PROVIDER-ROLES-07    | 未确认角色和参数的请求前拒绝、适配器边界及本地回归测试；见 [docs/provider-contract-acceptance.md](docs/provider-contract-acceptance.md)。                        | 目标部署对正式字段的真实读取和结果验证。                              |

## P0：生产基础设施与恢复

### [~] P0-REAL-INFRA-01 真实供应商视频任务跨进程恢复

- 在独立 PostgreSQL、Redis、对象存储 namespace 中，对真实供应商异步视频任务执行 Worker 崩溃后的接管、继续查询、下载和归档验证。
- 当前已有真实视频创建、轮询、下载和归档成功证据，但没有该供应商任务的 Worker 崩溃接管证据。
- 验收条件：任务身份不丢失、不重复创建、不重复记录 usage；隔离设施和真实供应商任务不得接触业务生产数据。
- 本项需要一次真实任务故障演练授权和供应商任务查询接口。
- 生产环境的跨实例恢复由 Server 的 P1-PRODUCTION-09 验收。

## P1：Provider、媒体覆盖与多 Key

### [~] P1-VIDEO-CONTRACT-04 真实视频完整契约（Local 子项）

- 取得并固化供应商正式的取消接口、Webhook 原始 body 签名与编码、时间戳重放保护、幂等范围、重复计费规则和安全重试规则。
- 根据已确认契约，在隔离环境补充取消、状态、签名、重放、幂等和结果不明等回归测试；未确认的字段和行为不得猜测性请求。
- 当前仅验证了 sub2 的 legacy-v1 创建、查询、内容下载和归档；不能据此推断取消、Webhook 或重试契约。
- 真实请求必须使用明确授权的测试任务和隔离数据库、队列、对象存储。
- 公开回调和目标部署演练见 [TODO-SERVER.md](TODO-SERVER.md) 的同一任务。

### [~] P1-MEDIA-COVERAGE-05 音频、参考输入与供应商扩展（Local 子项）

- 明确真实 TTS 模型、voice、格式和语速组合，并在隔离环境完成一次真实音频生成及 Worker、Prisma、对象存储归档。
- 取得多参考图、负面提示、尾帧、音轨、角色绑定、蒙版及其它扩展字段的正式契约，并先补齐字段映射、拒绝和结果解析测试。
- 不得使用未明确授权的音频模型、voice 或供应商扩展字段进行猜测性请求。
- 真实音频请求需要测试凭据和单次请求授权；生产业务桶、生产 Worker 和外部接收端不属于本项。
- 目标部署的生产媒体和归档验证见 [TODO-SERVER.md](TODO-SERVER.md) 的 P0-MEDIA-OPS-03 与 P1-PRODUCTION-09。

### [~] P1-PROVIDER-ROLES-07 真实角色与扩展字段映射（Local 准备）

- 整理 negativePrompt、lastFrame、audioTrack、style、character、mask 和多参考图的正式字段契约、模型适用范围和样例响应。
- 对每个已确认字段补充本地序列化、拒绝未知字段和响应解析测试；未确认的角色和参数继续在请求前显式拒绝，不能静默降级。
- Local 测试只能证明适配器边界和内部映射；供应商是否真实读取字段须由 [TODO-SERVER.md](TODO-SERVER.md) 的最终验收确认。

## Local 完成判定

- 所有启用的隔离测试必须有非空报告、零失败、零 skip/TODO；普通测试中的设施跳过不算通过。
- PostgreSQL、Redis、S3/MinIO、队列和凭据必须使用专用 namespace、bucket/prefix 和合成或明确授权的测试凭据。
- 需要真实 Provider 费用或外部状态时，先记录授权、请求身份和结果；结果不明不得重复发送可能计费的创建请求。
- Local 完成后，记录验证命令、环境、证据文件和剩余 Server 风险，再进入部署验收。

## Local 阻塞条件

- 真实供应商视频任务：需要一次真实任务中断或接管演练、查询接口和授权；不能用合成任务替代。
- 真实音频验收：需要明确 TTS 模型、voice、格式、测试 Key 和一次请求授权。
- Provider 高级契约：需要正式文档、状态、取消、回调、签名和幂等规则；未确认时保持显式失败。
- 本地测试设施：需要隔离 PostgreSQL、Redis、S3/MinIO、FFmpeg/ffprobe 和可复现的测试配置。

## P2：共用后置事项

本节为不适合重复维护的共用后置清单。只有相关 Local 与 Server 的 P0/P1 验收均完成后才按产品优先级推进；涉及部署的后续验收仍记录在 [TODO-SERVER.md](TODO-SERVER.md)。

### [>] P2-SSO-10 外部身份系统

- 等待 OAuth 2.0/OIDC 或兼容 JWT 正式契约后接入。

### [>] P2-USAGE-11 上游 usage 展示与对账增强

- 仅在产品优先级允许时补充 usage 展示、费用字段展示和可选对账；本项目不实现本地收费、额度扣减或账单结算。

### [>] P2-RESOURCE-12 资源提及增强能力

- 语义搜索、OCR、音频转录、视频关键帧描述、批量引用、索引异步化和大规模性能验证。

### [>] P2-DESKTOP-13 桌面端封装

- Web MVP 和生产链路稳定后再接入 Tauri 桌面壳。

### [>] P2-COLLAB-14 协作与后置编辑能力

- 多人协作、插件市场、代码节点、完整视频剪辑器和复杂移动端画布。
