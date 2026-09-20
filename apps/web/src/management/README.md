# 后台与个人资源工作台

`ManagementPage` 只承载仍由 Canvas 管理的资源、任务、审计和系统状态。身份、分组和费用由 New API 统一处理；本模块不提供注册、密码、邮箱、用户邀请或邮件投递管理。

## 页面与边界

- `/admin` 展示资源与任务概览，不依赖旧用户管理或邮件服务字段。
- `/admin/resources` 展示资源归属分组；`/admin/users/:id/resources` 是现有前端资源详情路径，归属资料读取 `/v1/admin/resource-owners/:id`。
- `/resources` 只读取当前用户资源，不发送可伪造的 `ownerId`。
- `/admin/runs` 与 `/runs` 只观察已有任务，不因打开详情或轮询自动重试生成。
- `/admin/audit` 只展示服务端脱敏审计摘要；`/admin/system` 只展示 API、资源存储和任务队列状态。
- 所有查询键同时包含当前登录用户和目标资源范围。身份变化时外层以用户 ID 重挂载页面，迟到结果只能进入旧身份缓存。

权限由服务端逐请求校验。隐藏导航项不能替代授权，前端也不保存 New API Key、PAT 或长期访问令牌。
