# 柔光日系氛围插画 Skill 检查点

## 范围与基线

- 日期：2026-10-04；P1，新增独立应用内提示词预设，不是 Codex 全局 Skill，不替换「仙妖同款裙装」。
- 初始基线：`main @ 818820b5b0a97e2b791f4b1b17c95de962770064`，上游 `origin/main`；Node `v24.12.0`、pnpm `11.19.0`，使用已有本地依赖。
- 执行期间用户的相机／资源引用任务独立提交为 `6d8b87d feat(canvas): 全节点统一参考资料并支持拍照引用`；本轮在其上完成，未覆盖或回退这些改动。初始状态与文件 SHA256 保留于 `.data/soft-anime-skill-20261004/`。
- 验收：简单人物／场景词进入完整独立文字优化任务；新目录与中文说明匹配；四种光景和同一画法均有规则；选择不生成，优化直写、撤销、冻结引用和保存重载保持既有合同。
- 不做：不改 API schema、数据库、依赖、节点布局或既有 Skill；不部署、不迁移、不上传参考图、不调用付费模型。

## 已完成

- [x] 读取 AGENTS、TODO、现有 Skill 定义与测试，核对四张本轮附件的可见服装、画法、场景与构图，附件只作参考数据。
- [x] 在原 32 项末尾追加 `soft-anime-atmosphere@1.0.0`「柔光日系氛围插画」，分类「人物与场景」。指令 6801 字符，低于现有 12000 字符保存限额。
- [x] 工作台增加与英文原文／版本匹配的中文说明；原文、版本不匹配或显式自定义时仍保留实际原文，不误用本地翻译。
- [x] 提炼白紫窗光、浅蓝水边、暖阳书房、冷雨暖灯四类例子；场景可扩展，雨夜保留深色，人物与服装不绑定原图角色或固定仙侠裁剪。
- [x] 保留显式人物、年龄、物种、发色、服装、场景、时间、镜头和语言；无人场景不补人物，资源占位、版本和身份不变。
- [x] [使用文档](soft-anime-atmosphere-skill.md) 包含最简输入、两段完整目标提示词、实际能力与生图验收边界；工具包文档仅增加新来源说明，不重写历史映射。
- [x] 专项、全仓静态检查、各包普通测试和 PC Mock 浏览器回归；已人工检查新 Skill 工作台与稀疏输入直写截图。
- [x] 完整任务差异、格式与敏感内容扫描；旧 32 项定义和领域运行函数在归一化 CRLF 后与初始基线逐字一致。

## 验证证据

证据目录：`.data/soft-anime-skill-20261004/`。以下均为本轮实际执行，不使用缓存或历史通过记录替代。

| 检查                                    | 命令或范围                                                                                                                                             | 结果                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 修改前 domain                           | `pnpm --filter @multimodal-canvas/domain exec vitest run src/prompt-skills.test.ts src/prompt-skills-toolkits.test.ts`                                 | 81/81                                                              |
| 修改前 Web                              | `pnpm --filter @multimodal-canvas/web exec vitest run src/prompt-skills.test.ts src/workspace/PromptSkillPanel.test.tsx --maxWorkers=2 --minWorkers=1` | 88/88                                                              |
| 新专项红绿                              | 新文件首次执行，随后与既有两文件组合复验                                                                                                               | 初次因新目录缺失 33 失败、3 通过；实现后新专项 36/36，组合 117/117 |
| 中文说明                                | `SkillWorkbench.presentation.test.tsx`                                                                                                                 | 修改前 48/48，修改后 52/52                                         |
| API Skill                               | store、目录路由、优化 API                                                                                                                              | 80/80，含 HTTP 健康、Mock 提交与轮询冒烟                           |
| lint                                    | `pnpm exec turbo run lint --force`                                                                                                                     | 9/9 任务，无缓存                                                   |
| typecheck                               | `pnpm exec turbo run typecheck --force`                                                                                                                | 15/15 任务，无缓存                                                 |
| build                                   | `pnpm exec turbo run build --force`                                                                                                                    | 9/9 任务，无缓存；保留已有 Vite 大包提示                           |
| runtime                                 | `pnpm test:runtime`                                                                                                                                    | 8/8                                                                |
| domain 全量                             | 包内本地 Vitest，2 workers                                                                                                                             | 372/372                                                            |
| providers 全量                          | 同上                                                                                                                                                   | 768/768                                                            |
| crypto / execution / observability / UI | 同上                                                                                                                                                   | 7/7、43/43、21/21、16/16                                           |
| API 全量                                | 同上，环境 `WEB_PORT=5173`                                                                                                                             | 1171 通过，92 跳过；设施跳过不算集成验收                           |
| Worker 全量                             | 同上                                                                                                                                                   | 784 通过，28 跳过；设施跳过不算集成验收                            |
| Web 全量文件集                          | 中断前已完成 45 文件，恢复后只跑未完成 78 文件                                                                                                         | 合计 123 文件、2298 项通过（1199 + 1099），不是一次连续跑完        |
| PC E2E                                  | `prompt-skills.spec.ts`，冻结构建预览，1 worker                                                                                                        | 新项／目录 3/3，剩余 22/22；合计 25/25，页面与控制台错误为零       |
| 收尾                                    | 9 个任务文件 Prettier、`git diff --check`、敏感内容检查                                                                                                | 通过；原图、真实凭据、测试产物不加入提交                           |

### 中断与测试环境恢复

首次根测试命令经 pnpm 转发 worker 参数失败；随后直接调用 Turbo 遇到系统临时目录 `EPERM`，均不计为通过。未修改依赖、测试超时或全局配置；将本次测试进程的 `TEMP/TMP/TMPDIR` 指向证据目录下 `tmp`，按包直接运行：

`node ./node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=1 --passWithNoTests`

同时设置 `WEB_PORT=5173`、`VITE_API_BASE_URL=http://localhost:3000`。用户中断时前八个包已结束，Web 只有 45 文件的完整通过日志。恢复后重读 AGENTS／检查点／Git，确认没有遗留测试进程；用 Vitest `list --filesOnly --json` 对照日志得到其余 78 文件，只补跑这些文件，无失败或未覆盖文件。对应证据为 `web-resume-state.json`、`web-resume-files.json`、`web-resume-tests.log`。

浏览器只访问独立端口 5193 的冻结 `web-dist`，所有业务接口均由测试合成并阻止外部请求，不操作已有项目。中断后重启相同预览，先前 3 项通过证据保留，再以 `--grep-invert '柔光日系|目录.*三十三'` 完成其余 22 项。截图在 `e2e-focused/`，完整日志在 `e2e-focused.log` 和 `e2e-existing.log`。

## 交付与仍未验收

- 仅提交本任务九个文件；分支 `main`、上游 `origin/main`，中文 Conventional Commit。按跨模块变更附中文 annotated Tag：`v2026.10.04-soft-anime-atmosphere`。提交 ID、推送结果与远端引用在最终交接中实时记录，本文不替代远端核验。
- 未重新部署用户正在使用的 API／Worker／Web；源码构建和隔离浏览器已验证，不声称现有运行站点自动更新。
- 本轮没有付费文字优化或图片请求。示例为人工目标输出，Mock 验证的是合同和交互；真实模型对四图画风的相似度仍待用户授权模型、费用和次数后验收。
- 回滚本次提交可移除新增预设；已选中新 ID 的节点需改选可用 Skill。保留已有提示词、历史 Run 和自定义 Skill，不清理用户数据，不回退用户相机／引用提交。
