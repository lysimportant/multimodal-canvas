#requires -Version 7.0
<#
.SYNOPSIS
在专用本机 MinIO 项目验收 bucket/prefix 最小权限，不连接外部 S3。
.DESCRIPTION
创建唯一测试桶、对象、用户和策略，验证授权与拒绝，再逐项清理并验证不存在。
任何检查或清理失败都会抛出错误；报告写入仓库 .data，不包含凭据。
不读取 .env，不启动或停止 Compose 服务，不修改现有桶或匿名策略。
.PARAMETER Project
仅允许已启动的 mc-acceptance-test-p0p1 专用 Compose 项目。
.PARAMETER Endpoint
仅允许 http://127.0.0.1:19900/；Docker 标签、挂载、端口和回环绑定仍须匹配。
.EXAMPLE
pwsh -NoProfile -File scripts/verify-s3-permissions.ps1
#>
[CmdletBinding()]
param(
  [ValidateSet('mc-acceptance-test-p0p1')]
  [string]$Project = 'mc-acceptance-test-p0p1',
  [ValidateScript({ $_.AbsoluteUri -ceq 'http://127.0.0.1:19900/' })]
  [uri]$Endpoint = 'http://127.0.0.1:19900/'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

<#
.SYNOPSIS
执行 Docker 并捕获退出码与输出，不自行判定操作成功。
.PARAMETER Arguments
传给 Docker 的参数数组，不经过额外 shell 拼接。
.OUTPUTS
包含 ExitCode 和 Output 的哈希表；输出可能含合成凭据，不得直接落盘。
#>
function Invoke-DockerResult {
  param([string[]]$Arguments)
  $output = & docker @Arguments 2>&1
  return @{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
}

<#
.SYNOPSIS
检查命令成功；非零退出时抛出包含操作名称、退出码及脱敏诊断的错误。
.PARAMETER Result
Invoke-DockerResult 或 Invoke-McResult 返回的命令结果。
.PARAMETER Label
不含凭据的业务操作名称。
#>
function Assert-Success {
  param([hashtable]$Result, [string]$Label)
  if ($Result.ExitCode -ne 0) {
    $diagnostic = $Result.Output
    foreach ($secret in $redactions) { $diagnostic = $diagnostic.Replace($secret, '[REDACTED]') }
    throw "$Label 失败，退出码 $($Result.ExitCode)：$diagnostic"
  }
}

<#
.SYNOPSIS
只在本轮临时客户端运行 mc，不直接打印输出。
.PARAMETER Arguments
mc 子命令及参数；管理操作仅限本轮资源。
.OUTPUTS
包含 ExitCode 和 Output 的哈希表，调用方必须检查结果。
#>
function Invoke-McResult {
  param([string[]]$Arguments)
  return Invoke-DockerResult (@('exec', $clientName, 'mc', '--json', '--no-color') + $Arguments)
}

<#
.SYNOPSIS
校验 mc 结构化错误码；网络错误、解析失败和意外成功均抛错。
.PARAMETER Result
待验证的 mc 命令结果。
.PARAMETER Codes
允许的精确服务错误码集合，不接受错误文案匹配。
.PARAMETER Label
失败诊断中的检查名称。
.OUTPUTS
已匹配的服务错误码字符串。
#>
function Assert-S3Error {
  param([hashtable]$Result, [string[]]$Codes, [string]$Label)
  if ($Result.ExitCode -eq 0) { throw "$Label 意外成功" }
  $records = @($Result.Output -split "`n" | Where-Object { $_.Trim() } | ForEach-Object {
    ConvertFrom-Json -InputObject $_ -AsHashtable -ErrorAction Stop
  })
  if ($records.Count -ne 1 -or $records[0]['status'] -ne 'error') {
    throw "$Label 未返回唯一结构化错误"
  }
  $code = $records[0]['error']['cause']['error']['Code']
  if ($code -notin $Codes) { throw "$Label 错误码不符：$code；预期 $($Codes -join ',')" }
  return $code
}

<#
.SYNOPSIS
向本轮报告追加已通过检查，并输出无凭据进度。
.PARAMETER Label
稳定的检查名称或本轮精确资源名。
.PARAMETER Evidence
成功状态或已验证的服务错误码，不得包含响应体及认证信息。
#>
function Add-Check {
  param([string]$Label, [string]$Evidence = 'success')
  $checks.Add(@{ name = $Label; evidence = $Evidence; passed = $true })
  Write-Host "PASS $Label ($Evidence)"
}

<#
.SYNOPSIS
使用仓库现有 AWS SDK 执行验收阶段；合成凭据仅经标准输入传递。
.PARAMETER Phase
Preflight 检查依赖，Test 检查权限，Inspect 检查副作用，Cleanup 精确清理本轮桶和对象。
.NOTES
追加 fixture 检查和版本；子进程失败或结果无法解析时抛错。
#>
function Invoke-S3Fixture {
  param([ValidateSet('Preflight', 'Test', 'Inspect', 'Cleanup')][string]$Phase)
  $configuration = @{
    phase = $Phase; project = $Project; endpoint = $Endpoint.AbsoluteUri; runId = $runId
    userSecret = $userSecret; createdBuckets = $createdBuckets.ToArray()
  }
  $output = ($configuration | ConvertTo-Json) | & node (Join-Path $PSScriptRoot 'fixtures/verify-s3-permissions.mjs')
  $exitCode = $LASTEXITCODE
  $result = ($output -join "`n") | ConvertFrom-Json -AsHashtable
  foreach ($check in $result.checks) { Add-Check $check.name $check.evidence }
  $versions.node = $result.versions.node
  $versions.awsSdk = $result.versions.awsSdk
  if ($exitCode -ne 0 -or $result.failure) { throw "S3 fixture $Phase 失败：$($result.failure)" }
}

<#
.SYNOPSIS
通过无代理、无重定向的本机 HTTP 请求验证匿名访问拒绝。
.PARAMETER Method
仅允许 Get 或 Put；请求最多等待十秒。
.PARAMETER ObjectPath
本轮测试桶中的对象路径，Put 写入合成载荷。
.NOTES
必须同时返回 HTTP 403 和 XML AccessDenied，否则抛错。
#>
function Test-AnonymousRequest {
  param([ValidateSet('Get', 'Put')][string]$Method, [string]$ObjectPath)
  $parameters = @{
    Uri = [uri]::new($Endpoint, $ObjectPath)
    Method = $Method
    NoProxy = $true
    SkipHttpErrorCheck = $true
    MaximumRedirection = 0
    TimeoutSec = 10
  }
  if ($Method -eq 'Put') { $parameters.Body = $payload }
  $response = Invoke-WebRequest @parameters
  $document = [xml]$response.Content
  if ([int]$response.StatusCode -ne 403 -or $document.Error.Code -cne 'AccessDenied') {
    throw "匿名 $Method 未返回 403 AccessDenied"
  }
  Add-Check "anonymous-$($Method.ToLowerInvariant())" 'HTTP 403 / AccessDenied'
}

<#
.SYNOPSIS
收集单步清理错误以继续其他清理，最终仍使整轮失败。
.PARAMETER Label
精确清理操作名称，保存在清理错误报告中。
.PARAMETER Action
仅针对本轮资源的清理及核验逻辑，不得执行批量全局清理。
#>
function Invoke-CleanupStep {
  param([string]$Label, [scriptblock]$Action)
  try { & $Action } catch { $cleanupErrors.Add("${Label}: $($_.Exception.Message)") }
}

<#
.SYNOPSIS
写入无凭据的恢复检查点或最终报告；写入失败显式抛错。
.PARAMETER Status
Running 不代表通过；Passed 仅用于全部检查及清理成功，其他结束状态为 Failed。
.NOTES
只写本轮 GUID 对应的 .data JSON 文件，不覆盖其他运行记录。
#>
function Write-AcceptanceReport {
  param([ValidateSet('Running', 'Passed', 'Failed')][string]$Status)
  $report = @{
    schemaVersion = 1
    runId = $runId
    startedAt = $startedAt
    completedAt = $(if ($Status -eq 'Running') { $null } else { [DateTimeOffset]::UtcNow.ToString('O') })
    status = $Status
    project = $Project
    endpoint = $Endpoint.AbsoluteUri
    scope = 'local-isolated-minio-only-not-production'
    versions = $versions
    resources = @{ buckets = @($bucket, $otherBucket); user = $userName; policy = $policyName; client = $clientName }
    checks = $checks.ToArray()
    failure = $failure
    cleanupErrors = $cleanupErrors.ToArray()
    passed = ($Status -eq 'Passed')
  }
  [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 12))
}

<# 本次运行状态只用于唯一命名、精确清理及无凭据报告；不复用其他运行的资源。 #>
$workspace = Split-Path $PSScriptRoot -Parent
$runId = [guid]::NewGuid().ToString('N')
$startedAt = [DateTimeOffset]::UtcNow.ToString('O')
$clientName = "mc-s3-permissions-$runId"
$bucket = "mc-s3-acl-$runId"
$otherBucket = "mc-s3-other-$runId"
$userName = "s3-user-$runId"
$policyName = "s3-policy-$runId"
$allowedPrefix = 'allowed'
$rootUser = 'synthetic-test-user'
$rootSecret = 'synthetic-test-password'
$userSecret = "synthetic-$([guid]::NewGuid().ToString('N'))"
$redactions = @($rootSecret, $userSecret)
$mcImage = 'minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727'
$minioImage = 'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e'
$payload = "synthetic-s3-permissions-$runId"
$checks = [System.Collections.Generic.List[object]]::new()
$cleanupErrors = [System.Collections.Generic.List[string]]::new()
$createdBuckets = [System.Collections.Generic.List[string]]::new()
$clientCreated = $false
$userCreated = $false
$policyCreated = $false
$policyAttached = $false
$failure = $null
$temporaryDirectory = $null
$temporaryDirectoryCreated = $false
$reportPath = $null
$versions = @{ powershell = $PSVersionTable.PSVersion.ToString(); minioImage = $minioImage; mcImage = $mcImage }

try {
  if ($env:DOCKER_HOST) { throw '拒绝 DOCKER_HOST 覆盖；请使用本机 Docker context' }
  $contextResult = Invoke-DockerResult @('context', 'inspect')
  Assert-Success $contextResult '读取 Docker context'
  $context = @($contextResult.Output | ConvertFrom-Json -AsHashtable)[0]
  $dockerHost = $context.Endpoints.docker.Host
  if ($dockerHost -notmatch '^npipe:/{4}\./pipe/[^/]+$|^unix:///[^/].*$') {
    throw '拒绝外部 Docker context；仅接受本机 named pipe 或 Unix socket'
  }
  $dockerVersion = Invoke-DockerResult @('version', '--format', '{{json .}}')
  Assert-Success $dockerVersion '读取 Docker 版本'
  $versionRecord = $dockerVersion.Output | ConvertFrom-Json -AsHashtable
  $versions.dockerClient = $versionRecord.Client.Version
  $versions.dockerServer = $versionRecord.Server.Version

  $containers = Invoke-DockerResult @('ps', '-q', '--filter', "label=com.docker.compose.project=$Project", '--filter', 'label=com.docker.compose.service=minio')
  Assert-Success $containers '定位专用 MinIO'
  if ($containers.Output -notmatch '^[a-f0-9]{12,64}$') { throw '专用项目必须恰有一个运行中的 MinIO' }
  $inspection = Invoke-DockerResult @('inspect', $containers.Output)
  Assert-Success $inspection '检查专用 MinIO'
  $server = @($inspection.Output | ConvertFrom-Json -AsHashtable)[0]
  $labels = $server.Config.Labels
  $workingDirectory = $labels['com.docker.compose.project.working_dir']
  $volumes = @($server.Mounts | Where-Object { $_.Destination -eq '/data' })
  $ports = @($server.NetworkSettings.Ports['9000/tcp'])
  if ($labels['com.docker.compose.project'] -cne $Project -or
      $labels['com.docker.compose.service'] -cne 'minio' -or
      -not $workingDirectory -or [IO.Path]::GetFullPath($workingDirectory) -ne [IO.Path]::GetFullPath($workspace) -or
      $server.Config.Image -cne $minioImage -or $server.State.Health.Status -ne 'healthy' -or
      $volumes.Count -ne 1 -or $volumes[0].Type -ne 'volume' -or $volumes[0].Name -cne "${Project}_multimodal_canvas_minio" -or
      $ports.Count -eq 0 -or @($ports | Where-Object { $_.HostPort -ne '19900' -or $_.HostIp -ne '127.0.0.1' }).Count -gt 0 -or
      "MINIO_ROOT_USER=$rootUser" -cnotin $server.Config.Env -or "MINIO_ROOT_PASSWORD=$rootSecret" -cnotin $server.Config.Env) {
    throw 'MinIO 项目、工作目录、镜像、健康状态、测试卷、端口或合成凭据不符合专用环境'
  }
  $versions.minio = $labels['version']
  Add-Check 'dedicated-local-project-guard'
  Invoke-S3Fixture 'Preflight'

  $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) $clientName
  if (Test-Path -LiteralPath $temporaryDirectory) { throw '临时目录已存在，拒绝复用' }
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
  $temporaryDirectoryCreated = $true
  $policy = @{
    Version = '2012-10-17'
    Statement = @(
      @{ Effect = 'Allow'; Action = @('s3:GetBucketLocation'); Resource = @("arn:aws:s3:::$bucket") },
      @{ Effect = 'Allow'; Action = @('s3:ListBucket'); Resource = @("arn:aws:s3:::$bucket"); Condition = @{ StringLike = @{ 's3:prefix' = @("$allowedPrefix/*") } } },
      @{ Effect = 'Allow'; Action = @('s3:GetObject', 's3:PutObject'); Resource = @("arn:aws:s3:::$bucket/$allowedPrefix/*") }
    )
  }
  [IO.File]::WriteAllText((Join-Path $temporaryDirectory 'policy.json'), ($policy | ConvertTo-Json -Depth 12))
  $reportDirectory = Join-Path $workspace '.data'
  New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
  $reportPath = Join-Path $reportDirectory "s3-permissions-$runId.json"
  Write-AcceptanceReport 'Running'
  $client = Invoke-DockerResult @(
    'run', '--detach', '--rm', '--pull', 'never', '--name', $clientName,
    '--label', "mc.s3-permissions.run=$runId", '--network', "container:$($server.Id)",
    '--env', "MC_HOST_admin=http://${rootUser}:${rootSecret}@127.0.0.1:9000",
    '--entrypoint', '/bin/sh', $mcImage, '-c', 'sleep 900'
  )
  Assert-Success $client '创建本轮临时 mc 客户端'
  $clientCreated = $true
  $clientVersion = Invoke-DockerResult @('exec', $clientName, 'mc', '--version')
  Assert-Success $clientVersion '读取 mc 版本'
  $versions.mc = ($clientVersion.Output -split "`n")[0]
  foreach ($filename in @('policy.json')) {
    Assert-Success (Invoke-DockerResult @('cp', (Join-Path $temporaryDirectory $filename), "${clientName}:/tmp/$filename")) "复制 $filename"
  }
  foreach ($targetBucket in @($bucket, $otherBucket)) {
    Assert-Success (Invoke-McResult @('mb', "admin/$targetBucket")) '创建唯一测试桶'
    $createdBuckets.Add($targetBucket)
  }
  Assert-S3Error (Invoke-McResult @('admin', 'user', 'info', 'admin', $userName)) @('XMinioAdminNoSuchUser') '确认测试用户不存在' | Out-Null
  Assert-S3Error (Invoke-McResult @('admin', 'policy', 'info', 'admin', $policyName)) @('XMinioAdminNoSuchPolicy') '确认测试策略不存在' | Out-Null
  Assert-Success (Invoke-McResult @('admin', 'user', 'add', 'admin', $userName, $userSecret)) '创建合成测试用户'
  $userCreated = $true
  Assert-Success (Invoke-McResult @('admin', 'policy', 'create', 'admin', $policyName, '/tmp/policy.json')) '创建最小权限策略'
  $policyCreated = $true
  Assert-Success (Invoke-McResult @('admin', 'policy', 'attach', 'admin', $policyName, '--user', $userName)) '绑定最小权限策略'
  $policyAttached = $true
  Invoke-S3Fixture 'Test'
  Test-AnonymousRequest 'Get' "$bucket/$allowedPrefix/read-write.txt"
  Test-AnonymousRequest 'Put' "$bucket/$allowedPrefix/anonymous-write.txt"
  Invoke-S3Fixture 'Inspect'
} catch {
  $failure = $_.Exception.Message
} finally {
  if ($clientCreated) {
    if ($policyAttached) {
      Invoke-CleanupStep '解绑本轮策略' {
        Assert-Success (Invoke-McResult @('admin', 'policy', 'detach', 'admin', $policyName, '--user', $userName)) '解绑本轮策略'
      }
    }
    if ($userCreated) {
      Invoke-CleanupStep '删除并核对本轮用户' {
        Assert-Success (Invoke-McResult @('admin', 'user', 'remove', 'admin', $userName)) '删除本轮用户'
        Assert-S3Error (Invoke-McResult @('admin', 'user', 'info', 'admin', $userName)) @('XMinioAdminNoSuchUser') '核对用户已清理' | Out-Null
      }
    }
    if ($policyCreated) {
      Invoke-CleanupStep '删除并核对本轮策略' {
        Assert-Success (Invoke-McResult @('admin', 'policy', 'remove', 'admin', $policyName)) '删除本轮策略'
        Assert-S3Error (Invoke-McResult @('admin', 'policy', 'info', 'admin', $policyName)) @('XMinioAdminNoSuchPolicy') '核对策略已清理' | Out-Null
      }
    }
    if ($createdBuckets.Count -gt 0) {
      Invoke-CleanupStep '删除并核对本轮对象和空桶' { Invoke-S3Fixture 'Cleanup' }
    }
    Invoke-CleanupStep '删除本轮临时客户端' {
      $inspection = Invoke-DockerResult @('inspect', $clientName)
      Assert-Success $inspection '核对临时客户端所有权'
      $ownedClient = @($inspection.Output | ConvertFrom-Json -AsHashtable)[0]
      if ($ownedClient.Config.Labels['mc.s3-permissions.run'] -cne $runId) { throw '客户端所有权不符，拒绝删除' }
      Assert-Success (Invoke-DockerResult @('rm', '-f', $ownedClient.Id)) '删除本轮客户端'
    }
  }
  if ($temporaryDirectoryCreated -and (Test-Path -LiteralPath $temporaryDirectory)) {
    Invoke-CleanupStep '删除本轮临时文件' {
      $resolved = [IO.Path]::GetFullPath($temporaryDirectory)
      $expected = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) $clientName))
      if ($resolved -cne $expected) { throw '临时目录越界，拒绝删除' }
      foreach ($filename in @('policy.json')) {
        $path = Join-Path $resolved $filename
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
      }
      if (@(Get-ChildItem -LiteralPath $resolved -Force).Count -gt 0) { throw '临时目录含未知文件，拒绝递归删除' }
      Remove-Item -LiteralPath $resolved -Force
    }
  }
  if ($cleanupErrors.Count -eq 0 -and $clientCreated) { Add-Check 'owned-resources-cleaned-and-verified' }
  if ($reportPath) {
    $status = if ($failure -or $cleanupErrors.Count -gt 0) { 'Failed' } else { 'Passed' }
    Write-AcceptanceReport $status
    Write-Host "Report: $reportPath"
  }
}

if ($failure -or $cleanupErrors.Count -gt 0) {
  throw (@($failure) + $cleanupErrors.ToArray() | Where-Object { $_ }) -join "`n"
}
Write-Host "PASS $($checks.Count) checks; local isolated MinIO only; no production acceptance claim."
