# 管理后台运行与验收

New API 是唯一账号来源；Canvas 内部管理员由部署允许列表 `NEW_API_ADMIN_USER_IDS` / Compose `MC_NEW_API_ADMIN_USER_IDS` 按不可变 New API 用户 ID 决定。先完成 New API 登录，再按[部署说明](docker-desktop.md)使用管理员脚本核对角色，邮箱和昵称不参与提权。

后台保留资源、任务、服务状态和安全审计；普通用户只访问本人项目、素材和运行。管理员资源查询使用专用管理边界，不改变所有者。Canvas 不再创建/邀请用户、重设密码、发送验证邮件、初始化管理员、同步广场售价或管理钱包。

所有管理权限在 API 验证。旧账号/钱包/价格写接口明确退役；退出后旧 Cookie 失效，切换账号不回填旧响应。敏感日志不得包含完整 Key、密码、授权码、Cookie、签名下载 URL 或用户素材正文。

验证状态与实际命令见[实施检查点](newapi-account-implementation-checkpoint.md)，隔离账号/生成烟测见[本地验收说明](docker-smoke.md)。当前共享实例和生产数据尚未切换；按备份、清理预览、消费者切换、前向迁移和恢复演练的顺序发布。
