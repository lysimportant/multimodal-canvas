# 隔离 MinIO 最小权限验收

## 范围

`scripts/verify-s3-permissions.ps1` 仅验收本机专用 Compose 项目
`mc-acceptance-test-p0p1` 的 MinIO 权限边界。它不连接外部 S3，不代表生产部署通过，
也不覆盖 TLS、云厂商 IAM、KMS、跨实例任务恢复或 API/Worker 媒体归档。

脚本不读取 `.env`，不修改主验收脚本、Compose、API、Worker 或 TODO。
测试使用合成内容和临时合成凭据，无真实用户数据或真实 Provider 请求。

## 运行

前提：PowerShell 7、Node、本机 Docker、已安装的仓库锁文件依赖，以及已启动且健康的专用 MinIO（映射端口 19900），
以及本地已有仓库固定 digest 的 `minio/mc` 镜像。缺镜像时 `--pull never` 显式失败，
不会自动运行其他版本。主脚本的启动方式如下；本验收不自行启动或停止其他服务。

```powershell
pwsh -NoProfile -File scripts/verify-isolated.ps1 -Action Start -Project mc-acceptance-test-p0p1
pwsh -NoProfile -File scripts/verify-s3-permissions.ps1
```

脚本检查 Docker context 必须是本机 socket/named pipe，拒绝 `DOCKER_HOST` 覆盖，
并核对 MinIO 的项目/服务标签、仓库目录、镜像 digest、健康状态、专用数据卷、端口与 `127.0.0.1` 绑定
及主脚本约定的合成 root 凭据。参数不能切换到其他项目或外部地址；发布到所有网卡的端口也会在创建测试资源前被拒绝。主启动脚本将数据库、Redis、S3 API 和控制台全部限制为本机回环地址。
临时 mc 客户端共享已核对 MinIO 容器的网络命名空间，仅请求 `127.0.0.1:9000`；
对象验收 fixture 复用 API 锁定的 `@aws-sdk/client-s3`，通过标准输入接收合成凭据，
仅请求 `127.0.0.1:19900`，不查询全局凭据或实例角色。每次请求使用独立连接、不重试，
连接限时 3 秒、请求限时 10 秒。匿名请求使用 PowerShell，禁止代理和重定向。
创建测试资源前先加载本地 SDK；依赖缺失时失败，不留下空桶或用户。

fixture 位于 `scripts/fixtures/verify-s3-permissions.mjs`，不应绕过主脚本的 Docker 所有权
检查直接调用。它也会拒绝非专用项目、其他 endpoint、非法 GUID 和越界清理桶名。

## 权限与断言

每次使用独立 GUID 创建两个测试桶、一个测试用户及一个策略，不复用任何既有桶。
策略由 PowerShell 对象经 `ConvertTo-Json` 生成，仅授予：

- 测试主桶的 `s3:GetBucketLocation`。
- 带 `s3:prefix = allowed/*` 条件的 `s3:ListBucket`。
- 主桶 `allowed/*` 对象的 `s3:GetObject` 与 `s3:PutObject`。

没有 `s3:*`、跨桶通配符、删除或管理权限，不更改桶匿名访问策略。

| 检查                | 必须满足                                                    |
| ------------------- | ----------------------------------------------------------- |
| 允许前缀            | PUT、GET 内容精确一致、带前缀 LIST 成功                     |
| 跨前缀              | 已存在对象 GET、PUT、LIST 返回 `AccessDenied`               |
| 前缀边界            | `allowed-sibling/` 不得被 `allowed/` 策略误放行             |
| 桶根列表            | 无 prefix 的 LIST 返回 `AccessDenied`                       |
| 跨桶                | 第二个桶的已存在对象 GET 和 PUT 返回 `AccessDenied`         |
| 未授予删除          | 允许前缀中的对象 DELETE 返回 `AccessDenied`                 |
| 错误 secret         | GET/PUT 返回 `SignatureDoesNotMatch`                        |
| 不存在的 access key | GET/PUT 返回 `InvalidAccessKeyId`                           |
| 匿名                | 无认证 GET/PUT 均返回 HTTP 403，XML 错误码为 `AccessDenied` |
| 无副作用            | 拒绝的写入未创建对象；允许对象与对照对象内容不变            |
| 清理                | 本轮用户、策略、对象、空桶、客户端和临时文件已清理          |

对象拒绝断言要求 AWS SDK 服务错误码与 HTTP 403 同时匹配；用户/策略管理错误要求
mc 非零退出码和结构化错误码匹配。连接失败、命令错误、解析失败、
404 或错误凭据意外成功均导致整轮失败，不能被当作权限验收通过。

## 清理与恢复

`finally` 只解绑并删除本轮用户/策略，逐个删除精确命名的本轮对象，随后删除本轮空桶。
对象删除使用 S3 `DeleteObject` 的幂等语义：不存在的拒绝写入对象无需特殊宽松错误匹配。
不使用递归对象删除、`rb --force`、通配符、Compose down 或卷删除。
删除用户、策略、桶后再次查询，必须分别收到对应的不存在错误。
客户端删除前核对本轮 GUID 标签；本地仅删除已知临时文件及其空目录。

清理某一步失败会继续清理其余本轮资源，但最终退出非零并记录错误。
强制结束 PowerShell、Docker 断开或主机断电可能阻止 `finally` 完成；重新运行使用新 GUID，
不会批量扫除历史运行。恢复时根据报告中的精确资源名核对专用项目及所有权后处理，
不能对其他桶、用户、策略或服务做全局清理。

每轮报告位于忽略目录 `.data/s3-permissions-<GUID>.json`，包含版本、检查项、错误和本轮资源名，
不包含 root/user secret、认证头或签名 URL。临时客户端环境包含合成凭据，不能将这种测试
注入方式当作生产密钥管理方案。
创建 Docker/MinIO 资源之前先写入 `Running` 检查点，完成后更新为 `Passed` 或 `Failed`。
若进程被强制结束，保留的 `Running` 报告不是通过证据，只用于定位本轮精确资源。

## 验证记录

验证日期：2026-09-05。首个完整通过报告：
`.data/s3-permissions-86868a9005b14e2f8240f3d9c6d7cf46.json`，28 项检查通过，清理错误为 0。
随后两个重复运行报告分别为 `s3-permissions-a2753f3df18a41a89941ca898f4b8759.json`
和 `s3-permissions-a1e93ba7257c49a0a4e37fb628726f74.json`，均 28 项通过、清理错误为 0。
这三轮之后增加了无副作用的 SDK 依赖预检查和运行前恢复检查点；最终逻辑版本再次连续运行：

| 报告（位于 `.data/`）                                  | 结果      | 清理错误 |
| ------------------------------------------------------ | --------- | -------- |
| `s3-permissions-f3bf0893e9c44be1978cc7eef43b92b2.json` | 29 项通过 | 0        |
| `s3-permissions-f38dbf74bfc54d329cca7683916ef741.json` | 29 项通过 | 0        |

- PowerShell：7.6.5；Docker Client/Engine：29.7.2。
- Node：v24.12.0；`@aws-sdk/client-s3`：3.862.0；无新增依赖。
- MinIO：`RELEASE.2025-09-07T16-13-09Z`，digest `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`。
- mc：`RELEASE.2025-08-13T08-35-41Z`，digest `sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727`。
- 本项仅新增 PowerShell 验收和文档，使用语法解析、真实隔离验收、重复运行和文档格式检查作为直接验证；不把其他 Agent 并行代码的测试结果算作本项证据。

静态验证：PowerShell AST 语法解析和函数 comment-based help 检查、
`node --check scripts/fixtures/verify-s3-permissions.mjs`、
`pnpm exec prettier --check docs/s3-permissions-acceptance.md scripts/fixtures/verify-s3-permissions.mjs`、
新文件 diff 空白检查及常见真实密钥模式扫描。项目没有 PowerShell lint/build 命令，
本项无编译产物；未运行或借用并行修改中的应用级全量 lint/typecheck/test/build。

以下五种负向启动均返回非零，创建资源前即被拒绝：

```powershell
pwsh -NoProfile -File scripts/verify-s3-permissions.ps1 -Project multimodal-canvas
pwsh -NoProfile -File scripts/verify-s3-permissions.ps1 -Project mc-acceptance-test-other
pwsh -NoProfile -File scripts/verify-s3-permissions.ps1 -Endpoint https://example.invalid
pwsh -NoProfile -File scripts/verify-s3-permissions.ps1 -Endpoint http://127.0.0.1:9000
```

第五种是在子进程环境设置 `DOCKER_HOST=tcp://example.invalid:2375` 后执行默认命令，
明确收到 `DOCKER_HOST` 拒绝，测试后恢复原进程变量。没有创建或切换 Docker context。
只读列举专用 MinIO 的桶、用户和策略，并与所有本轮报告的精确资源名比对：无残留；
Docker 中没有本脚本标签的临时客户端，专用 PostgreSQL/Redis/MinIO 始终保持健康。

实现阶段保留了失败记录：mc 会将部分对象错误归一化并丢失 S3 错误码，因此对象断言改用
现有官方 SDK；连接复用时删除反例重复出现传输超时，独立连接后完整通过。
失败轮次没有降低权限断言标准，均尝试完整清理；第一轮 mc 对不存在对象和空桶的错误
表达导致清理报告失败，经只读查询确认其测试桶实际已删除，后续使用 SDK 精确核验。
