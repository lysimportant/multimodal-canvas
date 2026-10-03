# 三工具包应用内 Skill 强化

## 范围与验收

P1，2026-10-03 开始，2026-10-04 完成本地验收。只修改 multimodal-canvas 的应用内 Skill 目录、工作台中文说明、对应测试及两份任务文档。原始资料只读，不修改 Codex Skill，不新增依赖、数据库迁移、外部采集、付费生成或生产部署。灰灰与洲洲重复资料按指纹合并，不按文件数量制造重复技能。

验收范围：保留现有 18 个稳定 ID 和顺序；强化其中 16 项至 1.1.0；另两项定义不变；新增 14 项 1.0.0，合计 32 项。提供逐项来源映射，验证资源 token 原顺序且各一次、冻结指令版本和自定义 Skill 合同。节点沿用优化直写／撤销；工作台升级沿用预览／采用到草稿／单独保存。

## 基线与兼容

- 分支 `codex/generate-to-new-node`，起始提交 `0caa024`，上游 `origin/codex/generate-to-new-node`；收尾时并行任务提交已推进至 `612a5e5`。
- Node `v24.12.0`，pnpm `11.19.0`，本地依赖已安装；没有安装依赖或修改锁文件。
- 修改前领域提示词专项 26/26。当前工作区另有 UI／移动工作区改动及文档删除，不覆盖、不纳入本任务提交。
- 保留稳定 ID、API 和自定义 Skill 数据。历史 Run 冻结的指令与版本不回写；旧版本待提交请求沿用版本冲突协议，不静默执行新版指令。
- `xianxia-dress-character`、`skill-authoring` 定义及目录之后的领域运行函数均与基线逐字一致。
- 回滚本任务代码提交可恢复旧目录；新增项在旧代码中不可选，历史 Run 与自定义项不删除。无数据迁移。

## 本地验收检查点

- [x] 读取原始资料目录约束、当前目录与领域层基线。
- [x] 去重三个工具包，完成 12 份秋月盈索引、58 项附件检查及32项来源映射。
- [x] 强化16项，新增14项，保留2项原定义并补齐32项中文说明。
- [x] Domain 321/321、API Skill 80/80及最终 PC Web E2E 23/23。
- [x] 最终变更文件复验、格式／类型检查和提交范围审查。

## 测试结果

| 范围                   | 结果及说明                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain                 | 全量321/321，2026-10-04再次完整通过；含旧提示词契约26项与新工具包专项55项。                                                                            |
| API Skill专项          | 29项存储＋16项路由＋35项优化，80/80；2026-10-04再次通过。                                                                                              |
| Web全量                | 串行运行114个文件、2132项：2131通过，1个恢复请求测试仍断言旧1.0.0。断言改为查询当前目录版本后，该文件59/59完整复验通过；未宣称修复后又全量执行2132项。 |
| Web中文说明            | 48/48；2026-10-04与PromptSkillPanel 59项一同复验，两文件107/107通过。                                                                                  |
| runtime／基础包        | runtime 8/8；credential-crypto 7/7；observability 21/21；UI 16/16；execution 43/43；providers 768/768。                                                |
| API全量                | 原日志报告1087 passed、92 skipped；按原日志计数，不对其显示的汇总差额自行补值。                                                                        |
| worker                 | 779 passed、28 skipped。                                                                                                                               |
| PC Web E2E             | `prompt-skills.spec.ts`最终整文件23/23，2026-10-04耗时1.7分钟；本地冻结构建副本，模拟接口，未调用真实模型。                                            |
| lint／typecheck／build | 2026-10-04最终全仓复验分别9/9、15/15、9/9通过；保留已有大chunk警告，未作无关拆包。                                                                     |

最终E2E命令：设置 `WEB_BASE_URL=http://127.0.0.1:5189` 后运行 `pnpm --filter @multimodal-canvas/web test:e2e -- prompt-skills.spec.ts --output=test-results/toolkit-final-20261004`。覆盖四类节点目录、直写／撤销、引用和身份保留、保存重载、Ctrl+S、小PC视口、工作台增改查启停删除、升级预览及32项中文说明和原文切换。截图保存在对应test-results目录，构建副本由独立预览进程提供。

## 环境恢复与边界

- 根 `pnpm test` 的Turbo子进程在Vitest临时目录出现 `EPERM mkdir .../ssr`；调整临时目录及环境无效，改为直接逐包运行相同测试，未修改测试工具配置。
- Web默认高并发引发超时，使用 `--maxWorkers=1 --no-file-parallelism` 串行验收；没有降低断言或更改项目默认配置。
- 并行任务更新App／CSS及dist曾导致HMR与产物中途变化；尝试独立构建遇到esbuild临时文件删除权限错误，随后复制成功构建产物到唯一临时目录，以5189端口提供冻结预览。启动前检查HTTP200。
- E2E先前22/23，小视口撤销时浮层已因截图关闭；补充按现有交互重新悬停后，专项1/1，再完整23/23。没有改变节点交互实现。
- 来源中的示例人物、固定人数／字数／镜头数、模型／引擎和分辨率保证不硬编码。未给时长的通用分镜须确认；10／15秒预设只补默认值，用户明确时长优先。
- 优化链路只接收文字与引用描述，视频逐镜拆解不声称看过视频像素或听过音频。外部集成跳过项、生产部署和真实模型输出质量不在本次已验收范围。

## 提交范围与发布配置

仅允许以下10个文件进入本任务提交：

1. `packages/domain/src/prompt-skills.ts`
2. `packages/domain/src/prompt-skills.test.ts`
3. `packages/domain/src/prompt-skills-toolkits.test.ts`
4. `apps/api/src/prompt-optimizations.test.ts`
5. `apps/web/src/workspace/SkillWorkbench.tsx`
6. `apps/web/src/workspace/SkillWorkbench.presentation.test.tsx`
7. `apps/web/src/workspace/PromptSkillPanel.test.tsx`
8. `apps/web/e2e/prompt-skills.spec.ts`
9. `docs/prompt-skills-toolkits.md`
10. `docs/prompt-skills-toolkits-checkpoint.md`

提交主题：`feat(skill): 基于三套工具包强化并扩充应用内技能`。配置上游为 `origin/codex/generate-to-new-node`，远端 `https://github.com/lysimportant/multimodal-canvas.git`。计划附注Tag为 `v2026.10.04-prompt-skills-toolkits`，不覆盖已有Tag，不强推。提交、Tag和远端一致性由Git对象及交付回复记录，不在待发布快照中预写推送成功。工作区其余改动继续保留，不宣称工作区干净。

## 最终复验命令

- `pnpm --filter @multimodal-canvas/domain test`：321/321。
- `pnpm --filter @multimodal-canvas/api test -- src/prompt-skill-store.test.ts src/prompt-skill-routes.test.ts src/prompt-optimizations.test.ts`：80/80。
- `pnpm --filter @multimodal-canvas/web test -- src/workspace/SkillWorkbench.presentation.test.tsx src/workspace/PromptSkillPanel.test.tsx --maxWorkers=1 --no-file-parallelism`：107/107。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`：分别9/9、15/15、9/9通过。
- `pnpm --filter @multimodal-canvas/web test:e2e -- prompt-skills.spec.ts --output=test-results/toolkit-final-20261004`：配置本地冻结预览后23/23通过。查看工作台中文说明截图，无文本遮挡或越界；截图中的第33项是测试夹具自定义Skill，不计入32项内置目录。

最近成功阶段：最终23项E2E、领域/API/界面专项复验、全仓lint/typecheck/build。命令日志位于系统临时目录的 `multimodal-toolkit-e2e-complete-20261004.log`、`multimodal-toolkit-final-focused-20261004.log` 与 `multimodal-toolkit-quality-complete-20261004.log`；全量分包测试沿用前序日志，不将缓存复用或分批复验描述成全部测试重新执行。

最终提交前审查：仅上述10个白名单文件，暂存区起始为空；凭据模式和冲突标记检查无发现。其他任务已独立提交移动工作区修改；仍未提交的CSS、CanvasNodeToolbar测试及resource-input-compatibility文档删除均不纳入本任务。
