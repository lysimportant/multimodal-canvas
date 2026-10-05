# 加载页与左侧菜单品牌图标

2026-10-05，P2 小范围展示修改。起点 `main @ 8a52cd9`、上游 `origin/main`，工作区干净；Node `24.12.0`、pnpm `11.19.0`，沿用已安装依赖。

- 复用 `public/brand/lovetv-mascot.webp`，HTML 启动页和 React 会话恢复页显示 128×128 完整大肥鱼图片；左侧主菜单的 LoveTV 旁显示 40×40 图标。
- 保留加载说明、Spin、超时反馈、导航焦点和主题行为。没有登录逻辑、画布数据、环境变量、依赖或数据库变更。
- 修改前启动壳、会话等待和导航组件测试 27/27 通过；修改后加入现有 App 会话等待专项，4 文件 38/38 通过。没有为简单图标展示新增单元测试。
- `pnpm lint` 通过，Web 为本轮执行，其它 8 个未改包复用缓存；`pnpm --filter @multimodal-canvas/web build` 的 TypeScript 检查与生产构建通过。使用独立 `TEMP`/`TMP` 避免系统 esbuild 临时文件占用，沿用既有大块体积警告。
- `.local-tests/loading-brand/verify.cjs` 在部署后的 `http://localhost:8080` 用合成项目及 API Mock 验证浅/深色：启动、会话和菜单图标均解码成功，加载移交、菜单关闭及焦点返回通过，控制台与页面错误为空。已实际查看 1440×900 截图，不读取或修改用户项目。
- 用已验证的 Web 产物及仓库现有 Caddy 配置打包，运行层与 Dockerfile 的 Web 阶段一致；仅重建本地 Web 容器。镜像 `sha256:ae3484e1d8edbdb836e2d33c56073cc001fbcee19a2f6251a09d8b41c8ac9228` 为 healthy，`/health` 返回 200。没有重启 API、Worker 或数据服务。
- 临时构建、日志及六张截图位于 `.local-tests/loading-brand/`。本次按小范围展示修复提交到当前上游，不涉及线上部署；没有重复执行与图标无关的全仓业务测试。
- 验收条件：加载两个阶段及左侧菜单都能看到图标，浅/深色布局正常，菜单打开/关闭与加载移交不受影响；只更新本地 Web。

回退代码或将 `multimodal-canvas-web:before-loading-brand-20261005` 标记回 `multimodal-canvas-web:local` 并只重建 Web 即可还原，不涉及用户数据。
