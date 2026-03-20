$projectRoot = Split-Path -Path $PSScriptRoot -Parent
$releaseDir = Join-Path $projectRoot "release"
$builderOutputDir = Join-Path $releaseDir "build"
$normalizedReleaseDir = [System.IO.Path]::GetFullPath($releaseDir)
$normalizedBuilderOutputDir = [System.IO.Path]::GetFullPath($builderOutputDir)

function Test-IsPathUnderDirectory {
  param(
    [string]$Path,
    [string]$Directory
  )

  if (-not $Path -or -not $Directory) {
    return $false
  }

  try {
    $normalizedPath = [System.IO.Path]::GetFullPath($Path)
    $normalizedDirectory = [System.IO.Path]::GetFullPath($Directory).TrimEnd('\')
  } catch {
    return $false
  }

  return $normalizedPath.Equals($normalizedDirectory, [System.StringComparison]::OrdinalIgnoreCase) -or
    $normalizedPath.StartsWith(($normalizedDirectory + "\"), [System.StringComparison]::OrdinalIgnoreCase)
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  try {
    & taskkill /PID $ProcessId /T /F *> $null
    return
  } catch {
  }

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
  } catch {
  }
}

$processIds = New-Object "System.Collections.Generic.HashSet[int]"

foreach ($process in Get-Process -Name "moyin-creator", "魔因漫创" -ErrorAction SilentlyContinue) {
  $null = $processIds.Add([int]$process.Id)
}

foreach ($process in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
  $exePath = $process.ExecutablePath
  $name = $process.Name
  if (
    (Test-IsPathUnderDirectory -Path $exePath -Directory $normalizedBuilderOutputDir) -or
    (($name -and $name -like "moyin-creator-*-setup.exe") -and (Test-IsPathUnderDirectory -Path $exePath -Directory $normalizedReleaseDir))
  ) {
    $null = $processIds.Add([int]$process.ProcessId)
  }
}

foreach ($processId in $processIds) {
  Stop-ProcessTree -ProcessId $processId
}

if ($processIds.Count -gt 0) {
  Start-Sleep -Milliseconds 1200
}

if (Test-Path -LiteralPath $builderOutputDir) {
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    try {
      Remove-Item -LiteralPath $builderOutputDir -Recurse -Force -ErrorAction Stop
      break
    } catch {
      if ($attempt -eq 6) {
        Write-Warning ("Failed to clean builder output directory; build will fall back to a fresh staging folder if needed: " + $_.Exception.Message)
      } else {
        Start-Sleep -Milliseconds (750 * $attempt)
      }
    }
  }
}

exit 0
