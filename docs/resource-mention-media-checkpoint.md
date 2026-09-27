# 资源提及媒体目录限制修复

2026-09-27，P1。取消模型目录媒体列表造成的资源提及误拦截，覆盖 `gpt-image-2.5-sunburst` 单份与两份生成。

## 基线、验收与边界

- 分支 `codex/generate-to-new-node`，起点 `23830134b12c6efccb29d47d054927e3a045e8a1`，跟踪 `origin/codex/generate-to-new-node`。
- Node `v24.12.0`、pnpm `11.19.0`，使用已有本地依赖和锁文件。工作区原有 `docs/resource-input-compatibility.md` 删除，不恢复、不纳入提交。
- 同一起点的诊断基线：API 资源预检/路由 37 项通过；Web 批量提交等定向 9 项通过，其余 107 项未选中。六个 Docker 服务 healthy，入口 `http://localhost:8080`。
- 本地目录在 2026-09-27 19:10（UTC+8）将该模型的 `input_media_types` 和 `mentionMediaTypes` 都同步为 `["text"]`。API 因此在创建 Run 前返回 400；这不构成供应商真实能力证据。
- 验收：目录缺失、仅文字、空列表及媒体字段别名不再决定提及输入是否受理；图片、版本和输入顺序不丢失；两份各自独立提交且不重复 POST。
- 保留权限、资产冻结、实际适配器映射、图片编辑格式/数量、模式/角色/组合限制及失败停止机制。不更改生成数量逻辑，不按模型名特判，不触发真实供应商调用。

## 影响与回滚

本次改变 API 的资源提及受理条件，不改变响应结构、数据库、依赖、凭据、画布或资产格式，无数据迁移。媒体目录仍可返回展示，但不能代替实际接口判断。

本地部署前检查在途任务，保留修复前 API 镜像和全部数据卷；不删除、覆盖用户数据。回滚时先停止新提交并处理在途任务，再切回修复前代码/镜像。回滚会恢复目录媒体拦截，不需要数据库回退。生产部署和付费验收不在范围内。

已保留本地回滚镜像 `multimodal-canvas-api:before-resource-mention-media-20260927`，镜像 ID 为 `sha256:6a6598fca7917bc83fcc6c94d355623d2fe706a032421888d47f5e98f91e7595`。初次检查及正式替换容器前均没有在途运行。

## 执行检查点

- [x] 核对分支、用户改动、运行版本、目录数据、历史取消范围和本地拒绝路径。
- [x] 增加先失败的媒体目录回归，取消 API 媒体白名单硬拦截；同步反推等复用入口测试。
- [x] API 路由验证图片冻结与两份独立受理；Web 验证两份提交和失败不重发。
- [x] 运行 lint、typecheck、test、build 及隔离浏览器烟测，区分条件跳过与已通过。
- [x] 检查在途任务并更新本地 Docker，复核服务健康和核心流程。
- [x] 检查完整差异、敏感信息和原有删除；交付引用见下节。

最近验证：新增 7 项目录媒体回归先在旧实现上全部失败，错误原文与用户反馈一致；移除硬拦截后，资源预检、图片反推和本地 API→Provider 图片编辑三个测试文件共 52 项通过。HTTP 适配回归覆盖精确模型、仅文字/空列表目录、多张图片顺序、历史版本字节、`image[]`、单次编辑请求及不重发。

API 路由新增与保留边界共 41 项通过，包含精确模型的单份及连续两份独立请求、冻结 v1 内容、每份一次执行和零外部 fetch。Provider 530、Worker 745、Domain 182、Execution 43、Credential Crypto 7、Observability 21、UI 16 项通过；Worker 26 项因未配置隔离设施/外部条件跳过，不计作通过。共享包及 Worker 的验证日志为 `.local-tests/resource-mention-media-packages-final.log`。

命令：`pnpm --filter @multimodal-canvas/api exec vitest run src/local-image-reference-runs.test.ts src/resource-mention-capabilities.test.ts src/reverse-prompts.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot`。

## 全量验证阶段

- `pnpm lint`：9/9 包通过；变更文档及 E2E 的 Prettier 检查通过。
- `pnpm typecheck`：15/15 task 通过；新增 E2E 独立严格 no-emit 类型检查通过。
- `pnpm build`：9/9 包通过；保留已有约 1.90 MB Web 主包警告，不在本次拆包。
- `pnpm build:runtime` 与 `pnpm test:runtime`：通过，运行时 8/8、零跳过。
- API 全量：873 passed、85 pending/skipped、0 failed、0 todo，JSON 报告 `.local-tests/resource-mention-media-api-report.json`；条件跳过不是对应集成验收通过。
- Web 定向：8/8 通过，其余 90 项按名称过滤未执行；冻结源码后的全量 87 文件、1307/1307 项通过，耗时 625.40 秒，无失败或跳过，日志 `.local-tests/resource-mention-media-web-full.log`。
- PC 浏览器：隔离开发入口连续两轮各 3/3，Docker Web 生产构建在 API 部署前后各 3/3，均零重试、零跳过、零 flaky。验证两份独立结果，以及 400/断网后停止提交，推进时间、恢复网络事件、刷新页面均不自动重发。成功场景无 console error，失败场景只有预期网络错误，全部无 pageerror 或未声明请求。
- 浏览器使用真实页面与仓库位图，全部 API/生成请求由 context route 截获；仅允许同源静态页面资源联网，不修改用户项目。开发入口观察到既有 React Flow #013 样式 warning，本次没有扩大到 CSS 修复。
- `docker compose build api` 与 `docker compose up -d --no-deps --wait --wait-timeout 120 api` 已完成，仅替换 API。部署前在途运行 0；部署后六个服务均 healthy，`/health` 与项目 SPA 均 HTTP 200。运行镜像为 `sha256:552edd46bd5bcfb80ab1febf40523b327deaa1b80377331f7a59de39a02f2e8f`。
- 运行容器、待部署镜像和本地产物的 API bundle SHA-256 均为 `c6fea0f2d08595535ff8688dad59cb4fb498c5768eed2e5921444135de16f8f5`；媒体目录拦截不存在，实际适配器、数量与模式边界仍在。部署后浏览器报告 `.local-tests/resource-mention-media-deployed-browser.json`，截图与 trace 位于 `test-results/resource-mention-media-deployed/`。
- 10 个任务文件的敏感字面量扫描、产品源码调试输出检查及 `git diff --check` 通过；API/Web 冻结源码 hash 未变化，无依赖/锁文件/数据库结构变更。

## 交付与验收边界

按 API 受理行为变更交付到 `origin/codex/generate-to-new-node`，使用中文 annotated Tag `v2026.09.27-resource-mention-media`。提交 ID 与远端一致性以 Git 引用及本次交接的核验结果为准；原有文档删除不纳入提交。

实现、全仓等效检查和本地部署验收已完成。所有生成流使用内存执行器或合成网络截获，不向真实供应商发送创建请求，不自动恢复或重发历史失败任务。本次证明本地目录误拦截已解除，不声称真实供应商一定支持该模型的图片输入或已生成两张图片。
