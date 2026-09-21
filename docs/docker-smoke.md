# New API 本地隔离烟测

当前验收使用独立 New API Docker、Canvas API/Worker 和 PostgreSQL/Redis/MinIO。该流程取代旧邮箱注册、手工 Key 和钱包烟测，不访问生产站点。

## 准备

1. 按 New API 仓库的 `docs/authentication.md` 中 Canvas 账号合同启动独立实例并登记 Canvas 的 issuer、client、instance 和精确 redirect URI。创建两个合成用户，开放用于验收的分组；包含精确排除组 `神秘分组` 和相近名称可检查边界。
2. 配置只指向本地 Mock 的渠道和文字模型 `canvas-test-model`。为模型声明 `POST /v1/chat/completions`；目录必须有有效合同和渠道资格，不能绕过缺合同拒绝。
3. Canvas 使用独立数据库、队列和对象存储，Origin、回调和 New API 配置保持一致，API 与 Worker 运行匹配版本。
4. 在进程环境中设置 `NEW_API_TEST_USER`、`NEW_API_TEST_PASSWORD`、`NEW_API_TEST_USER_B`、`NEW_API_TEST_PASSWORD_B`。不要将真实账号或密码写入脚本、报告或版本库。

可选地址为 `CANVAS_ACCEPTANCE_ORIGIN`（默认 `http://localhost:5173`）和 `NEW_API_ACCEPTANCE_ORIGIN`（默认 `http://127.0.0.1:13000`）。脚本拒绝非回环站点、URL 用户信息、查询参数和非根路径。

浏览器和容器需要能访问同一个 issuer。全 Docker 部署不能把容器内 `127.0.0.1` 当成宿主 New API；本机覆盖层应提供统一 HTTPS 来源、Docker DNS 别名和双方信任的 CA，并精确登记回调。New API 独立实例避免固定容器名、宿主端口和 bind 数据目录冲突。2026-09-21 的完整本地部署及仅查询复核命令见[实施检查点](newapi-account-implementation-checkpoint.md)。

## 执行与结果

```powershell
node scripts/docker/smoke.mjs --self-test
node scripts/docker/smoke.mjs run
```

一次 run 创建一个合成项目和一次文字生成，验证 PKCE 登录、全部纳入组、重登复用 Key、旧会话失效、两用户项目/目录/Run 隔离、Worker 归档、幂等键复用及退出。请求异常不自动重复 POST；先检查原 Run 和隔离服务日志。

脱敏报告写入忽略目录 `.local-tests/newapi-account/docker-smoke-report.json`。该报告证明本地集成，不代表真实供应商、外网素材读取或生产扣款已经验收。PC 浏览器操作和逐媒体组合另记于[实施检查点](newapi-account-implementation-checkpoint.md)。

## 旧数据与迁移

迁移 `20260921050000_retire_legacy_accounts_billing` 拒绝非空旧账务/定价表、旧账号、旧手动凭据、旧商品引用及在途旧任务。阻断时保留数据库与对象备份，使用 `scripts/newapi-cleanup.mjs preview` 按精确 UUID 清点，再按已批准计划执行；不能删行或重置迁移记录来绕过未结任务。

迁移失败会回滚本批结构变更。完成清理并核实失败批次确实未应用后，才可按 Prisma 的 `migrate resolve --rolled-back` 恢复部署。Git 回退无法恢复数据库或对象；只能回退到理解当前身份和执行授权的版本。清理工具仅面向删除迁移之前的结构，完成 DROP 后会明确拒绝运行。
