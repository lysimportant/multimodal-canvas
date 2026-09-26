# 节点资源命名、选字引用与并发生成检查点

更新时间：2026-09-26。P1：修复 PC Web 节点编辑与独立运行互相阻塞。

## 基线与边界

- 分支 `codex/generate-to-new-node`，起点 `c9c58e6`，上游 `origin/codex/generate-to-new-node`。
- Node `v24.12.0`、pnpm `11.19.0`，沿用已有依赖和锁文件，未新增依赖。
- 用户已有 `docs/resource-input-compatibility.md` 修改；未覆盖、未提交，部署前后 SHA256 相同。
- 不恢复历史丢图、不做音频扩展、不调用付费 Provider、不迁移数据库、不修改节点尺寸。旧全量 E2E 的夹具问题不纳入本轮。

## 已实现

- [x] 连线资源不再因为缺少 `mentionId` 而禁用保存。名称是目标节点本地别名，写入现有 `resourceRefs`；保留已有引用 ID、版本、其它引用、提示词、源资源名与连线。支持校验、撤销和刷新恢复。
- [x] 鼠标选中文字后显示同一资源选择器，保留搜索、竖排类型筛选和结果列表。选中文字成为 `entityName`，原文不变；首尾空白保留为普通文字。取消、Esc、撤销、重名冲突、160 字上限、旧引用重叠、只读与输入法组合均有回归。
- [x] 前端按节点发布运行/内容写入锁；提交响应尚未返回时就阻断同节点重复操作。快捷编辑器、顶部运行、命令面板和右键菜单使用同一判定，服务端恢复的五种活动状态也只占用对应节点。
- [x] 不同节点可以同时提交和轮询，画布修订保存仍串行，避免多个等待者同时 PATCH。批量生成的 unknown 停止后续提交规则不变。
- [x] Worker 显式配置跨 Run 并发，默认 4，合法范围 1..20；显式空值、非整数或越界值在连接 Redis 前报错。单个 Run 的 DAG 顺序、取消隔离、防重复发送和计费合同不变。

## 验收证据

| 检查                             | 结果                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 资源编辑器/连线资源              | 53 项通过；文本入口 3 项、节点编辑器 127 项另通过                                                                                                 |
| App/WorkflowCanvas 定向单 worker | 68 项通过                                                                                                                                         |
| 全库测试                         | 本地 `turbo.cmd run test --concurrency=2 -- --maxWorkers=2 --minWorkers=1`，15 个任务通过；Web 82 文件、1152 项无跳过；其它包的条件集成跳过仍保留 |
| 运行产物脚本                     | `pnpm test:runtime`，8/8                                                                                                                          |
| 真实隔离 Redis 并发              | 4/4，两个 Run 进入屏障后才释放；含 DAG/产物隔离、并发 1 回滚、取消与 unknown 不重发；清理后随机测试队列键数 0                                     |
| 静态检查与构建                   | 最终 `pnpm lint`、`pnpm typecheck`、`pnpm build` 通过；新 E2E 从 web 包独立执行带 `--types node` 的 TypeScript 检查通过                           |
| Vite 浏览器                      | 六个场景连续两轮，12/12；console.error/pageerror/未知路由/重复创建均 0                                                                            |
| Docker 正式产物浏览器            | `WEB_BASE_URL=http://127.0.0.1:8080`，相同六项 6/6；全部 console 消息、pageerror、未知路由均 0                                                    |

浏览器验证的是实际 UI 与严格 Mock API，不消费真实业务队列。覆盖别名仅一次 PATCH、revision 1→2、刷新恢复且源名不变；真实鼠标拖选后原文不变；取消 0 PATCH/POST；A 创建响应 pending 或 running 时 B 均能独立提交并先完成；双击只产生每节点一次 POST；刷新后通过 GET runs 恢复忙碌与终态。已人工查看 1600×1000 PC 截图。

首次默认 `pnpm test` 因高测试进程并行出现 6 项 5 秒超时（含未修改的设置/资源库/Skill 用例），没有改超时阈值或放宽断言。限制测试进程数后全量通过。资源选择器初跑的两处动画时序断言已改为等待真实可见状态。Vite 开发模式保留 React Flow #013 样式警告；Docker 正式产物六例没有该警告。Vite 仍有既有大 chunk 提示，拆包不在本轮范围。

主要日志均在忽略目录 `.data`：

- `node-resource-full-test.log` 保留首轮失败；`node-resource-full-test-bounded.log` 为最终全量结果。
- `node-resource-{lint,typecheck,build}-final.log`、`node-resource-runtime-test-final.log`。
- `node-resource-worker-concurrency-final.log`：主代理重跑真实隔离 Redis，使用已核实的本机 `canvas-result-recovery-test`（127.0.0.1:16389），只清理随机 `worker-concurrency-test-<UUID>` 队列；未重启或清理该容器其它数据。
- `node-resource-concurrency/repeat.log`、`final-summary.json`、`final-screenshots`：开发浏览器证据。
- `node-resource-production-browser.log`、`node-resource-production-browser-summary.json`、`node-resource-production-browser/`：正式产物浏览器和每例原始网络证据。

## 本地部署与当前恢复点

实现、最终全库检查及浏览器验收均完成。Web/Worker 子代理分别完成独立范围，临时连接错误后均从已保存状态恢复；最终由主代理审查并部署。

- 已构建 `docker compose --progress plain build web worker`。
- 更新前再次只读确认业务队列 active/waiting/delayed/prioritized/waiting-children/paused 全为 0，数据库活动 Run 为 0。
- 仅执行 `docker compose up -d --no-deps --wait --wait-timeout 120 web worker`，未重建 API、数据库、Redis 或 MinIO，未执行迁移或数据删除。
- Web 与 Worker 均 healthy，Worker 实际环境 `WORKER_CONCURRENCY=4`，`http://localhost:8080/health` 返回 200。
- 新建独立后台标签并刷新实际业务项目，已从项目恢复，浏览器 error 日志为空；关闭该验收标签，保留用户原编辑标签及其中未保存内容。用户保存编辑后刷新原页面即可加载新版本。
- 部署门禁、前后镜像身份与用户文档校验记录在 `node-resource-deploy-gate.json`、`node-resource-deployment-before.json`、`node-resource-deploy.log`。

交付采用当前分支的中文任务提交及附注 Tag `v2026.09.26-node-resource-concurrency`，仅推送上游 `origin/codex/generate-to-new-node` 和该 Tag；实际提交与远端核验以 Git 记录为准。不提交用户兼容性文档或忽略目录中的生成物。

## 兼容、回滚与未覆盖项

沿用既有 `PromptDocument`、`resourceRefs` 与 PATCH 保存合同，无数据库或公开 API 迁移。普通 revert 本轮提交并重建 Web/Worker 可回退；仅需恢复串行时设置 `MC_WORKER_CONCURRENCY=1`，确认没有活动任务后更新 Worker。并发限制按 Worker 进程计算，多副本会叠加。

真实 Redis 验收的 Provider、持久授权和计费为合成桩；常规套件的条件性数据库/外部 Provider 测试仍有跳过。本轮没有真实付费并发请求，不将前端 Mock 和队列测试当成上游限流、生产容量或真实计费验收。
