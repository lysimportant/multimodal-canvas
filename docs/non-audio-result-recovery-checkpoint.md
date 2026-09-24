# 非音频节点结果恢复检查点

日期：2026-09-25；等级 P0。基线分支 `codex/generate-to-new-node`，HEAD `7c1fe1e75798a8a9d90128665507f68527457ba7`；上游 `origin/codex/generate-to-new-node`。Node v24.12.0、pnpm 11.19.0，沿用现有锁文件，无新增依赖。workflow 基线 79/79。

## 范围与结果

- 视频 HTTP 输出仅尝试同主机、路径和查询参数的安全 HTTPS 候选，不回退明文；保留 DNS/socket 公网、TLS、重定向、大小、MIME 与取消检查。
- 仅视频下载 Response 的 401/403/404/410 触发原任务只读刷新。须有原平台任务 ID 和明确冻结合同；每次处理最多调用一次恢复流程，查询/下载只用 GET，绝不退回生成 POST。存储、安全校验及传输错误不触发刷新。
- 刷新严格复核任务、节点和合同，不能改原资产归档键、usage 或请求提示词身份。补齐 legacy-v1 明确返回其他任务 ID 时的拒绝；缺省 ID 保持原合同兼容策略。
- 反推/提示词优化在解析、回执写入前保存原响应到既有加密暂存。Worker 重启仅解析原输出并写回，不重新请求；无效/损坏/过期结果仍明确失败，取消不绕过。
- 独立结果成功修正失败 timing 必须有同一数据库 Run 的合法冻结快照、正确目标与结果类型；优化引用身份/版本/元数据/顺序一致。普通媒体仍要求资产版本，已取消终态不覆盖。
- 普通文字及上一轮图片恢复路径回归通过。音频逻辑不改；不恢复旧图、不操作旧业务任务、不调用真实上游、不自动重启业务容器。

## 风险与回退

无数据库 schema、依赖或公共 HTTP API 迁移。`resumeOnly` 仅是内部视频 Provider 请求标记。密文沿用已有 AES-GCM、完整身份绑定、首次值优先与固定 24 小时 TTL；刷新后的短期 URL 不覆盖首次值、不延长 TTL。若再次归档失败，下次仍按原平台 ID 和冻结合同只读恢复，不能承诺已经过期且上游也无法查询的资源可取回。

部署需另行安排 Worker 更新；回退前保留并处理待恢复密文，不删除用户数据、发送状态或恢复证据。无真实 Provider 验收，隔离桩测试不证明外部供应商行为或业务上线结果。

## 最终验证

| 检查                                                                           | 结果                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `pnpm test:runtime`                                                            | 8/8                                                            |
| `node node_modules/turbo/bin/turbo run test --concurrency=2 -- --maxWorkers=2` | 15/15 任务成功，部分为有效缓存；非配置集成测试按门禁跳过       |
| 显式隔离 PG/Redis 的 Worker 全量                                               | 696/696，21 个文件，无跳过                                     |
| workflow 回归                                                                  | 103/103；含三合同错任务 ID 拒绝、刷新中取消                    |
| Provider 全量                                                                  | 530/530；三合同 GET-only、缺少身份/合同、错 ID、下载与取消边界 |
| 归档器及真实 TLS                                                               | 204/204；含真实 MP4 字节一致及安全失败边界                     |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm build:runtime`           | 全部通过                                                       |
| 候选镜像正式 ESM 产物恢复 smoke                                                | 文字、视频、反推、优化、原图片均通过，每类只生成一次           |
| 候选镜像隔离 production 启动                                                   | ready Worker=1，未投递业务任务                                 |
| `git diff --check`、新增代码敏感信息/调试输出扫描                              | 通过；无新增真实凭据或调试输出                                 |

新增真实集成 `apps/worker/src/non-audio-recovery.integration.test.ts`：

- 视频：第一次存储失败后更换真实 Worker 实例；生成 1 次、归档 2 次。
- 视频链接失效：第一次存储失败→新 Worker→旧 URL 403→原任务 GET 刷新→成功；生成 1 次、只读 GET 1 次、归档 3 次。刷新返回的 999 USD 不覆盖原 1.25 USD。
- 反推/优化：第一次 received 回执写入失败，关闭原 Worker 后从密文恢复；各生成 1 次、媒体归档 0 次。
- 四例均断言数据库 SUCCEEDED、error=null、timing succeeded，原发送/请求身份不变、成功清理暂存。PostgreSQL、Redis、BullMQ、Prisma 执行服务真实运行；上游及媒体存储为合成桩。

### 隔离测试复跑

使用本轮专用 `canvas-result-recovery-postgres-test`（127.0.0.1:16390，result_recovery_test）和 `canvas-result-recovery-test`（127.0.0.1:16389），数据库已执行仓库迁移；不能替换为业务连接。测试只清理随机任务/用户/队列数据。

```powershell
$env:RESULT_RECOVERY_TEST_REDIS_URL='redis://127.0.0.1:16389'
$env:RESULT_RECOVERY_TEST_DATABASE_URL='postgresql://recovery_test:<isolated-test-password>@127.0.0.1:16390/result_recovery_test'
$env:TEST_DATABASE_URL=$env:RESULT_RECOVERY_TEST_DATABASE_URL
$env:TEST_DATABASE_CONFIRMED_ISOLATED='true'
pnpm --filter @multimodal-canvas/worker exec vitest run --maxWorkers=2
```

新集成测试拒绝不匹配的主机/端口/库名/用户或带 query 的 DSN，不能连接后再判断隔离性。没有显式变量则跳过；不得设置业务 DATABASE_URL 来绕过。

## 构建与运行边界

候选镜像：`multimodal-canvas-worker:non-audio-recovery-20260925`。本机与镜像 `/app/dist/server.mjs` SHA-256 均为 `3514c9824fa701a0e1990cc391a174d334ec7fb2c7a0e6b9d30364fcf61376a5`。Linux Node v24.12.0；恢复 smoke 用 `NODE_ENV=test` 防止 import 时自动消费默认队列，另用 production 环境验证空隔离队列启动。业务容器没有切换该候选镜像。

本地日志保留于 `.data/non-audio-*-final.log`；诊断脚本/日志不提交。构建期间 npm registry 的连接重置由包管理器重试恢复，最终镜像构建通过，未更改锁文件。

## 恢复记录与交付

主代理负责 Worker 集成、最终全仓验收及交付；归档器、Provider、持久化、真实集成分别由四个互斥文件范围的子代理完成。安全复核发现 legacy 错 ID 缺口后，先复现 Worker 第二次误归档，再修复并重跑全量和最终镜像。早期 workflow 用例间共享绑定污染已通过用例深拷贝消除。

用户原改动 `docs/resource-input-compatibility.md` blob `0f0688d28fd19f8f9cea3a79666c505e6a6e2e03` 保持不变且不纳入本次提交。最后成功阶段：代码、隔离集成、全仓检查、最终镜像与启动 smoke；交付分支及附注 Tag：`codex/generate-to-new-node`、`v2026.09.25-non-audio-result-recovery`。业务部署与真实 Provider 验收仍未执行。
