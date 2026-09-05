# 生产全局限流与恢复演练

## 行为与影响

- 生产 API 必须配置 `REDIS_URL`，且不能设置 `API_RATE_LIMIT_REDIS_ENABLED=false`。入口等待首次连接就绪；失败则在监听 HTTP 端口前退出，错误不包含连接凭据。
- Redis 命令有 1 秒超时且不使用离线命令队列。运行中 Redis 故障后进入 30 秒冷却；生产模式拒绝受限请求，不使用进程内额度，冷却结束后尝试 Redis。
- 登录、注册、配置了 `API_RATE_LIMIT_PER_MINUTE` 的普通 API，以及 SSE 受限入口返回 HTTP `503`、`code: rate_limit_unavailable`、可关联的 `requestId`、`retryAfterSeconds` 和 `Retry-After` 响应头。正常额度耗尽仍返回 `429`，两者不可混淆。
- `/health` 保持存活检查，不代表 Redis 就绪。未认证请求仍返回 `401`；已签名资源下载与 Provider Webhook 保持现有独立权限边界，不在本次变更中扩展限流。
- 开发模式默认使用有界内存限流；显式启用 Redis 时仍允许故障回退。不新增本地计费、扣费或额度结算。

## 隔离验证

在项目根目录使用已安装的 pnpm 和锁文件依赖。这里只操作明确的本地测试 Redis；不要将生产连接复制到终端或文档。

```powershell
pnpm --filter @multimodal-canvas/api exec vitest run src/rate-limit.test.ts src/runtime-rate-limit.test.ts src/rate-limit-http.test.ts --maxWorkers=1 --minWorkers=1
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6379'
$env:TEST_REDIS_NAMESPACE = 'test-rate-limit-acceptance'
pnpm --filter @multimodal-canvas/api exec vitest run --config vitest.rate-limit-integration.config.ts
```

专用集成配置缺少隔离变量时必须失败，不能以跳过测试伪装成功。普通单元测试缺少这些变量时跳过真实 Redis 演练。每次演练生成随机前缀，两个独立 Node 进程竞争同一窗口；测试退出和重建进程后共享额度不得重置。测试不运行 `FLUSHDB`、`FLUSHALL`，不修改其他应用键。

HTTP 注入与真实监听冒烟验证 `503`、`429`、认证、健康检查、日志脱敏以及冷却恢复；真实 Redis 子进程测试验证 Lua 原子共享状态。两类证据不能替代完整生产 API/Worker、TLS 代理、供应商任务或跨实例凭据验收。

## 运维与回滚

1. 部署前核对 Redis 连接、TLS/网络访问、连接池资源和入口限流配置。通过密钥管理系统注入连接凭据，不写入源码、日志或验收归档。
2. 告警关联 `rate_limit_unavailable`、请求 ID 和固定连接诊断；禁止记录原始 Redis 异常、URL 或命令。Redis 故障期间不要通过增加 API 实例规避限流。
3. 修复 Redis 后等待冷却结束，确认窗口内额度未重置、额度耗尽为 `429`，随后确认新窗口恢复正常。HTTP 客户端遵守 `Retry-After`，避免同步重试风暴。
4. 本次不迁移数据库，不修改 Redis key 格式，也不清理业务数据，因此不需要数据备份迁移。若需回滚，先在隔离环境部署前一应用版本再切换流量；旧版本可能回退进程内额度，回滚前必须由部署负责人确认入口具有等效全局限流保护。

真实生产故障注入、配置回滚和外部告警投递需单独授权，本地演练不自动执行这些操作。
