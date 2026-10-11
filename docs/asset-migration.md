# 旧 MinIO 素材迁入 R2

适用于数据库中的资源记录还在、文件仍留在旧 MinIO，而当前 API 已读取 R2 的部署。脚本只迁移对象，不复制数据库、认领用户资源或改写画布。如果切换到了空数据库，先另行恢复一致的数据库备份，不能靠对象迁移重建项目、版本与任务记录。

迁移会在 R2 中新增对象并产生存储与读取流量。执行前备份数据库、旧 MinIO 数据及应用密钥；迁移期间暂停旧存储写入，避免清单与下载内容变化。原存储和数据库不受脚本改写。回退可以继续使用旧存储和原有配置；如果需要清理本次新增的 R2 对象，先根据报告核对对象及现有引用，另行授权删除，脚本不自动回滚或删除。

## 配置源与目标

复制 `.env.migrate-assets.example` 为私有 `.env.migrate-assets`，填写旧 MinIO 的 endpoint、bucket 和读取凭据。服务器使用 `chmod 600 .env.migrate-assets .env.compose` 限制读取。源 endpoint 必须从迁移容器或宿主 Node 可达，不能把 Docker 内的 `localhost` 当成宿主机地址。

目标使用现有 `.env.compose` 中的 `S3_ENDPOINT`、`S3_BUCKET`、`S3_ACCESS_KEY` 和 `S3_SECRET_KEY`，必须是已创建的私有 R2 bucket。脚本不会创建 bucket，也不读取 `DATABASE_URL`。可选 Neon 覆盖层不会改变本脚本迁移的对象范围。

默认迁移 `assets/` 前缀下的所有对象，包含原文件、历史版本及新旧布局的派生文件，也可能包含没有数据库引用的历史对象。不会把未完成上传的临时对象迁入资源目录。如果旧部署自定义过对象键前缀，用 `--prefix 原前缀/` 明确指定；空前缀被拒绝，避免误复制整个 bucket。

## 服务器：使用 Docker

在仓库根目录执行。以下命令使用当前默认 Compose 项目；部署使用了 `-p` 或额外配置文件时，保留原部署的项目名与文件组合。构建 API 镜像只准备迁移工具，不重启应用、不启动依赖或运行数据库迁移。

```bash
docker compose --env-file .env.compose -f compose.yaml build api
mkdir -p .data/asset-migration
```

默认检查只列举源对象并检查目标是否存在，不下载素材、不上传对象。报告写入绑定目录，不依赖容器的临时文件系统：

```bash
docker compose --env-file .env.compose -f compose.yaml run --rm --no-deps \
  --user "$(id -u):$(id -g)" --entrypoint node \
  --volume "$PWD/.env.migrate-assets:/migration/source.env:ro" \
  --volume "$PWD/.data/asset-migration:/migration/work" \
  api docker/migrate-assets.mjs \
  --source-env-file /migration/source.env --work-dir /migration/work
```

核对报告中的范围、失败项和空间后，复制同一命令并在末尾加 `--apply` 执行复制。同名同大小在检查阶段仅标记 `unchecked_existing`，不代表内容已经核验。

Windows PowerShell 使用同一镜像与配置；绑定路径使用绝对路径：

```powershell
docker compose --env-file .env.compose -f compose.yaml build api
New-Item -ItemType Directory -Force .data/asset-migration | Out-Null
$migrationRoot = (Get-Location).Path
docker compose --env-file .env.compose -f compose.yaml run --rm --no-deps --user 0 --entrypoint node --volume "${migrationRoot}/.env.migrate-assets:/migration/source.env:ro" --volume "${migrationRoot}/.data/asset-migration:/migration/work" api docker/migrate-assets.mjs --source-env-file /migration/source.env --work-dir /migration/work
```

执行迁移同样在最后加 `--apply`。无需为了迁移重启 API/Worker；原对象键一旦在 R2 恢复，现有内容读取接口即可读取它们。

## 旧 MinIO 已停用，只剩 Docker 卷

不要直接把卷内的 `xl.meta` 或 `part.*` 当成素材上传，也不要把原卷挂给一个新 MinIO 实例写入。先在 Docker 备份或存储快照中保存原卷，再复制到全新的恢复卷；临时 MinIO 只使用副本。分布式或加密 MinIO 必须恢复全部必要磁盘及 KMS 密钥，不能仅复制一个卷。

下面是单节点、单数据卷部署的恢复示例。先把 `OLD_MINIO_VOLUME` 换成检查到的旧卷，把 `OLD_MINIO_IMAGE` 换成旧部署使用的固定版本镜像。`canvas-assets-recovery` 必须是一个未存在的新卷；如果名称已存在，换一个新名字，不复用或清空旧卷。应用镜像使用上一节构建的本地镜像。

```bash
docker volume inspect OLD_MINIO_VOLUME
docker volume inspect canvas-assets-recovery
# 上一条应提示该恢复卷不存在；确认后才创建。
docker volume create canvas-assets-recovery
docker run --rm --network none --user 0 --read-only \
  --mount type=volume,source=OLD_MINIO_VOLUME,target=/source,readonly \
  --mount type=volume,source=canvas-assets-recovery,target=/copy \
  --entrypoint sh multimodal-canvas-api:local -c 'cp -a /source/. /copy/'
```

在 `.env.migrate-assets` 中填入副本实例的 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`，并同步源 access key / secret key。确认当前 API 的 Docker 网络名（默认是 `multimodal-canvas-app_default`），将临时 MinIO 加入同一网络；不发布任何宿主端口：

```bash
docker run -d --name canvas-assets-recovery-minio \
  --network multimodal-canvas-app_default \
  --env-file .env.migrate-assets \
  --mount type=volume,source=canvas-assets-recovery,target=/data \
  OLD_MINIO_IMAGE server /data --address :9000 --console-address :9001
```

源 endpoint 使用 `http://canvas-assets-recovery-minio:9000`，源 bucket 保持原名，随后执行上一节检查与迁移。PowerShell 也可执行这些 Docker 命令，改用单行或 PowerShell 续行。迁移与浏览器验证完成后可以停止临时实例：`docker stop canvas-assets-recovery-minio`。保留原卷和副本，清理不属于迁移脚本的默认操作。

本机前一轮诊断找到的旧卷是 `multimodal-canvas-app_minio`；服务器必须自行核对，不能照搬本机卷名或资源数量。

## 已有 Node 项目依赖的环境

使用仓库规定的 Node 24.12.0 / pnpm 11.19.0 和锁定依赖，无需安装全局迁移包。宿主运行时，源 endpoint 应使用宿主可以访问的地址。

```bash
node scripts/docker/migrate-assets.mjs --help
node scripts/docker/migrate-assets.mjs --source-env-file .env.migrate-assets --target-env-file .env.compose
node scripts/docker/migrate-assets.mjs --source-env-file .env.migrate-assets --target-env-file .env.compose --apply
```

文件配置仅加载指定文件，不自动加载根 `.env`。命令不接受明文密码参数；所有凭据来自私有文件或进程环境。不要把报告、私有环境文件或媒体暂存目录加入 Git。

## 校验、失败与重跑

执行阶段逐个将源文件流式暂存到 `--work-dir`，核对长度并计算 SHA-256，使用条件写入创建缺失对象，再读取 R2 内容验证同一哈希。已有对象也读取内容核验；冲突时保留目标并报告失败。不要用 ETag 代替 SHA-256，MinIO 的分片 ETag 不一定是文件哈希。

工作目录至少需要容纳最大单个素材和报告。单次上传支持至多 5 GiB 的对象；更大文件会明确失败，需要另选支持分片上传的迁移方式。脚本不会自动修改依赖或切换方案。

JSONL 报告以私有权限创建，逐项记录键、大小、状态及已校验哈希，最后写汇总。默认每次生成新报告；`--report 路径` 指定的文件必须不存在，避免覆盖旧记录。源或目标配置在报告中只有哈希标识，不记录凭据或签名 URL。退出码 0 表示本轮所选范围没有失败；非 0 时查看 `failed` 项及其 `stage` / `code`。检查模式不等于完成迁移。

| 状态                 | 含义                                                   |
| -------------------- | ------------------------------------------------------ |
| `would_copy`         | 检查发现目标缺失，执行时才复制                         |
| `unchecked_existing` | 检查发现目标同大小，内容尚未校验                       |
| `created`            | 本轮创建目标，并完成 SHA-256 核验                      |
| `verified_existing`  | 目标实际内容一致，未覆盖；也用于上传结果未知后核对成功 |
| `failed`             | 缺失、冲突、权限、网络或完整性错误，需要处理           |

中断后重新运行同一迁移命令。脚本重新检查真实对象，同内容跳过，不依赖旧报告假定成功；结果未知的上传先核对目标，不重复发送上传请求。源清单不能列举时本轮失败，不能把空清单或权限错误当成全部迁完。

最后在应用中检查一张旧图片的原图与缩略图、一段旧音视频的预览与下载，以及资源的历史版本。数据库记录、画布 URL 或权限仍不正确时，需要继续排查对应链路；对象迁移不会修复这些问题。合成测试只验证脚本行为，真实服务器与旧文件完整性仍以实际迁移报告和应用验证为准。
