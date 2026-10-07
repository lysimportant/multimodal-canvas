# 视频节点手动获取资源检查点

2026-10-07。本轮为失败视频节点增加“获取资源”：沿用原 Run、原 BullMQ Job 与原平台任务 ID 查询并归档结果，不提交新的生成请求；“重试生成”仍是独立操作。只有原 Run 的目标视频节点拥有与 Provider、冻结快照和合同匹配的平台任务身份时，API 才受理只读恢复。多节点流程在任何 Provider 调用前检查全部待执行节点，不能恢复时明确失败。

任务等级 P1；基线为 `main` 的 `3640a7c`，Node `24.12.0`、pnpm `11.19.0`。验收覆盖失败与超时后的手动入口、原任务身份、成功归档回显、无法恢复时保留操作与错误，以及不发送新的 Provider 创建请求。本轮不部署、不测试真实付费请求。

公开 `POST /v1/runs/:runId/recover` 要求 `{ "retrieveOnly": true }`，旧的空对象调用返回 400；OpenAPI 已同步，仓库内 Web 调用已迁移。outbox 派发、恢复受理与发送意图使用同一 Run 事务锁；派发持锁后读取最新负载。发送边界还核对持久只读标志，防止旧队列数据绕过；旧 `unknown` 发送状态只有核实同一平台身份后才能继续查询。BullMQ 重新排队成功后更新进度时间，避免 Web 将失败后的新排队状态当作旧事件丢弃。

部署需同批更新 Web、API 和 Worker，先保证新 Worker 生效，再开放新 API/Web。没有数据库迁移，也不覆盖现有素材。回滚前先暂停相关队列并核对带 `retrieveOnly` 的原 Job/outbox：旧 Worker 不认识该标志，不能让未完成的只读恢复交给旧 Worker 消费，否则可能再次发起生成请求。保留原 Run 与平台任务身份，核实后再决定重新部署新版或处理队列。

本轮本地验证（最后检查点为 2026-10-07）：

- `pnpm exec turbo run lint typecheck --force`、`pnpm exec turbo run build --force` 均无缓存重跑通过；最后执行授权补丁后，再运行 `pnpm exec turbo run lint typecheck build --output-logs=errors-only` 通过，受影响包重新执行，其余包使用缓存。
- `pnpm test:runtime`：8/8。按包串行、`--fileParallelism=false` 运行全仓测试：credential-crypto 13、domain 406、observability 21、ui 16、providers 789、API 1223、Worker 861 项通过；execution 最后补丁后 56/56。API 108、Worker 28 项设施测试跳过，不能算集成验收通过。
- Web 全量首次为 2471 通过、6 失败；6 项来自同一 `canvas-editor.test.tsx` 夹具缺失 `projectId`，被新的原任务身份校验拒绝。补齐夹具后该文件 70/70 重跑通过，其余 133 个文件通过；未再次重复整个 Web 全量。
- `WEB_BASE_URL=http://127.0.0.1:5191 pnpm --filter @multimodal-canvas/web exec playwright test e2e/video-manual-recovery.spec.ts --workers=1`：2/2。实际验证按钮、视频取回回显、业务拒绝后可再点击、零新增生成请求及控制台；1440×900 截图已检查。仅访问本地 Vite 与业务 Mock，临时服务已关闭。
- `git diff --check`、新增源码敏感信息扫描及本轮文件格式检查通过。同步修改的两份历史 New API 文档原有表格格式警告在 HEAD 中也存在，本轮仅更新恢复合同说明，未格式化无关表格。

本地合同与模拟任务测试只能证明恢复路径不会主动创建新请求。用户部署后仍需用已知平台任务 ID 的失败/超时视频 Run 验证查询、归档与页面回显，并核对上游创建请求次数和费用；没有平台任务 ID 的创建失败应返回明确错误，不应自动重试。真实 Provider、New API 账单和生产队列尚未在本轮验收。
