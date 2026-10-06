# New API 已移除分组清理

日期：2026-10-06。P0，分组目录同步与执行授权边界。

## 基线与验收

- `main @ d2e5248`，上游 `origin/main`，开始时工作区干净；Node `v24.12.0`、pnpm `11.19.0`，依赖齐全，无需安装。
- 原因：`synchronize` 把权威账号列表之外的绑定置为 `unavailable`，但保留目录；`status` 和 `models` 又返回这些绑定，导致设置页显示“分组已撤销或不参与画布接入”，模型选项也留有旧组。
- 目标：上游成功返回的账号分组列表确认旧分组已删除、改名或不再授权后，从当前账号分组、模型和凭据选择目录清理旧组。已有节点/默认选择继续明确失效，不自动换到另一分组。
- 验收覆盖：移除/改名、全部移除、有效组保留、同名组重新纳入、暂时上游故障、迟到同步和 Key 恢复响应，以及旧组禁止新任务受理。
- 客户端基线 10/10 通过；日志位于 `.local-tests/newapi-group-retirement/client-baseline.log`。

## 数据影响与回滚

使用现有字符串状态记录 `removed`，清空已移除组的当前模型目录与自动路由范围；无新增列和 schema 迁移。分组绑定、凭据及轮换历史由旧任务引用，保留为内部档案，不再作为当前分组返回。

只在账号接口成功返回、身份一致时确认移除。网络故障、禁用令牌或可修复 Key 缺失不凭错误推断分组不存在。已冻结的历史任务和素材不改写。

身份的 `syncedAt` 记录最近同步尝试的开始时间，同时用于数据库 CAS 区分并发同步轮次；并发请求在同一毫秒也会领取不同轮次。失败会显示原有同步错误并保留目录，不把这个时间当作成功标记。分组关系的 `syncedAt` 仍记录已应用的同步结果。

本轮只修改源码并使用合成隔离测试，不执行用户数据库清理或正式服务升级。隔离 PostgreSQL 容器 `mc-acceptance-test-group-retirement-20261006` 仅发布 `127.0.0.1:19436`，数据使用 tmpfs，数据库名 `group_retirement_test`；验收在随机 schema 内创建并清理测试记录。真实部署前保留当前镜像与业务库备份；回退代码不会删除历史档案，成功重新同步可恢复权威目录。

## 最终行为

- 已确认移除的分组清空目录、自动路由范围与恢复状态，归档凭据版本并更新操作身份；`status`、`models`、设置凭据列表不再返回它，也不允许验证、修复或轮换它。
- 同名分组被上游重新纳入后重新验证；不同 Key 会保存新密文与版本，旧密文继续归档。首次验证暂时失败仍能在下次同步恢复，原任务快照不会因同名组恢复而重新获得执行权限。
- 同步轮次、事务内身份锁与分组操作身份阻止旧目录和恢复回包复活已移除关系。迟到验证的 401/503 不覆盖新同步，也不撤销新状态下的会话。

## 本轮验证

证据保存在 `.local-tests/newapi-group-retirement/`，不提交合成数据与运行日志。

| 验证                                                                                                                                | 结果                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 账号集成基线                                                                                                                        | 30/30 通过                                                                                                                                           |
| `pnpm --filter @multimodal-canvas/api exec vitest run --config vitest.integration.config.ts src/newapi-account.integration.test.ts` | 最终 37/37 通过，隔离 PostgreSQL；包括移除/重建新 Key、首次恢复 503 后重试、全空/改名、缺 Key 恢复、迟到账号/修复/验证响应、旧快照拒绝及历史密文保留 |
| `pnpm --filter @multimodal-canvas/api test`                                                                                         | 1,196 通过，103 项设施测试跳过；账号专项另行实际执行，不把普通测试跳过当验收                                                                         |
| `pnpm exec turbo run test --force --filter='!@multimodal-canvas/web' --filter='!@multimodal-canvas/api'`                            | 共享包与 Worker 共 2,019 通过，28 项设施测试跳过                                                                                                     |
| `pnpm test:runtime`                                                                                                                 | 8/8 通过                                                                                                                                             |
| `pnpm --filter @multimodal-canvas/web test`                                                                                         | 首轮 2,423 通过、14 失败，涉及 8 个文件，多数为并发负载下的超时，并伴随 Skill 测试迟到异常                                                           |
| Web 失败文件单独复跑：`vitest run <8 个文件> --maxWorkers=1 --no-file-parallelism`                                                  | 8/8 文件、519/519 测试通过，无未处理异常；没有修改生产 Web 或放宽超时。不宣称原并发全量命令一次通过                                                  |
| `SettingsPanel.test.tsx` 专项                                                                                                       | 10/10 通过，成功移除/空目录/503 保留/旧默认不自动换组                                                                                                |
| `WEB_PORT=5188`，`settings-page-layout.spec.ts --project=chromium --workers=1 --grep 'PC 设置页同步后清除无效分组'`                 | 1440×900 Chromium 1/1 通过；真实页面启动、目录刷新、旧默认失效、零控制台/页面错误；API 使用拦截夹具                                                  |
| lint / typecheck / build                                                                                                            | 全 workspace 强制检查通过；最后 API 修改后再次单独 lint/typecheck/build 通过。构建仍有原有大 chunk 提醒                                              |
| `git diff --check`                                                                                                                  | 通过                                                                                                                                                 |

Web 复跑文件为 `App.resource-mention-sync.test.tsx`、`App.test.tsx`、`canvas-editor.test.tsx`、`settings-panel.test.tsx`、`management/ResourcePages.test.tsx`、`workspace/NodeQuickEditor.test.tsx`、`workspace/SkillWorkbench.test.tsx`、`workspace/WorkflowCanvas.test.tsx`。截图检查确认旧组退出表格与模型选项，旧默认保持“未选择”，页面无溢出。

本轮没有部署现有本地 Docker 或正式服务，没有真实 Provider 请求。使用新版本后，登录、会话刷新或设置页“同步分组与模型”触发清理。剩余生产/真实合同验收继续遵循 `TODO-CONSOLIDATED.md`，不因本次合成测试关闭。

验收结束后已删除本任务的隔离 PostgreSQL 容器及其 tmpfs 合成数据；未停止其他服务。
