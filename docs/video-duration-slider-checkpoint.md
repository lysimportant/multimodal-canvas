# 视频时长滑块与参数复核检查点

更新时间：2026-09-30。任务级别 P1；主目标为视频时长交互改为 5–30 秒滑块，新建默认 10 秒，并复核既有图片档位及视频传值。

## 基线与边界

- 工作区 `G:\multimodal-canvas`，分支 `codex/generate-to-new-node`，基线 `f7dd2f22d73539818042d75f0b6559f2c34ef116`，upstream `origin/codex/generate-to-new-node`。
- Node `24.12.0`、pnpm `11.19.0`、Git `2.53.0.windows.1`；依赖与锁文件已存在，无新增依赖计划。
- 用户原有删除 `docs/resource-input-compatibility.md` 保留，不恢复、不暂存、不纳入本任务提交。没有工作区 AGENTS 或根 README，遵循本次会话提供的规则，已读 `TODO-CONSOLIDATED.md` 与图片参数修复文档。
- Web 基线：`pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/NodeQuickEditor.test.tsx src/workspace/node-generation-defaults.test.ts`，189/189 通过。日志在忽略目录 `.local-tests/video-duration-slider/`。
- 不发收费生成请求、不重放历史 Run、不修改真实项目保存参数、不迁移数据库、不扩大供应商合同。历史低清图片不会自动重生或放大。

## 验收条件与方案

- 原生滑块范围 5–30 秒、步进 1 秒；显示当前秒数、模型约束和错误，支持拖动与键盘，保持浮卡层级、焦点、Escape、只读交互。
- 新建或明确切换模型时，未设置的视频时长写入数字 `10`，而不是只让滑块视觉停在 10。目录或模型不支持时明确拒绝生成，不暗改为其它秒数。
- 历史未设置、2/4 秒、自动 `-1` 及无效值保留；打开卡片不保存。自动时长使用独立按钮，清除为显式动作。已确认的编辑/延长合同不变。
- 图片 1K/2K/3K/4K 同时检查文生图 JSON、图生图 multipart；视频核对精确模型身份、duration、resolution、aspect ratio 与模式边界。
- 单测、lint/typecheck/build、严格 Mock 桌面 E2E 和控制台检查通过；Mock 禁止任何未声明业务请求透传。最终检查 diff/敏感信息后提交并推送 upstream。

## 当前阶段

1. 滑块、样式和默认值已实现；新建默认值红测确认旧实现缺失 10 秒，修改后交互与默认值测试通过。所有代理已交回文件，后续由主代理串行维护，不存在并行编辑。
2. 参数审计发现小写 Moon H3 缺失时长会被网关拒绝，已补 Provider 创建 POST 前守卫和 Web 必填提示。仅涉及现有视频合同，没有新增外部请求或更改数据库格式。
3. API/Worker/Web 已构建并部署到本机，8080 健康检查为 200，六个 Compose 服务均 healthy。PostgreSQL/Redis/MinIO 容器 ID 未变；保留三个旧应用镜像的 rollback-video-duration-20260930-f7dd2f2 标签。
4. 最终只读比对仍为 revision 601、14 个节点、8 条边、26 条 Run，节点/边/Run 摘要与任务初始一致；全局在途 Run 和未发布 outbox 均为 0。当前视频参数仍是精确小写 minimax-h3、10 秒、480p、16:9。
5. 5188 为隔离 Vite，5189 为从已部署容器复制的静态产物预览，无 API 代理。5189 的全部三个 JS/CSS 文件与 8080 实际资源 SHA256 一致，部署后严格 Mock 冒烟 6/6 通过。相关旧 E2E 已修正 Portal、控件角色和 Select 内部输入边界假设，最终整组复跑通过。

## 参数审计与阶段验证

- Domain 252/252、原 Provider 701/701 通过。额外内存检查：图片 1K/2K/3K 的 96 组合与视频 22 组合通过；所有创建请求使用 stub，公开 Moon 插件仅执行内存解码，没有调用真实上游。
- Moon H3 缺失时长的新红测复现旧问题；修复后目标参数文件 99/99、Provider 全量 725/725 通过。验证缺失/空值/别名、0 fetch、0 请求记录与 submitting 回调、不改快照及其它合同兼容性。
- Web 交互与默认值 220/220 通过（193 + 27）；两桌面严格 Mock 参数 E2E 52/52 通过、零重试，参考点专项另跑 6/6。截图位于 test-results/video-duration-agent-final，主代理已复核快捷/完整浮卡、模型不支持提示及两桌面尺寸。
- Web 全量 1449/1449 通过；Domain 252/252、Provider 725/725 再次全量通过，Worker 766 通过、28 条条件跳过；API 928 通过、85 条条件跳过。没有重新启动隔离数据库测试，不能把这些跳过项写成真实验收。
- 全仓 lint、typecheck、build、build:runtime 和 8 项 runtime 测试通过。四个修改过的 E2E 文件还单独执行了 strict/noUnusedLocals/noUnusedParameters 类型检查，通过。
- 旧 smoke 的 13 项相关 PC 用例全部通过；参数浮层 7 项及批量生成 7 项全部通过，均零重试。加上新的参数提交 52 项，共 79 项相关桌面 E2E 通过；两次专项复核及部署产物冒烟单独记录，不重复计入这 79 项。
- 一次并行构建读到尚未完成的交互测试编辑，出现 TS1109；该测试文件修复并冻结后，最终类型检查和构建已通过。Vite 既有大 chunk 提示仍在，不做无关优化。
- 首次误将部署后 Mock 验收目标指向 8080，六项均在导航前被测试安全守卫拒绝，没有放宽守卫；改用无代理的 5189 相同产物后 6/6 通过。日志分别为 deployed-smoke.log 与 deployed-bundle-smoke.log。
- 旧 smoke 的失败来自过时的 Portal 后代、模型选项名称、控件角色及内部输入边界假设。保持原有对齐精度，按参数格读取稳定几何；1440/1024 两项已通过，未改生产布局迁就测试。动画等待不能替代修正内部输入框与完整控件的边界差异。
- 最终交付按明确的 13 个任务文件提交到当前分支，使用中文提交及 annotated Tag v2026.09.30-video-duration-slider，推送 origin/codex/generate-to-new-node 并核验远端；用户原有删除不暂存、不提交。

## 证据与恢复

- 所有主代理日志位于忽略目录 .local-tests/video-duration-slider；packages-final.log、web-final.log、api-test-final.log、build-final.log 和 deployed-bundle-smoke.log 保存相应结果。旧 E2E 最终结果为 legacy-verified.log 的 13/13 与 overlays-batch-verified.log 的 14/14。
- final-data-comparison.json 保存任务初始与最终数据摘要；deployed-all-bundles-proof.json 保存三份静态资源哈希；containers-before.json、containers-after.json 与 rollback-images.json 保存容器和回滚镜像身份。
- 已执行 docker compose build api worker web 及 docker compose up -d --no-deps --no-build --wait --wait-timeout 180 api worker web。交付仅替换三个应用镜像，没有执行数据迁移或重建数据服务。
- 回滚前先停止新提交并确认在途任务，只替换应用镜像，不回退画布、Run 或资产，不重放历史请求。回滚目标 f7dd2f2 已含图片尺寸修复；本轮回滚只撤销滑块及 Moon H3 必填时长守卫。
- 本轮自建的 5188/5189 QA 服务已停止并确认端口释放；8080 与全部六个业务服务保留，最终健康检查通过。

## 待验证风险

- 模型目录和本地序列化测试不能证明真实上游一定按档位输出；收费验收继续遵循 TODO 的既有待办。
- 精确大小写 `MiniMax-H3` 与 `minimax-h3` 是不同合同，不能按显示名称混用分辨率白名单。
- 新建默认 10 秒若不属于某模型的枚举，必须在生成前提示用户重新选择；不能把默认值当作能力声明。
- 视频参数的 API 入队前集中预检仍是独立待办：当前 Web 与 Provider 会拒绝无效值，但绕过 Web 的请求仍可能先创建失败 Run；见 TODO-CONSOLIDATED 的 P1-02。
