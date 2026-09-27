# 节点时长浮层、光标与边界交互检查点

更新时间：2026-09-27。任务等级 P1，仅 PC Web 节点编辑交互。

## 基线与范围

- 分支 `codex/generate-to-new-node`，本轮基线 `98427b3`；此前交互提交不重写历史。
- Node `v24.12.0`、pnpm `11.19.0`，依赖已安装，无依赖或数据格式变更。
- 本轮目标：输入面板只在节点上方/下方展开，触边后超过节点高度 75% 才换边，修复放大后聚焦跳动；保持节点双倍宽输入面板和原生编辑行为。
- 用户已删除 `docs/resource-input-compatibility.md`，保留删除状态，不恢复、不暂存、不提交。
- 不改 Provider 合同、模型默认值、数据库、资源内容；不执行付费生成。
- 仓库根目录无 README/AGENTS 文件；已读取用户提供的 AGENTS 规则、TODO-CONSOLIDATED 和现有节点编辑/Docker 文档。

## 验收结论

- [x] 仅保留 above/below 两种展开方向，不再切换到节点左右侧。
- [x] 按面板实际外边缘触边，节点继续沿垂直方向移动超过自身高度 75% 才换边；恰好 75% 不切换。反向微动不立即回切，空间不足时不压成细条。
- [x] 放大后真实鼠标首次点击不改变面板、输入框和父滚动位置；光标按点击位置放置，原生拖选及滚动正常。
- [x] 长文本输入不撑大节点；失焦后拖小节点不会因旧测量宽度产生横向溢出。
- [x] 最终源码通过专项、全量单测、lint、typecheck、build、浏览器回归及真实项目冒烟。
- [x] 仅替换 Docker Web 容器，非 Web 容器 ID 全部不变；6 项资源、4 个节点和原有图片正常，未改提示词或触发生成。

## 实现记录

### 上下布局及换边阈值

- `quick-editor-layout.ts` 和 WorkflowCanvas 的 placement 类型只保留 above/below，删除左右候选及侧边收窄策略。
- 触边距离使用节点屏幕高度的 75%，与画布缩放一致；往返移动不累计路程，换边后须对侧重新触边才允许回切。
- 保留节点双倍宽、可见区域约束和自然内容高度测量，不改变节点的持久化尺寸。

### 聚焦跳动根因

- PromptCaret 的隐藏镜像原先使用 auto 高度，填入长文本后会撑大父级 scrollHeight，触发输入面板重新定位；现同步为 textarea 实际高度并裁剪溢出。
- 失焦、选择文字或 IME 期间，镜像同步 hidden 并退出布局，避免节点缩小时旧测量宽度继续影响滚动范围。
- 不使用永久焦点锁、滚动恢复循环或 pointerdown 默认行为拦截。正常首次点击、拖选、滚动和后续画布几何更新均保留。
- 前置已交付的 2 屏幕像素光标、视频秒数 hover 卡片和 5/10/15/30/自定义选项保持不变。

### 浏览器测试合同

- 新增 `node-editor-placement.spec.ts`，使用真实 WorkflowCanvas、真实鼠标点击/拖选/拖动、长文本和引用图片；所有 API 由浏览器 Mock，未知请求直接失败。
- 旧 picker 夹具补齐当前 Cookie 会话有效期，截图改用测试独立目录。弹层纵向断言兼容视口底边翻转，并继续检查与同一 @ 字符的水平、垂直距离；按钮边界允许最多 1 屏幕像素的缩放舍入，不改变产品组件。

## 最终验证记录

- 专项 Vitest：WorkflowCanvas 45、quick-editor-layout 13、PromptCaret 13，共 **71/71** 通过。
- Web 全量：**87 个文件、1302/1302** 通过；冻结源码后执行 `pnpm --filter @multimodal-canvas/web exec vitest run --passWithNoTests --testTimeout=15000 --maxWorkers=1 --minWorkers=1 --reporter=dot`，耗时 777.54 秒。日志：`.local-tests/node-input-final-vitest.log`。
- `pnpm lint`：9/9 packages 通过。`pnpm --filter @multimodal-canvas/web typecheck`、两个改动 E2E 文件的独立严格 no-emit TypeScript 检查、Prettier 和 `git diff --check` 均通过。
- `pnpm --filter @multimodal-canvas/web build` 与 Docker Web build 通过；保留既有大 chunk 警告，主 JS 约 1.90 MB。
- `pnpm test:runtime`：**8/8** 通过。
- 新增浏览器规格的 7 项场景在最终 Docker 静态包连续执行两轮：**14/14** 通过（`--repeat-each=2 --retries=0`）；源码 Vite 验证亦通过。
- 最终 Docker 扩展浏览器回归：**8/8** 通过，覆盖 @ 搜索筛选、完整 Dialog、原生拖选和取消、画布缩放、长文拖缩、最小宽度按钮及 Skill 同行布局。两组共 **15 项**，最终运行均关闭自动重试。
- Docker 使用 `docker compose build web` 和 `docker compose up -d --no-deps --wait --wait-timeout 120 web`；API/Worker/Postgres/Redis/MinIO 容器 ID 未变，全部 6 个服务 healthy，健康检查与项目页 HTTP 200。
- 已刷新真实项目确认加载新包 `index-DIbRxlQe.js`。1.8119 倍下点击原有长提示词，overlay 和 textarea 矩形前后逐项相同，editor.scrollHeight 均为 269、scrollTop 均为 108，原生光标为 [33,33]，控制台无错误。
- 真实项目截图及几何记录保存在 Git 忽略的 `.local-tests/node-input-delivery/`；没有修改原提示词、拖动持久化节点或调用生成接口。

## 排障记录与剩余风险

- 首轮全量在源码继续修订时运行，含旧模块缓存与一项 15 秒超时，未用作完成依据；最终冻结源码后的 1302 项全部通过。
- 旧长文拖缩 E2E 曾有一次拖拽未命中手柄。保持原用例不变，连续单项 **3/3** 和最终整组 **8/8** 均通过；后续可单独加强初始画布定位就绪检查，本轮不扩大产品修改范围。
- 大 chunk 警告仍存在，未在本轮引入拆包或依赖调整；其他浏览器和生产外部 Provider 验收不在本轮范围。

## 交付边界

- 本轮代码和功能验收无剩余任务；交付分支为 `codex/generate-to-new-node`，发布标记为 `v2026.09.27-node-input-placement`，以 Git 提交及双端 ref 核验记录为准。
- 用户原有文档删除不纳入提交。数据库、资源、API/Worker 运行环境保持原状，不需要数据迁移。
