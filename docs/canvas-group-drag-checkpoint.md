# 分组拖动与五列整理

## 范围与基线

- 2026-10-02，P1；分支 codex/generate-to-new-node，起点08ddf38。Node v24.12.0、pnpm 11.19.0，复用锁文件依赖。
- 修复分组拖动闪影、标题与外框被节点遮挡；独立节点每行最多5个，连接层级与父节点居中规则保留。
- 不改节点内容、尺寸、分组成员、真实连线、Provider、数据库及生成流程。浏览器仅使用同源合成项目，不移动用户真实项目。
- 原有 index.css、CanvasNodeToolbar.test.tsx 修改及 resource-input-compatibility.md 删除保持原样，不纳入提交。本轮样式只修改分组专用文件。

## 原因与处理

- 原组层z-index为2，节点视口为3，标题与边框被共同压在下层。背景仍放在2；外框、标题与手柄放在4，去除组整体transform层叠隔离。正文穿透给节点与端口，背景空白仍可拖组，胶囊等固定控件保留。
- 整组移动未设置成员临时dragging状态，批量卡牌仍执行220ms transform过渡。有效基线的批量场景最大相对错位14.0117屏幕像素；不是生成文件或图片分辨率变化。
- 整组成员现在复用单节点轻量拖动态、批量动画关闭和临时连线显示投影；真实边不删除，松手恢复状态与自动保存。
- 指针事件按requestAnimationFrame合并，每帧同步提交组与成员；松手、取消和失焦补交尾帧。拖动期间隐藏悬浮卡片并停止重复定位，不销毁焦点或拖动捕获目标。
- 稳定监听器通过ref读取最新回调，待提交事件冻结当时缩放倍率，缩放/回调变化不丢尾帧。卸载同样补交尾帧并结束拖动态，不在React清理期嵌套flushSync。
- 独立节点五列，61节点排成13行；连通分量仍逐层向右，父节点对齐自己的子节点中心。多父合流优先不重叠，手动组仍受10,000像素边长限制，超限整体拒绝。

## 验证与证据

- 证据：.local-tests/canvas-group-drag-five-columns-20261002/。基线组测试38/38。
- 主回归12文件329/329通过，无跳过；覆盖布局、编辑器、App、历史、保存、分组、批量卡牌、工具栏和WorkflowCanvas。
- 尾帧补充后的组回归3文件95/95，覆盖缩放变化、卸载、pointercancel、blur、逐帧合并与最后位移。329项主回归与新增两项分开执行，不冒充一次全量运行。
- 完整浏览器12/12：五列整理、连接层级、父居中、50%/100%/200%组拖动、空白与卡片拖动、节点/端口命中、重命名、解散、保存刷新及撤销重做。
- 最终普通/批量节点含松手后共82/90帧采样，最大相对错位均为0.0175像素；只代表合成桌面场景，不推断超大项目帧率。
- 初轮标题用例加载超时，普通节点用例被并行编辑引发的热更新中断，未算作功能失败；文件稳定后全部通过。批量卡牌14像素漂移为有效基线。
- 已人工查看重叠截图：标题与边框可见，节点内容与端口可访问；页面/控制台错误为0。尾帧补充后再次运行分组浏览器9/9通过；pnpm typecheck 15 tasks、pnpm lint 9 tasks、pnpm build 9 tasks，以及Docker web构建全部通过。

## 复现命令

- 主回归：pnpm --filter @multimodal-canvas/web exec vitest run src/canvas-auto-arrange.test.ts src/canvas-editor.test.tsx src/canvas-history.test.ts src/canvas-persistence.test.ts src/canvas-group-utils.test.ts src/canvas-utils.test.ts src/workspace/CanvasNodeToolbar.test.tsx src/workspace/CanvasNodeToolbar.arrange.test.tsx src/workspace/WorkflowCanvas.test.tsx src/workspace/CanvasGroupLayer.test.tsx src/workspace/generation-batch-view.test.ts src/App.test.tsx --maxWorkers=2 --testTimeout=60000。
- 尾帧：pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/CanvasGroupLayer.test.tsx src/canvas-group-utils.test.ts src/workspace/WorkflowCanvas.test.tsx --maxWorkers=2。
- 浏览器先设WEB_PORT=5187、VITE_API_BASE_URL=http://127.0.0.1:5187，再执行pnpm --filter @multimodal-canvas/web exec playwright test -c playwright.config.ts e2e/canvas-group-menu.spec.ts e2e/canvas-auto-arrange.spec.ts --workers=1。夹具拒绝8080、外部访问与未声明写入，不调用真实Provider。
- 全仓：pnpm typecheck、pnpm lint、pnpm build；保留既有大chunk提示，不扩大范围拆包。

## 发布与回退

- 已只构建并替换compose的web；发布前后核对其余五个容器ID未变，六服务healthy。8080项目页HTTP 200，实际主包/assets/main-sMYAxVEa.js及main-7S5aj9lm.css已确认五列文案、分层样式及拖动卡片状态；不再含旧十列入口文案。
- 运行web的旧镜像标签已失效，已从运行容器保存不暂停服务的精确快照multimodal-canvas-web:before-group-drag-five-columns-20261002。回退将其标记为multimodal-canvas-web:local后，仅执行docker compose -f compose.yaml up -d --no-deps web，不改数据卷。
- 功能、回归、独立尾帧复核及本地发布已完成。原有两项修改的SHA-256与起点一致，原文档删除保持；三项不纳入提交。任务提交与中文annotated Tag以Git记录为准。
