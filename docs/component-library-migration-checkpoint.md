# 通用 UI 组件库迁移

## 目标与基线

任务 P1，按大型变更交付。以 Ant Design 6.6.5 替换通用按钮、输入框、选择器、Dialog、菜单、Popover 等自定义/原生控件，不重写画布节点和生成流程等业务组件。保留现有主题、PC 布局、显式节点尺寸、IME 和结构化资源引用。

- 起点：`codex/generate-to-new-node @ a22b223`，上游 `origin/codex/generate-to-new-node`。
- Node `v24.12.0`、pnpm `11.19.0`。共享 UI 原基线 3 项通过；上一任务 Web 953 项通过；既有 smoke 的 25 项失败已在迁移前复现。
- 初始 Web 静态扫描：242 个原生 button/input/textarea/select/dialog/details 标签，包含需要保留的隐藏文件输入与媒体原生接口。
- 通过项目 pnpm 安装精确版本 `antd@6.6.5`，更新 Web/UI manifest 和锁文件，移除未使用的 Radix Dialog、CVA 依赖及旧菜单定位 hook。
- 用户已有 `docs/resource-input-compatibility.md` 修改，不覆盖、不提交；保留 Git blob 哈希 `0f0688d28fd19f8f9cea3a79666c505e6a6e2e03`。

## 实现与验收状态

- [x] 依赖盘点、固定版本接入；不涉及服务端或数据迁移。
- [x] 共享 Button/Input/Textarea/Modal 改为真实库组件，统一中文文案、主题和 DOM ref 兼容。
- [x] 工作台、节点编辑、Skill、设置、资源管理、导航的 Select/AutoComplete/菜单/浮层/表格等通用控件按模块迁移。
- [x] 保留原业务断言并补齐真实组件回归，明确必要原生例外。
- [x] 完整单元回归、lint/typecheck/build、PC 浏览器交互和截图、控制台、最终 diff/敏感信息核对。

### 收尾修复

- Modal 的渲染包装层不改变业务 grid/flex；显式宽度、padding、自定义 Title/Description ID 与 ARIA 关联保留。关闭回调仅在 preventDefault 时取消默认回焦，并覆盖常驻受控、条件卸载和 StrictMode。
- Textarea 不自动长高；原生选区和 IME 继续工作。资源引用仍在光标旁搜索、竖排筛选及滚动，删除最后一处引用名称会移除对应引用资源，撤销可恢复。
- 右键菜单缩小视口后，屏幕锚点限制到当前视口，Dropdown 负责双轴避让；创建节点仍使用冻结的画布坐标。资源复合搜索框的背景和焦点样式继续由外层承载。
- 画布快捷键识别库菜单、列表和 Tabs；React Flow 的默认 Backspace 删除监听关闭，统一走已有业务删除、历史记录和保存。真实菜单内 Delete/Backspace/撤销/重做不改变画布；菜单关闭后节点键盘删除与撤销仍正常。
- SkillAction 的真实 Tooltip 保留 hover/定位，焦点状态在微任务中更新并复核挂载、DOM 连接及实际焦点。已定位的 effect 内 flushSync 开发警告由 8 次降为 0；未关闭 StrictMode、过滤错误或修改依赖内部实现。

## 最终验证（2026-09-24）

- `pnpm lint`：9 个任务通过；`pnpm typecheck`：15 个任务通过；`pnpm build`：9 个任务通过。
- 完整 Web：78 文件、1,061/1,061 项通过（`vitest run --maxWorkers=2`）。共享 UI 16/16；Skill 25、键盘边界 22、WorkflowCanvas 26 项包含在相应验证中。完整 App 集成套件上限 15 秒，未放宽业务断言。
- 其他工作区（不含 Web/UI）1,775 项通过；加共享 UI 后非 Web 共 1,791 项通过；运行时脚本 8/8。Worker 的 4 项、API 的 84 项按原隔离基础设施环境跳过；API 报告总数 899 项，其中未计入通过和跳过的 5 项不作为通过证据，不代表生产验收。
- 最新生产构建预览 `http://127.0.0.1:5188` 的 Chromium 专项 10/10 通过，包含 1440/1024 PC、@ 选择及删除撤销、尺寸不增长、Dialog 嵌套焦点/Escape/IME、五种可选主题、菜单边缘避让、资源保存/归档/恢复、审计分页、预览回焦、设置/Skill/生成说明布局与画布快捷键隔离。控制台错误断言为空。
- 原先通过的 smoke 35 项在最新构建上 35/35 通过；右键边界和搜索框场景额外重复 5 轮共 10/10。既有 smoke 总计 60 项中另 25 项失败已在迁移前复现，本轮未声称整套 e2e 全绿。
- 开发服务 `http://127.0.0.1:5173` 的设置/Skill 原场景通过，8 次 flushSync 警告降为 0；新增菜单键盘隔离场景也在开发服务通过。
- 浏览器验证使用隔离路由与本地素材，没有真实 Provider 或付费调用。静态扫描仅保留 3 个隐藏 file input（ResourceMentionEditor、AssetNode、ResourcePanel）；媒体、SVG、画布与业务资源卡片保留原生底层接口。
- 最终任务范围 111 个文件，扫描未发现真实凭证或生产 debug 输出；唯一长 token 命中是浏览器 Mock 的明确合成值。用户文档哈希保持不变。

## 风险、后续与回滚

- Web 主 JS 1,873.32 kB、gzip 578.88 kB，保留大 chunk 警告。按路由/业务模块分包属于后续性能任务，本次不扩大范围。
- 既有 25 项 smoke 基线失败、需真实基础设施的跳过测试、生产和供应商验收仍独立保留，不由本轮 UI 测试替代。
- 影响前端 DOM、样式、焦点和键盘行为；不改 API、存储格式、资源文件或付费调用。依赖已固定并写锁，可回退此次任务提交、按旧锁安装恢复；用户既有改动不在提交内。

## 本地证据与交付目标

- 最后成功的关键验证：完整 Web 1,061 项；最新构建专项 10 项及原 smoke 35 项；根 lint/typecheck/build。
- 日志：`.data/component-library-{lint,typecheck,build,browser}-final.log`、`.data/component-library-web-tests-final.json`、`.data/component-library-ui-tests-final.log`、`.data/component-library-backend-tests-final.log`、`.data/component-library-runtime-tests.log`、`.data/component-library-legacy35.log`。
- 截图：`test-results/resource-mention-picker*.png`、`test-results/component-library-{command,resources,audit,preview,settings,skills}.png`、`test-results/component-library-theme-{eye-care,light,dark,sepia,contrast}.png`。
- 开发警告证据：`.data/flushsync-diagnostic-report.md`、`.data/skill-tooltip-browser-before.json`、`.data/skill-tooltip-browser-after.json`。
- 既有 smoke 基线：`.data/resource-picker-smoke-baseline-comparison.txt`。上述本地运行证据按仓库规则忽略，不加入源码提交。
- 交付分支：`codex/generate-to-new-node`；远程 `origin`；annotated Tag：`v2026.09.24-antd-ui-migration`。代码与验收已完成，Git 交付在本检查点之后执行，最终结果以远程分支和 Tag 引用核验为准。
