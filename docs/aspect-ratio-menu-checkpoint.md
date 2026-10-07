# 图片与视频比例菜单检查点

## 目标与基线

2026-10-07（Asia/Shanghai），P2：PC 快捷和完整编辑器的图片、视频比例菜单统一为等宽两列，每行两个选项，图标左、文字右；占位、选中标签与菜单宽度一致。

- 分支 `main`，起点 `eaad19981f9cee7cb0bfb1fedee2ad7576ed8dfe`，上游 `origin/main`；开始时工作区干净。
- Node v24.12.0、pnpm 11.19.0，依赖已存在，使用原锁文件。
- 已读 `AGENTS.md`、`TODO-CONSOLIDATED.md`、编辑器与参数样式、现有组件和浏览器回归。
- 用户截图显示弹窗右侧留空、文字随图标宽度错位。现有列表宽度固定 294px，外层弹窗宽度另由 Select 决定；选项按内容宽度换列，图标没有固定槽。
- 不修改图片 `size` 和视频 `aspectRatio` 的保存或请求合同，不迁移数据、不调用真实 Provider、不部署。

## 验收与恢复位置

- 图片/视频、快捷/完整入口在 1440×900 和 1366×768 下均为每行两个等宽选项，列表填满弹窗；图形按真实比例缩放，文案起点对齐。
- 未设置、自动比例、当前已保存但不支持的值保持现有语义；长说明完整换行，保留禁用选项和键盘导航。
- 选择保存、再次打开、键盘选择及 Escape 焦点恢复正常，节点外框宽高不变；控制台无错误且没有生成请求。
- 专项组件基线：编辑器 229 项、短枚举样式 3 项通过。真实浏览器红基线中，快捷图片菜单的最大/最小选项宽度相差 12px；不是等宽双列。
- 已完成共享比例渲染和局部样式：比例专属 340px 浮层、填满列表的两等宽列、44×32 图标槽、等比 SVG 图形与自动比例虚线方框；选中控件同样显示图形和标签。
- 选中值展开时变淡来自 Ant Design 6 默认 `opacity: 0.25`，并非值丢失。仅对可用的比例选择器恢复不透明度为 1，保留真实占位和禁用语义。
- 类型检查 9 个包通过。组件回归首次 231 项通过、1 项仍检查旧 `aspectRatio` 样式；已将其改为检查实际 SVG 矩形宽高比，对应视频参数用例单独通过。
- 浏览器最终完整文件 22 项通过，覆盖双列等宽、列表填满弹窗、固定图标槽、图形比例、长禁用说明、占位/选中标签、两种窗口与入口的键盘和保存回读。节点外框仍为 320×180；所有用例没有生成 POST 或控制台错误。
- 全量检查首次因 API 超时退出，随后逐包复跑：API 1236、Worker 861 项通过；Web 2498 项通过、6 项失败。保持原超时并逐文件单 Worker 定向复核，6 项全部通过，未修改相关模块或放宽断言。首次全量仍记录为未通过。

## 兼容与回滚

本轮仅修改 Web 展示，不新增公开数据格式、依赖或数据库迁移。回滚使用起点提交重新构建 Web，不覆盖画布、Run 或用户素材。

## 本轮验证

| 检查       | 命令与实际结果                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 专项基线   | `NodeQuickEditor.test.tsx` 和 `node-parameter-option-layout.test.ts`：232 项通过                                                                                                                                                                                                  |
| 类型       | `pnpm typecheck -- --force --only --concurrency=2`：9 个包通过，无缓存冒充本轮结果                                                                                                                                                                                                |
| 格式       | `pnpm lint -- --force`：9 个包通过；检查点另做 Prettier 检查                                                                                                                                                                                                                      |
| 首次全量   | `pnpm test -- --force --concurrency=2 -- --maxWorkers=2 --minWorkers=1 --reporter=dot`：运行产物及 Domain、Provider、Execution、Credential、Observability、UI 通过；API 超时 1 项，Web/Worker 被中断，命令未通过                                                                  |
| 逐包恢复   | 原默认超时，包内 `vitest run --maxWorkers=2 --minWorkers=1 --reporter=dot`：API 1236、Worker 861 项通过；API 108、Worker 28 项按设施/真实媒体开关跳过；Web 2498 项通过、6 项失败                                                                                                  |
| 浏览器     | `pnpm --filter @multimodal-canvas/web exec playwright test e2e/node-parameter-overlays.spec.ts --workers=1 --output G:/multimodal-canvas/.local-tests/ratio-menu/green-final`：22 项通过（3.6 分钟）。1440×900、1366×768 的图片和视频快捷/完整入口已人工检查截图；5198 监听已清零 |
| 构建与交付 | `pnpm build -- --force --concurrency=2`：9 个包通过；保留现有 Vite 500 kB 分包提示。最终 `git diff --check`、变更文件格式和新增行敏感模式扫描通过；按 P2 小范围展示修复提交并推送 `main` 到 `origin/main`                                                                         |

日志及截图保留在被 Git 忽略的 `.local-tests/ratio-menu/`。测试进程使用该目录下独立的 `TEMP/TMP`，不改动全局环境。首次 API 超时不作为通过记录；未提供的真实设施验收仍保留在原 TODO，本轮没有发送付费请求或更新部署。

Web 全量失败位于 `App.test.tsx`、`canvas-editor.test.tsx`、`ResourceMentionEditor.test.tsx` 和 `SkillWorkbench.test.tsx`。独立复核使用包内 `vitest run <文件> -t <原失败用例名称> --maxWorkers=1 --reporter=dot`，依次 1、2、1、2 项通过；原来的 5 秒/15 秒时限保持不变。选区和 Skill 两个独立单测未挂载比例编辑器；未据此宣称全部失败都是已确认的历史问题。日志为 `recheck-app/canvas/mention/skill.log`，保留完整全量失败记录，未再次运行整套 Web。

桌面展示验收已完成。没有未提交的既有用户改动；提交仅包含比例组件/样式、对应测试与本检查点。当前运行中的网站尚未部署该修改，真实 Provider 和生产设施验收继续按原 TODO 独立推进。
