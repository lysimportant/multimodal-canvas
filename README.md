# multimodal-canvas

以 PC Web 为主的多模态创作画布。用户组织文字、图片、音频和视频节点，通过连线与资源引用执行模型任务，保存画布、素材版本和结果。

## 当前职责

| 组件                | 负责                                                       |
| ------------------- | ---------------------------------------------------------- |
| Canvas Web          | 节点编辑、参数输入、资源引用、任务与结果展示               |
| Canvas API / Worker | 身份和资源归属、任务持久化、防重、请求序列化、结果归档     |
| New API             | 身份授权、分组和模型权限、能力判断、价格、预扣、计费及账单 |
| PostgreSQL / Neon   | 用户映射、画布、资源元数据、Run 和执行授权                 |
| Redis               | 队列与运行配置                                             |
| Cloudflare R2       | 私有素材对象；部署必需，不使用 MinIO                       |

Canvas 不维护钱包、报价、预估费用或金额账本，也不按模型名或目录能力再次限制用户的时长、模式、数量、比例、分辨率和媒体引用。用户输入经对应协议转发，由 New API / 上游判断是否支持。登录、所有权、数据结构、资源版本、路径安全和发送防重仍由 Canvas 保证。

## Docker 部署

需要 Docker Engine / Docker Desktop（Linux containers）与 Compose 2.24.4 或更高版本，Neon 覆盖层使用 `!override`。应用镜像固定 Node 24.12.0 / pnpm 11.19.0；宿主机不必安装 Node。

1. 创建私有 Cloudflare R2 bucket，为该 bucket 创建有对象读写权限的 API Token，取得 S3 endpoint、access key 和 secret key。
2. 在独立的 New API 登记 Canvas 的 client、instance 与精确回调地址。
3. 将 `.env.compose.example` 复制为 `.env.compose`，填写 R2 和 New API 配置。真实配置不能提交到 Git。

必填配置：

| 变量                             | 含义                                            |
| -------------------------------- | ----------------------------------------------- |
| `S3_ENDPOINT`                    | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_BUCKET`                      | 已存在的私有 R2 bucket                          |
| `S3_ACCESS_KEY`、`S3_SECRET_KEY` | 限定该 bucket 的对象读写凭据                    |
| `NEW_API_ISSUER`                 | 浏览器和 API/Worker 均可访问的 New API 来源     |

`S3_REGION=auto`；R2 所需的 AWS 附加校验和选项由运行配置设置为 `WHEN_REQUIRED`。上传与下载经 API，不能把长期 R2 密钥交给浏览器。bucket 必须预先创建，启动不会修改 Cloudflare 账户或设置。

`NEW_API_CLIENT_ID`、`NEW_API_INSTANCE_ID`、`NEW_API_REDIRECT_URI` 与 New API 的登记一致。`CANVAS_WEB_URL` 是用户实际访问的来源，默认 `http://localhost:8080`，回调路径为 `/v1/auth/newapi/callback`。管理员配置使用 New API 不可变用户 ID。
同源网关部署不需要 `CORS_ORIGIN`；只有浏览器从其他来源访问 API 时才显式设置 HTTPS origin 列表。

默认使用本栈 PostgreSQL 和 Redis：

```bash
docker compose --env-file .env.compose -f compose.yaml config --quiet
docker compose --env-file .env.compose -f compose.yaml up -d --build --wait
docker compose --env-file .env.compose -f compose.yaml ps -a
docker compose --env-file .env.compose -f compose.yaml stop
```

本机访问 `http://localhost:8080`。服务只发布 Web 回环端口，数据库、Redis 与 API 不对宿主机开放。停止保留数据卷；启动包含 `prisma migrate deploy`，应用既有版本迁移，不能指向未经核对的数据库。

Windows PowerShell 5.1+ 可使用 `scripts/docker.ps1`，Linux Bash 可使用 `scripts/docker.sh`。`Build` / `build` 只构建镜像，`Start` / `start` 才启动并执行迁移：

```powershell
.\scripts\docker.ps1 -Action Build
.\scripts\docker.ps1 -Action Start -NoBrowser
.\scripts\docker.ps1 -Action Status
.\scripts\docker.ps1 -Action Stop
```

```bash
bash scripts/docker.sh build
bash scripts/docker.sh start
bash scripts/docker.sh status
bash scripts/docker.sh stop
```

外部数据库加 `-Neon` / `--neon`，公网入口加 `-Server` / `--server`。旧 `-LocalNewApi` 和本机自签 HTTPS 配套入口已退出，不启动内置 New API 或 Mock，不再依赖 `.local-tests/newapi-account/local-docker`。

### 可选 Neon

不使用 Neon 时无需填写 `DATABASE_URL`，运行默认 PostgreSQL 即可。

使用 Neon 时，将 `DATABASE_URL` 设为 Neon 的直连地址（主机名不含 `-pooler`），保留 `sslmode=require`，选择靠近部署机的区域。迁移与 API/Worker 使用同一数据库：

```bash
docker compose --env-file .env.compose -f compose.yaml -f compose.neon.yaml config --quiet
docker compose --env-file .env.compose -f compose.yaml -f compose.neon.yaml up -d --build --wait
docker compose --env-file .env.compose -f compose.yaml -f compose.neon.yaml ps -a
docker compose --env-file .env.compose -f compose.yaml -f compose.neon.yaml stop
```

所有操作保留相同文件组合与项目名，不能把默认 PostgreSQL 栈和 Neon 栈当成可随意互换的数据库。切换数据库必须另行迁移现有数据，不自动复制或覆盖。

### 公网 HTTPS

配置自己的 DNS、`MC_DOMAIN` 和对应的 HTTPS `CANVAS_WEB_URL` 后，启用 `server` profile：

```bash
docker compose --env-file .env.compose -f compose.yaml --profile server up -d --build --wait
```

Neon 部署同时加上 `-f compose.neon.yaml`。New API 回调应匹配公网 HTTPS 来源。供应商媒体引用通过本站短时签名 API 读取 R2 冻结版本，公网网关须支持 GET / HEAD / Range，并隐藏日志中的签名参数；不要求公开 bucket。localhost 素材不能直接供远端供应商读取。

## 本地开发与验证

需要 Node 24.12.0、pnpm 11.19.0，使用锁文件和项目依赖：

```powershell
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
pnpm exec turbo run dev --parallel --env-mode=loose
```

先安全注入 `.env.example` 所列环境变量。开发入口不自动加载根 `.env`；`--env-mode=loose` 只透传进程已有变量，不启动数据库、Redis 或 R2。`pnpm db:generate` 不迁移数据库。开发 API 默认 3000、Web 默认 5173，单独启动 Web 使用 `pnpm --filter @multimodal-canvas/web dev`。

常规检查：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm build:runtime
git diff --check
```

Docker 入口与配置另做 Compose 渲染、Node 测试和脚本语法检查。设施集成只用明确的 `TEST_DATABASE_URL`、`TEST_REDIS_URL` 和测试专属 R2 bucket/prefix，不对生产对象执行测试清理。没有真实 R2 / Neon / New API 的测试结果，不能称为这些环境已验收。

## 数据、更新与回退

- `.env*`、密钥、上传素材、`.data` 和本地验收文件不进入 Git。
- 本轮重配不会停止旧容器，也不会删除 PostgreSQL、Redis、对象存储或密钥卷，不会迁移 R2 对象。旧素材必须先确认导入或备份方案，不能用删除旧卷代替迁移。
- 更新前记录提交和镜像，停止写入并一致备份数据库、Redis、R2 对象与加密密钥。密钥丢失后不能仅靠数据库恢复凭据。
- 保留已发布 `prisma/migrations`。当前 Prisma Client 不包含旧费用字段和金额账本；既有数据库中的历史表/列保留，不自动执行 DROP。未来创建迁移时必须核对差异，不能让自动生成的迁移悄悄删除旧记录。
- Git 回退只能恢复源码与配置，不能撤销数据库迁移、恢复对象或更换过的密钥。回退应用前先核对数据兼容性，不运行 `down -v` 或 volume prune。
- 旧部署文档、验收检查点和方案已从工作区移除；历史记录可用 `git show 43d86c2:<path>` 查看，不代表当前部署能力。

## 素材与提示词来源

应用内提示词 Skill 的当前定义在 `packages/domain/src/prompt-skills.ts`。参考秋月盈、灰灰、洲洲工具包，来源分别为：

- 秋月盈：[工具包页面](https://lcn3xj0hi1iz.feishu.cn/wiki/Ppcywu3oIiQfsJkM3W0c0lsmnMe)
- 灰灰：[工具包页面](https://my.feishu.cn/wiki/QBw7w8MTkizHlYk8cUocqwstntg)
- 洲洲：[工具包页面](https://my.feishu.cn/wiki/O0kMwswPZipuzwkgSPRc0T4dnUc)

外部参考在 `G:/novel-studio/doument-canvas` 只读，不是运行依赖；旧来源映射保存在 Git 历史。留存快照不证明当前在线内容或版权许可。独立的仙妖裙装、柔光日系插画 Skill 来自用户参考图。

首页演示视频及品牌图来源分别保留在 `apps/web/public/demo/README.md`、`apps/web/public/brand/README.md`，不当作真实模型生成结果。
