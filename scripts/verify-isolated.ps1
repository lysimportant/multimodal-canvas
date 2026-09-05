#requires -Version 7.0
<#
.SYNOPSIS
在专用 Compose 项目执行 P0/P1 基础设施验收，只向本机回环地址发布端口，不操作开发服务。
.PARAMETER Action
Start 创建隔离设施；Test 验证迁移及集成；Stop 仅停止该项目，保留测试卷。
.PARAMETER Project
本次专用项目名，必须以 mc-acceptance-test- 开头；各次调用必须保持一致。
#>
param(
  [ValidateSet('Start', 'Test', 'Stop')][string]$Action = 'Test',
  [ValidatePattern('^mc-acceptance-test-[a-z0-9-]+$')][string]$Project = 'mc-acceptance-test-p0p1',
  [int]$PostgresPort = 19432,
  [int]$RedisPort = 19379,
  [int]$S3Port = 19900,
  [int]$S3ConsolePort = 19901,
  [string]$OpenSslPath = ''
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$composePath = Join-Path $workspace 'docker-compose.dev.yml'
$emptyEnvironment = [System.IO.Path]::GetTempFileName()
$variables = @{
  COMPOSE_PROJECT_NAME = $Project
  POSTGRES_DB = 'multimodal_canvas_test'
  POSTGRES_USER = 'test_user'
  POSTGRES_PASSWORD = 'synthetic-test-password'
  POSTGRES_HOST_PORT = "127.0.0.1:$PostgresPort"
  REDIS_HOST_PORT = "127.0.0.1:$RedisPort"
  MINIO_API_HOST_PORT = "127.0.0.1:$S3Port"
  MINIO_CONSOLE_HOST_PORT = "127.0.0.1:$S3ConsolePort"
  MINIO_ROOT_USER = 'synthetic-test-user'
  MINIO_ROOT_PASSWORD = 'synthetic-test-password'
  S3_BUCKET = $Project
  DATABASE_URL = ''
  WORKER_PROVIDER = 'mock'
  RUN_SERVICE = 'memory'
  NEW_API_BASE_URL = ''
  NEW_API_API_KEY = ''
  TEST_DATABASE_URL = "postgresql://test_user:synthetic-test-password@127.0.0.1:$PostgresPort/multimodal_canvas_test?schema=public"
  TEST_REDIS_URL = "redis://127.0.0.1:$RedisPort/15"
  TEST_REDIS_NAMESPACE = $Project
  TEST_S3_ENDPOINT = "http://127.0.0.1:$S3Port"
  TEST_S3_REGION = 'us-east-1'
  TEST_S3_BUCKET = $Project
  TEST_S3_ACCESS_KEY = 'synthetic-test-user'
  TEST_S3_SECRET_KEY = 'synthetic-test-password'
  TEST_S3_PREFIX = "integration/$Project"
  REQUIRE_INTEGRATION_SERVICES = 'true'
  REQUIRE_PRODUCTION_ENTRY = 'false'
  OPENSSL_PATH = $OpenSslPath
}
$previous = @{}
try {
  foreach ($name in $variables.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $variables[$name], 'Process')
  }
  Push-Location $workspace
  if ($Action -eq 'Start') {
    & docker compose --env-file $emptyEnvironment -f $composePath -p $Project up --detach --wait postgres redis minio
    if ($LASTEXITCODE -ne 0) { throw '隔离设施启动失败，请检查专用端口和 Docker 状态' }
    & docker compose --env-file $emptyEnvironment -f $composePath -p $Project run --rm --no-deps minio-init
    if ($LASTEXITCODE -ne 0) { throw '隔离存储初始化失败' }
  } elseif ($Action -eq 'Stop') {
    & docker compose --env-file $emptyEnvironment -f $composePath -p $Project stop
    if ($LASTEXITCODE -ne 0) { throw '隔离设施停止失败' }
  } else {
    $env:DATABASE_URL = $env:TEST_DATABASE_URL
    & pnpm exec prisma migrate deploy
    if ($LASTEXITCODE -ne 0) { throw '隔离数据库迁移失败' }
    & pnpm exec prisma migrate diff --from-url $env:TEST_DATABASE_URL --to-schema-datamodel prisma/schema.prisma --exit-code
    if ($LASTEXITCODE -ne 0) { throw '隔离数据库 schema 不一致' }
    $env:DATABASE_URL = ''
    $env:S3_BUCKET = ''
    & pnpm --filter '@multimodal-canvas/api' test:integration --maxWorkers=1 --minWorkers=1
    if ($LASTEXITCODE -ne 0) { throw '隔离基础设施集成测试失败' }
    & pnpm --filter '@multimodal-canvas/api' exec vitest run --config vitest.rate-limit-integration.config.ts --maxWorkers=1 --minWorkers=1
    if ($LASTEXITCODE -ne 0) { throw 'Redis 跨进程限流验收失败' }
    if (-not $env:OPENSSL_PATH) {
      $openssl = Get-Command openssl -ErrorAction SilentlyContinue
      if ($openssl) {
        $env:OPENSSL_PATH = $openssl.Source
      } else {
        $git = Get-Command git -ErrorAction SilentlyContinue
        if ($git) {
          $candidate = Join-Path (Split-Path (Split-Path $git.Source -Parent) -Parent) 'usr/bin/openssl.exe'
          if (Test-Path -LiteralPath $candidate -PathType Leaf) { $env:OPENSSL_PATH = $candidate }
        }
      }
    }
    if (-not $env:OPENSSL_PATH) { throw 'TLS 验收需要 OpenSSL，请通过 -OpenSslPath 指定现有工具路径' }
    $env:REQUIRE_PRODUCTION_ENTRY = 'true'
    & pnpm --filter '@multimodal-canvas/api' exec vitest run src/production-proxy.test.ts --maxWorkers=1 --minWorkers=1
    if ($LASTEXITCODE -ne 0) { throw 'TLS 生产入口验收失败' }
  }
} finally {
  Pop-Location
  foreach ($name in $previous.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
  }
  Remove-Item -LiteralPath $emptyEnvironment -Force
}
