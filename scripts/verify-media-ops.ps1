#requires -Version 7.0
<#
.SYNOPSIS
在已启动并迁移的专用回环测试栈中验收真实媒体与 S3 派生归档，不操作 Compose 或读取 .env。
.PARAMETER FFmpegPath
本地 FFmpeg 可执行文件；默认读取 FFMPEG_PATH，否则使用 PATH 中的 ffmpeg。
.PARAMETER FFprobePath
本地 ffprobe 可执行文件；默认读取 FFPROBE_PATH，否则使用 PATH 中的 ffprobe。
#>
param(
  [string]$FFmpegPath = $(if ($env:FFMPEG_PATH) { $env:FFMPEG_PATH } else { 'ffmpeg' }),
  [string]$FFprobePath = $(if ($env:FFPROBE_PATH) { $env:FFPROBE_PATH } else { 'ffprobe' }),
  [ValidatePattern('^mc-acceptance-test-[a-z0-9-]+$')][string]$Project = 'mc-acceptance-test-p0p1',
  [int]$PostgresPort = 19432,
  [int]$S3Port = 19900
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$variables = @{
  FFMPEG_PATH = $FFmpegPath
  FFPROBE_PATH = $FFprobePath
  MEDIA_REAL_TESTS = 'true'
  MEDIA_OPS_INTEGRATION = 'true'
  WORKER_PROVIDER = 'mock'
  RUN_SERVICE = 'memory'
  DATABASE_URL = ''
  S3_BUCKET = ''
  NEW_API_BASE_URL = ''
  NEW_API_API_KEY = ''
  TEST_DATABASE_URL = "postgresql://test_user:synthetic-test-password@127.0.0.1:$PostgresPort/multimodal_canvas_test?schema=public"
  TEST_S3_ENDPOINT = "http://127.0.0.1:$S3Port"
  TEST_S3_REGION = 'us-east-1'
  TEST_S3_BUCKET = $Project
  TEST_S3_ACCESS_KEY = 'synthetic-test-user'
  TEST_S3_SECRET_KEY = 'synthetic-test-password'
}
$previous = @{}
Push-Location $workspace
try {
  foreach ($name in $variables.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $variables[$name], 'Process')
  }
  foreach ($binary in @($FFmpegPath, $FFprobePath)) {
    $version = & $binary -version
    if ($LASTEXITCODE -ne 0) { throw '本地媒体工具不可用；请提供已安装工具路径' }
    Write-Output $version[0]
  }
  & pnpm --filter '@multimodal-canvas/api' exec vitest run src/assets.test.ts src/media.test.ts src/media.real.test.ts src/media-ops.integration.test.ts --maxWorkers=1 --minWorkers=1
  if ($LASTEXITCODE -ne 0) { throw '真实媒体与 S3 验收失败' }
  & pnpm --filter '@multimodal-canvas/worker' exec vitest run src/result-archiver.test.ts src/result-output.test.ts --maxWorkers=1 --minWorkers=1
  if ($LASTEXITCODE -ne 0) { throw 'Worker 媒体边界回归失败' }
  & pnpm --filter '@multimodal-canvas/observability' test --maxWorkers=1 --minWorkers=1
  if ($LASTEXITCODE -ne 0) { throw '可观测性验收失败' }
} finally {
  foreach ($name in $previous.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
  }
  Pop-Location
}
