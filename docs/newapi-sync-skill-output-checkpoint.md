# 分组同步与 Skill 升级结果排查

日期：2026-10-06。P0，当前请求恢复与同步状态；PC Web 优先。

## 基线与范围

- `main @ f62e4b6`，代码工作区初始干净，仅本检查点未跟踪；上游 `origin/main`，Node `v24.12.0`、pnpm `11.19.0`，依赖齐全。
- 用户报告设置同步仍提示部分分组失败，以及 Skill 工作台升级完成生成后因返回格式错误而归档失败。
- 目标：确认实际服务版本和失败组原因；按真实结果形态修复 Skill 输出处理，并验证已生成结果恢复不会再次调用模型。
- 不生成新的付费任务、不覆盖业务数据、不清理现有队列；正式部署和业务恢复需明确目标与现有授权。

## 更新前的排查证据

- 本机 `http://localhost:8080` 使用 `multimodal-canvas-app`；API/Worker/Web 容器创建于 2026-10-06 07:07 UTC，早于分组清理提交。
- API 运行 bundle 包含 `resumeBootstrapRepair`，不包含 `retireRemovedGroups` / `claimSynchronization`，确认未部署 `f62e4b6`。
- 只读分组查询：17 组 active；`公益-0.0000`、`难民扶持` 仍 unavailable，原错误为“分组已撤销或不参与画布接入”。设置页对任何非 active 分组给出用户所报通用错误，符合旧版行为。
- 用户提供正式页面报错时，本机业务库与 Redis 尚未找到对应失败记录；不能把两套环境混为同一任务。用户随后在本地重新复现，证据见下一节。
- Skill 解析基线：domain `prompt-skills.test.ts` 26/26、Worker Skill/optimization 聚焦 6/6 通过。当前解析只接受严格 JSON 或完整单层 JSON 围栏；仅凭报错无法判断模型原文是包装、截断还是不符合合同。

## 本地复现证据（2026-10-06 19:04）

- 用户提供本地项目后，只读定位 `skill-authoring` 失败任务 `run_idem_c2693d6705c401921871adacb7e0174ddf7521d7d2da4f67a1e98d42556d64ca`，模型为 `Deepseek-V4.1-Flash`，没有重新创建请求。
- 按原项目和任务身份读取 Redis 加密暂存，返回文字为 1518 字符，以 `{"prompt":"` 开始，在示例内容中途结束，没有闭合引号和花括号。JSON.parse 报 Unterminated string。正文没有经过应用截短；不能通过补括号把不完整内容当成成功升级。
- 冻结 parameters 为空，应用没有设置 max_tokens。已保存的 usage 只有供应商计数，没有 finish_reason；不能据此认定具体上限或上游中断原因，也不猜测并增加模型输出预算。
- 问题一是模型输出不完整；问题二是 Worker 将确定的结果合同失败统一包装为“生成已完成，归档失败”，并对同一错误结果进行无效归档重试。
- 正式站点只读页面另确认“公益”“公益-0.0000”“难民扶持”仍显示失效；未核实正式 bundle 和原任务输出，不能把本地结论外推成正式版本证明。

## 修复与风险边界

- 对 Skill 结果合同错误使用明确的业务错误类型，保留严格 JSON、长度和引用校验；停止同结果的无效自动归档重试，保留 received 回执、用量和暂存记录。
- 工作台要求明确说明可保存指令位于外层 JSON 的 prompt 字段，避免“只输出指令”被理解为输出裸文本。用户输入、语言和资源占位不改写。
- 较长失败文案在工作台中完整换行，失败后保留原草稿、画布和 Skill，不产生预览或自动重发。
- 无数据迁移、依赖或凭据变更。历史失败记录不覆盖，不自动重新生成。回退本轮代码即可恢复原错误处理；已经截断的历史输出仍不能恢复成完整 Skill。

## 验证与本地更新

- `pnpm lint`、`pnpm typecheck`、`pnpm build` 均通过；构建保留现有大 chunk 提示。
- 全包测试分包执行：Web 2438、API 1197、Worker 784、domain 382、providers 768、execution 43、ui 16、credential-crypto 7、observability 21 项通过；运行产物测试 8 项通过。API 108、Worker 28 项设施测试跳过，API 另有 5 项 TODO，不能视为集成验收。
- 根 Turbo 测试在 Windows 临时目录创建时遇到 `EPERM`，改用包内 Vitest 完成上述检查；未宣称单次 `pnpm test` 成功。最终 Worker 仅回执恢复新增断言另行定向通过 2/2。
- Playwright 工作台 AI 升级 3/3 通过，覆盖内置/自定义预览采用保存和失败保留草稿；1440/1366px PC 截图检查及浏览器 console/page error 检查通过。接口完全 Mock，未知出站请求被拦截，不涉及真实用户项目或付费模型调用。
- 最后新增错误换行样式后，Web lint 通过；Windows Web 复构建在 esbuild 临时文件删除阶段遇到 Access denied，仓库 Docker 构建最终完成 9/9 构建任务并成功导出 Web 镜像，不修改系统权限或依赖。
- 本地 8080 的 API/Worker/Web 已通过 Compose 重新构建，仅替换应用服务：`up -d --no-deps --no-build --pull never --wait`。没有迁移、卷清理或业务写入，正式服务器未部署。
- 更新后 API/Worker/Web 健康，`/health` 返回 200；运行 bundle 已确认包含本轮输出错误分类和前一提交的 `retireRemovedGroups` / `claimSynchronization`。最终 Web 镜像再次更新后，8080 返回的工作区 JS/CSS 已核验 JSON 输出合同和错误换行样式。
- 更新前后仍为 137 条 Run（98 成功、39 失败）、1 项目、1 自定义 Skill；队列 active/waiting/delayed 均为 0。本地登录页正常加载，浏览器无错误；用户项目内的真实付费生成未再次执行。
- 旧应用镜像保留为 `multimodal-canvas-{api,worker,web}:before-skill-output-20261006`。需要回退时将对应备份镜像重新标记为 `:local`，再以相同无依赖启动命令替换应用容器；不回退或覆盖数据库。

## 汇报核对（2026-10-06 20:30–20:45，只读）

- 工作区干净，`main` 与 `origin/main` 同步，HEAD `1dff458` 已推送；无未提交改动。
- 运行中的 API/Worker 镜像构建于修复前（Worker bundle 时间 11:42 UTC），但未包含旧行为：两包 bundle 都含 `PromptOptimizationOutputError`（Worker 9 处），API bundle 含 `retireRemovedGroups` / `claimSynchronization` 各 2 处。11:42 UTC 构建的镜像装的是当前源码，说明此前“确认未部署”的结论已过时。
- Web 容器（12:03 UTC，与 `multimodal-canvas-web:local` 一致）经 Caddy 提供 `index-hcV44bMM.js` → `main-B3eNQpU3.js` + `main-CbSxjc59.css`；三者含新输出合同文案（`Do not return bare text`）、`12000` 上限和 `overflow-wrap:anywhere` 错误换行样式，`/` 与 `/health` 均返回 200。
- 库内记录与 Redis 队列一致：`runs` 98 SUCCEEDED / 39 FAILED，queue wait/active/delayed 为 0，failed 39、completed 98。最新失败任务 `3cfa5b53` 的 `error.message` 已是修复后分类文案“生成已完成，归档失败：Skill 返回格式无效：需要包含 prompt 的 JSON 对象。仅重试归档，不会重新生成”。该行与 `apps/worker/src/index.ts` 中 `rawError instanceof PromptOptimizationOutputError` 的终止分支并存，且本次未重跑该任务，故它是修复前写入的**历史**记录，不能当作回归证据。
- 结论：代码、本地镜像与本地服务三者一致，无待办改动；真实供应商中断原因、正式环境部署与同环境验收仍属未完成项，本次只读核对未产生新的付费请求或业务写入。

本地代码、回归验证与应用更新已完成。历史失败任务保持原状态；上游输出为何中断仍需供应商响应或日志证据。正式环境尚未部署、未完成同环境验收。
