# 节点交互与反推提示词

## 范围与基线

- 级别 P1：完成 PC Web 五项节点交互需求，反推调用的权限、版本与去重作为 P0 边界。
- 起点 `codex/generate-to-new-node @ 153acc5`；上游 `origin/codex/generate-to-new-node`，GitHub `lysimportant/multimodal-canvas`。
- Node v24.12.0、pnpm 11.19.0；使用现有本地依赖。没有根目录 README / AGENTS 文件，采用会话规则。
- 初始用户修改 `docs/resource-input-compatibility.md` 保留，不计入本次提交。
- 现存服务 5184 / 19301 保持运行，浏览器验收使用隔离服务。
- 修改前基线：提示词 Dialog、设置、浏览器偏好专项共 74 项通过。

## 验收条件

- [x] 节点悬浮直接显示提示词入口与耗时，信息面板入口继续存在。
- [x] 提示词 Dialog 可选择文字模型反推当前资源，独立展示详细提示词与整体摘要。
- [x] 默认采用设置中的文字默认模型；未设置才采用第一个文字模型，保留凭据身份。
- [x] 自动反推开关默认关闭；开启后处理成功回显的新资源版本，同一版本不因刷新或重复事件重复调用。
- [x] 资源名称 hover 预览放大、内容居中、边缘不溢出，不撑大节点。
- [x] 右键菜单采用竖向列表，包含上下文相关的现有操作。
- [x] 从组名拖动可以移动整组，支持缩放后的坐标；悬浮显示成员数与类型统计。
- [x] 相关测试、lint、typecheck、test、build 与桌面浏览器烟测通过。

## 兼容与回滚

反推通过后端运行链路分析冻结资产版本，沿用项目/资产权限与服务器凭据。生成的分析结果独立保存，不能覆盖真实请求记录，也不能把分析输出再次作为自动分析来源。自动执行按版本去重，失败需显式手动操作，不自动重发可能收费的请求。

新增 API 与可选运行标记保持旧画布和运行记录可读，不执行生产数据迁移或覆盖。回滚时先关闭自动反推，再回退 UI/API；保留已有运行记录与资产。供应商真实多媒体理解效果、手机布局不属于本轮本地验收。本轮不调用收费供应商。

新增路由：`GET/POST /v1/assets/:assetId/versions/:version/reverse-prompts`。POST 接收项目、可选模型/凭据、幂等键及自动标志；GET 返回分析与已解析的默认模型，普通用户无需读取平台配置。实际文本存入 `RunResult.reversePrompt`，原始请求记录仍只反映实际发送内容。没有 Prisma 迁移或新依赖；OpenAPI 已同步。

手动提交在当前标签页按用户、项目、资源版本保存待确认请求身份；关闭/刷新 Dialog 后仍复用该身份。明确成功或拒绝后才清除，连接中断不会自动重发。自动提交由后端按版本去重，前端只处理新回显事件；历史 REST 与 SSE 重放不触发付费分析。队列恢复会复用成功结果，发送状态未知时明确失败，不盲目重发。

默认模型优先读取设置页的文字类型默认，包含独立凭据身份；缺省才选目录首个文字模型。无可用模型或供应商不支持所引用媒体时显示明确错误，不偷偷切换连接。纯 MockProvider 没有真实理解媒体的能力，因此浏览器测试用合成结构化响应验证交互，不能据此宣称真实语义效果通过。

当前 5184 前端会通过 Vite 读取改动；19301 是此前启动的内存 API，本轮未重启它以避免丢失临时项目和资源。新反推路由需要新 API 进程，不能把这份旧内存预览当作最新后端。正常持久化部署更新后应重启 API 与 Worker；本轮没有操作生产部署。

## 执行检查点

- [x] 核对 Git、环境、现存服务与用户修改。
- [x] 确认组名按钮阻断拖动、资源 hover 使用小缩略图、耗时与提示词藏于信息面板。
- [x] 节点悬浮与资源预览实现。
- [x] 组移动与竖向菜单实现。
- [x] 反推 API、Dialog、设置与自动去重实现。
- [x] 验证与差异审查，交付当前分支的任务提交及 annotated Tag。

实现与本地验收已完成。独立审查发现的默认模型竞态、历史 SSE 误触发、旧项目回调、关闭 Dialog 丢失请求身份及旧版本读取已修复并补回归。最后一次业务检查：受影响的 16 项浏览器验收及 66 项组件回归通过，Web 构建通过。Git 交付目标为 `origin/codex/generate-to-new-node`，Tag 为 `v2026.09.17-node-interaction-reverse-prompt`；精确提交与远端核验见本任务交接。

## 验证记录

- `pnpm lint`、`pnpm typecheck`、`pnpm build` 通过；构建仍提示既有 Web 主包大于 500 kB，未扩大范围做拆包。
- `WEB_PORT=5173 pnpm test` 通过：Web 892、API 753、Worker 251、Provider 344、Domain 72、观测 21、凭据加密 7；API 59、Worker 3 个依赖隔离基础设施/真实供应商的条件测试跳过。
- 新增浏览器专项：反推 9、悬浮预览 3、组与菜单 5。包含模型默认和同名凭据、开关持久化、上传/排队/即时完成、历史重放、v1 显示而最新 v2、断网后同键恢复、50/100/200% 组移动等场景。
- 联合浏览器验收覆盖 87 项，使用端口 5187、单 Worker，所有外部 API 由合成路由接管。首轮 79 项通过，8 项因旧夹具缺少新 GET 路由和单一耗时选择器失效而失败；同步夹具并补信息入口焦点恢复后，受影响的 `next-acceptance.spec.ts` 全部 16 项通过，87 项均已有通过证据。新旧 Dialog 入口、复制、刷新、明暗主题及 1366/1440/1920 桌面布局均覆盖。
- 日志位于 `test-results/node-interaction-{lint,typecheck,test,build,browser,browser-recheck,web-build}.log`，截图在 `test-results/node-interaction-browser/` 与 `test-results/node-interaction-browser-recheck/`，不提交生成产物。最后差异检查通过，任务文件凭据模式扫描未发现真实密钥。

## 悬浮操作栏布局调整（2026-09-17）

- P2 局部 UI 调整，起点 `codex/generate-to-new-node @ 52b78c9`；Node v24.12.0、pnpm 11.19.0，依赖已安装。
- 验收：提示词入口和耗时并入现有按钮区，取消独占行与分隔线，统一图标、字号和间距；信息 Dialog、反推调用和节点尺寸保持原有行为。
- 不涉及 API、数据格式或依赖变更；不调用真实供应商。原有用户修改 `docs/resource-input-compatibility.md` 保留。
- [x] 读取当前实现与检查点；`pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/AssetNode.test.tsx --reporter=dot` 基线 39 项通过。
- [x] 取消提示词和耗时的独立摘要行，移入“信息”旁的现有按钮区；图标统一为 18px、文字为 13px。耗时仍区分结果与当前执行。
- [x] 桌面宽度允许整排显示；窄窗口在同一按钮区自然换行。悬浮栏继续反向缩放，不改变节点尺寸。
- [x] `pnpm --filter @multimodal-canvas/web lint`、`typecheck`、`build` 通过；`exec vitest run --reporter=dot` 共 67 文件、892 项通过。最终 CSS 调整后样式专项 1 项和构建再次通过。
- [x] `WEB_PORT=5187 pnpm --filter @multimodal-canvas/web exec playwright test e2e/node-hover-preview.spec.ts --workers=1 --output=../../test-results/node-toolbar-inline-browser` 共 3 项通过，覆盖 1366×900、1920×1080、1024×768；已检查截图、弹窗入口、节点尺寸和浏览器错误。
- [x] 原 5184 前端 HTTP 200；差异检查及任务文件密钥/调试代码扫描通过。构建仍有既存的主包体积提示。

实现与验收完成，Git 交付目标为 `origin/codex/generate-to-new-node`。本次为小范围 UI 修复，不新增 Tag；精确提交和远端核验见本轮交接。

## 图片摘要角色优先（2026-09-18）

- P2 提示词规则调整，起点 `codex/generate-to-new-node @ fad9015`；Node v24.12.0、pnpm 11.19.0，本地依赖齐全。保留用户已有 `docs/resource-input-compatibility.md` 修改。
- 图片中有角色时，“整体摘要”仅提炼可见角色的衣着款式、颜色材质、发型妆容、随身配饰和磨损污渍等辨识细节，使用简洁短句，不描述背景、周边摆设、光线或构图。
- 示例措辞为“月白布衫，青裙，发髻松一缕，袖口有薄面灰，右腕旧红绳。”，仅描述图片实际可见的内容，不照搬例句或补全遮挡细节。多人时优先主体，其他主要角色分别描述，不混合衣着特征。
- 仅在没有角色时才概括整体场景、主要物品及空间关系。第二项“详细提示词”仍描述完整画面；视频、音频、文本反推规则保持不变。
- 沿用原 JSON 字段、长度限制、精确资源版本和幂等身份，无 API、数据库、依赖或数据迁移。仅影响更新 API 后新发起的图片分析；旧结果和自动去重记录保留，用户可显式重新反推，不自动重发收费请求。回滚撤销本次提交并重启 API。
- 子代理 `gpt-5.6-sol/max` 仅负责反推规则和 API 回归测试，主代理负责模板、文档、最终验收与提交。
- [x] 定位到服务端通用摘要缺少角色优先约束，并为图片附加专属摘要规则。
- [x] `pnpm lint`、`pnpm typecheck`、`pnpm build` 通过；Web 反推专项 10 项、Playwright 反推浏览器流程 9 项通过，包含当前版本、历史结果、手动重试与自动去重。
- [x] 反推 API 基线 11 项通过；新增模板测试及 API 实际请求/结果断言后专项 15 项通过。`pnpm test` 全量通过，Web 1073、API 863、Worker 258 项通过；API 67、Worker 3 项环境条件测试仍跳过，不计作真实设施验收。基线与专项日志为 `test-results/reverse-prompts-{baseline,specialized}-2026-09-18.log`，工程及浏览器日志为 `test-results/reverse-character-*.log`。

本次为局部服务端提示词修复，不新增 Tag；任务提交推送至 `origin/codex/generate-to-new-node`，最终提交 ID 与远端核验见本轮交接。

不调用真实供应商或使用真实 Key。合成用例能验证发送指令、结果存储与界面交互，不能替代真实图片的视觉语义验收。已有内存预览进程不为本次提示词改动重启，避免丢失临时项目；上线需由运行 API 加载新构建。
