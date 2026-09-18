# 独立连接保存修复

任务级别：P1。目标是首次直接保存节点独立连接后可以刷新目录、选择模型并用于节点；保留取消配置入口，失败后可以重试已保存连接。范围不包含新的 Skill 功能、供应商适配、手机布局或生产部署。

## 起点与证据

- 分支 `codex/generate-to-new-node`，起点 `e3e6790`，上游 `origin/codex/generate-to-new-node`。
- Node v24.12.0、pnpm 11.19.0，已有本地依赖，无依赖安装或升级。
- 起始未提交的设置面板取消按钮及测试属于本任务；`docs/resource-input-compatibility.md` 是用户已有改动，保留且不提交。
- Prisma 刷新、三种存储的凭据可用性检查仍依赖全局活动连接，独立连接保存却使用 `activate: false`，首次配置时发生冲突。此前关于多进程文件缓存的猜测未得到证实。
- 现有独立连接测试先配置全局 Key，漏掉首次配置；前端还会在新目录刷新前保存旧模型绑定。

## 兼容与回滚

数据库继续使用已有 `independent` 标记，无 schema 迁移。文件记录新增可选 `independent` 布尔标记，旧文件可读取，不改变旧记录的密文、ID 和版本。缺少标记的旧记录不推断为独立连接；重新按独立连接提交该 URL 与 Key 会创建独立身份，后续重复保存复用该身份，返回 ID 与凭据摘要一致。摘要优先保留独立连接及当前活动连接，同 Key 的两个用途在界面明确区分。独立连接可显式选择，但不自动成为全局默认；已删除连接和撤销的全局历史版本仍不可用于新任务。

回滚前备份凭据 JSON 和配套加密密钥；回滚代码后旧版本可忽略可选字段，但独立连接在无全局连接时再次受旧检查限制。不删除、重写或重新加密已有用户数据。

## 检查点

- [x] 恢复工作区状态、阅读设置实现与已有测试。
- [x] 原有 4 文件 90 项通过；新增首次独立连接的 3 项回归全部失败，Prisma 刷新返回 `404 credential_not_found`，内存目录读取返回 404，文件存储可用性返回 false。
- [x] 后端修改后 7 文件 161 项通过，覆盖保存、目录刷新、类型默认与冻结引用；补充旧文件确认独立用途的持久化回滚和历史撤销用例通过。
- [x] 后端修复与前端保存、刷新、重试、取消闭环。先刷新新凭据目录，再绑定仍匹配的旧模型；否则保留连接待用户选模。目录不再借用其他 Key 的候选。
- [x] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 通过。最终 Web 1070 项、API 863 项通过，其余工作区包和运行时测试通过；API 67 项、Worker 3 项跳过，不能视为对应集成验收通过。构建保留已有大 chunk 提示。
- [x] 前端专项 63 项、设置浏览器回归 6 项通过。浏览器覆盖无全局连接首次保存、404 后重试同一新 ID、目录选模、取消、删除和节点默认回归。
- [x] 真实本地 HTTP 与浏览器 smoke 通过：全局仍未配置时保存独立连接、刷新目录、选择模型、刷新页面恢复及取消；页面和 console 无错误。上游是本机合成服务，未发送新的真实供应商请求。
- [x] 最终审查补充同 Key 的全局与独立用途、全局默认更新、撤销、旧文件多版本和重复保存回归。新增失败场景经修复通过，文件存储 19 项、内存与 Prisma 专项 48 项通过；后端三种存储均只复用独立身份，不改变旧任务的冻结引用。

## 验证记录

日志为 `test-results/independent-connection-{api,lint,typecheck,tests,build,browser}.log`，真实本地浏览器截图为 `test-results/independent-connection-live.png`。

独立预览为 `http://127.0.0.1:5192/settings`，API 为回环端口 19312，本地合成上游为 19313。合成管理员为 `preview@example.test`，密码为 `Synthetic-Preview-2026!`；不连接现有业务数据库。启动入口为 Git 忽略的 `.data/independent-connection-preview.mts`（使用项目本地 tsx）和 `.data/independent-connection-web.mjs`（Node）。全新安装仍通过项目常规 `pnpm dev` 运行，无需这些验收脚本。

本次未部署生产服务。交付目标为 `origin/codex/generate-to-new-node`，annotated Tag 为 `v2026.09.18-independent-connection-fix`；提交与远程引用核验结果在最终交接中报告。用户原有 `docs/resource-input-compatibility.md` 改动不纳入本次提交。

Docker daemon 的 Linux engine pipe 不可达；已尝试启动，启动/状态命令未恢复后结束等待进程。新增真实 PostgreSQL 跨实例用例已纳入集成套件，本次因设施不可用跳过；Prisma 查询替身的路由回归和文件存储真实 HTTP 验收通过，但不代替真实 PostgreSQL 验证。
