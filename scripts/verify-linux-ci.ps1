#requires -Version 7.0
<#
.SYNOPSIS
使用完整干净快照构建并运行一次性 Linux CI；不挂载宿主文件或连接开发设施。
.PARAMETER SnapshotPath
完整 index 或已审核工作区文件快照目录，必须包含本轮修改；禁止传入真实工作区或旧 HEAD。
.PARAMETER PrepareOnly
只构建固定 Node/pnpm、锁文件依赖、FFmpeg 和 Chromium，留待最终快照复用缓存。
.PARAMETER Image
专用验收镜像标签，不得指定生产镜像。
.PARAMETER Scope
full 执行全部验收；delta 只补跑指定包与 Web E2E，不代表重新执行基础设施验收。
.PARAMETER Packages
delta 模式中已经人工核对源码差异的包名；完整模式不使用。
.NOTES
全部运行容器共享独立的无外部网络命名空间。报告写入工作区 .data，退出时仅清理本次容器。
#>
param(
  [Parameter(Mandatory)][string]$SnapshotPath,
  [switch]$PrepareOnly,
  [ValidateSet('full', 'delta')][string]$Scope = 'full',
  [ValidateSet('api', 'web', 'worker', 'providers', 'domain', 'observability', 'credential-crypto', 'ui')]
  [string[]]$Packages = @(),
  [ValidatePattern('^multimodal-canvas-acceptance:[a-z0-9.-]+$')]
  [string]$Image = 'multimodal-canvas-acceptance:local'
)

$ErrorActionPreference = 'Stop'
if ($Scope -eq 'delta' -and $Packages.Count -eq 0) { throw 'delta 验收必须明确指定 Packages' }
if ($Scope -eq 'full' -and $Packages.Count -gt 0) { throw 'full 验收不能指定 Packages，避免误解执行范围' }
$snapshot = (Resolve-Path -LiteralPath $SnapshotPath).Path
$workspace = Split-Path $PSScriptRoot -Parent
$runName = 'mc-linux-ci-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$reportDirectory = Join-Path $workspace ".data/$runName"
$containers = [System.Collections.Generic.List[string]]::new()

<#
.SYNOPSIS
运行 Docker 并检查退出码，失败时不把半完成步骤当作成功。
.PARAMETER Arguments
已分开的 Docker 参数；不拼接跨 shell 命令或继承用户服务连接。
#>
function Invoke-Docker {
  param([Parameter(Mandatory)][string[]]$Arguments)
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Docker 步骤失败：$($Arguments[0])，退出码 $LASTEXITCODE" }
}

<#
.SYNOPSIS
等待本次创建的依赖就绪，最多等待 60 次；只执行只读健康检查。
.PARAMETER Arguments
Docker exec 参数，必须指向本次创建的隔离容器。
#>
function Wait-Dependency {
  param([Parameter(Mandatory)][string[]]$Arguments)
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & docker @Arguments *> $null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 1
  }
  throw '隔离依赖未在 60 次健康检查内就绪'
}

foreach ($forbidden in @('.git', '.data', '.turbo', 'node_modules', '.pnpm-store', '.env')) {
  if (Test-Path -LiteralPath (Join-Path $snapshot $forbidden)) { throw "快照包含禁止打包的路径：$forbidden" }
}
foreach ($entry in Get-ChildItem -LiteralPath $snapshot -Force -Recurse) {
  if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw '快照不能包含符号链接或目录联接'
  }
  if ($entry.Name -in @('.git', '.data', '.turbo', 'node_modules', 'dist', 'test-results', '.pnpm-store')) {
    throw "快照包含禁止打包的目录或文件：$($entry.Name)"
  }
  if ($entry.Name -eq '.env' -or ($entry.Name -like '.env.*' -and $entry.Name -notlike '*.example')) {
    throw '快照不能包含真实 .env 配置'
  }
}
foreach ($required in @('package.json', 'pnpm-lock.yaml', 'Dockerfile.acceptance', 'scripts/verify-linux-ci.sh')) {
  if (!(Test-Path -LiteralPath (Join-Path $snapshot $required) -PathType Leaf)) { throw "快照缺少 $required" }
}
$package = Get-Content -LiteralPath (Join-Path $snapshot 'package.json') -Raw | ConvertFrom-Json
if ($package.packageManager -ne 'pnpm@11.19.0') { throw '验收镜像与快照的 pnpm 版本不一致' }
$npmConfiguration = Get-Content -LiteralPath (Join-Path $snapshot '.npmrc') -Raw
if ($npmConfiguration -match '(?im)(?:_auth(?:Token)?|password)\s*=') { throw '快照 .npmrc 不得包含认证配置' }

New-Item -ItemType Directory -Path $reportDirectory | Out-Null
$sourceManifest = @(Get-ChildItem -LiteralPath $snapshot -File -Force -Recurse | Sort-Object FullName | ForEach-Object {
  [ordered]@{
    path = [IO.Path]::GetRelativePath($snapshot, $_.FullName).Replace('\', '/')
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
})
$sourceManifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $reportDirectory 'source-manifest.json') -Encoding utf8
$target = if ($PrepareOnly) { 'dependencies' } else { 'acceptance' }
Invoke-Docker -Arguments @('build', '--progress=plain', '--target', $target, '--tag', $Image, '--file', (Join-Path $snapshot 'Dockerfile.acceptance'), $snapshot)
if ($PrepareOnly) {
  Write-Host "隔离依赖镜像准备完成：$Image；完整验收仍需包含本轮修改的已审核快照。"
  return
}

try {
  $runner = "$runName-runner"
  $containers.Add($runner)
  Invoke-Docker -Arguments @('run', '--detach', '--name', $runner, '--label', "multimodal.acceptance=$runName", '--network', 'none', '--shm-size', '1g', '--entrypoint', 'sleep', $Image, 'infinity') | Out-Null
  if ($Scope -eq 'full') {
  foreach ($service in @(
    @{ Name = 'postgres'; Image = 'postgres:16-alpine'; Arguments = @('-e', 'POSTGRES_DB=multimodal_canvas_ci', '-e', 'POSTGRES_USER=ci_user', '-e', 'POSTGRES_PASSWORD=ci_password'); Command = @() },
    @{ Name = 'redis'; Image = 'redis:7-alpine'; Arguments = @(); Command = @() },
    @{ Name = 'minio'; Image = 'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e'; Arguments = @('-e', 'MINIO_ROOT_USER=ci-minio-user', '-e', 'MINIO_ROOT_PASSWORD=ci-minio-password'); Command = @('server', '/data', '--console-address', ':9001') }
  )) {
    $name = "$runName-$($service.Name)"
    $containers.Add($name)
    Invoke-Docker -Arguments (@('run', '--detach', '--name', $name, '--label', "multimodal.acceptance=$runName", '--network', "container:$runner") + $service.Arguments + @($service.Image) + $service.Command) | Out-Null
  }
  Wait-Dependency -Arguments @('exec', "$runName-postgres", 'pg_isready', '-U', 'ci_user', '-d', 'multimodal_canvas_ci')
  Wait-Dependency -Arguments @('exec', "$runName-redis", 'redis-cli', 'ping')
  Wait-Dependency -Arguments @('exec', $runner, 'curl', '--fail', '--silent', 'http://127.0.0.1:9000/minio/health/live')
  Invoke-Docker -Arguments @('run', '--rm', '--network', "container:$runner", '--entrypoint', '/bin/sh', 'minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727', '-ec', 'mc alias set local http://127.0.0.1:9000 ci-minio-user ci-minio-password; mc mb local/multimodal-canvas-linux-ci')
  }

  [ordered]@{
    run = $runName
    scope = $Scope
    packages = $Packages
    snapshot = $snapshot
    image = $Image
    imageId = (& docker image inspect $Image --format '{{.Id}}')
    lockfileSha256 = (Get-FileHash -LiteralPath (Join-Path $snapshot 'pnpm-lock.yaml') -Algorithm SHA256).Hash
    sourceManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $reportDirectory 'source-manifest.json') -Algorithm SHA256).Hash
    network = '独立 network=none 命名空间，无宿主端口、挂载或外部网络'
    startedAt = [DateTime]::UtcNow.ToString('O')
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $reportDirectory 'environment.json') -Encoding utf8
  Write-Host "Linux 隔离验收开始：$runName；报告：$reportDirectory"
  Invoke-Docker -Arguments @('exec', '-e', 'ACCEPTANCE_ISOLATED=true', '-e', "ACCEPTANCE_SCOPE=$Scope", '-e', "ACCEPTANCE_PACKAGES=$($Packages -join ',')", '-e', 'PLAYWRIGHT_JSON_OUTPUT_FILE=/workspace/test-results/ci/web-e2e.json', $runner, '/bin/bash', '/workspace/scripts/verify-linux-ci.sh') | Tee-Object -FilePath (Join-Path $reportDirectory 'execution.log')
} finally {
  if ($runner) {
    & docker cp "${runner}:/workspace/test-results/." $reportDirectory 2>$null
  }
  $cleanupNames = $containers.ToArray()
  [Array]::Reverse($cleanupNames)
  foreach ($name in $cleanupNames) {
    $label = & docker inspect $name --format '{{index .Config.Labels "multimodal.acceptance"}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $label -eq $runName -and $name.StartsWith("$runName-")) {
      & docker rm --force --volumes $name | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Warning "隔离容器清理失败，请按验收标签核对：$name" }
    }
  }
  Write-Host "验收报告保留在 $reportDirectory；未删除输入快照或验收镜像。"
}
