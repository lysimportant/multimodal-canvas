#requires -Version 5.1
<#
.SYNOPSIS
Builds amd64 Docker images locally and packages them for manual FTP upload.
.EXAMPLE
.\deploy-server.bat

The server's .env.compose is authoritative and is excluded from the archive.
This script only creates local files. Upload and server startup are manual.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repository = Split-Path $PSScriptRoot -Parent
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
  foreach ($command in @('docker.exe', 'tar.exe')) {
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
  $archiveName = "multimodal-canvas-$id.tar.gz"
  $archive = Join-Path $outputDirectory $archiveName
  $partialArchive = "$archive.partial"
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
    Invoke-Checked 'tar.exe' @('-czf', $partialArchive, '-C', $stage, 'images.tar', 'compose.yaml', 'compose.neon.yaml', 'docker', 'scripts') 'Cannot create deployment archive'
    Move-Item -LiteralPath $partialArchive -Destination $archive
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
  $checksumName = "$archiveName.sha256"
  [IO.File]::WriteAllText((Join-Path $outputDirectory $checksumName), "$hash  $archiveName`n", [Text.Encoding]::ASCII)
  $serverCommand = @(
    "cd '$remoteProject' &&",
    "sha256sum -c '$checksumName' &&",
    "tar -xOzf '$archiveName' scripts/deploy-server-apply.sh | bash -s -- '$archiveName'"
  ) -join "`n"
  $instructions = Join-Path $outputDirectory "$id-server-commands.txt"
  [IO.File]::WriteAllText($instructions, "$serverCommand`n", [Text.Encoding]::ASCII)

  Write-Host "Package ready ($sizeGb GB). Upload BOTH files to ${remoteProject}/:"
  Write-Host "  $archive"
  Write-Host "  $(Join-Path $outputDirectory $checksumName)"
  Write-Host "Server commands saved to: $instructions"
  Write-Host ''
  Write-Host $serverCommand
  Write-Host ''
  Write-Host 'Local packaging completed. The server has not been contacted.'
} catch {
  Write-Host "Packaging stopped: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
