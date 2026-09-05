#requires -Version 5.1
<#
.SYNOPSIS
在 Windows Docker Desktop 中管理完整生产应用及指定已注册管理员。
.DESCRIPTION
仅操作本机 named pipe context 中的 multimodal-canvas-app 项目，不切换全局 context。
忽略仓库 .env，使用独立 named volumes；不删除卷或已有开发数据。
Start、Build 和 Https 最多等待 Docker 引擎 180 秒，随后由 Compose 等待服务健康 180 秒。
首次下载和构建镜像所需时间不计入健康等待时间；失败时只查询状态，不自动重试变更。
.PARAMETER Action
Start 启动并按需构建缺失镜像；Stop 保留数据地停止；Status 只查询；Build 重新构建并启动。
Https 额外启用 local-https profile，同时保留 HTTP；Stop/Status 包含 server 和 local-https。
Admin 仅提升 Email 指定的已注册账户，不自动创建账户或重置密码。
.PARAMETER Email
仅供 Admin 使用的已注册账户邮箱；必须明确提供，成功后需退出网页并重新登录。
.PARAMETER NoBrowser
Start、Build 或 Https 成功后不打开默认浏览器，适合终端或自动化。对其他操作无影响。
.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\docker.ps1 -Action Start
.EXAMPLE
$env:MC_HTTP_PORT = '8088'
.\scripts\docker.ps1 -Action Build -NoBrowser
.EXAMPLE
.\scripts\docker.ps1 -Action Https -NoBrowser
.EXAMPLE
.\scripts\docker.ps1 -Action Admin -Email 'user@example.com'
.NOTES
兼容 Windows PowerShell 5.1 和 PowerShell 7。文件使用 UTF-8 BOM，保证 5.1 正确读取中文。
MC_HTTP_PORT 取当前进程环境变量，默认为 8080，允许 1 至 65535；不写入用户环境配置。
MC_HTTPS_PORT 默认为 8443，同样允许 1 至 65535；Https 的两个端口必须不同且仅绑定回环地址。
MC_VIDEO_CONTRACT 可设为 newapi-unified-v1 或 legacy-v1，默认由 Compose 采用 newapi-unified-v1。
失败返回退出码 1，成功返回 0。日志只显示到终端，不把凭据或诊断写入仓库文件。
#>
[CmdletBinding()]
param(
  [ValidateSet('Start', 'Stop', 'Status', 'Build', 'Https', 'Admin')]
  [string]$Action = 'Start',
  [string]$Email,
  [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
运行 Docker 原生命令并检查退出码；需要诊断失败状态时可显式允许非零退出。
.PARAMETER Arguments
Docker 参数数组，不通过额外 shell 拼接；调用方不得传入明文凭据。
.PARAMETER CaptureOutput
捕获只读查询的输出，否则将进度直接显示在终端。
.PARAMETER AllowFailure
返回失败结果而不抛错；调用方必须检查 ExitCode。
.OUTPUTS
包含 ExitCode 和 Output 的对象；未捕获输出时 Output 为空字符串。
#>
function Invoke-Docker {
  param([string[]]$Arguments, [switch]$CaptureOutput, [switch]$AllowFailure)

  $previousPreference = $ErrorActionPreference
  # Windows PowerShell 5.1 会把原生 stderr 转为错误记录，最终仍以原生退出码判定结果。
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    $ErrorActionPreference = 'Continue'
    $output = @()
    if ($CaptureOutput) {
      $output = @(& $script:DockerExecutable @Arguments 2>&1)
    } else {
      & $script:DockerExecutable @Arguments 2>&1 | ForEach-Object { Write-Host $_ }
    }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $result = [pscustomobject]@{ ExitCode = $code; Output = ($output -join "`n") }
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "Docker 命令失败，退出码 ${code}：docker $($Arguments -join ' ')`n$($result.Output)"
  }
  return $result
}

<#
.SYNOPSIS
查找已安装的 Docker CLI 或 Docker Desktop，不安装软件或修改 PATH。
.PARAMETER Desktop
指定时查找 Docker Desktop.exe，否则先查找 PATH 中的 docker.exe。
.OUTPUTS
可执行文件的绝对路径；未找到时抛错并提示安装 Docker Desktop。
#>
function Find-DockerExecutable {
  param([switch]$Desktop)

  if (-not $Desktop) {
    $command = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  # 同时兼容 Docker Desktop 的全机安装和当前用户安装目录。
  $installations = @()
  if ($env:ProgramFiles) { $installations += Join-Path $env:ProgramFiles 'Docker\Docker' }
  if ($env:LOCALAPPDATA) { $installations += Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop' }
  if ($Desktop -and $script:DockerExecutable) {
    $installations += Split-Path (Split-Path (Split-Path $script:DockerExecutable -Parent) -Parent) -Parent
  }
  foreach ($installation in $installations) {
    $relativePath = if ($Desktop) { 'Docker Desktop.exe' } else { 'resources\bin\docker.exe' }
    $candidate = Join-Path $installation $relativePath
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  throw '未找到已安装的 Docker Desktop。请先安装并完成首次启动引导，再运行 Docker-Start.cmd。'
}

<#
.SYNOPSIS
读取并确认当前 Docker context 仅连接本机 named pipe，不修改 context 配置。
.OUTPUTS
经过验证的 context 名称；DOCKER_HOST 覆盖、远程连接或无效元数据均抛错。
#>
function Get-LocalDockerContext {
  if (-not [string]::IsNullOrWhiteSpace($env:DOCKER_HOST)) {
    throw '检测到 DOCKER_HOST 覆盖，拒绝操作。请在当前终端移除该变量，并确认使用本机 Docker Desktop context。'
  }
  $current = Invoke-Docker -Arguments @('context', 'show') -CaptureOutput
  $name = $current.Output.Trim()
  if (-not $name) { throw 'Docker 未返回当前 context，未执行任何容器操作。' }
  $inspection = Invoke-Docker -Arguments @('context', 'inspect', $name) -CaptureOutput
  $contexts = @($inspection.Output | ConvertFrom-Json)
  if ($contexts.Count -ne 1 -or $contexts[0].Name -cne $name) {
    throw 'Docker context 元数据与当前名称不一致，未执行任何容器操作。'
  }
  if ($contexts[0].Endpoints.docker.Host -notmatch '^npipe:/{4}\./pipe/[^/\\]+$') {
    throw '拒绝非本机 Docker context。仅允许 Windows Docker Desktop 的本机 named pipe，不接受 TCP、SSH 或远程引擎。'
  }
  return $name
}

<#
.SYNOPSIS
限时探测已确认的本机 Docker 引擎，避免引擎无响应导致无限等待。
.PARAMETER TimeoutSeconds
单次探测上限，单位秒，范围 1 至 10；超时只终止本脚本创建的查询子进程。
.OUTPUTS
包含 ExitCode 和 Output 的对象；成功的 Output 为引擎 OSType，超时退出码为 124。
#>
function Invoke-EngineProbe {
  param([ValidateRange(1, 10)][int]$TimeoutSeconds = 10)

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $script:DockerExecutable
  $startInfo.Arguments = 'info --format "{{.OSType}}"'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables['DOCKER_CONTEXT'] = $script:DockerContext
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw '无法创建 Docker 引擎探测子进程。' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      $process.Kill()
      if (-not $process.WaitForExit(1000)) { throw '本次 Docker 查询子进程超时且未退出，停止后续操作。' }
      return [pscustomobject]@{ ExitCode = 124; Output = 'Docker 引擎查询超时。' }
    }
    $code = $process.ExitCode
    $output = $stdout.GetAwaiter().GetResult().Trim()
    $errorOutput = $stderr.GetAwaiter().GetResult().Trim()
    if ($code -ne 0) { $output = "$output`n$errorOutput".Trim() }
    return [pscustomobject]@{ ExitCode = $code; Output = $output }
  } finally {
    $process.Dispose()
  }
}

<#
.SYNOPSIS
确认 Linux 引擎可用；仅 Start、Build 和 Https 可以启动已安装的 Docker Desktop。
.PARAMETER AllowDesktopStart
引擎未就绪时隐藏启动 Desktop，最多等待 180 秒；不自动切换容器模式。
.NOTES
已运行的 Desktop 不会再次启动；非 Linux 引擎、启动失败或等待超时均抛错。
#>
function Wait-DockerEngine {
  param([switch]$AllowDesktopStart)

  $deadline = [DateTime]::UtcNow.AddSeconds(180)
  $probe = Invoke-EngineProbe
  if ($probe.ExitCode -ne 0 -and $AllowDesktopStart) {
    $desktop = Find-DockerExecutable -Desktop
    $launcher = $null
    if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
      Write-Host '正在启动 Docker Desktop...'
      $launcher = Start-Process -FilePath $desktop -WindowStyle Hidden -PassThru
    }
    Write-Host '正在等待本机 Docker 引擎，最多 180 秒...'
    while ($probe.ExitCode -ne 0 -and [DateTime]::UtcNow -lt $deadline) {
      if ($launcher -and $launcher.HasExited -and $launcher.ExitCode -ne 0) {
        throw "Docker Desktop 启动进程失败，退出码 $($launcher.ExitCode)。"
      }
      $remaining = [int][Math]::Floor(($deadline - [DateTime]::UtcNow).TotalSeconds)
      if ($remaining -le 0) { break }
      $probe = Invoke-EngineProbe -TimeoutSeconds ([Math]::Min(10, $remaining))
      $remaining = [int][Math]::Floor(($deadline - [DateTime]::UtcNow).TotalSeconds)
      if ($probe.ExitCode -ne 0 -and $remaining -gt 0) {
        Start-Sleep -Seconds ([Math]::Min(2, $remaining))
      }
    }
  }
  if ($probe.ExitCode -ne 0) {
    throw "本机 Docker 引擎未就绪，退出码 $($probe.ExitCode)。未重启任何应用服务。请检查 Desktop 的 WSL 2/虚拟化与启动状态，再运行 Status。`n$($probe.Output)"
  }
  if ($probe.Output -cne 'linux') {
    throw '当前 Docker 引擎不是 Linux containers。请在 Docker Desktop 切换到 Linux containers 后重试；脚本不会修改该全局设置。'
  }
}

<#
.SYNOPSIS
读取本次 HTTP 或 HTTPS 入口端口，不读取任何 .env 文件。
.PARAMETER Name
当前进程的端口变量名；HTTP 默认为 8080，HTTPS 默认为 8443。
.OUTPUTS
1 至 65535 的整数，未设置变量时采用对应默认端口；非法值抛错。
#>
function Get-LocalPort {
  param([ValidateSet('MC_HTTP_PORT', 'MC_HTTPS_PORT')][string]$Name = 'MC_HTTP_PORT')

  $defaultPort = if ($Name -eq 'MC_HTTPS_PORT') { 8443 } else { 8080 }
  $rawPort = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrEmpty($rawPort)) { return $defaultPort }
  $port = 0
  if ($rawPort -notmatch '^[1-9][0-9]{0,4}$' -or -not [int]::TryParse($rawPort, [ref]$port) -or $port -gt 65535) {
    throw "$Name 必须是 1 至 65535 的整数；默认端口为 $defaultPort。"
  }
  return $port
}

<#
.SYNOPSIS
确认端口空闲，或仅由本项目指定服务以 127.0.0.1 绑定；不终止占用进程。
.PARAMETER Service
端口所属服务；HTTP 为 web，本地 HTTPS 为 gateway-local，不接受另一服务占用的端口。
.PARAMETER Port
拟发布的本机 TCP 端口，单位为端口号，范围 1 至 65535。
.NOTES
Docker 返回的端口元数据与临时独占监听共同用于检查；冲突或查询失败均抛错。
#>
function Assert-ServicePort {
  param(
    [ValidateSet('web', 'gateway-local')][string]$Service,
    [ValidateRange(1, 65535)][int]$Port
  )

  $serviceResult = Invoke-Docker -Arguments ($script:ComposeArguments + @('ps', '--quiet', '--status', 'running', $Service)) -CaptureOutput
  $containerIds = @($serviceResult.Output -split '\r?\n' | Where-Object { $_.Trim() })
  if ($containerIds.Count -gt 1) { throw "发现多个运行中的 $Service 容器，无法确认端口所有权，请先运行 Status 检查。" }
  if ($containerIds.Count -eq 1) {
    $inspection = Invoke-Docker -Arguments @('--context', $script:DockerContext, 'inspect', '--format', '{{json .NetworkSettings.Ports}}', $containerIds[0]) -CaptureOutput
    $ports = $inspection.Output | ConvertFrom-Json
    if ($ports) {
      $ownedLoopbackPort = $false
      foreach ($property in $ports.PSObject.Properties) {
        foreach ($binding in @($property.Value)) {
          if ($binding -and $binding.HostPort -eq [string]$Port) {
            if ($binding.HostIp -cne '127.0.0.1') {
              throw "本项目已有 $Service 端口 ${Port} 未限定为 127.0.0.1，拒绝自动覆盖。"
            }
            $ownedLoopbackPort = $true
          }
        }
      }
      if ($ownedLoopbackPort) { return }
    }
  }
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
  try {
    $listener.ExclusiveAddressUse = $true
    $listener.Start()
  } catch {
    $portVariable = if ($Service -eq 'gateway-local') { 'MC_HTTPS_PORT' } else { 'MC_HTTP_PORT' }
    throw "本机 127.0.0.1:${Port} 已被其他程序/服务占用或受系统保留。未停止任何进程；请自行处理占用，或改用 $portVariable 后重试。$($_.Exception.Message)"
  } finally {
    $listener.Stop()
  }
}

# 以下状态只在本次脚本进程有效；空环境文件不包含配置或凭据，并在退出时删除。
$script:DockerExecutable = $null
$script:DockerContext = $null
$script:ComposeArguments = @()
$emptyEnvironmentFile = $null
$composeReady = $false
$exitCode = 0
# 仅由 Action 选择 profile，避免继承的 COMPOSE_PROFILES 意外打开公网入口；退出时恢复。
$previousComposeProfiles = [Environment]::GetEnvironmentVariable('COMPOSE_PROFILES', 'Process')

try {
  if ($Action -eq 'Admin') {
    if ([string]::IsNullOrWhiteSpace($Email) -or $Email -notmatch '^[^\s@]+@[^\s@]+$') {
      throw 'Admin 必须通过 -Email 明确指定已注册账户的邮箱；不会创建新账户或重置密码。'
    }
  } elseif ($PSBoundParameters.ContainsKey('Email')) {
    throw '-Email 仅可与 -Action Admin 一起使用，未执行任何容器操作。'
  }
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw '此入口仅支持 Windows Docker Desktop，请在 Windows PowerShell 5.1 或 PowerShell 7 中运行。'
  }
  $workspace = Split-Path $PSScriptRoot -Parent
  $composeFile = Join-Path $workspace 'compose.yaml'
  if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) {
    throw '仓库根目录缺少 compose.yaml，请取得完整项目文件后重试。'
  }
  $port = Get-LocalPort
  $httpsPort = $null
  if ($Action -eq 'Https') {
    $httpsPort = Get-LocalPort -Name 'MC_HTTPS_PORT'
    if ($httpsPort -eq $port) { throw 'MC_HTTP_PORT 和 MC_HTTPS_PORT 不能相同；未执行任何容器操作。' }
  }
  $videoContract = [Environment]::GetEnvironmentVariable('MC_VIDEO_CONTRACT', 'Process')
  if (-not [string]::IsNullOrEmpty($videoContract) -and $videoContract -cnotin @('newapi-unified-v1', 'legacy-v1')) {
    throw 'MC_VIDEO_CONTRACT 仅允许 newapi-unified-v1 或 legacy-v1；脚本不会自动切换供应商协议。'
  }
  $webUrl = "http://localhost:$port/"
  if ($Action -eq 'Https') { $webUrl = "https://localhost:$httpsPort/" }
  $script:DockerExecutable = Find-DockerExecutable
  $script:DockerContext = Get-LocalDockerContext
  Write-Host "Docker context：$script:DockerContext（本机）"
  $version = Invoke-Docker -Arguments @('--context', $script:DockerContext, 'compose', 'version', '--short') -CaptureOutput
  Write-Host "Docker Compose：$($version.Output.Trim())"
  Wait-DockerEngine -AllowDesktopStart:($Action -in @('Start', 'Build', 'Https'))

  [Environment]::SetEnvironmentVariable('COMPOSE_PROFILES', $null, 'Process')
  $emptyEnvironmentFile = [IO.Path]::GetTempFileName()
  $script:ComposeArguments = @('--context', $script:DockerContext, 'compose', '--env-file', $emptyEnvironmentFile, '-f', $composeFile, '-p', 'multimodal-canvas-app')
  if ($Action -in @('Stop', 'Status')) {
    $script:ComposeArguments += @('--profile', 'server', '--profile', 'local-https')
  } elseif ($Action -eq 'Https') {
    $script:ComposeArguments += @('--profile', 'local-https')
  }
  $composeReady = $true
  Invoke-Docker -Arguments ($script:ComposeArguments + @('ps', '--all')) | Out-Null

  switch ($Action) {
    'Status' { Write-Host '已查询当前容器状态，未启动或停止服务。' }
    'Admin' {
      Invoke-Docker -Arguments ($script:ComposeArguments + @('exec', '-T', 'api', 'node', 'docker/run.mjs', 'admin', $Email)) | Out-Null
      Write-Host '指定账户的管理员操作已完成。请退出网页账户后重新登录，原密码不变。'
    }
    'Stop' {
      Invoke-Docker -Arguments ($script:ComposeArguments + @('stop')) | Out-Null
      Invoke-Docker -Arguments ($script:ComposeArguments + @('ps', '--all')) | Out-Null
      Write-Host '应用及已启用的网关已停止，全部数据卷保留。HTTP 使用 Docker-Start.cmd；恢复本地 HTTPS 请运行 -Action Https。'
    }
    default {
      Assert-ServicePort -Service 'web' -Port $port
      if ($Action -eq 'Https') { Assert-ServicePort -Service 'gateway-local' -Port $httpsPort }
      $upArguments = @('up', '-d', '--wait', '--wait-timeout', '180')
      if ($Action -eq 'Build') { $upArguments += '--build' }
      Write-Host '正在启动完整生产应用；首次拉取镜像和构建需要联网，请等待命令结束。'
      Invoke-Docker -Arguments ($script:ComposeArguments + $upArguments) | Out-Null
      Invoke-Docker -Arguments ($script:ComposeArguments + @('ps', '--all')) | Out-Null
      Write-Host "Compose 健康检查通过。访问地址：$webUrl"
      if ($Action -eq 'Https') {
        Write-Host "HTTP 入口仍保留：http://localhost:$port/"
        Write-Warning '本地 HTTPS 使用 Caddy 内部 CA；首次访问需手动信任该根证书。脚本不会自动安装证书或关闭 TLS 校验，步骤见 docs/docker-desktop.md。'
      }
      Write-Host '首次管理员引导与供应商配置请参阅 docs/docker-desktop.md。'
      if (-not $NoBrowser) {
        try { Start-Process -FilePath $webUrl | Out-Null } catch {
          Write-Warning "服务已启动，但无法打开默认浏览器。请手动访问 $webUrl。$($_.Exception.Message)"
        }
      }
    }
  }
} catch {
  $exitCode = 1
  Write-Host "操作未完成：$($_.Exception.Message)" -ForegroundColor Red
  if ($composeReady) {
    Write-Host '正在只读核对当前容器状态；不会自动重试启动、构建或停止...'
    try {
      $status = Invoke-Docker -Arguments ($script:ComposeArguments + @('ps', '--all')) -CaptureOutput -AllowFailure
      if ($status.ExitCode -eq 0) {
        Write-Host $status.Output
      } else {
        Write-Warning "状态查询也失败，退出码 $($status.ExitCode)。$($status.Output)"
      }
    } catch {
      Write-Warning "无法确认当前状态：$($_.Exception.Message)"
    }
  }
  Write-Host '请保留当前错误信息，先检查 Docker Desktop 和文档，再使用 -Action Status 核对。'
} finally {
  [Environment]::SetEnvironmentVariable('COMPOSE_PROFILES', $previousComposeProfiles, 'Process')
  if ($emptyEnvironmentFile) {
    try { Remove-Item -LiteralPath $emptyEnvironmentFile -Force } catch {
      $exitCode = 1
      Write-Warning "无法删除本次空环境临时文件 ${emptyEnvironmentFile}：$($_.Exception.Message)"
    }
  }
}
exit $exitCode
