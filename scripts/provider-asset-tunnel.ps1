#requires -Version 5.1
<#
.SYNOPSIS
为本机 Canvas 的签名素材路由临时提供公网 HTTPS 入口。
.DESCRIPTION
需要已启动的 multimodal-canvas-app、Docker Desktop 和本地 Caddy/cloudflared 镜像。
Start 仅更新 Worker 的 CANVAS_WEB_URL；Stop 在无活动 Run 时恢复此前来源并停止本脚本容器。
Cloudflare quick tunnel 地址是临时的；每次 Start 都重新读取当前地址。此入口不适合作为固定部署域名。
#>
[CmdletBinding()]
param(
  [ValidateSet('Start', 'Status', 'Stop')]
  [string]$Action = 'Status'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$composeFile = Join-Path $repoRoot 'compose.yaml'
$caddyFile = Join-Path $PSScriptRoot 'provider-asset-tunnel.Caddyfile'
$stateFile = Join-Path $repoRoot '.local-tests/provider-asset-tunnel/managed-state.json'
$proxyName = 'mc-provider-asset-proxy-script'
$tunnelName = 'mc-provider-asset-tunnel-script'
$workerName = 'multimodal-canvas-app-worker-1'
$networkName = 'multimodal-canvas-app_default'
$managedLabel = 'mc.provider-asset-tunnel.script'

<# 运行 Docker 命令并仅返回捕获结果；异常不回显可能含密钥的原始输出。 #>
function Invoke-Docker {
  param([string[]]$Arguments, [switch]$AllowFailure)

  $previousPreference = $ErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& docker @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "Docker $($Arguments[0]) 失败（退出码 $code）；未输出原始日志。"
  }
  return [pscustomobject]@{ ExitCode = $code; Output = ($output -join "`n") }
}

<# 只接受本机 Docker Desktop context，避免操作远端项目。 #>
function Assert-LocalDocker {
  if ($env:DOCKER_HOST) { throw '检测到 DOCKER_HOST 覆盖，拒绝操作。' }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw '未找到 Docker CLI。' }
  $context = (Invoke-Docker -Arguments @('context', 'show')).Output.Trim()
  $details = (Invoke-Docker -Arguments @('context', 'inspect', $context)).Output | ConvertFrom-Json
  if ($details.Endpoints.docker.Host -notmatch '^npipe:/{4}\./pipe/[^/\\]+$') {
    throw '仅允许本机 Docker Desktop named pipe context。'
  }
  $engine = (Invoke-Docker -Arguments @('info', '--format', '{{.OSType}}')).Output.Trim()
  if ($engine -ne 'linux') { throw '需要 Docker Linux 容器引擎。' }
}

<# 返回容器状态；同名非本脚本容器绝不启动或停止。 #>
function Get-ManagedContainer {
  param([string]$Name)

  $result = Invoke-Docker -Arguments @('inspect', '--format', '{{.State.Status}}|{{.State.StartedAt}}', $Name) -AllowFailure
  if ($result.ExitCode -ne 0) { return $null }
  $labels = (Invoke-Docker -Arguments @('inspect', '--format', '{{json .Config.Labels}}', $Name)).Output | ConvertFrom-Json
  $fields = $result.Output.Trim().Split('|')
  if ($fields.Count -ne 2 -or $labels.$managedLabel -ne 'true') {
    throw "容器 $Name 已存在但不属于本脚本，未操作。"
  }
  return [pscustomobject]@{ Status = $fields[0]; StartedAt = $fields[1] }
}

<# 从已运行 Worker 读取唯一非敏感来源配置。 #>
function Get-WorkerOrigin {
  $origin = (Invoke-Docker -Arguments @('exec', $workerName, 'node', '-p', 'process.env.CANVAS_WEB_URL')).Output.Trim()
  return Normalize-Origin $origin
}

<# 限定来源为无路径、凭据及查询参数的 HTTP(S) origin。 #>
function Normalize-Origin {
  param([string]$Value)

  $uri = $null
  if (-not [uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
      $uri.Scheme -notin @('http', 'https') -or
      $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) {
    throw 'CANVAS_WEB_URL 必须是无路径、查询参数和凭据的 HTTP(S) 来源。'
  }
  return $uri.GetLeftPart([UriPartial]::Authority)
}

<# 从正式 Compose 默认配置取恢复来源；不会打印其他配置。 #>
function Get-BaseOrigin {
  $configuration = (Invoke-Docker -Arguments @('compose', '-f', $composeFile, 'config', '--format', 'json')).Output | ConvertFrom-Json
  return Normalize-Origin ([string]$configuration.services.worker.environment.CANVAS_WEB_URL)
}

<# 只读取 Run 状态汇总；未知状态或活动任务阻止 Worker 重建。 #>
function Assert-NoActiveRuns {
  $rows = (Invoke-Docker -Arguments @('exec', 'multimodal-canvas-app-postgres-1', 'psql', '-U', 'canvas', '-d', 'canvas', '-tAc', 'select status,count(*) from runs group by status;')).Output
  foreach ($row in ($rows -split "`n")) {
    if (-not $row.Trim()) { continue }
    $parts = $row.Trim().Split('|')
    if ($parts.Count -ne 2 -or $parts[0] -notin @('DRAFT', 'SUCCEEDED', 'FAILED', 'CANCELLED')) {
      throw '存在活动或未知状态的 Run，拒绝重建 Worker。'
    }
  }
}

<# 读取当前启动周期日志中的公开隧道域名，不回显完整日志。 #>
function Get-TunnelOrigin {
  param([string]$StartedAt)

  $logs = (Invoke-Docker -Arguments @('logs', '--since', $StartedAt, $tunnelName)).Output
  $found = [regex]::Matches($logs, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($found.Count -eq 0) { return $null }
  return Normalize-Origin $found[$found.Count - 1].Value
}

<# 启动本脚本专用容器；已有同名容器只在标签匹配时复用。 #>
function Start-ManagedContainers {
  $proxy = Get-ManagedContainer $proxyName
  if (-not $proxy) {
    Invoke-Docker -Arguments @('run', '-d', '--pull', 'never', '--name', $proxyName, '--network', $networkName, '--label', "$managedLabel=true", '--mount', "type=bind,source=$caddyFile,target=/etc/caddy/Caddyfile,readonly", '--entrypoint', 'caddy', 'caddy:2.10.2-alpine', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile') | Out-Null
  } elseif ($proxy.Status -ne 'running') {
    Invoke-Docker -Arguments @('start', $proxyName) | Out-Null
  }

  $tunnel = Get-ManagedContainer $tunnelName
  if (-not $tunnel) {
    Invoke-Docker -Arguments @('run', '-d', '--pull', 'never', '--name', $tunnelName, '--network', $networkName, '--label', "$managedLabel=true", 'cloudflare/cloudflared:latest', 'tunnel', '--no-autoupdate', '--url', "http://${proxyName}:8081") | Out-Null
  } elseif ($tunnel.Status -ne 'running') {
    Invoke-Docker -Arguments @('start', $tunnelName) | Out-Null
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    $tunnel = Get-ManagedContainer $tunnelName
    if (-not $tunnel) {
      Start-Sleep -Seconds 2
      continue
    }
    if ($tunnel.Status -ne 'running') { throw 'Cloudflare 隧道容器未保持运行。' }
    $origin = Get-TunnelOrigin $tunnel.StartedAt
    if ($origin) { return $origin }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Cloudflare 隧道未在 45 秒内给出域名。'
}

<# 通过无签名 GET 确认公网仅到达签名路由；401 才可更新 Worker。 #>
function Assert-PublicRoute {
  param([string]$Origin)

  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw '未找到 curl.exe，无法验证公网路由。' }
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $status = (& curl.exe -sS --max-time 15 -o NUL -w '%{http_code}' "$Origin/v1/provider-assets/probe-untrusted/versions/1/content" 2>$null).Trim()
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($code -ne 0 -or $status -ne '401') { throw '公网素材路由未返回预期 401，未更新 Worker。' }
}

<# 使用一次性 Compose 覆盖配置仅重建 Worker，不启动依赖或改写正式配置。 #>
function Set-WorkerOrigin {
  param([string]$Origin)

  Assert-NoActiveRuns
  $temporaryFile = Join-Path ([IO.Path]::GetTempPath()) ("mc-provider-assets-$([guid]::NewGuid().ToString('N')).yaml")
  $override = @{ services = @{ worker = @{ environment = @{ CANVAS_WEB_URL = $Origin } } } } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($temporaryFile, $override, (New-Object System.Text.UTF8Encoding($false)))
  try {
    Invoke-Docker -Arguments @('compose', '-f', $composeFile, '-f', $temporaryFile, 'up', '-d', '--no-deps', '--no-build', 'worker') | Out-Null
  } finally {
    Remove-Item -LiteralPath $temporaryFile -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    $health = (Invoke-Docker -Arguments @('inspect', '--format', '{{.State.Health.Status}}', $workerName)).Output.Trim()
    if ($health -eq 'healthy') { break }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($health -ne 'healthy' -or (Get-WorkerOrigin) -ne $Origin) {
    throw 'Worker 未以目标来源恢复健康，需检查容器状态。'
  }
}

<# 保存非敏感来源，供 Stop 恢复；文件位于 Git 忽略的本机检查目录。 #>
function Save-State {
  param([string]$OriginalOrigin, [string]$ActiveOrigin)

  $directory = Split-Path $stateFile -Parent
  if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
  $state = @{ originalOrigin = $OriginalOrigin; activeOrigin = $ActiveOrigin } | ConvertTo-Json
  [IO.File]::WriteAllText($stateFile, $state, (New-Object System.Text.UTF8Encoding($false)))
}

<# 读取并验证本脚本自己的来源记录。 #>
function Get-SavedState {
  if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
  $saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  $original = Normalize-Origin ([string]$saved.originalOrigin)
  $active = if ($saved.activeOrigin) { Normalize-Origin ([string]$saved.activeOrigin) } else { $null }
  return [pscustomobject]@{ OriginalOrigin = $original; ActiveOrigin = $active }
}

Assert-LocalDocker
if ($Action -eq 'Status') {
  $proxy = Get-ManagedContainer $proxyName
  $tunnel = Get-ManagedContainer $tunnelName
  $workerOrigin = Get-WorkerOrigin
  $tunnelOrigin = if ($tunnel -and $tunnel.Status -eq 'running') { Get-TunnelOrigin $tunnel.StartedAt } else { $null }
  [pscustomobject]@{
    Proxy = if ($proxy) { $proxy.Status } else { 'absent' }
    Tunnel = if ($tunnel) { $tunnel.Status } else { 'absent' }
    TunnelOrigin = $tunnelOrigin
    WorkerOrigin = $workerOrigin
    WorkerUsesTunnel = ($tunnelOrigin -and $workerOrigin -eq $tunnelOrigin)
  } | Format-List
  return
}

if ($Action -eq 'Start') {
  Assert-NoActiveRuns
  $workerOrigin = Get-WorkerOrigin
  $saved = Get-SavedState
  if ($saved) {
    $originalOrigin = $saved.OriginalOrigin
  } elseif ($workerOrigin -match '^https://[a-z0-9-]+\.trycloudflare\.com$') {
    $originalOrigin = Get-BaseOrigin
    if ($originalOrigin -match '^https://[a-z0-9-]+\.trycloudflare\.com$') {
      throw '当前 Worker 和 Compose 默认来源均为临时域名，无法确定恢复地址。'
    }
  } else {
    $originalOrigin = $workerOrigin
  }
  $origin = Start-ManagedContainers
  Assert-PublicRoute $origin
  Save-State $originalOrigin $origin
  if ($workerOrigin -ne $origin) { Set-WorkerOrigin $origin }
  Write-Host "临时素材入口已就绪：$origin；Worker 已使用该来源。"
  return
}

$saved = Get-SavedState
if (-not $saved) { throw '没有本脚本的恢复记录，未停止或改动任何容器。' }
Assert-NoActiveRuns
$workerOrigin = Get-WorkerOrigin
if ($saved.ActiveOrigin -and $workerOrigin -eq $saved.ActiveOrigin) {
  Set-WorkerOrigin $saved.OriginalOrigin
} elseif ($workerOrigin -ne $saved.OriginalOrigin) {
  throw 'Worker 来源已被其他流程修改，未覆盖或停止隧道。'
}
foreach ($name in @($tunnelName, $proxyName)) {
  $container = Get-ManagedContainer $name
  if ($container -and $container.Status -eq 'running') {
    Invoke-Docker -Arguments @('stop', $name) | Out-Null
  }
}
Save-State $saved.OriginalOrigin $null
Write-Host "已恢复 Worker 来源：$($saved.OriginalOrigin)；本脚本隧道容器已停止。"
