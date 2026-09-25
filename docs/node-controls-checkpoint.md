# 节点计时与输入区控件检查点

日期：2026-09-25；P1 局部 UI 修正。分支 `codex/generate-to-new-node`，基线 `5422351770937ce161c5e564b8b652a6fa2d5346`；Node v24.12.0、pnpm 11.19.0。依赖齐全，无安装或升级。

## 范围与最终交互

- 节点悬浮卡片耗时按完整秒数显示：0、1、2 秒递增，12.4 秒显示为 12 秒。继续使用服务端参考时间与单个共享时钟，终态冻结；不修改保存的毫秒值或 domain 公共格式化函数。
- 每节点生成数量使用现有 Ant Design Select，1–20 份，与模型控件同高度、圆角、字体和主题色；保留非法历史值阻止生成、切换节点同步、忙碌禁用、数量保存和全局默认语义。重选当前数量不写历史或把已有结果标成待更新。
- 用户中途明确要求 Skill 与其他工具同行，不再单独占一行。最终放在数量/生成旁，配置、进度、错误、可编辑预览和应用均在 hover 浮卡里；正文只保留一个紧凑按钮。窄的侧边编辑器只收起参数摘要文字，保留参数按钮、可访问名称和 title。
- 浮卡关闭不停止已受理任务、不清除预览、不重复提交。保留点击固定、Escape 逐层关闭、IME、Tab 在预览中顺序导航、快速/完整编辑器往返和显式应用。目录错误也在浮卡展示，收起时按钮保留状态说明。
- 不改变节点外框尺寸；不改 API、数据库、依赖、付费生成或音频处理，不恢复旧图片，不部署或重启业务 Docker。

## 基线、协作与用户改动

NodeQuickEditor/PromptSkillPanel 原基线 169/169。PC 实测原 Skill 触发器拉满整行，数量是与其它设置不同的方框。根目录没有 AGENTS.md 或 README.md，按会话规则和仓库现有 TODO 执行。

主代理负责输入区、Skill 浮卡、样式与浏览器验收；Laplace 负责整秒计时与14项回归；Hegel 负责画布/批量测试的数量选择交互；Lagrange 负责编辑器/Skill 回归；Arendt 只读复核。已处理复核发现的数量同值回调和浮卡 Tab 导航问题，无重叠写入。

原有用户改动 `docs/resource-input-compatibility.md` 未修改、不纳入本次提交，blob 为 `0f0688d28fd19f8f9cea3a79666c505e6a6e2e03`。原始分支已有 origin upstream，推送只使用 `origin/codex/generate-to-new-node`，不推 main 或其它 remote。

## 验证与证据

- 运行时测试：`pnpm test:runtime`，8/8 通过。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm build:runtime` 已通过。Vite 仍有既有大于 500 kB 的 chunk 警告，本任务不做拆包。
- 最终全仓测试：`WEB_PORT=5173 node node_modules/turbo/bin/turbo run test --concurrency=2 -- --maxWorkers=1`，15/15 Turbo task 成功、0 cached，耗时 9m34.57s。Web 82 文件、1117/1117 通过；API 810 passed、84 skipped；Worker 683 passed、13 skipped。此前并行运行出现 ProjectHub 原选择器入场可见性偶发失败；最终串行完整执行已通过，未修改无关组件或削弱断言。
- 最终生产构建经 Vite preview 5176 验证：`resource-mention-picker.spec.ts` 12/12 通过，包括最新 Skill 同行、hover、预览、真实连续 Tab、点击收起重开、显式应用、资源引用保留、五主题和 Dialog 焦点。
- 数量1/2/3、默认数量、新增的3种PC尺寸（1366×900、1920×1080、1024×768）悬浮计时/终态冻结、提示词耗时刷新恢复：最终生产构建专项 8/8 通过，与资源引用整文件合计 20/20 通过。
- NodeQuickEditor 127/127、PromptSkillPanel 55/55，子代理最终复验 182/182 通过，主代理全仓测试再次覆盖；新增计时单测 14/14 通过。
- 所有浏览器请求由 `**/v1/**` 本地 fixture 拦截；无真实优化/生成、无计费请求，未连接业务数据库。
- 截图和日志保存在忽略目录 `.data/node-controls-*`，不提交生成物。已查看 1440/1024、完整 Dialog、hover 配置和优化预览截图；无横向溢出或节点外框增长。
- 最终证据：`.data/node-controls-full-test-verified.log`、`.data/node-controls-resource-production.log`、`.data/node-controls-production-verified.log`；lint/typecheck/build/runtime 的最终日志同目录以 `node-controls-` 开头并以 `final.log` 结尾。

## 已知旧测试与范围外待办

- 旧 `prompt-skills.spec.ts` 在实现改动前已有缺失 auth fixture、portal 定位及冷加载超时，未宣称通过。本轮采用当前完整 fixture 验证 Skill。
- 旧 `node-hover-preview.spec.ts` 的资源预览组合用例仍依赖已移除的 CSS 选择器，且动画中的 boundingBox 断言不稳定；保留未通过记录，不削弱旧断言来冒充全 E2E 通过。新增单独整秒/冻结 smoke；仅补齐同文件的 auth/me mock。
- `next-acceptance.spec.ts` 的联合流程与资源历史两例仍依赖原生 select 的 selectOption/value，当前库 Select 不适用；本轮只同步耗时预期，后续单独更新旧 fixture/选择器。
- 未跑需独立 TEST_* 配置或真实 Provider 的集成验收；常规测试跳过项不代表这些合同已验证。

## 交付与回滚

无数据迁移；现有生成数量、Skill 选择和恢复记录格式不变。回滚使用本任务提交的普通 git revert 并重建前端即可，不回滚用户文档或历史生成结果。

实现与本地验收已完成。本任务使用中文任务提交和附注 Tag `v2026.09.25-node-controls` 交付，仅推送 `origin/codex/generate-to-new-node` 及该 Tag，并以远端分支和 Tag 解引用核验为准。业务 Docker 保持原状态；当前业务地址需另行重建前端才会使用本次修改。
