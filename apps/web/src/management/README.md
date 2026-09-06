# 后台与个人工作台

`ManagementPage` 接收应用当前路径、当前用户、统一登录回调和会话更新回调。所有实际权限由 `/v1/admin/*` 与 `/v1/account/*` 服务端接口执行，页面不能通过隐藏菜单替代授权。

## 页面与边界

- `/admin` 读取服务端初始化状态；未完成时直接显示管理员创建与邮箱验证码页面。状态读取失败不开放初始化。完成后，匿名访问进入登录，普通账户显示拒绝访问，管理员进入概览。
- `/auth/verify?email=...&purpose=...` 支持初始化、注册、邀请、密码重置和更换邮箱。邀请和重置要求收件人设置密码，更换邮箱要求已登录。验证码只保存在输入框，不放入 URL 或浏览器存储；验证成功交给应用回调续接原流程。
- `/account/profile`、`/account/security` 提供资料、头像地址、改密、邮箱绑定和会话撤销。资料 PATCH 不改变访问令牌；改密和邮箱验证成功后替换服务端签发的新会话。
- `/admin/users`、`/admin/users/:id` 提供搜索、分页、邀请、资料编辑、禁用/恢复、邮箱变更与密码重置邮件。管理员不能读取用户密码，也不能通过通用表单改写角色、归属和审计字段。
- `/admin/resources` 只展示用户分组；`/admin/users/:id/resources` 才查询该用户资源。`unassigned` 是管理员专用的待确认归属组。`/resources` 只调用当前用户资源接口，不发送 `ownerId`。
- 资源支持名称、类型、来源、标签、项目、归档状态筛选，图片缩略图、四类媒体详情、历史版本、鉴权下载、重命名、标签、归档与恢复。文本按纯文本渲染；所有 Blob URL 在页面卸载后撤销。
- `/runs`、`/admin/runs` 只观察已有任务，不会因为进入详情或页面轮询自动重试收费生成。`/admin/audit`、`/admin/system`、`/admin/settings/email` 展示脱敏审计与真实服务状态。

## 验证

2026-09-06 已完成本模块以下检查：

```powershell
pnpm --filter @multimodal-canvas/web exec vitest run src/management/ManagementPage.test.tsx src/management/client.test.ts
pnpm --filter @multimodal-canvas/web typecheck
pnpm exec prettier --check apps/web/src/management
```

31 项模块回归验证初始化、角色入口、本人及其他用户邮箱变更入口、临时故障、验证表单、注册发信失败后的重发恢复、未保存资料离开确认、会话撤销、延迟响应不会覆盖后续身份、资源分组与请求契约。完整应用的视觉检查可在已有 Web 服务运行时执行：

```powershell
# 从 apps/web 运行；该脚本只模拟业务 API，不发送真实邮件或修改真实账户。
$env:WEB_BASE_URL = 'http://127.0.0.1:5187'
node src/management/verify-browser.mjs
```

截图保存在根目录 `.data/management-review/`，避免其他 Playwright 套件清理测试目录时丢失证据。该检查覆盖 1440x900、1280x720、390x844 的页面、媒体详情、归档/恢复、账户菜单、窄屏导航焦点与控制台错误。业务数据和会话均为合成数据，这些结果不能代替真实数据库、邮箱投递或 Provider 生成验收；对应服务端和完整流程证据由仓库总检查点记录。

## 恢复检查点

本目录独占管理前端实现。中断后先检查根目录 `IMPLEMENTATION-CHECKPOINT.md`、`TODO-ADMIN.md`、Git 状态与接口当前定义 `apps/api/src/account-routes.ts`。查询键包含当前用户和目标用户，用户身份变化时外层必须立即卸载旧内容；不要为了保留动画而延迟权限切换。
