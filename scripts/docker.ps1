#requires -Version 5.1
<#
.SYNOPSIS
管理本机 Windows Docker Desktop 的 Canvas/R2 生产配置，不包含 New API。
.PARAMETER Action
Build 只构建；Start 构建本轮镜像、启动并执行迁移；Stop 保留卷；Status 只读；Admin 同步已登录管理员。
.PARAMETER EnvFile
显式私有配置文件，默认为仓库 .env.compose；不自动读取开发 .env，不创建或改写任何环境文件。
.PARAMETER Neon
叠加 compose.neon.yaml，使用该文件中 DATABASE_URL 指向的外部数据库。
.PARAMETER Server
启用公网 HTTPS 网关；MC_DOMAIN 与 CANVAS_WEB_URL 必须对应同一域名。
.PARAMETER NewApiUserId
Admin 必填的 New API 不可变用户 ID，必须先登记 NEW_API_ADMIN_USER_IDS 并完成登录。
.PARAMETER NoBrowser
Start 成功后不打开浏览器。
#>
[CmdletBinding()]
param(
  [ValidateSet('Start', 'Build', 'Stop', 'Status', 'Admin')][string]$Action = 'Start',
  [string]$EnvFile = '.env.compose',
  [switch]$Neon,
  [switch]$Server,
  [string]$NewApiUserId,
  [switch]$NoBrowser
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
运行 Docker 参数数组并按退出码失败；捕获的配置只在内存解析，不回显到日志。
.PARAMETER Arguments
不含明文密钥的 Docker 参数数组。
.PARAMETER Capture
捕获只读查询输出。
.OUTPUTS
捕获时返回字符串；命令失败抛错。
#>
function Invoke-Docker {
  param([string[]]$Arguments, [switch]$Capture)
  $previous = $ErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    $ErrorActionPreference = 'Continue'
    if ($Capture) { $output = @(& $script:DockerExecutable @Arguments 2>&1) }
    else { & $script:DockerExecutable @Arguments 2>&1 | ForEach-Object { Write-Host $_ } }
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
  if ($code -ne 0) { throw "Docker 命令失败，退出码 $code；未自动重试变更，请检查 Docker 状态及必填配置。" }
  if ($Capture) { return ($output -join "`n") }
}

<#
.SYNOPSIS
验证本机 Linux Docker 引擎；Start/Build 可隐藏启动已安装的 Desktop，不切换全局 context。
.OUTPUTS
无返回值；仅允许 Windows 本机 named pipe，失败抛错。
#>
function Assert-LocalEngine {
  if ($env:DOCKER_HOST) { throw '拒绝 DOCKER_HOST 覆盖，请使用本机 Docker Desktop context。' }
  $context = (Invoke-Docker @('context', 'show') -Capture).Trim()
  $hostAddress = (Invoke-Docker @('context', 'inspect', $context, '--format', '{{.Endpoints.docker.Host}}') -Capture).Trim()
  if ($hostAddress -notmatch '^npipe:/{4}\./pipe/[^/\\]+$') { throw '拒绝远程 Docker context，仅允许本机 named pipe。' }
  $script:Context = $context
  $probe = Get-EngineState
  if ($probe.ExitCode -ne 0 -and $Action -in @('Start', 'Build')) {
    $desktopCandidates = @()
    if ($env:ProgramFiles) { $desktopCandidates += Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe' }
    if ($env:LOCALAPPDATA) { $desktopCandidates += Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe' }
    $desktop = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $desktop) { throw '未找到 Docker Desktop，请先安装并完成 Linux containers 初始化。' }
    if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
      Start-Process -FilePath $desktop -WindowStyle Hidden | Out-Null
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(180)
    do {
      Start-Sleep -Seconds 2
      $probe = Get-EngineState
    } while ($probe.ExitCode -ne 0 -and [DateTime]::UtcNow -lt $deadline)
  }
  if ($probe.ExitCode -ne 0 -or $probe.Output -cne 'linux') { throw '本机 Docker Linux 引擎未就绪，请先检查 Desktop。' }
}

<#
.SYNOPSIS
限时检查已确认的本机引擎，超时只终止本次查询进程，不停止应用或 Docker。
.OUTPUTS
ExitCode 和不含配置的引擎类型；单次最多等待十秒。
#>
function Get-EngineState {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $script:DockerExecutable
  $start.Arguments = 'info --format "{{.OSType}}"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['DOCKER_CONTEXT'] = $script:Context
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw '无法创建 Docker 查询进程。' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(10000)) {
      $process.Kill()
      [void]$process.WaitForExit(1000)
      return [pscustomobject]@{ ExitCode = 124; Output = '' }
    }
    [void]$stderr.GetAwaiter().GetResult()
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.GetAwaiter().GetResult().Trim() }
  } finally { $process.Dispose() }
}

$previousProfiles = [Environment]::GetEnvironmentVariable('COMPOSE_PROFILES', 'Process')
$previousFiles = [Environment]::GetEnvironmentVariable('COMPOSE_ENV_FILES', 'Process')
$previousDisable = [Environment]::GetEnvironmentVariable('COMPOSE_DISABLE_ENV_FILE', 'Process')
$locationChanged = $false
$exitCode = 0
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw '此入口仅支持 Windows；Linux/macOS 使用 scripts/docker.sh。' }
  $workspace = Split-Path $PSScriptRoot -Parent
  if (-not [IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $workspace $EnvFile }
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw '缺少配置，请复制 .env.compose.example 并填写 R2 与独立 New API。' }
  $docker = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue
  if (-not $docker) { throw '未找到 docker.exe，请安装 Docker Desktop 并检查 PATH。' }
  $script:DockerExecutable = $docker.Source
  if ($Action -eq 'Admin' -and $NewApiUserId -notmatch '^[1-9][0-9]*$') { throw 'Admin 必须明确提供 New API 不可变用户 ID。' }
  if ($Action -ne 'Admin' -and $PSBoundParameters.ContainsKey('NewApiUserId')) { throw 'NewApiUserId 仅用于 Admin。' }
  Assert-LocalEngine
  Push-Location $workspace
  $locationChanged = $true
  [Environment]::SetEnvironmentVariable('COMPOSE_PROFILES', $null, 'Process')
  [Environment]::SetEnvironmentVariable('COMPOSE_ENV_FILES', $null, 'Process')
  [Environment]::SetEnvironmentVariable('COMPOSE_DISABLE_ENV_FILE', '1', 'Process')
  $compose = @('--context', $script:Context, 'compose', '--env-file', $EnvFile, '-p', 'multimodal-canvas-app', '-f', 'compose.yaml')
  if ($Neon) { $compose += @('-f', 'compose.neon.yaml') }
  if ($Server -or $Action -in @('Stop', 'Status')) { $compose += @('--profile', 'server') }
  Invoke-Docker ($compose + @('config', '--quiet'))
  switch ($Action) {
    'Build' {
      Invoke-Docker ($compose + @('build'))
      Write-Host '镜像构建完成，未启动服务或执行迁移。'
    }
    'Start' {
      $configuration = (Invoke-Docker ($compose + @('config', '--format', 'json')) -Capture) | ConvertFrom-Json
      $webUrl = $configuration.services.api.environment.CANVAS_WEB_URL
      if ($Server -and (-not $configuration.services.gateway.environment.MC_DOMAIN -or $webUrl -cne "https://$($configuration.services.gateway.environment.MC_DOMAIN)")) {
        throw 'Server 要求 MC_DOMAIN 与 HTTPS CANVAS_WEB_URL 一致。'
      }
      Invoke-Docker ($compose + @('up', '-d', '--build', '--wait', '--wait-timeout', '180'))
      Invoke-Docker ($compose + @('ps', '--all'))
      Write-Host "服务健康检查通过，访问：$webUrl"
      if (-not $NoBrowser) {
        try { Start-Process -FilePath $webUrl | Out-Null }
        catch { Write-Warning "服务已就绪，但无法打开默认浏览器；请手动访问 $webUrl。" }
      }
    }
    'Stop' {
      Invoke-Docker ($compose + @('stop'))
      Write-Host '服务已停止，数据和密钥卷保留。'
    }
    'Status' { Invoke-Docker ($compose + @('ps', '--all')) }
    'Admin' { Invoke-Docker ($compose + @('exec', '-T', 'api', 'node', 'docker/run.mjs', 'admin', $NewApiUserId)) }
  }
} catch {
  $exitCode = 1
  Write-Host "操作未完成：$($_.Exception.Message)" -ForegroundColor Red
} finally {
  if ($locationChanged) { Pop-Location }
  [Environment]::SetEnvironmentVariable('COMPOSE_PROFILES', $previousProfiles, 'Process')
  [Environment]::SetEnvironmentVariable('COMPOSE_ENV_FILES', $previousFiles, 'Process')
  [Environment]::SetEnvironmentVariable('COMPOSE_DISABLE_ENV_FILE', $previousDisable, 'Process')
}
exit $exitCode
