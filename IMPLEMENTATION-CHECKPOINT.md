# 后台与全站体验实施检查点

更新时间：2026-09-06。本地核心功能和最终联合验收完成。用户已明确授权实现，并允许按不冲突模块并行委派；正式部署与真实邮件送达未执行。

## 基线与范围

- 起点：`main @ dd429f2`，初始 Git 工作区干净；Node 24.12.0、pnpm 11.19.0。
- 目标：完成 TODO-ADMIN.md 的账户/管理员/用户资源核心流程、通用 UI/UX 和首页动效，最后执行隔离真实接口与浏览器验收。
- 基线命令：Web auth-client/router/AppNavigation 精准 Vitest 66/66 通过。
- 现有正式 Compose 七项服务 healthy，入口 8080；现阶段不迁移正式数据库、不删除或转移现有数据。
- 邮件配置仅从用户桌面 email.txt 读取到进程环境；已确认 EMAIL_HOST/PORT/SECURE/USER/PASS/FROM，未输出实际值或发送邮件。

## 并行责任

- 主 Agent：App.tsx、auth-client、公共账户菜单/导航/路由、启动/部署配置、集成质检、其余文档和 Git 交付。
- backend_admin：apps/api、Prisma/migrations、邮件依赖、必要 Worker 归属边界及后端测试。
- frontend_management：apps/web/src/management 的后台/账户/资源界面与测试。
- homepage_implementation：首页组件、首页样式、public/demo 素材及独立首页测试，首页专项文档。

## 已验证阶段

- [x] 读取现有规范/计划、记录干净基线和运行时。
- [x] 账户菜单、晚到 401 防护、并发续期与换号隔离的首批测试通过：AccountMenu 3 项、session-lifecycle 6 项、原导航/路由 14 项。
- [x] App 与管理页入口接通后，既有 auth-client 52 项重新通过；新增账户/会话测试继续纳入全量回归。
- [x] 两个新增迁移在隔离数据库通过；初始化/邀请/验证/资源权限已实现，原迁移校验和不变。最新历史资源回归 91 项、真实 Prisma 集成 4 项通过。
- [x] 真实 API 预览与 SMTP/TLS/认证握手通过；未发送真实邮件，预览 API 当前未加载真实邮件凭据。
- [x] 已有全仓库 lint/typecheck/test/build 通过日志；隔离数据库/Redis/TLS 66 项、媒体相关 96 项、Web 445 项、画布冒烟 23 项及首页专项 7 项通过。
- [x] 本人邮箱修改入口最后修正：管理员用户详情转到个人账户安全页，其他用户仍走管理验证流程；管理模块 31 项及 Web typecheck 复验通过。
- [x] 五种管理视口通过并保留 43 张截图；新增 1920x1080 和 720x450（1440x900 在 200% 下的等效 CSS 布局，非真实浏览器缩放）。修复低高度侧栏裁切与表头隐藏标签导致的整页横向溢出。
- [x] 仓库 lint/typecheck/test/build/build:runtime 均退出 0；最后节点小修后的 Web lint/typecheck/test/build 再次通过，454 项 Web 单测通过。
- [x] 最后静态构建的 23 项画布冒烟、真实 HTTP/Prisma/浏览器 9 组流程通过；代码和资源结果均已实际检查。
- [x] 同步本地完成与后置 TODO、审查 diff、格式、文档链接与敏感信息。Git 按本次大改动创建中文提交及 annotated `v0.15.0`；最终推送状态以远端引用及交付记录为准。

## 已落盘的证据

- 仓库最终检查：`.data/admin-verified-{lint,typecheck,test,build,build-runtime}.log`，五项均退出 0。其后仅有 Web 节点测量/样式小修，最新 Web 454 项通过，见 `.data/admin-node-final-{lint,typecheck,test,build}.log`。
- 最终 API：595 项通过、53 项设施条件跳过，见 `.data/admin-p1-api-test-final.log`；最后两个会话问题的针对性回归 54 项、真实 Prisma 4 项通过。跳过项不计为通过，设施证据另列。
- 数据库/Redis/TLS：`.data/admin-isolated-infrastructure-passed.log`；媒体：`.data/admin-isolated-media.log`。
- 历史资源与真实 Prisma：`.data/admin-final-legacy-assets-{test,integration,lint,build}.log`。合法项目范围内的空 owner 历史资源兼容读取，不改写归属；冲突/跨用户访问仍拒绝。
- 最终真实 HTTP/Prisma/浏览器 9 组流程：`.data/admin-browser/mc_admin_browser_f10db5cd5cde48/report.json`；静态 Web 5188，最新 `index-BcIYB9pW.js`。运行中及完成后账户往返保持身份、结果与尺寸，生成 1 次、误注销 0 次、无额外 canvas revision、无错误“待更新”，控制台及页面异常为 0。
- 最终静态 Playwright 冒烟：`.data/admin-verified-smoke.log`，23/23、0 skip；含手动 resize、保存/刷新恢复、四类节点、参数与剪贴板回归。
- 管理截图：`.data/management-review/`；首页截图与性能记录：`test-results/homepage-20260906/`、`docs/homepage-ui-motion-todo.md`。
- `.data/admin-final-*` 和 `.data/admin-release-*` 中更早的数量是中途结果，不能替代上述最终证据。
- 配置测试 15 项通过，Prisma schema validate 在显式设置隔离 `DATABASE_URL` 后通过；默认终端未配置此变量时会返回 P1012，不代表迁移 SQL 错误。

## 最后审查的修正

- 凭据查询禁用时隐藏已有共享缓存；SettingsPanel/激活/模型刷新在异步边界核验身份，画布设置面板在权限变化时立即卸载；流式续期响应体晚到不能恢复旧角色。对应失败回归已复现后修复并通过。
- 实际账户部署拒绝无 sid 旧 JWT，旧客户端重新登录；Memory/File 全部读写与事务共用可重入互斥队列，失败回滚不再覆盖并发登录或恢复已撤销会话，文件重启回归通过。没有新增迁移或改写用户资料。
- 初次 DOM 尺寸测量不记为用户编辑，避免账户往返触发无意义自动保存和“待更新”；显式手动 resize 继续保存。窄节点头部不拆字、不压扁图标，固定外框与预览裁剪保持原约束。
- 真实浏览器首轮运行态观察采用默认 5 秒发生超时，改为 12 秒预算和 100/200ms 采样后两轮通过；仍严格断言实际运行态，不降低业务验收条件。失败现场数据库保留，未执行批量清理。

## 当前约定

采用管理员后台与个人页面独立入口；首次未初始化的 `/admin` 直接显示创建页。初始化完成标记持久化且不因管理员数量、浏览器或重启变化。新注册和邀请用户必须验证邮箱；存量 active 账户保留访问但明确邮箱未验证，敏感改绑走验证码。管理员代跑/跨用户迁移必须先满足操作者与所有者分离，首期不提供隐式接管。

迁移恢复：旧 `0001_init` 显式引用 public，仅改变 schema 不能隔离，首次预演因 MediaType 已存在失败；没有重置或覆盖已有类型/数据。后续改用隔离 PG 实例上的独立数据库 `admin_review`（public schema），后端集成使用另一独立数据库 `admin_account_test`。

恢复时已核实服务：API 3081、Vite 5187、静态预览 5188、首页专项 Vite 5186、隔离 PG 19432、正式入口 8080 均在监听。最终构建统一设置 `VITE_API_BASE_URL=http://127.0.0.1:3081`，避免共享 dist 被默认 API 端口覆盖。

自动审批曾拒绝载入真实邮件配置并隐藏启动后台预览，返回 `blocked by policy`；没有绕过该拒绝。当前完整业务验收使用合成邮件接收器与 mock Provider；真实收件箱送达和正式发布未执行。

交付目标为 `main` 的上游 `origin/main`（GitHub），annotated Tag 为 `v0.15.0`，仅推送本次变更。正式迁移/备份/发布另行确认；自动邮件重试、配额限制、详细设备信息、永久/批量删除及跨用户迁移/代跑继续保留为后置 TODO。真实浏览器 200% 缩放、人工读屏与长期内存观察未验收；Vite 仍提示约 999KB 主 JS 分块，本轮不以消除提示为由扩大打包改造。

## 首页圆形揭示与登录面板动效

用户在 `4d7afbe` 后要求圆形鼠标窗口显示隐藏画面，并补新建项目触发登录面板的进出场动画。本轮开始时 `main` 工作区干净，Node 24.12.0、pnpm 11.19.0，首页基线 8 项通过，5187/5188/3081 服务可用。

- [x] 首页改为直径 264px 的圆形隐藏图层窗口，移除十字标记；圆内文案与原文案对齐，保留原生指针和点击行为，输入/选区/触屏/减少动态效果正确退化。
- [x] 登录侧栏从右侧滑入、向右滑出，遮罩同步淡入淡出；关闭后 220ms 卸载，退出态禁止输入和重复提交，登录与注册验证完成后继续新建项目表单。
- [x] HomeRevealField 静态隐藏网络复用本地公开图片，不读取业务数据或真实 Provider；重复文案使用 inert/aria-hidden，不增加读屏或键盘入口。
- [x] 仓库 `pnpm lint/typecheck/test/build` 均退出 0，Web 43 文件、462 项单测通过；日志 `.data/home-login-motion-{lint,typecheck,test,build}.log`。
- [x] 首页 8 项 Playwright 专项通过；网络、位图、标题三个位置的圆内像素明显变化、圈外像素变化为 0。截图在 `.data/home-reveal-playwright/`，可复核 JSON 及同组截图在 `.data/home-reveal-pixels-final/`。
- [x] 最终静态构建 `index-JiAPEQBT.js` / `index-Cs0xYob6.css` 的 28 项冒烟与登录专项通过，日志 `.data/home-login-motion-static.log`；桌面/390px 都采到进退场中间帧，焦点恢复、登录/注册续接及无自动项目 POST 通过，控制台错误为 0。
- [x] 同步文档、审查 diff 与敏感信息，按当前分支中文提交及 annotated `v0.15.1` 交付，上游 `origin/main`。此轮没有后台权限、数据格式、依赖、邮件或正式部署变更。

恢复记录：首次浏览器检查发现 Vite 仍返回旧 CSS（26px 指针），重启已核实的 5187 服务后确认返回圆形裁剪新规则；当前预览 `http://127.0.0.1:5187/`。圆外像素检查排除了下一节独立入场动画的影响；比较时冻结装饰动画，仍严格要求圈外变化为 0。减少动态效果的浏览器检查以实际 DOM 卸载而非假定下一 RAF 的 React 调度为准，最终约 3.9ms 卸载，未等待 220ms 退场。

最新性能样本：90 帧采样静态/动态中位数均约 16.7ms，动态 p95 16.8ms，无超过 50ms 帧；10 次卸载重挂并 GC 后增加 738904 字节，4 倍 CPU 限速入口操作约 899ms。本机样本不代表所有设备。主 JS 约 1004KB 的既有分块提示保留；其他正式发布边界沿用前述记录。

## 独立认证页面

本轮起点 `main @ b30c38e`，工作区干净。用户要求登录、注册、验证码各用新页面，验证码确认后返回工作台，取代前述登录侧栏。沿用既有验证 API，不变更数据库、邮件配置或正式服务。

- [x] 独立 `/auth/login`、`/auth/register`、`/auth/verify` 路由及受控 next；注册验证统一回工作台，登录新建意图仅恢复表单，仍需显式提交。
- [x] authentication 页面与样式、验证码表单复用、页面离开取消；密码和验证码不进入 URL 或存储，重发成功保留验证码和倒计时。
- [x] login/register/verifyAccount 支持 AbortSignal；取消、换号、晚到 JSON、真实超时和成功后卸载均有回归。
- [x] 旧侧栏测试迁移为独立 URL、键盘、刷新、浏览器返回、注册验证和无自动创建流程。
- [x] 最终仓库 lint/typecheck/test/build 通过；Web 45 个文件、501 项通过；静态构建 29 项 smoke/login 通过；真实 HTTP/Prisma 浏览器 11 组通过。
- [x] 文档、差异、敏感信息和 17 个文档链接复核完成，已准备中文提交、annotated `v0.15.2` 与上游推送。

断点恢复：预览 API3081、Vite5187、静态5188 已按既有隔离配置恢复，正式8080与PG19432未重启。路由/布局23项、请求取消/会话36项、联合认证91项和 Web501项通过。最终动态真实 HTTP/Prisma 浏览器11组、静态构建版 smoke/login29项通过；页面截图在 `.data/auth-page-e2e-settled/` 和 `.data/auth-pages-static-e2e-artifacts/`。第一次真实流程被 Vite HMR 打断后已用静态构建复跑，失败报告仅保留作恢复证据，不计入最终结论。旧侧栏专用CSS已移除。
