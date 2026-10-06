# LoveTV 品牌、首页与运行停止检查点

## 范围与基线（2026-10-05）

- P1：将用户可见品牌统一为 LoveTV，使用用户提供的鲸鱼娘图片作为网站图标；优化首页、介绍页与搜索元数据；生成中的节点允许显式停止。
- 起点 `main` / `origin/main`：`f7f17e6`；Node `24.12.0`、pnpm `11.19.0`，本地测试依赖可用。已有 Skill 工作台、提示词及相关测试/文档修改保留，不纳入本任务提交。
- 用户确认正式域名为 `https://love.lolicon.beer`。产品展示名变更不改包名、存储键、API 路径、资源身份或数据库格式。
- PC Web 优先；保留现有 React/Ant Design、主题和画布首页结构。设计取值：布局变化 6、动效 4、信息密度 4；鲸鱼娘保留原彩色，不生成替代角色。

## 安全与兼容

- 首页只能展示公开示例或当前账户有权读取的生成资源；不把用户资产或凭链接访问的分享自动发布到公共图库。换号、退出和迟到响应不得泄露旧资源。
- 只有首页与介绍页允许搜索收录；项目、工作台、设置、账号、管理、分享令牌和未知路由禁止收录。canonical 与 sitemap 不包含用户数据、查询参数或令牌。
- 停止使用现有任务取消合同，不虚构远端取消/退款，不重复发起结果未知的付费创建请求。未调用真实 Provider；没有迁移、覆盖或删除用户数据。
- 此轮涉及多个前端模块，按大改动交付：完成验证后仅提交本任务，创建中文附注 Tag，推送当前上游。回滚可撤销该提交，不需要数据迁移；运行环境发布与构建验收区分记录。

## 分工与恢复点

- 主代理：鲸鱼娘资源、静态与路由 SEO、部署配置、集成和最终验证。
- Jason：节点运行停止及取消边界，独占 App/NodeQuickEditor/WorkflowCanvas/AssetNode 与相关测试。
- Galileo：首页素材轮换、下部介绍与 Home 系列样式/回归。
- Wegener：导航/认证品牌、联系介绍页、分享页品牌及对应测试。
- 已生成 PNG/ICO/WebP/分享卡，不安装新依赖；已实际检查图标与 1200×630 分享图。品牌、首页、SEO 和节点停止均已实现。

## 使用行为

- 首页标题为 `LoveTV`；导航、登录、分享页和 API 文档统一品牌。介绍页保留 `/contact` 地址，补充 API 接入、AI 图片/视频生成、参考资料、Skill、短视频复刻与版本管理说明。
- 首次 HTML 响应就提供公开产品文案、canonical、OG/Twitter 和 JSON-LD；构建生成介绍页静态入口、robots 与只含两个公开地址的 sitemap。私有页面使用 noindex，不把分享令牌或项目参数放入搜索标签。
- 首页新增四个固定预览格，登录后只读当前账户最近一页资源，随机选取最多八项生成图片/视频；hover 或键盘聚焦切换备用图。图片走现有缩略图缓存，视频只读海报；无图、失败时保留占位。匿名不读取用户资源。
- 节点创建请求发出后即可点击“停止”；创建尚未返回时先记住停止意图，取得 Run ID 再请求取消，不中断请求而丢失任务身份。批量停止不再发起剩余任务，分叉节点关联同一次操作；其它节点仍可独立生成。
- 快捷编辑器、节点运行状态、右键菜单和命令入口共用停止状态。停止失败可重试；`cancel_requested` 保持“停止中”，直至服务端终态。没有新增或猜测 Provider 远端取消接口。
- 停止回调与按节点订阅的状态存储保持稳定，不通过 Context 将单节点停止状态广播给所有节点。

## 本轮验证与恢复记录

- 启动与路由基线：2 文件 23 项通过。SEO 与启动专项：3 文件 32 项通过。API OpenAPI 品牌专项：52 项通过。
- 首次 Vite 打包遇系统临时目录的 esbuild 文件删除拒绝访问；没有改依赖或删除系统临时文件。为本任务设置 `TEMP`/`TMP` 到 `.local-tests/lovetv-20261005/build-temp` 后恢复。最终全仓无缓存构建 9/9 任务成功，`pnpm build:runtime` 生成 API/Worker 入口；公开 HTML、介绍页、sitemap 与 robots 均生成。既有主 JS chunk 超过 500 kB 的告警保留，不在本轮顺带拆包。
- Caddy 配置验证通过；使用独立容器 `lovetv-seo-check-20261005`、端口 `8086` 验证静态入口，未重启现有 `8080` 应用栈。公开入口、图标、manifest、sitemap 和 robots 均 HTTP 200，工作台/分享页返回 `X-Robots-Tag: noindex, nofollow`。
- 首页 9 项 Playwright 回归通过；已查看 1440×900 的完整页面与深色主题截图。品牌子任务的组件专项 31 项、首页品牌断言 1 项、登录 5 项和品牌相关 smoke 3 项通过。
- SEO 浏览器回归 3 项通过，覆盖首响应、路由切换和离开分享页；记录在 `.local-tests/lovetv-20261005/seo-e2e-final.log`。测试图片和 trace 必须输出到仓库根目录 `.local-tests`，不要放在 Vite root 内，避免生成 HTML 触发测试期间全页重载。
- 并行 Skill 任务已独立提交为 `de52346`，本任务在其之上继续，未重写或重复纳入 Skill 修改。
- 首轮全仓 lint/typecheck 因仍在编辑的 `App.tsx` 格式未完成而中断；修复后无缓存执行 24/24 任务通过。运行产物测试 8/8 通过；非 Web 全包测试无缓存执行 13/13 任务成功，其中 API 1181 项通过、92 项因设施/真实环境条件跳过，跳过不算集成验收。
- Web 首轮全量 2355 项通过、21 项失败，均为旧生成按钮或品牌文案断言；保留并发防重、其它节点独立运行和终态恢复覆盖后，四个受影响文件 191/191 通过。
- 复核发现恢复的活动 Run 在重渲染前连续调用停止会发出两次取消请求。新增回归实测红灯（预期一次、实际两次），补同步停止意图检查；覆盖并发防重、失败可重试和 `cancel_requested` 防重。该问题不会重发生成 POST。
- 补充停止回归已转绿；测试夹具等待恢复的运行状态后再断言，避免误将活动节点算作空节点。最终 lint/typecheck 无缓存 24/24 通过，之后仅调整测试断言及本文。
- 第二轮全 Web 2375 项通过、1 项未改动的 Skill 工作台用例超过默认 5 秒；独立复核在默认限时下通过（约 2.7 秒），未修改 Skill 代码或放宽超时配置。停止并行重型检查后，最终完整 Web 测试 **130/130 文件、2377/2377 用例全部通过**，日志为 `web-verified.log`；包含新增恢复停止防重用例和原 Skill 工作台用例。
- 最终构建在独立 8086 静态服务上复验：公开页面缓存与元数据、私有页 noindex、sitemap、robots、图标及 manifest 均通过；生产构建浏览器回归 8/8 通过，含 SEO 跳转、菜单/登录导航、创建项目及创建中停止、再次生成。业务 API 全为本地夹具，无真实生成、账号或项目写入。菜单 E2E 等待抽屉焦点就绪，并将存量设置标题断言同步为现有 New API 文案，没有修改导航行为。
- 当前恢复点：功能与本地验证完成，差异检查及常见密钥格式扫描无命中；本轮仅纳入品牌、SEO、首页和停止相关文件。独立静态验证容器已停止并移除；开发预览仍在 `http://127.0.0.1:5185`。现有 8080 应用栈及正式网站尚未发布本轮改动。

## 2026-10-06 QQ 分享卡续验

- 线上首响应已确认：首页、`/pricing` 均有 `title`、description、canonical、OG/Twitter 标记及可访问的 1200×630 分享图；QQ 不出卡不能单独归因于缺 SEO，仍可能受 QQ 抓取策略与缓存影响。
- 画布已为 `/share` 生成独立静态入口：首响应使用“共享资源 · LoveTV”通用标题和摘要，明确 `noindex, nofollow`，不带首页 canonical、`og:url`、JSON-LD，也不把 hash token 或资源详情写入元数据；Caddy 对 `/share` 设置独立 no-cache 规则。
- 两站补齐分享图的 `secure_url`、类型和尺寸元数据；New API 仅对规范的大肥鱼 PNG 输出已核实的 `image/png`、`1200×630`，自定义图片不猜测尺寸。
- 定向检查：画布 SEO 单测 20/20、生产静态 Caddy 浏览器回归 4/4、New API router SEO 测试通过、New API 前端 SEO 单测 15/15。画布全仓测试在默认临时目录遇 Windows `EPERM`，切换到 `.local-tests/seo-qq-20261006/temp` 后继续；既有重型 Web 用例仍有超时，未将其归因于本次 SEO 改动。

## 复现命令与边界

```powershell
$env:VITE_API_BASE_URL='http://localhost:3000'
$env:WEB_PORT='5173'
pnpm exec turbo run lint typecheck --force --concurrency=2 --env-mode=loose
pnpm test:runtime
pnpm exec turbo run test --filter='!@multimodal-canvas/web' --force --concurrency=2 --env-mode=loose
pnpm --filter @multimodal-canvas/web exec vitest run --maxWorkers=2 --reporter=verbose

$env:TEMP=(Resolve-Path '.local-tests/lovetv-20261005/build-temp').Path
$env:TMP=$env:TEMP
$env:VITE_API_BASE_URL=''
pnpm exec turbo run build --force --concurrency=2 --env-mode=loose
pnpm build:runtime
```

测试、截图和本地验证脚本保留在忽略目录 `.local-tests/lovetv-20261005`；该临时目录不是部署依赖。浏览器输出必须放在 Vite root 之外。没有执行真实 Provider 取消、退款、生产部署或搜索引擎收录验收；SEO 元数据正确不保证立即收录或排名。
