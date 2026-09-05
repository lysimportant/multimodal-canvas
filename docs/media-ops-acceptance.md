# 媒体与可观测性本地验收

## 范围与检查点

日期：2026-09-05。起点 `main` / `9692ed8`，Node `v24.12.0`、pnpm `11.19.0`。
仅处理 P0-03/P1-05 的媒体归档和可观测性本地缺口，没有连接生产或收费 Provider，未提交推送。
开始时 Worker 归档/输出 20、API 媒体 6、Observability 15 项定向测试通过。
仓库没有 README 或项目级 AGENTS.md；执行边界来自本任务提供的代理规则和合并 TODO。

## 实际修复

- 真实 FFmpeg 复现音频 waveform 声明 `image/png`、实际编码为 MJPEG；API/Worker 现在显式输出 PNG。
- Worker 新增可选缩略图、poster、waveform 生成和归档，沿用 API 的对象键与描述格式。
- FFmpeg/ffprobe 使用本地临时文件，禁止 HTTP 等二次联网协议，执行超时后终止子进程；异常不暴露原始 stderr。
- 校验工具超时为正整数，拒绝空预览，成功或失败均清理本次临时目录。
- Worker 下载的 DNS、响应头、流读取共享截止时间；取消后不再继续下载，拒绝体积超限及错误媒体类型，取消未消费的响应体。
- 严格 DNS 模式下，默认 HTTP 传输在真实 socket 的 lookup 回调内再次校验地址，不使用第二次未校验的解析结果；拦截 IPv4 映射 IPv6、私网、CGNAT 和组播地址。支持 gzip/deflate/br 流式解压，解压后的字节仍受大小限制。自定义 `fetchImpl` 属于可信注入边界，必须自行满足同等连接约束。
- 下载采用同媒体类别的实际响应 MIME，避免将 WebP 等响应错误归档为默认 PNG；Provider 明确 MIME 不匹配时失败，不伪装成目标媒体类型。
- 修复字符串数组中的 base64 输出被外层 `data` 覆盖；补充 AAC/FLAC/Opus/PCM 格式提示。
- S3 单次 put/delete（含 SDK 重试）默认最多 30 秒；归档元数据沿用共享脱敏策略，不保存认证信息和签名查询参数。
- 数据库提交结果未知且回查失败时保留可能已被引用的对象，不以清理为由删除已成功结果；确认失败时按本次写入键清理。
- OTLP/Sentry 投递默认超时 2 秒、最多 32 个在途请求；超量丢弃，不重试、不跟随重定向、不读取响应内容。
- 日志适配器异常与遥测故障回调异常均与主流程隔离；签名 URL、URL 用户信息、Cookie、认证属性和请求内容脱敏。普通 token usage 数值保留。

## 公共调用与存储契约

`PrismaResultAssetArchiver.archive(input)` 签名不变。新增可选构造参数：

```ts
const archiver = new PrismaResultAssetArchiver(prisma, {
  blobStore: new WorkerS3BlobStore(bucket, storageOptions),
  keyPrefix: isolatedPrefix,
  metadataExtractor: new WorkerFfprobeMediaMetadataExtractor({ binary: ffprobePath }),
  derivativeGenerator: new WorkerFfmpegMediaDerivativeGenerator({ binary: ffmpegPath }),
});
```

- 环境工厂在 `FFMPEG_ENABLED=true` 或显式 `FFMPEG_PATH` 时启用预览；ffprobe 仍使用已有配置。
- 新对象键：`${contentKey}.derivatives/{thumbnail|poster|waveform}`；API 的源键仍是 `assets/<id>/v1`，Worker 源键仍带内容摘要，不修改源对象。
- API 读取与预签名先选新键，仅新键缺失时回退旧 S3 `${contentKey}/derivatives/<kind>`；权限和传输失败不回退。S3 预签名用 HEAD 选择存在的键，不下载预览内容。
- Asset 与 AssetVersion 的 `metadata.derivatives[kind]` 保存 `mimeType/sizeBytes/sha256/contentUrl`。
- 辅助处理保存 `metadataStatus`、`derivativeStatus` 的 `ready/failed`。未配置工具时不写该状态；辅助失败不会把原始媒体结果改为失败。
- 已有归档重放仍返回同一 asset/version；不会重新生成历史预览。缺失预览的重建不属于本次实现。
- `WorkerS3BlobStore` 新增可选 `timeoutMs`；默认 30000。
- `createExportingObservability` 新增 `timeoutMs`、`maxPendingExports`、`onExportFailure`。回调只接收 `timeout/network/http/capacity`，不接收地址、请求头、凭据或响应文本。

本轮不改数据库 schema，无需迁移或批量回填。新增元数据是兼容性扩展；回滚应保留对象与元数据，不删除既有归档。历史 MIME 错标不自动修正，内容或身份冲突仍显式拒绝。派生键切换的部署约束见下方“路径兼容与回滚”。

## 真实工具与设施

使用此前已保留的本地 `ffmpeg-9.0.1-essentials_build`，未新增下载、包依赖或全局安装。

| 工具        | SHA-256                                                            |
| ----------- | ------------------------------------------------------------------ |
| ffmpeg.exe  | `72A489ECCD008C2EC2C0A5856C5C75BC3D8BBFA90166C4566865C246445E6AA3` |
| ffprobe.exe | `19202B23C0043F15AD1B7BCE2344F406FD52BD6EFD8F995CE02E7392A1CEC52F` |

本地目录：`C:/Users/Sui/AppData/Local/Temp/multimodal-canvas-ffmpeg/extract/ffmpeg-9.0.1-essentials_build/bin`。
可通过 `FFMPEG_PATH`/`FFPROBE_PATH` 指定其它已安装的工具；Linux 未设置时使用 PATH。

真实设施使用已启动并迁移的隔离栈 `mc-acceptance-test-p0p1`，PostgreSQL `127.0.0.1:19432`、MinIO `127.0.0.1:19900`。
每次生成独立项目 UUID 与 `media-ops-test/<uuid>` 前缀；只清理该项目的行和记录到的精确对象键，不枚举删除桶，不停止共享测试栈，不操作开发容器。

## 可重复命令

Windows：先通过 `scripts/verify-isolated.ps1` 启动并迁移专用栈，再执行：

```powershell
./scripts/verify-media-ops.ps1 -FFmpegPath $env:FFMPEG_PATH -FFprobePath $env:FFPROBE_PATH
```

脚本只使用固定合成测试凭据，不读取 `.env`，结束后恢复所修改的进程环境变量。

Linux/CI 直接运行测试，不依赖 PowerShell。必须设置：

- `MEDIA_REAL_TESTS=true`、`MEDIA_OPS_INTEGRATION=true`、`WORKER_PROVIDER=mock`。
- `TEST_DATABASE_URL`：回环地址且数据库名包含 test/ci；只使用已迁移测试数据库。
- `TEST_S3_ENDPOINT`：回环 HTTP(S) 地址；`TEST_S3_BUCKET` 名称包含 test/ci/integration。
- `TEST_S3_REGION`、`TEST_S3_ACCESS_KEY`、`TEST_S3_SECRET_KEY`：隔离桶的合成凭据。
- 可选 `FFMPEG_PATH`、`FFPROBE_PATH`；未配置使用 PATH 中已安装的二进制。

```sh
pnpm --filter @multimodal-canvas/api exec vitest run src/assets.test.ts src/media.test.ts src/media.real.test.ts src/media-ops.integration.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @multimodal-canvas/worker exec vitest run src/result-archiver.test.ts src/result-output.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @multimodal-canvas/observability test --maxWorkers=1 --minWorkers=1
```

显式启用后配置或工具缺失会失败，不会把跳过算通过。普通单测不启用上述开关时跳过真实媒体/设施场景。

## 验收证据

- 真实存储/Prisma：8 项通过。PNG 图片、MP4 视频、WAV 音频从正式输出解析进入 Worker，源媒体和三类预览实存实读；校验真实 codec、640px 尺寸、SHA-256、AssetVersion 元数据、重复归档和项目隔离。另验证真实子进程启动失败时原音频仍可读。路径修复后新增 API/Worker 文件存储读回、S3 新键预签名、旧键只读回退及新旧同时存在时的新键优先。
- 真实 FFmpeg/ffprobe：5 项通过，包含三类媒体、1ms 子进程超时、HLS 二次 HTTP 请求为零。
- API 媒体边界：14 项通过；Worker 归档/输出定向回归：35 项通过。
- 可观测性：21 项通过，包含真实回环 HTTP collector 的 OTLP JSON、Sentry envelope、超时恢复、容量、503 和重定向故障；没有发送到第三方服务。
- API/Worker 主流程附加回归：26 项通过。
- 最终定向脚本：96 项通过，分别为 API 媒体/存储 40、Worker 归档/输出 35、Observability 21；全部使用单 worker 执行。
- 最终全量 Worker：`pnpm --filter @multimodal-canvas/worker exec vitest run --maxWorkers=1 --minWorkers=1`，12 个文件、183 项通过。
- API/Worker/Observability 的 `build` 均通过（包含 TypeScript 检查），范围内 Prettier 检查与 `git diff --check` 通过。
- 最终全量 API 为 454 passed、49 skipped，退出码 0；前次凭据目录事务测试替身缺少 `$executeRaw` 的 3 项失败已修复并通过回归。跳过项不计作通过，其中真实媒体和设施场景由显式隔离脚本单独执行通过。完整证据为 `.data/acceptance-units-final.log`。

## 路径兼容与回滚

- 真实 `FileSystemBlobStore` 复现了 thumbnail/poster/waveform 的 `ENOTDIR`：源 `v1` 是文件，不能再创建 `v1/derivatives` 子目录。修复后旁路 `v1.derivatives` 是目录，源文件内容和读取路径保持不变。
- API 与 Worker 只写新派生键。旧对象不迁移、不覆盖、不删除；旧 S3 预览仍可通过 API 直接读取及预签名下载。
- 新旧键同时存在时新键优先，不比较时间戳，不写回旧对象。新键返回权限/网络错误时显式失败，不能以旧键掩盖故障。
- 本地文件存储对缺失路径与源文件下不可能存在的旧子路径返回不存在（ENOENT/ENOTDIR）；其它文件系统错误仍抛出。
- `BlobStore.exists` 是可选接口扩展；S3 用 HEAD 实现，未实现此接口的可签名适配器以读取结果判断存在性。普通源文件和版本预签名逻辑不变。
- 对 Amazon S3，部署策略需允许对应前缀的 GetObject，并能区分不存在的键；没有前缀级 ListBucket 权限时，缺失键可能返回 403 而不是 404，此时按权限故障处理，不冒险回退。无需桶级广泛列举或旧对象写入权限。
- 部署时暂停新增上传/归档写入与队列消费，待全部 API 实例支持双读后再切换 Worker 并恢复写入。没有支持旧 API 与新写入器混部时预览零中断的承诺。
- 回滚版本必须保留双读能力和文件系统旁路目录写入；直接回滚到只读 `/derivatives` 的旧版，会使新预览不可见，虽不损坏源文件或版本数据，也不能算兼容回滚。不得通过批量迁移、复制或删除旧对象掩盖这一约束。
- `assets.test.ts` 当前 13 项通过，包括真实文件写入/重启读回、读取与预签名回退顺序、权限错误不降级、跨项目不可见及失败清理只针对新键。

## 部署边界

- 数据库提交不明时可能留下孤立对象，必须经确定引用关系后的维护任务回收，不能盲删。不同 FFmpeg 版本同时重建同一预览、历史预览重建不在本次验收范围。
- 禁止 FFmpeg 网络协议不等于操作系统沙箱；生产仍应使用非特权容器、只读根文件系统和独立临时目录限制本地文件访问。
- Linux/GitHub Runner 是否通过以对应执行日志为准，本节 Windows 本地证据不替代其它运行环境的结果。
- 本地真实 HTTP/S3/二进制证据不替代实际外部部署、真实 OTLP/Sentry 接收服务、供应商媒体契约或收费 Provider 验收。
