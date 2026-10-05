# 大肥鱼品牌 SEO 说明

2026-10-06，P2。起点 `main @ 064d35f`、上游 `origin/main`，工作区干净；沿用 Node `24.12.0`、pnpm `11.19.0` 和当前锁文件依赖。

- 原有 favicon、manifest 图标、OG/Twitter 分享卡及软件结构化图片已经使用同一鲸鱼娘素材；遗漏的是用户使用的“大肥鱼”称呼，搜索摘要没有角色介绍，图片替代说明只写鲸鱼娘。
- 首页和介绍页搜索摘要、OG/Twitter 图片说明、manifest 描述统一补上“大肥鱼（鲸鱼娘）”。静态首响应与 React 路由共享图片说明；公开页面结构化数据通过 `ImageObject` 提供图标 URL、名称、说明和尺寸。介绍页可见正文同步说明品牌形象。
- 不改变站点名、正式域名、私有页 noindex、账号及用户资产范围，不新增外部请求或依赖。没有迁移或环境变量变化。
- 修改前后 SEO 与公开页面专项均为 3 文件 24/24 通过；实现、本机部署与验证已完成，日志保存在 `.local-tests/seo-mascot/`。

验收目标：公开首页、介绍页首响应与路由切换后的元数据均有图片及名称说明；图片可访问，私有页仍不收录。真实搜索结果展示取决于重新抓取与搜索引擎选择，不能把本机测试当线上收录结果。

## 验证记录

- `VITE_API_BASE_URL=http://localhost:3000` 下执行 `pnpm --filter @multimodal-canvas/web exec vitest run src/seo/seo-build.test.ts src/seo/SiteMetadata.test.tsx src/pages/PageStates.test.tsx --maxWorkers=1`：24/24 通过。
- `pnpm lint`：9/9 任务通过，Web 本轮实际执行，其余 8 项使用缓存。
- `VITE_API_BASE_URL=''` 下执行 `pnpm --filter @multimodal-canvas/web build`：Web TypeScript 检查与 Vite 正式构建通过；保留既有的大于 500 kB 分块提示。此次未重复运行不涉及的 API、Worker 及其他包全量测试。
- `WEB_BASE_URL=http://localhost:8080` 下执行 `pnpm --filter @multimodal-canvas/web exec playwright test e2e/seo.spec.ts --workers=1 --retries=0 --output=../../.local-tests/seo-mascot/e2e`：3/3 通过，覆盖公开首响应、站内跳转、私有页及分享页的 noindex 边界。
- 本机 `/`、`/contact` 首响应均为 200，摘要、OG/Twitter 图片说明、公开 JSON-LD 图标名称均包含“大肥鱼（鲸鱼娘）”；favicon、512 px 图标、分享图和 `/health` 均返回 200。
- 已检查 1440 × 900 的介绍页截图，品牌说明显示完整，无重叠；分享卡图片正常。只读子代理审查无阻断项，记录见 `.local-tests/seo-mascot/review.md`。
- `git diff --check` 通过。

## 本机部署与线上边界

- 仅更新 `multimodal-canvas-app-web-1`，访问地址为 `http://localhost:8080`；容器健康，没有重启 API、Worker 或数据服务，没有执行迁移。
- 本轮使用主机 Web 正式构建产物，按仓库 Web 最终阶段配置以 `caddy:2.10.2-alpine` 打包，运行 `docker compose --env-file .env.compose -p multimodal-canvas-app -f compose.yaml up -d --no-deps --no-build --pull never --wait --wait-timeout 90 web`。
- 本机镜像为 `sha256:4a45c4cfca464cb8bf5ca1cd5a9c274731c9ba323e5b11b5a8ce958d049840c0`；更新前镜像保留为 `multimodal-canvas-web:before-mascot-seo-20261006`。
- 本轮只读检查 `https://love.lolicon.beer/` 返回 200，线上已有大肥鱼图标和分享图，但文字仍为更新前的“鲸鱼娘”版本。本次没有部署生产服务器，线上文案需部署新版 Web 后生效。

回滚只需还原本次前端提交或使用上述本机备份 Web 镜像，不涉及用户数据。
