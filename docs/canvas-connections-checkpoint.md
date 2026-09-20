# 画布多连接模型选择检查点

## 目标与基线

2026-09-20，P1：所有已保存连接的可用模型进入画布，用户按连接选择同名模型，执行和人民币报价始终使用所选平台模型绑定。New API 模型保存连接后自动同步并沿用上游价格；已有连接提供一次性全部同步入口。

- 分支 `codex/generate-to-new-node`，起点 `e635466`，上游 `origin/codex/generate-to-new-node`。
- Node 24.12.0、pnpm 11.19.0，依赖已存在。Web 定向基线 83 项通过，日志 `.data/billing-implementation/all-connections-baseline-web.log`。
- 用户原有 `docs/resource-input-compatibility.md` 修改保留，不纳入提交。
- 已核对模型目录仅来自已发布平台商品；菜单把不同连接合并为同一组，保存连接未自动导入平台模型。

## 影响、兼容与回滚

公开模型 DTO 新增可选脱敏连接摘要，只包含稳定公开身份和主机/Key 安全尾号，不公开完整 Key、指纹或内部调用绑定。平台模型 ID、报价冻结与 CNY 钱包合同不变。无需数据库迁移，不删除既有数据；部署前备份数据库及密钥。回滚本轮代码可隐藏来源和停止自动同步，已创建商品仍可由原后台管理，已有账务不能用旧备份覆盖。

自动同步只发布合同和能力明确的 New API 托管模型；保留手工定价、暂停、删除和人工改绑。失败或缺合同明确提示，不把未知价格当免费。普通用户仍不能管理连接。

本轮不涉及真实收费生成、生产部署、支付或移动端改造。

## 验收与恢复

- 多个 Key 的同名模型分别展示；选择后保存与刷新保留平台身份。
- 普通用户可选择各连接，无法访问凭据管理；活动连接切换不改变节点选择。
- 保存及全部同步沿用 New API 价格；重复同步不覆盖人工状态，缺联动明确报告。
- 使用隔离 API/PostgreSQL 和合成上游验证目录、选择、报价与删除影响，真实 Provider 生成次数为零。
- 完成定向测试、lint、typecheck、test、build、runtime、浏览器核心交互和控制台检查。

API 公开摘要及批量同步、画布/优化/反推来源展示、保存连接自动联动已实现。普通模型选择仍提交平台商品身份，后台按真实绑定解析；只对展示增加主机与 Key 尾号。全局切换折叠历史凭据版本后，旧商品继续显示同一 Key 的尾号和原平台身份。菜单长模型名称截断时尾号独立保留。子代理消息传输为空，已中止，代码由主代理完成。

## 验证结果

证据均在 `.data/billing-implementation/`：

| 检查                                | 结果                                                                                            | 日志                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| API 模型服务、路由、OpenAPI         | 37 项通过，含多连接同名、每连接一次目录请求、权限、部分失败、人工价格/暂停/删除保留、旧绑定尾号 | `all-connections-api-final.log`                                  |
| Web 设置、模型管理、目录查询        | 85 项通过；新增保存后自动同步、全部连接结果、分页与来源                                         | `all-connections-web-final.log`                                  |
| Web 节点、紧凑选单、提示词优化      | 168 项通过，同名平台身份及尾号持续展示                                                          | `all-connections-polish-tests.log`                               |
| 真实 PostgreSQL + Redis             | 15 项通过，零跳过，包含模型同步和托管导入、报价、钱包、outbox、权限及历史绑定                   | `all-connections-integration.log`                                |
| `pnpm lint`                         | 9/9 通过                                                                                        | `all-connections-lint-final.log`                                 |
| `pnpm typecheck`                    | 15/15 通过                                                                                      | `all-connections-types-final.log`                                |
| `pnpm test`                         | 15/15 通过，3,239 项通过；122 skipped、另 5 pending 不计通过                                    | `all-connections-test-final.log`                                 |
| `pnpm build` / `pnpm build:runtime` | 9/9 通过；API/Worker 运行包生成，Web 既有大包提示保留                                           | `all-connections-build.log`、`all-connections-runtime-final.log` |

全量包通过数为 UI 3、credential-crypto 7、observability 21、domain 236、providers 445、billing 36、Worker 362、Web 1,157、API 964，另 runtime 8。未改动包复用 Turbo 缓存；定向结果不与全量相加。

浏览器使用本机 API 13000、Vite 15173、隔离 PostgreSQL 19432、Redis 19379/15 及合成 HTTP 上游。真实 UI 添加两个独立 Key 后自动上架同名模型；普通用户在画布选第二个 Key，保存、重载后保留，管理员激活第一个 Key 也不改变选择。报价使用第二个 Key 的合成 2,000 quota，显示 CNY 0.0292，数据库报价冻结该凭据；取消后钱包不变。删除第一个 Key 后第二个仍可用，普通用户管理凭据返回 403。生成提交和 Provider 生成次数均为 0，页面、控制台及意外 HTTP 错误为空。报告 `all-connections-browser-result.json`、最终日志 `all-connections-browser-final.log`；1440×1000 及 1280×720 截图 `all-connections-{menu,selected,selected-1280,square,settings,quote}.png` 已检查。

验收只删除本轮合成连接、逻辑删除合成模型、归档合成项目。原设置和凭据列表逐项比较不变。首次浏览器脚本误用账务查询字段 `userId`，更正为实际 `payerId` 后通过；早期全量检查发现新增同步路由未写入 OpenAPI，补齐文档后全量通过。没有放宽业务校验，也没有真实收费生成。

## 交付与后续

目标分支 `origin/codex/generate-to-new-node`，附注标签 `v2026.09.20-canvas-all-connections`；远端交付回执保留在 `all-connections-git-delivery.json`。用户原有 `docs/resource-input-compatibility.md` SHA256 为 `56B2C9D2BFB09DCC56720769B9CE12AED4877A29090DEDFBADD2F1FC5B3AA2A7`，未纳入本轮提交。

无需数据库迁移或依赖安装。已有连接需要在设置或模型管理点击“同步全部连接到画布”；新增和刷新连接自动联动。上游必须支持并启用 Canvas Bridge，缺合同或价格的模型不会被伪装为可用。大量目录的生产容量与异步同步、真实 Provider 生成、支付和部署验收仍由 TODO P2-03 跟踪，隔离结果不替代线上证据。回滚遵循上文，不能覆盖新账务流水。
