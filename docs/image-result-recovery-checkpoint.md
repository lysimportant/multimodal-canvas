# 图片成功结果归档修复检查点

更新时间：2026-09-24 23:15。等级 P0（已付费结果保留与防重发）。

## 当前结论

代码修复、隔离回归及最终 Docker 产物验证已完成；本地 8080 业务 Worker **尚未更换**。用户仅确认 Docker 已启动，业务容器重启需另行确认。本次不恢复旧图片、不操作旧任务、不发送真实付费请求。

## 根因与修复

原同步图片响应返回 HTTP URL，生产归档仅允许 HTTPS，首错为 `provider result URL must use HTTPS`。输出当时仅在内存中，任务已有 received 证据，防重复付费逻辑阻止再次生成，却无法取得原输出，后续提示覆盖首错。

- [x] 成功输出在归档及发送回执落库前进入 Worker 专用 AES-256-GCM 暂存；使用现有凭据密钥环，支持历史密钥。
- [x] 暂存身份绑定部署队列、用户、项目、原 Run、节点、冻结快照、请求 ID；记录原 attempt。固定 24 小时 TTL，首次写入优先，不覆盖或续期，成功归档后清理。
- [x] 重启、同 Run 重放或 retryOf 恢复只归档原输出，不重新生成、不重新水合输入素材，沿用请求绑定、archiveKey 与原费用 Run。
- [x] 暂存恢复先核对原发送事实，允许凭完整冻结证据补记丢失的 intent；取消前也记录已发生的 sent 与 usage，不复活撤销授权。
- [x] 新重试发送核对最多 32 层原请求链；sending/unknown/sent 阻止新发。`beginSend` 在同一事务内再次复核并持锁，已有后继重试的原 Run 不能领取新请求。API 的确定性 retry RunId 保持不变。
- [x] 首个具体归档错误脱敏保留；旧队列不能覆盖数据库已有首错和 recorded/external 费用终态。
- [x] 内联图片优先；仅默认端口、无 userinfo 的 HTTP 图片可尝试同主机/路径/query 的 HTTPS，实际验证 TLS、DNS/连接地址、MIME、大小、超时与取消；禁止明文回退和重定向。
- [x] 成功恢复清除旧 Run error。已归档缓存路径严格补写成功节点 timing，保留开始时间，不再残留 failed；写入失败继续保留缓存供重放。

## 基线与保护范围

- 分支 `codex/generate-to-new-node`；开始时 HEAD `970bd4bad0c3009518b2ba72f8300c550fac808f`。
- 上游 `origin/codex/generate-to-new-node`；origin 为 `https://github.com/lysimportant/multimodal-canvas.git`。
- Node `v24.12.0`，pnpm `11.19.0`；依赖已安装，本轮未改 manifest/lockfile。
- 用户原改动 `docs/resource-input-compatibility.md`，blob `0f0688d28fd19f8f9cea3a79666c505e6a6e2e03`，已验证未变，不纳入提交。
- 初始 workflow 测试 59 项；最终 79 项。根 AGENTS.md、README.md 缺失，执行用户提供的规则和 TODO-CONSOLIDATED.md 的边界。

## 影响与回退

不改数据库 schema、依赖或公共 API，也不默认给未知模型增加 response_format。新增 ProviderJob 可选恢复字段和 Redis 专用命名空间密文；队列、数据库与日志不保存原 URL/base64 明文。暂存默认原始内容上限 50 MiB，复用 `RESULT_ASSET_MAX_BYTES`。

Redis 仍依赖部署原有访问控制、持久化及传输安全；TTL 不是备份擦除保证。暂存超时、密钥缺失、内容损坏或上游 URL 到期时，安全停止而非重新付费生成。若上游没有可用 HTTPS 且未提供内联内容，仍明确归档失败，不放宽安全边界。收到响应到完成 Redis 写入之间的进程崩溃、Redis 故障不能保证原输出可恢复。

回退不会损坏已归档资产；待归档密文需要本版 Worker 与原密钥。回退前停止新接单并处理待归档任务，不能清空发送状态来重发。此次未重启或迁移业务服务，未更改用户资产。

## 最终验证

| 命令/范围                                                                      | 结果                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `pnpm test:runtime`                                                            | 8/8                                                                                         |
| `node node_modules/turbo/bin/turbo run test --concurrency=2 -- --maxWorkers=2` | 15 个任务通过；Web 1090、API 810、Provider 473；API 84 个条件项跳过                         |
| `pnpm --filter @multimodal-canvas/execution test`                              | 43/43                                                                                       |
| Worker 全量，显式启用独立 PostgreSQL/Redis                                     | 486/486，20 个文件，无跳过；包含 workflow 79、暂存 73、归档器 74、真实 TLS 5、真实持久化 43 |
| 原结果恢复集成                                                                 | PostgreSQL+Redis 4/4（同 Run、retryOf、取消、已归档缓存）；Redis 双 Worker 1/1              |
| `pnpm lint` / `pnpm typecheck` / `pnpm build`                                  | 9/15/9 个任务通过                                                                           |
| `pnpm build:runtime`                                                           | API 与 Worker 正式 ESM 产物生成成功                                                         |
| 最终 Docker Worker 构建与 Linux Node24 smoke                                   | 成功；生成 1 次、归档 2 次、最终 succeeded、真实外部请求 0                                  |
| `git diff --check` / 敏感内容与调试输出扫描                                    | 通过；唯一私钥命中为明确标注的本机合成 TLS 测试夹具                                         |

全仓测试采用受限并行，避免早期全速并行的前端 5 秒超时；未修改前端测试或超时阈值。末次全仓检查重用未变包的缓存；Worker 又在真实隔离服务下完整执行 486 项。合成输出和隔离服务测试不等于真实上游或生产验收。

最终候选镜像：`multimodal-canvas-worker:result-recovery-20260924`。

镜像 ID：`sha256:f2b9dbcf99e0000ec72cf77343b9755cd28db71ae39982c4e25d24d41d9ee4d1`。

运行中的旧业务 Worker 镜像：`sha256:15ed93498a7ccc95f76819f1dfa658be51ba62db0ccb39c98e21a0adc10d09c7`，仍 healthy。不要把候选镜像验证误认为业务部署完成。

本地原始日志位于被 Git 忽略的 `.data/image-recovery-*-final.log`。独立复查额外验证了父子发送锁竞争，最终确认缓存成功仍残留 failed 的用例在修改前失败、修改后通过。

## 复跑隔离验收

只使用本机专用 Redis `127.0.0.1:16389` 和 PostgreSQL `127.0.0.1:16390/result_recovery_test`；不得改为业务连接。现有容器为 `canvas-result-recovery-test` 与 `canvas-result-recovery-postgres-test`，前者 Redis 7，后者 PostgreSQL 16。数据库已执行仓库全部迁移；仅合成测试数据，清理限定本次随机 Run/Project。

```powershell
$env:RESULT_RECOVERY_TEST_REDIS_URL = 'redis://127.0.0.1:16389'
$env:RESULT_RECOVERY_TEST_DATABASE_URL = 'postgresql://recovery_test:synthetic-recovery-test-password@127.0.0.1:16390/result_recovery_test?schema=public'
$env:TEST_DATABASE_URL = $env:RESULT_RECOVERY_TEST_DATABASE_URL
$env:TEST_DATABASE_CONFIRMED_ISOLATED = 'true'
pnpm --filter @multimodal-canvas/worker test --maxWorkers=2
Remove-Item Env:RESULT_RECOVERY_TEST_REDIS_URL, Env:RESULT_RECOVERY_TEST_DATABASE_URL, Env:TEST_DATABASE_URL, Env:TEST_DATABASE_CONFIRMED_ISOLATED
```

## 交付与下一步

本轮代码及检查点按大型行为变更交付，使用中文 Conventional Commit 与附注 Tag `v2026.09.24-image-result-recovery`，推送 origin 当前上游；实际成功以最终 Git ref 核验为准，不包含用户原文档改动。

唯一部署步骤：取得用户明确同意后，先检查业务活动任务，再仅更新 Worker 并验证健康和回显链路；不自动创建任何真实付费生成请求。旧图恢复始终不在本次范围内。
