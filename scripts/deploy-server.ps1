#requires -Version 5.1
<#
.SYNOPSIS
Builds amd64 Docker images locally, transfers them to the Linux server, and starts Compose.
.EXAMPLE
.\deploy-server.bat
.EXAMPLE
.\deploy-server.bat -Database Neon -Gateway On
.EXAMPLE
.\deploy-server.bat -PackageOnly

The server's .env.compose is authoritative. This script never uploads a local env file.
OpenSSH prompts for the server password (once for scp and once for ssh) unless a key is configured.
#>
[CmdletBinding()]
param(
  [ValidateSet('Auto', 'Local', 'Neon')][string]$Database = 'Auto',
  [ValidateSet('Auto', 'On', 'Off')][string]$Gateway = 'Auto',
  [switch]$PackageOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repository = Split-Path $PSScriptRoot -Parent
$remote = 'root@47.242.207.224'
$remoteProject = '/opt/multimodal-canvas'
$images = @(
  'multimodal-canvas-initialize:local',
  'multimodal-canvas-migrate:local',
  'multimodal-canvas-api:local',
  'multimodal-canvas-worker:local',
  'multimodal-canvas-web:local',
  'postgres:16-alpine',
  'redis:7-alpine',
  'caddy:2.10.2-alpine'
)

function Invoke-Checked {
  param([string]$Executable, [string[]]$Arguments, [string]$Failure)
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Failure (exit $LASTEXITCODE)" }
}

function Assert-LocalDocker {
  if ($env:DOCKER_HOST) { throw 'DOCKER_HOST is set; use the local Docker Desktop engine.' }
  $context = (& docker.exe context show).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Docker context.' }
  $hostAddress = (& docker.exe context inspect $context --format '{{.Endpoints.docker.Host}}').Trim()
  if ($LASTEXITCODE -ne 0 -or $hostAddress -notmatch '^npipe:/{4}\./pipe/[^/\\]+$') {
    throw 'Docker context must point to the local Windows named pipe.'
  }
  $platform = & docker.exe info --format '{{.OSType}}/{{.Architecture}}' 2>$null
  if ($LASTEXITCODE -ne 0) {
    $desktopCandidates = @()
    if ($env:ProgramFiles) { $desktopCandidates += Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe' }
    if ($env:LOCALAPPDATA) { $desktopCandidates += Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe' }
    $desktop = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $desktop) { throw 'Docker Desktop is unavailable; install or start its Linux engine.' }
    if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
      Write-Host 'Starting Docker Desktop...'
      Start-Process -FilePath $desktop -WindowStyle Hidden | Out-Null
    }
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    do {
      Start-Sleep -Seconds 3
      $platform = & docker.exe info --format '{{.OSType}}/{{.Architecture}}' 2>$null
    } while ($LASTEXITCODE -ne 0 -and [DateTime]::UtcNow -lt $deadline)
  }
  $platform = [string]$platform
  if ($LASTEXITCODE -ne 0 -or $platform -ne 'linux/x86_64') {
    throw "Docker Desktop must run Linux/amd64 containers (current: $platform)."
  }
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use this entry on Windows.' }
  foreach ($command in @('docker.exe', 'ssh.exe', 'scp.exe', 'tar.exe')) {
    if (-not (Get-Command $command -CommandType Application -ErrorAction SilentlyContinue)) {
      throw "Missing $command in PATH."
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $repository '.env.compose') -PathType Leaf)) {
    throw 'Missing local .env.compose, which Docker Compose needs to validate the build configuration.'
  }

  Assert-LocalDocker
  $id = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $outputDirectory = Join-Path $repository '.local-deploy'
  $stage = Join-Path $outputDirectory "$id-stage"
  $archive = Join-Path $outputDirectory "$id.tar.gz"
  New-Item -ItemType Directory -Path (Join-Path $stage 'docker'), (Join-Path $stage 'scripts') -Force | Out-Null

  Push-Location $repository
  try {
    $oldProfiles = $env:COMPOSE_PROFILES
    $oldFiles = $env:COMPOSE_ENV_FILES
    $oldDisable = $env:COMPOSE_DISABLE_ENV_FILE
    $oldPlatform = $env:DOCKER_DEFAULT_PLATFORM
    try {
      Remove-Item Env:COMPOSE_PROFILES, Env:COMPOSE_ENV_FILES -ErrorAction SilentlyContinue
      $env:COMPOSE_DISABLE_ENV_FILE = '1'
      $env:DOCKER_DEFAULT_PLATFORM = 'linux/amd64'
      $compose = @('compose', '--env-file', '.env.compose', '-p', 'multimodal-canvas-app', '-f', 'compose.yaml')
      Invoke-Checked 'docker.exe' ($compose + @('config', '--quiet')) 'Local Compose configuration is invalid'
      Write-Host 'Building application images for linux/amd64...'
      Invoke-Checked 'docker.exe' ($compose + @('build', 'initialize', 'migrate', 'api', 'worker', 'web')) 'Local image build failed'
    } finally {
      $env:COMPOSE_PROFILES = $oldProfiles
      $env:COMPOSE_ENV_FILES = $oldFiles
      $env:COMPOSE_DISABLE_ENV_FILE = $oldDisable
      $env:DOCKER_DEFAULT_PLATFORM = $oldPlatform
    }

    foreach ($image in $images) {
      $platform = & docker.exe image inspect --format '{{.Os}}/{{.Architecture}}' $image 2>$null
      if ($LASTEXITCODE -ne 0) {
        if ($image -like 'multimodal-canvas-*') { throw "Missing built image: $image" }
        Write-Host "Pulling required image $image..."
        Invoke-Checked 'docker.exe' @('pull', '--platform', 'linux/amd64', $image) "Cannot pull $image"
        $platform = & docker.exe image inspect --format '{{.Os}}/{{.Architecture}}' $image
      }
      if ($LASTEXITCODE -ne 0 -or $platform.Trim() -ne 'linux/amd64') {
        throw "Image $image is not linux/amd64."
      }
    }

    Copy-Item -LiteralPath 'compose.yaml', 'compose.neon.yaml' -Destination $stage
    Copy-Item -LiteralPath 'docker\Caddyfile', 'docker\logging.caddy' -Destination (Join-Path $stage 'docker')
    Copy-Item -LiteralPath 'scripts\deploy-server-apply.sh' -Destination (Join-Path $stage 'scripts')

    Write-Host 'Saving Docker images; this may take several minutes...'
    Invoke-Checked 'docker.exe' (@('image', 'save', '-o', (Join-Path $stage 'images.tar')) + $images) 'Cannot save Docker images'
    Write-Host 'Compressing deployment archive...'
    Invoke-Checked 'tar.exe' @('-czf', $archive, '-C', $stage, 'images.tar', 'compose.yaml', 'compose.neon.yaml', 'docker', 'scripts') 'Cannot create deployment archive'
    $stagePath = [IO.Path]::GetFullPath($stage)
    $outputPrefix = [IO.Path]::GetFullPath($outputDirectory).TrimEnd('\') + '\'
    if (-not $stagePath.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Temporary directory escaped the deployment output directory.'
    }
    Remove-Item -LiteralPath $stagePath -Recurse -Force
  } finally {
    Pop-Location
  }

  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  $sizeGb = [math]::Round((Get-Item -LiteralPath $archive).Length / 1GB, 2)
  Write-Host "Archive ready: $archive ($sizeGb GB, SHA-256 $hash)"
  if ($PackageOnly) { exit 0 }

  $archiveName = ".incoming-$id.tar.gz"
  $remoteArchive = "$remoteProject/$archiveName"
  Write-Host 'Uploading archive. OpenSSH may ask for the server password...'
  Invoke-Checked 'scp.exe' @('-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', $archive, "${remote}:$remoteArchive") 'Upload failed'

  # All interpolated arguments are controlled here and contain only safe path/hash/mode characters.
  $applyName = ".deploy-apply-$id.sh"
  $remoteCommand = "cd '$remoteProject' && printf '%s  %s\n' '$hash' '$archiveName' | sha256sum -c - && tar -xOf '$archiveName' scripts/deploy-server-apply.sh > '$applyName' && bash '$applyName' '$archiveName' '$Database' '$Gateway' '$id' && rm -f -- '$applyName'"
  Write-Host 'Starting services on the server. OpenSSH may ask for the password again...'
  Invoke-Checked 'ssh.exe' @('-T', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', $remote, $remoteCommand) 'Remote deployment failed'
  Write-Host 'Deployment completed successfully.'
} catch {
  Write-Host "Deployment stopped: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
