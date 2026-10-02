# 画布一键整理

## 本轮范围与基线

- 2026-10-02，P1；分支 `codex/generate-to-new-node`，起点 `2f2d251`；Node v24.12.0、pnpm 11.19.0，复用现有依赖。
- 顶部及胶囊共用整理入口。用户最终确认：**独立节点每行最多 10 个；连接节点按上下游从左到右分列，同层上下排列，父节点垂直居中对齐子节点**。例如 1 → 2、3：1 在第一列，2、3 在第二列，1 的中心位于两个子节点中心之间。
- 各连通分量单独成块，不与孤立节点混排、不创建持久分组。连接图按依赖列展开，不强制在第 10 层折行，避免破坏层级关系。
- 保留真实连线、手动分组、节点数组顺序、外框尺寸、内容和状态；仅更新位置及组框。复用一次撤销/重做、自动保存和刷新恢复。重复整理不多写历史。
- 不改 API/Worker、Provider、生成/下载、数据库或依赖；不在真实项目中自动点击整理。移动适配与其它性能改造不在本轮范围。
- 起点用户已有 index.css、CanvasNodeToolbar.test.tsx 修改及 resource-input-compatibility.md 删除，必须保持原样且不纳入本轮提交。

## 布局约束

- 未分组节点在上，各手动组按原顺序在下；各范围内先排孤立节点，之后按原节点第一次出现顺序排列连接分量。
- 依赖深度取全部父节点最大深度加 1，合流节点位于最深父节点右侧；树形兄弟节点按原节点顺序，分支整块留位，节点数组本身不重排。依赖列宽取该列最大节点宽度，节点中心按实际持久/测量/默认尺寸计算，不写回默认尺寸。
- 横向净距 60、纵向及区块净距 80、组内边距 24，单位均为画布像素。父节点按直接子节点中心范围居中；同列冲突优先保证不重叠，多父/交叉关系不能承诺所有父节点同时完全居中。
- 手动分组优先，跨组连线不合并归属；只在各归属内排依赖列，不为跨组边强行统一全局列位置。
- 有效连接识别忽略方向，依赖层级遵守方向；未知端点忽略，重复边去重用于计算但原边保留。自环不增加深度；有环时从原顺序首个未处理节点展开，回边保留，不递归重算。
- 分组仍遵守既有 10,000 像素边长合同；孤立网格超宽时可减少列数，连接列过宽或区块过高则明确报错，整个原布局和历史不变。
- 不展开批次卡牌，只整理当前加载节点，不强制改变视口缩放。回滚用本轮提交的逆向提交及发布前 web 镜像，不覆盖项目数据或用户已有改动。

## 验证结果

- 基线 26 项布局单测通过。最终布局 41 项通过，覆盖 0/1/10/11/21/61、异形尺寸、分叉/合流、父居中、环/重复/无效边、跨组、幂等和组框拒绝；补测不平衡多层分支、121 节点三叉树每级父节点居中、5,000 节点长链。大节点数结果仅证明布局计算，不代表浏览器渲染性能验收。
- 最终相关回归 10 文件、**290/290 通过，无跳过**。命令：`pnpm --filter @multimodal-canvas/web exec vitest run src/canvas-auto-arrange.test.ts src/canvas-editor.test.tsx src/canvas-history.test.ts src/canvas-persistence.test.ts src/canvas-group-utils.test.ts src/canvas-utils.test.ts src/workspace/CanvasNodeToolbar.test.tsx src/workspace/CanvasNodeToolbar.arrange.test.tsx src/workspace/WorkflowCanvas.test.tsx src/App.test.tsx --maxWorkers=2 --testTimeout=60000`。
- Playwright **3/3 通过**：61 个孤立节点十列网格、七条独立连接链、三节点分叉父居中。已人工复核 PC 桌面截图，DOM 中心偏差不超过 1 像素；保存、刷新、幂等、一次撤销/重做、尺寸及边保留均通过，页面/控制台及隔离错误为 0。
- 浏览器命令：先设置 `WEB_PORT=5187`、`VITE_API_BASE_URL=http://127.0.0.1:5187`，再执行 `pnpm --filter @multimodal-canvas/web exec playwright test -c playwright.config.ts e2e/canvas-auto-arrange.spec.ts --workers=1`。全部使用同源合成数据，夹具拒绝 8080、未知 API、生成请求和外部写入。
- `pnpm typecheck` 15 tasks、`pnpm lint` 9 tasks、`pnpm build` 9 tasks 全部通过；保留既有大 chunk 构建警告，不扩大本轮范围拆包。
- 初轮集成夹具边 order 使用了全局序号，现已按目标节点及 handle 分别计数修正，未改生产序列化合同。
- 日志及截图位于 `.local-tests/canvas-arrange-connections-20261002/`；部署前后身份和发布校验分别为 `deployment-before.json`、`deployment-after.json`、`deployment-verification.json`。

## 本地发布与恢复

- 已执行 `docker compose -f compose.yaml build web`、`docker compose -f compose.yaml up -d --no-deps web`，只替换 web；六服务 healthy，其余五服务容器 ID 均未改变。
- 8080 项目页面 HTTP 200，已读取入口动态引用的主 JS 确认“独立节点每行最多 10 个”“父节点居中”和新布局错误合同，不再含旧 30 列文案。只检索小型 index 入口不足以确认实际主包。
- 未刷新用户编辑标签页或自动点击真实项目整理，没有真实 Provider 请求或项目数据写入。用户刷新网页后可从顶部或胶囊“整理”按钮执行。
- 发布前纯 web 镜像保留为 `multimodal-canvas-web:before-layered-arrange-20261002`。回退时将该标签重新标记为 `multimodal-canvas-web:local`，再仅执行 `up -d --no-deps web`，不改数据卷；源代码可逆向撤销本轮提交。
- 原有两项用户修改的 SHA-256 与起点一致，原文档删除保持；三项均不纳入本轮提交。提交、分支及中文 annotated Tag 以 Git 记录为准。
