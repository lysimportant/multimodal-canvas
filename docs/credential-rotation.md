# 凭据轮换与恢复边界

## 当前实现

API 文件存储、Prisma 存储和 Worker 共用 `@multimodal-canvas/credential-crypto`。新增密文为 `mc:v2:<key-id>:<base64url>`，继续按原有 SHA-256 派生方式读取无 key-id 的 AES-GCM 历史密文。重复 key-id、格式错误、标签篡改和缺失历史密钥均显式失败，不回显密钥或密文。

- `AI_CREDENTIAL_ENCRYPTION_KEY`：当前写入密钥，由密钥管理系统注入。
- `AI_CREDENTIAL_ENCRYPTION_KEY_ID`：稳定标识，默认 `default`；长度 1–64，不是密钥材料。
- `AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS`：历史标识到密钥的 JSON 对象，缺省为空；不得将实际内容写入源码、测试日志、提交或聊天。

本地文件模式仅支持单 API 进程。启动会检查并重加密所有历史记录，等待原子写回完成后才能接受请求；写回失败时拒绝启动，原文件保持不变。

Prisma 历史行重加密保留 `id/version/updatedAt`，不能改变活动排序或越过撤销墓碑。写入同时比较旧密文、key-id、版本和时间；竞争失败时返回固定错误并拒绝此次凭据读取，不覆盖另一实例的新密文。API 和 Worker 都不能以活动 Key 替代无法恢复的冻结引用。

撤销的既有语义保持不变：当前实例撤销默认配置后不再据此创建新运行，但已冻结 ID/版本的排队任务仍可读取历史凭据。本轮验证 API 重启后仍识别撤销墓碑，不代表其他运行中实例的内存设置缓存会立即同步撤销；跨实例即时撤销仍待补齐。供应商侧撤销可能使任务失败，不能自动换 Key 或重建收费任务；若需要同时终止排队任务，应由部署负责人单独确认并取消相关运行。

## 迁移与回滚

1. 在受控存储中备份数据库；文件模式同时备份凭据 JSON 和配套密钥文件。记录迁移版本、当前 key-id、队列和对象存储测试前缀，不记录明文密钥。
2. 先执行增量迁移 `0014_ai_credential_encryption_key_id`，仅增加可空字段，不重写任何密文。仅执行迁移后，旧代码仍可读取原有行；开始写入 v2 密文后，旧版解密器不再兼容。
3. 暂停设置写入、新运行提交和队列消费，排空或停止旧 API/Worker。所有实例部署支持 v2 的代码，并使用相同的当前 key-id 和历史密钥配置后，再逐步恢复流量与消费。
4. **不支持不同 current key-id 的实例同时进行自动重加密。** CAS 防止迟到的旧读覆盖新写，但不能防止两个可相互解密的实例顺序反向轮换。本实现不宣称零停机轮换；不能只把新密钥加入旧实例的历史列表后混跑。
5. Prisma 按读取逐步迁移，不代表启动时已重加密所有历史行。必须检查所有仍被保留的历史记录均已转换、恢复演练通过且备份保留期已满足，才能移除旧密钥。
6. 如需回滚，保留历史密钥并使用仍支持 v2 的上一应用版本。不得在已写入 v2 后直接回退到旧解密器；必须恢复经确认的匹配数据库备份及密钥配置，相关覆盖操作需单独授权。

## 已验证证据

- 文件模式：先复现“内存已轮换但未写回”和“写回失败仍放行”，修复后验证仅持有新密钥时可恢复多个冻结版本。
- 隔离 PostgreSQL：API/Worker 分别在独立 Node 进程轮换历史行，重建 API 并移除旧密钥后仍可读取；活动凭据、撤销墓碑、版本和业务时间保持不变。
- 真实数据库竞争屏障：新实例先写，迟到实例 CAS 失败，最终密文只需最新密钥即可恢复。
- 全新隔离 Docker 栈执行迁移、Prisma/Redis/MinIO 集成及生产模式 API/Worker 启动。这里的生产模式指 `NODE_ENV=production` 配置路径，不是已验收的生产部署。

复现使用显式隔离 `TEST_DATABASE_URL`、`TEST_REDIS_*` 和 `TEST_S3_*`，从项目根目录运行：

```powershell
pnpm --filter @multimodal-canvas/api test:integration --maxWorkers=1 --minWorkers=1
pnpm --filter @multimodal-canvas/api exec vitest run src/file-ai-settings.test.ts src/settings.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @multimodal-canvas/worker exec vitest run src/prisma-persistence.test.ts --maxWorkers=1 --minWorkers=1
```

完整生产 TLS/反向代理、真实 Provider、队列任务恢复、冻结媒体版本恢复、媒体工具及外部告警投递仍未全部验收，不能由这些结果推导 P0/P1 已完成。
