# 资源分类与视频参数浮层修复检查点

更新时间：2026-09-27。任务等级 P1，PC Web 局部界面修复。

## 基线与边界

- 分支 `codex/generate-to-new-node`，起点 `4b6375d4ef6a47ae9a4e349d4c834f416a072269`。
- Node `v24.12.0`、pnpm `11.19.0`；沿用 Ant Design 6.6.5，无依赖或锁文件变更。
- 初始 Git 仅有用户删除 `docs/resource-input-compatibility.md`；不恢复、不暂存、不提交。
- 侧栏基线 ResourcePanel/CompactSelect **28/28**；NodeQuickEditor 基线 **141/141**。上轮 87 文件、1302 项 Web 测试日志与起点提交一致。
- 不改变 Provider、API、数据库或资源格式；不修改用户提示词、资源及节点持久化几何，不触发真实生成。
- 本轮跨资源栏与节点参数两个组件，按较大变更交付一个任务提交和附注 Tag，不扩展到移动端或其它功能。

## 验收目标

- [x] 分类标题无旧底色、边框或聚焦外框；筛选、搜索、抽屉与文字焦点提示正常。
- [x] 秒数浮卡位于生成参数上方；5/10/15/30、自定义均完整展示，可用项遵循原模型能力。
- [x] 视频比例值、图形和短中文说明不挤换行；短清晰度仍紧凑排列，模型长名称正常换行。
- [x] 最终 Web 全量 87 文件、1305 项全部通过；专项、lint、类型、构建及浏览器检查通过。
- [x] 最终 diff、源码冻结 hash 和敏感信息检查通过；交付只包含本轮 11 个文件，保留用户原有删除。

## 实现

### 资源分类

- 清除 `index.css` 中资源筛选的旧表单皮肤及主题覆盖，使用 borderless Select，不叠加两层背景。
- 根控件不再描边或加阴影，只读输入不继承全局 input 的焦点描边；聚焦时给标题文字加下划线，保留键盘可辨识性。
- 不改变筛选、搜索、上传、归档及自动抽屉状态逻辑。

### 嵌套参数浮层

- 原时长 Popover 层级为 1030，父 Dropdown 为 1050，导致子卡片被盖住。
- 参数页改为 Popover 容器，使用组件库的嵌套层级上下文，不硬编码超大 z-index；快捷编辑器和完整 Dialog 均覆盖。
- 保持原 portal 位置，避免嵌入滚动容器被裁剪；IME、逐层 Escape 关闭及回焦保持有效。

### 视频选项

- 原固定三列把比例图形与文字挤在不足的单元格内，16:9、21:9 和摄影横向等均出现断行。
- 短枚举按内容宽度换列，主值及短说明保持单行；不使用省略号隐藏文字，也不改变长模型列表。
- 子代理 Erdos 负责节点参数模块和新 E2E，已完成并关闭；主代理负责侧栏及最终集成。

## 验证记录

- ResourcePanel/CompactSelect **29/29**；NodeQuickEditor **143/143**；SkillWorkbench 修正异步可见性等待后 **25/25**。
- `pnpm lint`：9/9 包通过；Web `typecheck`、`build`、两个 E2E 文件独立严格 no-emit 类型检查、Prettier 与 `git diff --check` 通过。
- `pnpm test:runtime`：**8/8**。
- 新增 8 个关键浏览器场景在 Docker 静态包重复两轮：**16/16**，零重试。覆盖五种主题、键盘分类、快捷/完整参数页、秒数命中、自定义输入、Wan3/Moon H3 比例、清晰度及长模型名。
- 兼容浏览器回归 **14/14**，零重试：上下布局、75% 换边、缩放聚焦/拖选/滚动、资源引用、完整 Dialog、资源预览、主题、Skill 与同栏数量。
- 原缺陷的回归断言已在旧包中实际失败。开发测试期间发生 Vite 页面重载的轮次不作为验收依据。
- 首轮 Web 全量：87 文件，1304 通过、1 项旧 Skill 可见性断言失败。该用例先查到选项 DOM、但未等待动画结束；原文件单独复跑 25/25。仅把该断言改为 `waitFor` 等待同一可见性条件，不修改 Skill 功能，也不放宽条件或超时。
- 最终冻结版本 Web 全量通过：`pnpm --filter @multimodal-canvas/web exec vitest run --passWithNoTests --testTimeout=15000 --maxWorkers=1 --minWorkers=1 --reporter=dot`，**87/87 文件、1305/1305 项**，耗时 **596.93 秒**，进程退出码 0。随后确认 8 个源码/单测 hash 与测试前冻结值完全一致。

## 部署与真实项目

- 已执行 `docker compose build web` 及 `docker compose up -d --no-deps --wait --wait-timeout 120 web`。
- 仅 Web 容器更换；API、Worker、Postgres、Redis、MinIO ID 全部不变，6 服务 healthy，健康检查和项目页 HTTP 200。
- 新入口包 `index-BToq3Qi6.js` 已加载。真实项目仍可读取 6 项资源，提示词未编辑，控制台无错误。
- 实际测得参数页 z-index 1030、秒数浮卡 1200，4 个预设、自定义标签及输入框中心均命中对应控件，无遮挡。
- 实际 Moon H3 的 8 项比例值和 8 项说明全部单行，未截断；资源标题、控件和内部输入背景透明、无可见边框/描边/阴影。
- 真实页面验收时，快速关闭选项动画后的一次点击误选为 21:9；已只恢复该项为验收前的 16:9，等待保存并刷新确认当前参数为 480P / 16:9 / 10 秒。未调整其它参数、提示词或资源，未运行生成。

## 日志与恢复

- 最终全量：`.local-tests/resource-parameter-final-vitest.log`；首轮失败保留在 `.local-tests/resource-parameter-first-full-vitest.log`。
- 浏览器：`.local-tests/resource-parameter-docker-core.log`、`.local-tests/resource-parameter-docker-regression.log`。
- 源码冻结校验：`.local-tests/resource-parameter-frozen-final-source.json`；构建、部署及容器比对使用同目录下 `resource-parameter-*` 文件。
- 最终截图：`.local-tests/resource-parameter-delivery/`，均来自隔离测试画布，不代表用户资源数量。
- 验收结束时再次确认项目页 HTTP 200、加载 `index-BToq3Qi6.js`，6 个 Docker 服务全部 healthy。最后一轮 `pnpm lint` 为 9/9 包通过，Web typecheck 退出码 0。

## 交付定位

- 任务提交主题：`fix(web): 修复资源筛选底色与视频参数浮层显示`。
- 分支：`codex/generate-to-new-node`；附注 Tag：`v2026.09.27-resource-parameter-ui`，用于定位包含本检查点的任务提交。
- 发布目标为现有 `origin`（GitHub）与 `gitee`；分别核对分支 SHA、Tag 对象和 peeled commit，不强推。
- 用户原有的 `docs/resource-input-compatibility.md` 删除不纳入任务提交。浏览器使用隔离 Mock 画布，未触发真实生成或计费。

## 风险与回退

- 无迁移和数据清理；需回退时撤销本次任务提交并重建 Web 即可，不回退用户数据。
- 保留既有约 1.90 MB 主包警告；拆包优化、移动端及生产 Provider 合同验收不在本轮范围。
