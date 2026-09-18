# 节点提示词 Skill

## 目标与基线

- P1：所有媒体节点共用分类 Skill Select；悬浮显示作用，显式优化、预览、采用或放弃。
- 首批 16 项：人物、人物多视图、场景、场景四视图、道具、资产提取、剧本、分镜、图片质感、运镜、微表情、打斗与特效，加原创故事、章纲、正文、局部修订。
- 用户追加 Skill 工作台 CRUD：同一用户跨项目共用；内置可查看/启停/复制，自定义可增删改查。
- 分支 `codex/generate-to-new-node`，起点 `76ce695`；Node v24.12.0，pnpm 11.19.0，依赖已安装。
- 起始用户改动 `docs/resource-input-compatibility.md`，不属于本次提交。
- 基线：NodeQuickEditor / CompactSelect 86 项通过；reverse-prompts API 11 项通过。

## 数据与兼容

Skill 保存稳定 ID 和版本，源自 `G:/novel-studio/doument-canvas` 的漫剧提示词资料；应用内指令整理后随代码发布，不运行第三方脚本或读取资料目录。

节点新增可选 `promptSkillId`，Run JSON 新增可选 `promptOptimization` 来源和结果。新增用户技能表保存自定义技能与内置启停覆盖；迁移只新增表，不修改既有数据。开发无数据库时使用独立文件存储。旧画布不选择 Skill 时行为不变。优化为独立文字 Run，复用模型、凭据、任务和幂等机制；不生成媒体资产、不改动原提示词。只有用户采用时走现有画布历史与保存。

仅发送提示词文字和资源占位标记，不读取图片、视频或音频内容。输出必须保留资源数量、顺序和完整元数据。实际媒体生成仍由用户主动触发。保留用户内容的原语言，固定优化指令使用英文。

回滚：先停止新优化请求，备份画布、Run 以及 prompt_skills 表（本地开发为 .data/prompt-skills.json），再回退应用版本。新增表可原样保留，不执行删表。旧版不会识别新增字段，因此存在丢弃选择信息的风险；不要用旧版重新保存需要保留 Skill 信息的画布。用户已采用的提示词仍是标准 PromptDocument。

## 验收与检查点

- [x] 读取项目和资料、确认现有链路、记录专项基线。
- [x] 共享目录和资源引用不变性校验，domain 专项 11 项通过。
- [x] 用户级技能 CRUD、持久化、并发版本与工作台。
- [x] 独立优化 API / Worker、项目权限、幂等和失败处理。
- [x] 所有节点的分类选择、Hover、预览采用和过期结果保护。
- [x] lint / typecheck / test / build 与浏览器核心流程。
- [x] 最终 diff 与敏感信息扫描，保留用户原有文档改动。

交付分支 `codex/generate-to-new-node`，Tag `v2026.09.18-prompt-skills`，目标上游为 GitHub `origin`；提交及推送以 Git 引用和本轮交付回报为准。

2026-09-18 恢复：未发现新的适用 AGENTS.md、根 README.md 或 TODO.md，按会话规则与 next.md 继续。三名子代理恢复成功，未再出现此前的 403 余额错误。已修复同实例并发幂等、队列发布恢复、账户切换、目录刷新、终态错误和目录初始加载问题。编辑器按节点四周可用区域布局，模型与参数菜单采用顶层浮层，长内容内部滚动。节点完全占满视口、四周没有可用区域时暂隐藏编辑器，平移或缩小后恢复。

## 验证与部署

- 初次恢复后 lint、typecheck、test、build 全部通过；Turbo 命中已有未变化模块缓存。Web 73 文件 / 1009 项，API 60 文件 / 833 项；Domain 129、Provider 354、Worker 258 项。普通测试未配置设施时明确跳过基础设施用例。
- 首次 Playwright 专项 23/23：四种节点 Skill、hover、可编辑预览、应用、丢弃、原文变化保护、保存重载、工作台 CRUD，以及反推和批量生成回归。检查 1366×768、1440×900、1920×1080 工作台截图及完整编辑器截图，测试捕获的页面和控制台错误为零。
- 本机专用设施 `mc-acceptance-test-next-20260917`：迁移前保存 schema 到 `test-results/prompt-skills-schema-before.sql`。仅应用新增迁移 `20260918090000_prompt_skills`，`prisma migrate diff --exit-code` 无差异，未操作现有业务容器或生产数据库。
- 真实 PostgreSQL：Skill CRUD 5 项、运行持久化（含仅补建不覆盖生命周期）专项全部通过。真实 PostgreSQL + Redis DB 15 的随机队列验证发布失败、跨服务重建、同键恢复及终态不重发通过，清理仅限测试随机项目与队列。
- `scripts/verify-isolated.ps1 -Action Test -Project mc-acceptance-test-next-20260917`：基础设施 38、Redis 9、HTTPS 22 项全部通过，零跳过。迁移兼容测试已补上新增表的版本清单。
- 开发启动：`pnpm --filter @multimodal-canvas/web dev --port 5173 --strictPort`；API 使用 `WORKER_PROVIDER=mock pnpm --filter @multimodal-canvas/api dev`。Web HTTP 200，`http://127.0.0.1:3000/health` 返回 `status=ok`。本地 Mock 仅回传原文并显示模拟标识，不冒充模型优化。

恢复过程与复验：

- 重启 Vite 解决旧模块缓存的 `AuthSessionChangedError` 导出错误，页面非空、启动控制台无异常；中断的空白页测试不作为代码结论。
- 重启后首轮全量 Playwright：105 通过、22 失败、3 跳过。15 项涉及旧夹具未声明 Skill 目录，7 项涉及编辑器布局和节点操作，保留日志 `test-results/prompt-skills-e2e-final.log`。
- 已补齐 6 个旧夹具；相关专项 27 通过、1 条件跳过，日志 `test-results/prompt-skills-fixtures.log`。布局与 Skill 专项 19/19、两组件 107/107 通过。
- 布局修复后全量 Playwright 127 通过、3 跳过，日志 `test-results/prompt-skills-e2e-verified.log`。截图复查后补窄编辑器工具栏换行，模型入口至少 140px；最终版本再次全量 127 通过、3 跳过，耗时 4.6 分钟，日志 `test-results/prompt-skills-e2e-release.log`。跳过项为需真实账号的能力可见性、需收费授权的图片编辑和需单独标注的性能比较。
- 单测曾与构建及浏览器同时运行，出现 5 个 5 秒超时；停止其他验收后单独运行 `pnpm test` 全部通过，不提高超时或移除用例。Web 1042、API 850、Domain 131、Provider 354、Worker 258、UI 3、可观测性 21、凭据加密 7 项通过；API 66、Worker 3 项设施/真实请求条件用例跳过。13 个 Turbo 任务成功，11 个输入未变化的任务命中缓存，日志 `test-results/prompt-skills-test-release.log`。
- ProviderJob 身份落库失败后，禁止仅凭 credentialId 把 Mock 任务升级为真实调用；缺少可靠身份时明确拒绝自动补发。新增 2 项故障回归，BullMQ 专项 22 项通过。该罕见故障需运维核对原任务，不允许客户端换键自动重发。
- 最新真实 PostgreSQL/Redis 专项 3 文件 36 项通过，零跳过，日志 `test-results/prompt-skills-postgres-final.log`。

最终 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`git diff --cached --check` 通过，日志使用 `test-results/prompt-skills-*-final.log`。`prisma validate` 首次因未设置 DATABASE_URL 拒绝，显式设置隔离测试库地址后通过；没有写入项目环境配置。任务 60 个文件的密钥模式扫描无命中。已复查三种 PC 尺寸的长预览、用途提示与工作台截图；页面启动 HTTP 200，控制台无错误，API 健康检查正常。

验收后停止本轮 Web/API 开发进程，未改动既有业务设施。再次启动使用上面的 Web/API 命令，入口 `http://127.0.0.1:5173/workspace`。

正式数据库部署需先备份，再执行 `pnpm exec prisma migrate deploy`；本轮仅验收隔离库。无数据库时 `.data/prompt-skills.json` 按 API 工作目录保存，仅支持单进程，不适用生产多实例。Skill 提交的项目级并发保护限同一 API 实例；跨实例严格运行配额仍需数据库/分布式原子准入，不属于本轮共享库 CRUD 的保证。真实 Provider 效果与费用未验收，未发送新的收费请求。原有 Vite 大包警告保留；手机适配后置。

## 2026-09-18 配置收纳（完成）

- P1：Skill 分类、优化模型、工作台入口和优化命令收进 Skill 按钮的悬停浮层，点击可固定；关闭不影响任务或结果预览。
- 输入框宽度由 520px 增加到 570px，保持画布边界限制和节点四周避让。仅改 PC Web UI，不变更接口、存储或收费调用。
- 起点 `bf08188`，分支 `codex/generate-to-new-node`；Node v24.12.0、pnpm 11.19.0，本地依赖齐全。原有用户修改 `docs/resource-input-compatibility.md` 不纳入任务。
- 基线：`pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/PromptSkillPanel.test.tsx src/workspace/NodeQuickEditor.test.tsx --reporter=dot`，2 文件 / 116 项通过。
- 已完成浮层及宽度实现；配置关闭会卸载嵌套菜单，但保留模型选择、待确认请求及可编辑预览。修复窄视口宽度计算，正常空间为 570px，空间不足时保留 8px 边距和节点避让。
- 首轮全仓 lint / typecheck / test / build 通过，Web 1058 项；首次浏览器专项 12/14 通过，发现 Dialog 捕获 Escape 提前关闭及禁用按钮失焦漏收起。已补焦点监听与 Dialog 关闭防护，并加入回归。
- 最新命令：`pnpm --filter @multimodal-canvas/web test:e2e prompt-skills.spec.ts --workers=2 --output=../../test-results/skill-popover-e2e-fixed --reporter=line`，14/14 通过。三种 PC 尺寸截图已复查，1920px 视口验证实际编辑器宽度为 570px，页面/控制台错误零。
- 开发启动 5173 无冲突，首页 HTTP 200；验收结束后停止本轮开发进程。重新启动沿用上文命令和 `http://127.0.0.1:5173/workspace`，未启动真实 Provider 或修改数据库。
- 全量浏览器首轮 127 通过、3 条件跳过、2 中断：组拖动用例 Chromium 启动超时；四类媒体用例被补充测试文件触发的 Vite 重载打断。后续验收冻结源码与测试文件，仅重跑幂等检查。最后补上捕获阶段外部点击，保证编辑器阻止指针冒泡时空白区域也可关闭配置。
- 冻结后全仓 `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` 全部通过，Web 1060 项；未变化模块使用 Turbo 缓存。API 66、Worker 3 条件用例仍跳过。最终浏览器复验 18/18 通过，包含全部 14 条 Skill 用例、两条中断用例和两条入口回归；日志为 `test-results/skill-popover-*-release.log`。结合全量首轮，129 条浏览器用例均获得通过记录，原有 3 条条件跳过不变。
- 三种 PC 尺寸无配置裁切，完整 Dialog 与嵌套菜单依次关闭，模型/预览/任务身份不丢失。已复查 diff、格式和密钥/调试代码模式，无新增依赖或迁移；保留原有 Vite 大包警告和真实 Provider 效果未验收的限制。
- 交付目标 `origin/codex/generate-to-new-node`，Tag `v2026.09.18-skill-popover`；仅包含本轮 Web UI、测试与检查点。回退本轮 UI 提交即可恢复旧布局，不影响既有 Skill 数据和提示词。

## 后置

- 跨 API 实例及普通生成/Skill 混合竞争的严格运行配额原子准入。
- Skill 文件导入导出、工具脚本执行、自动技能组合。
- 参考视频理解与完整 Agent 工作流。
- 长篇连续自动创作的章节状态管理、内容审核、生物群像和独立服饰预设。
- 题材、画风和时长先尊重用户提示词，后续再增加专门选项。
