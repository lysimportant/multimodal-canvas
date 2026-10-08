# 画布资源交互检查点

2026-10-08，P1。起点 `main @ eaff8d3`，上游 `origin/main`；Node `24.12.0`、pnpm `11.19.0`，沿用现有依赖与锁文件。

## 本轮范围

- 修复从资源侧栏加入画布的音频节点无法拖动，播放控件仍单独交互。
- 提示词“上传引用资源”先打开项目资料 Dialog，每行两个资源，右上提供本地文件上传；选择与上传只添加冻结资料，不改正文。
- 节点选中使用 1px 透明边框，维持外框尺寸。
- 节点悬浮卡片增加分享入口，仅成功可用的资源显示；默认无密码，显式点击才创建分享，沿用原有版本和授权合同。
- 禁用鼠标选区自动打开引用搜索，仅由 `@` 或明确的引用操作打开；选区和复制仍正常。

不扩展移动端，不改变 Provider、数据库、资源格式或依赖，不部署生产或调用真实 Provider。分享沿用现有已授权接口与无密码默认值，无服务端合同升级；回滚恢复本轮前应用代码即可，用户素材和已有分享不清理。

起点已有 Image2Pro 的 Domain、Providers、API/Worker 测试、NodeQuickEditor、参数 E2E 与文档改动，全部保留，本次提交只纳入本轮文件及必要差异块。

## 当前阶段

- 已核对 AGENTS、当前检查点、TODO、分支/上游、HEAD、工作区与运行时；依赖存在，无需安装。
- 音频已在真实 Chromium 复现：从侧栏添加后媒体加载完成，留白拖动仍没有位移；整个 `artifact-preview-audio-shell` 带 `nodrag` 是拦截原因。修复只把限制保留在音频控件。
- 引用 Dialog 和选区触发由一个代理独占；音频与分享由一个代理独占；新增 PC 浏览器验证由一个代理独占。主代理负责选中边框、集成核对、文档和 Git 交付。
- 选中边框已改为 `1px solid transparent` 与 `border-box`。CSS 三文件基线 32/32，新断言在原实现下 1 项失败，修复后 32/32；两档 PC 实测选中和拖动时外框尺寸保持不变。日志位于忽略目录 `.local-tests/canvas-resource-interactions/`。
- 已同步直接受需求改变影响的 TextPromptEditor 单测和五处旧浏览器场景：上传先打开资料窗口；鼠标选区不打开搜索；明确 `@` 插入；拖动恢复比较原生选区。`node-resource-concurrency` 兼容实际 textarea 与 contenteditable：前者按字体指标测量首行，后者按正文 Range 测量；仅使用真实鼠标选字，未设置或伪造选区，补齐夹具的缩略图接口。
- 独立审查发现目录从 51 项缩小到 0/1 项时可能卡在第二页，已根据当前合法目录总数约束页码并重查；四项新红绿回归通过。引用五组最终 111/111，音频/分享三组 157/157，主代理 TextPromptEditor/App/WorkflowCanvas/CSS 集成四组 215/215。
- 子代理 503 中断后已重新激活并核对指南、检查点、工作区和日志。主代理旧开发服务也已恢复为本轮正式构建的专用 preview，地址 `http://127.0.0.1:5211`，隐藏后台进程与 PID 记录仅在忽略目录；不依赖 HMR 或重用用户站点。
- 本轮强制重跑全仓 lint 9/9、typecheck 15/15、build 9/9 通过，全部零缓存；运行产物测试 8/8。新 PC 规格和更新的旧 PC 场景最终共 20 项通过，详见下节。

## 最终验证

### 包测试

使用 `pnpm test:runtime` 和强制零缓存的 `turbo run test --force --concurrency=1 -- --maxWorkers=2 --testTimeout=15000 --reporter=dot`，未加载根 `.env` 或接入真实设施。

| 检查                                                        | 本轮结果                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 运行产物测试                                                | 8/8 通过                                                                                                 |
| Observability / Credential Crypto / UI / Domain / Execution | 分别 21 / 13 / 16 / 446 / 56 项通过                                                                      |
| Web 全量首轮                                                | 137 文件，2587 项通过、2 项失败；唯一失败文件为 `NodeQuickEditor.test.tsx`                               |
| Web 失败修复复验                                            | 两项仍期待上传按钮直接打开本地文件，已同步为先开资料 Dialog、再点本地上传；整文件 247/247 通过，退出码 0 |
| Providers / API / Worker 完整补跑                           | 分别 815 / 1259 / 862 项通过，Turbo 8/8 成功、零缓存、退出码 0                                           |
| 设施边界                                                    | API 跳过 108 项，Worker 跳过 28 项；这些跳过不算数据库、队列、对象存储或真实 Provider 集成验收           |

全量首轮确实退出 1，没有将其记为全量通过；修复只涉及旧测试断言，随后整文件复验通过，未无理由重跑全部 Web。日志分别为 `.local-tests/canvas-resource-interactions/full-test.log`、`node-quick-final.log`、`server-tests.log`，各包未变场景采用本轮已完成的全量结果。

### PC 浏览器与截图

- 新增 `canvas-resource-interactions.spec.ts`，使用本轮正式构建、1440×900 与 1366×768 两档 Chromium，共 6/6 场景通过，26.4 秒。覆盖音频加入/拖动/播放、两列项目资源 Dialog、本地上传和目录选择不改正文、透明边框和节点尺寸、显式无密码冻结版本分享、鼠标选区不搜索及正文后直接输入 `@`。
- 新规格 6 个场景均通过内置浏览器和请求审计，无浏览器错误、未知请求或真实 Provider 请求；审计断言随场景执行，未单独生成六份 JSON 文件。18 张截图保存在 `.local-tests/canvas-resource-interactions/final-static-pc/`。子代理实际查看两档 8 张最终截图，主代理另行检查两列 Dialog、分享和两档完整 Dialog Skill 截图。
- 更新的旧 PC 规格共 14 个场景：首轮 10 项通过、4 项失败。两项旧原生选区 helper 缺少实际字体/Range 测量，已改为真实鼠标按实际位置拖选，并补齐缩略图 Mock，复验 2/2 通过；另两项旧固定点位被输入面板遮挡，已通过 `elementFromPoint` 查找真实可见位置，不使用强制点击，复验 2/2 通过。
- 旧规格同时验证快捷输入区域、画布上下边贴附、放大 Dialog 的底部 Skill、引用资料与正文解耦、三个入口独立响应和拖动后原生选区恢复。日志为 `.local-tests/canvas-resource-interactions/final-old-pc.log`、`native-pc.log`、`decouple-pc.log`；原生选区补跑审计只有 GET，零写入、生成和错误。
- 新规格 Prettier、独立 strict TypeScript，以及最终工作区和暂存差异检查通过。全仓 lint/typecheck/build 的日志为同目录 `lint.log`、`typecheck.log`、`build.log`，本轮没有新增依赖。

## 交付与剩余边界

本轮实施与 PC 核心交互已完成。仅提交本任务 21 个文件；共享 `NodeQuickEditor.test.tsx` 只纳入上传 Dialog 流程的差异块，Image2Pro 改动保持未暂存。提交前核对完整暂存差异、敏感内容、当前分支/上游及远程引用，按跨模块改动创建中文附注 Tag 后推送 `origin/main`。

真实 Provider、生产部署、缺少隔离设施而跳过的集成项及移动端未验收。节点悬浮分享沿用现有接口的服务端所有权、归档和可用性校验，只有显式点击创建分享；没有新增逐节点请求或 Context 广播。
