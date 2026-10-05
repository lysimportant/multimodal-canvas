# New API 分组 Key 删除恢复

日期：2026-10-05。P0 账号凭据恢复，两端本地实现与隔离验证完成，部署验收待执行。

## 基线和验收

- Canvas：`main @ 7d8ac67`，上游 `origin/main`，开始时工作树干净；Node 24.12.0、pnpm 11.19.0，已有依赖可用。
- New API：`D:/newapi`，`main @ 6e77181de`，上游 `fork/main`，开始时工作树干净；Go 1.26.0，模块基线 1.25.1。
- 目标：用户已明确要求登录、会话刷新和手动同步直接恢复。Key 被改组时恢复原管理分组；Key 已删除时创建该已有分组的新 Key，并恢复模型目录。禁用、人工改其它权限、撤销、跨用户/实例操作继续拒绝。
- 验收覆盖：删除后新 Token/Key 与原版本不同、改组恢复原 Token/Key、旧任务引用不变、同操作重试不重复创建、登录与手动同步共用恢复、错误响应不泄露 Key。
- 范围为两端代码、本机隔离数据库与浏览器验收；不部署服务器、不调用付费模型、不删除业务记录。

## 存储与回滚

Canvas 对 `newapi_credential_rotations` 追加 `kind` 和 `grantId`，对分组绑定追加 `repairState` 和 `grantId`。已有轮换默认 `rotate`，不修改旧密文和历史任务。迁移为单个事务，沿用原轮换记录保存待恢复操作和旧凭据版本；修复完成后本地凭据版本递增。删除时上游 Token ID 更新，单独错组时保留原 Token ID/Key。

登录和手动同步共享 `synchronize`；首次本地尚无 Key 的恢复也先持久化操作，再向上游请求。同账号切换实例时可采用当前授权返回的凭据，归档原本地版本；同一 grant 的迟到旧修订不能回滚当前凭据。已失效 Key 的修复不等待旧任务排空，也不向旧任务注入新版本或重发 Provider 请求；正常主动轮换仍要求排空。

切换实例后若存在原 grant 未完成的修复，先将其归档为 `superseded` 并保留原版本密文，再以当前 grant 同步。原本地凭据版本递增以隔离新操作；首次无凭据的旧修复意图直接结束。不会因旧 grant 的待恢复记录永久阻塞新授权，也不向旧 grant 继续发送恢复请求。

上线前备份业务 PostgreSQL 和 New API 数据库并保留旧镜像。回滚代码时保留新增列、旧密文和操作记录，不恢复已删除 Key、不把新 Key 注入旧任务；存在待完成重建时先停止新提交并完成/核对原操作。隔离验收使用独立测试容器，不迁移当前用户库。

## 当前检查点

- 已确认旧路径：同步和重登录只校验原管理关系，删除 Token 后返回冲突，没有重建入口。
- Canvas 客户端 10 项、真实隔离 PostgreSQL 身份集成 30 项通过。涵盖首次无本地凭据、重新登录、`/v1/auth/me` 登录检查、`/v1/auth/refresh` 续期、删除补建、改组复原、丢包重试、旧 unknown 任务不阻塞修复、未完成修复后切换实例与迟到响应保护。
- PostgreSQL 16 隔离容器的全新迁移、从本轮 HEAD 的旧 schema 升级及重复迁移均通过，schema diff 为零。种入的旧轮换密文、指纹、未完成状态及原分组 operation_id 保持不变。
- `newapi-account.integration.test.ts` 应使用 `vitest.integration.config.ts`；默认单测配置会清空认证环境，旧两个会话用例未显式注入 JWT 时出现失败，需要按集成入口核验。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm build:runtime`、`pnpm test:runtime` 通过；本轮受影响 API/Web 任务实际执行，共享未变包部分使用 Turbo 缓存。最后补充测试后再次执行 API typecheck 与测试文件格式检查。构建保留现有大 chunk 提示。
- 完整单测采用稳定的本地 TEMP 和受限并发重跑：API 1183 通过 / 95 跳过、Worker 784 通过 / 28 跳过、Web 2379 通过。共享包 UI 16、crypto 7、domain 379、execution 43、providers 768 均通过。首次高并发运行出现 TEMP EPERM 和 Web 超时，不能当作业务通过证据；以上为重跑结果，设施跳过不算集成通过。
- New API `go test ./controller ./model ./router ./middleware -count=1`、`go vet ./controller ./model ./router ./middleware`、`go build ./...` 通过；最后模型调整后重复了 Canvas 定向回归。账号 controller 与模型矩阵在 SQLite 3.50.4、MySQL 8.0.46、PostgreSQL 16.15 均通过，模型矩阵包含新建、旧版升级、重复迁移、轮换与恢复；未运行无关包的完整 `go test ./...`。
- PC 设置同步浏览器冒烟已通过，截图布局已查看。该测试拦截账号/模型接口，未调用生产 New API；本机业务 Docker 和服务器均未升级。
- New API 配套提交：`45e031d48`、`d99b5755a` 已推送 `fork/main`；最终 Tag `v1.0.0-rc.37.custom.33`。普通组误切 Auto 后清空多余路由范围的新增回归也已在三库通过。

隔离验证命令：

```powershell
pnpm --filter @multimodal-canvas/api exec vitest run --config vitest.integration.config.ts src/newapi-account.integration.test.ts
pnpm --filter @multimodal-canvas/api exec vitest run src/newapi-account-client.test.ts
pnpm --filter @multimodal-canvas/web exec playwright test e2e/settings-page-layout.spec.ts -g 'PC 设置页同步后展示服务端自动修复的分组' --project=chromium
go test ./model -run '^TestCanvasAccountDatabaseMatrix$' -count=1 -v
```

集成入口需提供隔离 `TEST_DATABASE_URL`、合成 `API_JWT_SECRET` 和 `WEB_PORT=5173`；New API 矩阵需提供隔离 `TEST_MYSQL_DSN` / `TEST_POSTGRES_DSN` 与 `CANVAS_REQUIRE_DATABASE_MATRIX=true`。日志位于忽略目录 `.local-tests/key-repair-migration/`，包括 `integration-final.log`、`newapi-matrix-final.log`、完整单测和构建日志。测试容器仅含合成数据，未触及业务数据。

## 授权边界复核

已阅读 OWASP Authentication、Session Management、OAuth2 Cheat Sheet，并核对 ASVS 5.0.0 中 8.2.1/8.2.2/8.3.1（服务端功能和对象权限）及 16.2.5/16.5.1（日志和错误不泄露凭据）。修复仍使用本人有效 grant，逐次验证当前可用组、原管理关系和修订；不会采用浏览器传入的管理 Key。集成回归覆盖跨所有者、撤销、登录重放和丢包幂等；New API controller 验证修复审计不含旧 Key、新 Key 或 grant bearer。本记录仅说明本次受影响控制的验证，不代表全站 ASVS 认证。
